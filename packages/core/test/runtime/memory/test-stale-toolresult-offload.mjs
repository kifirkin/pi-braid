/**
 * setting-gated stale toolResult offloader (braid.context.staleToolResultOffload).
 *
 * Charter: deterministic (no LLM),
 * lossless (flush to ~/.pi/agent/braid/offload/ before any substitution),
 * idempotent (stubbed entries recognizable + skipped; flush exists-guarded),
 * bounded (maxOffloadCharsPerRun), default OFF (provable no-op).
 *
 * Behaviors pinned here:
 * A. Config resolver: absent → all defaults (enabled=false); valid merge;
 * per-field invalid → that field's default; non-object → all defaults;
 * first invalid logs ONCE per process (buffered logger, TUI-safe).
 * B. Planner (pure): old+large beyond both the staleness policy and the
 * keep-recent guard → planned; recent / small / error / internal /
 * image / over-budget → skipped; already-stubbed → recognizable+skipped.
 * C. Apply: stub carries toolName, chars, ISO timestamp, flush path; full
 * original text is on disk BEFORE substitution; input array never
 * mutated; flush failure → entry untouched (never stub without flush).
 * D. Default-off invariant: setting absent → handler returns undefined and
 * the context is untouched (zero behavior change).
 * E. pi-core integration: the INSTALLED pi-coding-agent (0.82.1) applies a
 * `context`handler's returned { messages } once per LLM call and
 * structuredClones the live session array (ExtensionRunner micro-test).
 *
 * Settings + storage isolation: HOME is redirected to a temp dir BEFORE the
 * dist imports (os.homedir() reads $HOME on POSIX), so no live settings.json
 * is read and all offload flushes land in the temp home (same pattern as
 * test-context-limit-config.mjs). The reader reads fresh on every call, so
 * fixtures write settings.json between phases.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate settings AND offload storage: temp home. MUST precede imports.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w87-offload-"));
process.env.HOME = FAKE_HOME;
const SETTINGS_PATH = join(FAKE_HOME, ".pi", "agent", "settings.json");
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });

const { resolveStaleToolResultOffloadConfig, getStaleToolResultOffloadConfig } =
  await import("../../../dist/lib/config/braid-settings.js");
const { getLogBuffer } = await import("../../../dist/lib/core/logger.js");
const {
  planStaleToolResultOffloads,
  applyStaleToolResultOffloads,
  registerStaleToolResultOffloader,
  getOffloaderHealth,
} = await import("../../../dist/extensions/memory/context-manager/handlers/offload.js");
const { OFFLOAD_DIR } = await import("../../../dist/lib/config/braid-paths.js");
// Installed pi-core — proves the mechanism end-to-end (test E).
const { ExtensionRunner } =
  await import("../../../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js");

console.log("=== stale toolResult offloader ===\n");

let passed = 0;
let failed = 0;
// Sequential chaining: async tests MUST NOT run concurrently — they share
// settings.json fixtures and the offloader's process-global state.
let chain = Promise.resolve();
function test(name, fn) {
  chain = chain
    .then(
      () => fn(),
      () => {},
    )
    .then(
      () => {
        console.log(` [v] ${name}`);
        passed++;
      },
      (e) => {
        console.log(` [x] ${name}: ${e.message}`);
        failed++;
      },
    );
}

function writeSettings(braid) {
  if (braid === null) {
    rmSync(SETTINGS_PATH, { force: true });
    return;
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify({ braid }));
}

function countBraidSettingsLogs() {
  return getLogBuffer().filter((e) => e.source === "braid-settings").length;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let toolCallCounter = 0;
function toolResult(text, { toolName = "bash", isError = false } = {}) {
  toolCallCounter++;
  return {
    role: "toolResult",
    toolCallId: `call_${toolCallCounter}`,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp: new Date().toISOString(),
  };
}

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });

const BASE_CFG = {
  enabled: true,
  minChars: 100,
  stalenessTurns: 2,
  keepRecentTurns: 1,
  maxOffloadCharsPerRun: 100_000,
};

// ── A. Config resolver ────────────────────────────────────────────────────────

test("resolver: absent → all defaults (enabled=false)", () => {
  const c = resolveStaleToolResultOffloadConfig(undefined);
  assert.equal(c.enabled, false);
  assert.equal(c.minChars, 4_000);
  assert.equal(c.stalenessTurns, 40);
  assert.equal(c.keepRecentTurns, 20);
  assert.equal(c.maxOffloadCharsPerRun, 65_536);
});

test("resolver: valid partial config merges over defaults", () => {
  const c = resolveStaleToolResultOffloadConfig({ enabled: true, minChars: 8_000 });
  assert.equal(c.enabled, true);
  assert.equal(c.minChars, 8_000);
  assert.equal(c.stalenessTurns, 40);
  assert.equal(c.keepRecentTurns, 20);
  assert.equal(c.maxOffloadCharsPerRun, 65_536);
});

test("resolver: invalid fields fall back per-field (no throw)", () => {
  const c = resolveStaleToolResultOffloadConfig({
    enabled: "yes",
    minChars: -5,
    stalenessTurns: 0,
    keepRecentTurns: 1.5,
    maxOffloadCharsPerRun: "big",
  });
  assert.equal(c.enabled, false);
  assert.equal(c.minChars, 4_000);
  assert.equal(c.stalenessTurns, 40);
  assert.equal(c.keepRecentTurns, 20);
  assert.equal(c.maxOffloadCharsPerRun, 65_536);
});

test("resolver: non-object shapes (string, array, null) → all defaults", () => {
  for (const bad of ["on", [true], null]) {
    const c = resolveStaleToolResultOffloadConfig(bad);
    assert.equal(c.enabled, false, `bad=${JSON.stringify(bad)}`);
    assert.equal(c.minChars, 4_000);
  }
});

// The invalid tests above (invalid-fields + non-object) already consumed this
// process's one warning; assert the log-once DEDUP from here on.
test("invalid config warns but only ONCE per process (log-once dedup)", () => {
  const before = countBraidSettingsLogs();
  assert.ok(before >= 1, "the invalid shapes above emitted at least one warning");
  resolveStaleToolResultOffloadConfig({ minChars: -1 });
  resolveStaleToolResultOffloadConfig("garbage");
  resolveStaleToolResultOffloadConfig({ stalenessTurns: 0 });
  const count = countBraidSettingsLogs();
  for (let i = 0; i < 5; i++) resolveStaleToolResultOffloadConfig({ minChars: -i - 2 });
  assert.equal(
    countBraidSettingsLogs(),
    count,
    "repeated invalid values do not warn again (log-once)",
  );
});

test("getter mirrors the resolver against live settings (fresh reads)", () => {
  writeSettings({ context: { staleToolResultOffload: { enabled: true, minChars: 500 } } });
  const c = getStaleToolResultOffloadConfig();
  assert.equal(c.enabled, true);
  assert.equal(c.minChars, 500);
  writeSettings(null);
  assert.equal(getStaleToolResultOffloadConfig().enabled, false);
});

// ── B. Planner ────────────────────────────────────────────────────────────────

function makeContext({ oldChars = 300, midChars = 150, recentChars = 150 } = {}) {
  // toolResults: old (rank 2), mid (rank 1), recent (rank 0).
  return [
    user("fix the build"),
    toolResult("x".repeat(oldChars), { toolName: "bash" }), // rank 2 — stale
    toolResult("y".repeat(midChars), { toolName: "grep" }), // rank 1 — below staleness
    toolResult("z".repeat(recentChars), { toolName: "read" }), // rank 0 — recency guard
  ];
}

test("planner: old large toolResult beyond thresholds → planned (oldest first)", () => {
  const { plan } = planStaleToolResultOffloads(makeContext(), BASE_CFG);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].toolName, "bash");
  assert.equal(plan[0].index, 1);
  assert.equal(plan[0].chars, 300);
});

test("planner: recent toolResult inside keepRecentTurns guard → untouched", () => {
  const { plan } = planStaleToolResultOffloads(makeContext(), BASE_CFG);
  assert.ok(!plan.some((p) => p.toolName === "read"), "recent entry must never be planned");
});

test("planner: small old toolResult under minChars → untouched", () => {
  const messages = makeContext();
  messages.splice(1, 0, toolResult("tiny", { toolName: "find" })); // rank 3, 4 chars
  const { plan } = planStaleToolResultOffloads(messages, BASE_CFG);
  assert.equal(plan.length, 1, "only the large stale entry is eligible");
  assert.equal(plan[0].toolName, "bash");
});

test("planner: isError result → skipped", () => {
  const ctx = makeContext();
  ctx[1] = toolResult("x".repeat(300), { toolName: "bash", isError: true });
  const { plan } = planStaleToolResultOffloads(ctx, BASE_CFG);
  assert.equal(plan.length, 0, "error results are decision-relevant: never offloaded (v1)");
});

test("planner: internal braid tool results → skipped", () => {
  const ctx = makeContext();
  ctx[1] = toolResult("x".repeat(300), { toolName: "think" });
  const { plan } = planStaleToolResultOffloads(ctx, BASE_CFG);
  assert.equal(plan.length, 0);
});

test("planner: non-text (image) content → skipped", () => {
  const ctx = makeContext();
  ctx[1] = {
    role: "toolResult",
    toolCallId: "call_img",
    toolName: "screenshot",
    content: [
      { type: "text", text: "screenshot of ".padEnd(120, ".") },
      { type: "image", data: "base64data", mimeType: "image/png" },
    ],
    isError: false,
  };
  const { plan } = planStaleToolResultOffloads(ctx, BASE_CFG);
  assert.equal(plan.length, 0);
});

test("planner: staleness policy dominates keepRecentTurns when larger", () => {
  const ctx = makeContext({ oldChars: 300 });
  const cfg = { ...BASE_CFG, stalenessTurns: 10, keepRecentTurns: 1 };
  const { plan } = planStaleToolResultOffloads(ctx, cfg);
  assert.equal(plan.length, 0, "age 2 < stalenessTurns 10 → not eligible");
});

test("planner: per-run budget bounds planned chars (oldest wins)", () => {
  const ctx = [
    user("go"),
    toolResult("a".repeat(200), { toolName: "bash" }), // rank 1
    toolResult("b".repeat(200), { toolName: "grep" }), // rank 0 — wait, both stale below
  ];
  // Two eligible entries (ranks 1 and 0) — set keepRecentTurns=0.
  const cfg = { ...BASE_CFG, stalenessTurns: 1, keepRecentTurns: 0, maxOffloadCharsPerRun: 300 };
  const { plan } = planStaleToolResultOffloads(ctx, cfg);
  assert.equal(plan.length, 1, "budget 300 admits only the first 200-char entry");
  assert.equal(plan[0].toolName, "bash", "oldest entry has priority");
});

test("planner: already-stubbed entries are recognizable and skipped", () => {
  const ctx = makeContext();
  ctx[1] = {
    role: "toolResult",
    toolCallId: "call_offloaded",
    toolName: "bash",
    content: [
      {
        type: "text",
        text: "[offloaded: bash result, 300 chars, 2026-09-05T00:00:00.000Z — full text: /tmp/x.txt]",
      },
    ],
    isError: false,
  };
  const { plan, alreadyStubbed } = planStaleToolResultOffloads(ctx, BASE_CFG);
  assert.equal(plan.length, 0, "stubbed entries are never re-planned (idempotence)");
  assert.equal(alreadyStubbed, 1);
});

// ── C. Apply (real fs into the temp home) ─────────────────────────────────────

const APPLY_SESSION = "w87-apply-session";

test("apply: flushes FULL original text to disk, then stubs the in-context body", () => {
  const ctx = makeContext();
  const { plan } = planStaleToolResultOffloads(ctx, BASE_CFG);
  const before = JSON.stringify(ctx);
  const io = {
    nowIso: () => "2026-09-05T10:00:00.000Z",
    exists: (p) => existsSync(p),
    flush: (p, t) => {
      mkdirSync(join(OFFLOAD_DIR, APPLY_SESSION), { recursive: true });
      writeFileSync(p, t, "utf-8");
    },
    flushPath: (s, id, name) => join(OFFLOAD_DIR, s, `${name}-${id}.txt`),
  };
  const result = applyStaleToolResultOffloads(ctx, plan, io, { sessionId: APPLY_SESSION });
  assert.equal(result.offloaded, 1);
  assert.equal(result.charsSaved, 300);
  assert.equal(result.bytesFlushed, 300);
  // Input untouched.
  assert.equal(JSON.stringify(ctx), before, "apply must never mutate the input array");
  assert.notEqual(result.messages, ctx, "a new array is returned");
  // Stub content: toolName + size + timestamp + path.
  const stub = result.messages[1].content[0].text;
  assert.ok(stub.startsWith("[offloaded: bash result, 300 chars,"), `stub: ${stub}`);
  assert.ok(stub.includes("2026-09-05T10:00:00.000Z"), "stub carries the ISO timestamp");
  const m = stub.match(/full text: (\S+)\]$/);
  assert.ok(m, "stub carries the flush path");
  const flushPath = m[1];
  assert.ok(existsSync(flushPath), "flush file exists on disk");
  assert.equal(
    readFileSync(flushPath, "utf-8"),
    "x".repeat(300),
    "flush file holds the FULL original text (lossless recovery)",
  );
});

test("apply: flush failure → entry skipped, never stubbed", () => {
  const ctx = makeContext();
  const { plan } = planStaleToolResultOffloads(ctx, BASE_CFG);
  const failingIo = {
    nowIso: () => "2026-09-05T10:00:00.000Z",
    exists: () => false,
    flush: () => {
      throw new Error("EACCES: disk full");
    },
    flushPath: () => join(OFFLOAD_DIR, "fail", "x.txt"),
  };
  const result = applyStaleToolResultOffloads(ctx, plan, failingIo, { sessionId: "fail" });
  assert.equal(result.skipped, 1);
  assert.equal(result.offloaded, 0);
  assert.equal(result.messages, ctx, "input returned unchanged on total failure");
});

test("apply: idempotence — second run flushes nothing new, stub identical", async () => {
  writeSettings({
    context: {
      staleToolResultOffload: {
        enabled: true,
        minChars: 100,
        stalenessTurns: 2,
        keepRecentTurns: 1,
      },
    },
  });
  const captured = [];
  const fakePi = { on: (type, fn) => captured.push({ type, fn }) };
  registerStaleToolResultOffloader(fakePi);
  const handler = captured.find((h) => h.type === "context").fn;
  const fakeCtx = {
    sessionManager: { getSessionFile: () => "s-idem.jsonl", getSessionId: () => "idem" },
  };
  const input = makeContext();
  const first = await handler({ type: "context", messages: input }, fakeCtx);
  assert.ok(first && first.messages, "first run offloads");
  const firstStub = first.messages[1].content[0].text;
  const bytesAfterFirst = getOffloaderHealth().totalBytesFlushed;
  const second = await handler({ type: "context", messages: input }, fakeCtx);
  assert.ok(second && second.messages, "second run still substitutes (per-request view)");
  assert.equal(
    second.messages[1].content[0].text,
    firstStub,
    "stub is byte-identical (stable meta)",
  );
  assert.equal(
    getOffloaderHealth().totalBytesFlushed,
    bytesAfterFirst,
    "no new bytes flushed (exists-guard)",
  );
});

// ── D. Default-off invariant (provable zero behavior change) ──────────────────

test("default-off: setting absent → handler returns undefined, context untouched", async () => {
  writeSettings(null);
  const captured = [];
  const fakePi = { on: (type, fn) => captured.push({ type, fn }) };
  registerStaleToolResultOffloader(fakePi);
  const handler = captured.find((h) => h.type === "context").fn;
  const fakeCtx = {
    sessionManager: { getSessionFile: () => "s-off.jsonl", getSessionId: () => "off" },
  };
  const input = makeContext();
  const snapshot = JSON.stringify(input);
  const out = await handler({ type: "context", messages: input }, fakeCtx);
  assert.equal(out, undefined, "disabled handler must return undefined (no messages key)");
  assert.equal(JSON.stringify(input), snapshot, "messages must not be mutated");
  assert.ok(
    !existsSync(join(FAKE_HOME, ".pi", "agent", "braid", "offload", "off")),
    "no flush written for this session (session-scoped dir absent)",
  );
});

test("default-off: enabled=false explicitly → same zero behavior", async () => {
  writeSettings({ context: { staleToolResultOffload: { enabled: false } } });
  const captured = [];
  const fakePi = { on: (type, fn) => captured.push({ type, fn }) };
  registerStaleToolResultOffloader(fakePi);
  const handler = captured.find((h) => h.type === "context").fn;
  const input = makeContext();
  const snapshot = JSON.stringify(input);
  const out = await handler({ type: "context", messages: input }, { sessionManager: {} });
  assert.equal(out, undefined);
  assert.equal(JSON.stringify(input), snapshot);
});

test("default-off: eligible old large result is a no-op while disabled", async () => {
  writeSettings(null);
  const captured = [];
  const fakePi = { on: (type, fn) => captured.push({ type, fn }) };
  registerStaleToolResultOffloader(fakePi);
  const handler = captured.find((h) => h.type === "context").fn;
  const input = [user("x"), toolResult("a".repeat(50_000), { toolName: "read" })];
  const out = await handler({ type: "context", messages: input }, { sessionManager: {} });
  assert.equal(out, undefined, "no-op even for a 50k-char stale result");
});

// ── E. pi-core integration: installed runner applies the handler return ───────

test("pi-core emitContext applies the offloader return (installed 0.82.1, runtime-proven)", async () => {
  // stalenessTurns must be >= 1 (resolver validates); give the big result rank 1
  // behind a recent small filler.
  writeSettings({
    context: {
      staleToolResultOffload: {
        enabled: true,
        minChars: 100,
        stalenessTurns: 1,
        keepRecentTurns: 0,
      },
    },
  });
  const captured = [];
  const fakePi = { on: (type, fn) => captured.push({ type, fn }) };
  registerStaleToolResultOffloader(fakePi);
  const handler = captured.find((h) => h.type === "context").fn;
  const ext = { path: "w87-offload-test", handlers: new Map([["context", [handler]]]) };
  const runner = new ExtensionRunner([ext], {}, process.cwd());
  const input = [
    user("go"),
    toolResult("r".repeat(500), { toolName: "bash" }), // rank 1 — eligible
    toolResult("recent", { toolName: "read" }), // rank 0 — guard
  ];
  const out = await runner.emitContext(input);
  assert.equal(
    out[1].content[0].text.startsWith("[offloaded: bash result, 500 chars,"),
    true,
    "LLM-visible payload carries the stub",
  );
  assert.equal(
    input[1].content[0].text,
    "r".repeat(500),
    "live session message untouched (structuredClone)",
  );
  // Recovery: the flushed file holds the full original text.
  const path = out[1].content[0].text.match(/full text: (\S+)\]$/)[1];
  assert.equal(readFileSync(path, "utf-8"), "r".repeat(500));
  writeSettings(null);
});

await chain;
console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== stale toolResult offloader tests passed ===");
