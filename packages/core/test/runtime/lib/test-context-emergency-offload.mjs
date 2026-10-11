/**
 *: emergency context-window offloader (braid.context.contextEmergencyOffload).
 *
 * Charter: 413-QUOTA-BURN — when the LLM error classifier says
 * context_window (413 payload-too-large), the LARGEST oversized toolResults
 * are flushed losslessly to disk and stubbed in the per-request context, then
 * the send is retried EXACTLY ONCE. This is the health-gate exception: the
 * emergency path never consults SessionHealthState, so the shrink runs
 * exactly when the 413 latched context_overflow (the state that used to BLOCK
 * consolidation and burn quota in a retry loop).
 *
 * Behaviors pinned here:
 * A. Config resolver: absent → all defaults with enabled=true; valid merge;
 * per-field invalid → that field's default; non-object → all defaults
 * (log-once).
 * B. Planner (pure): LARGEST-first; keepRecentTurns recency guard; minChars
 * floor; isError / internal-tool / already-stubbed skipped; image
 * (base64) content ELIGIBLE (the 413 source); budget admits largest
 * first.
 * C. Apply: full content flushed to disk as JSON BEFORE any stub exists;
 * flush failure → entry skipped (never stub without a verified flush).
 * D. Per-request substitution (applyEmergencyStubs): preserves ALL original
 * toolResult fields; idempotent (already-stubbed untouched); no-op for
 * other roles.
 * E. Runner (runContextEmergencyOffload): branch messages scanned; stubs
 * recorded in CmState; telemetry counters bump; errors contained.
 * F. llm-call emergency retry (the revert-proof core): a context_window
 * error triggers the published offload and EXACTLY ONE retry; a no-shrink
 * result does NOT retry; non-context_window errors never trigger it.
 *
 * Settings + storage isolation: HOME is redirected to a temp dir BEFORE the
 * dist imports (os.homedir() reads $HOME on POSIX), so no live settings.json
 * is read and all flushes land in the temp home (same pattern as
 * test-stale-toolresult-offload.mjs / test-context-limit-config.mjs).
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// Isolate settings AND offload storage: temp home. MUST precede imports.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w115-emergency-"));
process.env.HOME = FAKE_HOME;
const SETTINGS_PATH = join(FAKE_HOME, ".pi", "agent", "settings.json");
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });

const { resolveContextEmergencyOffloadConfig, getContextEmergencyOffloadConfig } =
  await import("../../../dist/lib/config/braid-settings.js");
const { OFFLOAD_DIR } = await import("../../../dist/lib/config/braid-paths.js");
const {
  planContextEmergencyOffloads,
  applyContextEmergencyOffloads,
  applyEmergencyStubs,
  runContextEmergencyOffload,
  getEmergencyOffloaderHealth,
  resetEmergencyOffloaderHealth,
} = await import("../../../dist/extensions/memory/context-manager/handlers/context-emergency.js");
const { registerContextEmergencyOffloader } =
  await import("../../../dist/extensions/memory/context-manager/handlers/context-emergency.js");
const {
  setContextEmergencyOffloadRunner,
  setContextEmergencyCtxProvider,
  resetContextEmergencyOffloadRunner,
  resetContextEmergencyCtxProvider,
} = await import("../../../dist/lib/state/global-state.js");
const {
  __setCompleteSimpleForTest,
  __resetCompleteSimpleForTest,
  __resetRateLimitCooldownForTest,
} = await import("../../../dist/lib/ai/llm-call.js");
const { resetLlmCallListeners } = await import("../../../dist/lib/state/global-state.js");

console.log("=== emergency context-window offloader ===\n");

let passed = 0;
let failed = 0;
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

let toolCallCounter = 0;
function toolResult(text, { toolName = "bash", isError = false, extra } = {}) {
  toolCallCounter++;
  return {
    role: "toolResult",
    toolCallId: `call_${toolCallCounter}`,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp: new Date().toISOString(),
    ...(extra ?? {}),
  };
}
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });

const BASE_CFG = {
  enabled: true,
  minChars: 262_144,
  maxCharsPerRun: 1_048_576,
  keepRecentTurns: 1,
};

// ── A. Config resolver ────────────────────────────────────────────────────────

test("resolver: absent → defaults with enabled=TRUE (the 413 fix must be active)", () => {
  const c = resolveContextEmergencyOffloadConfig(undefined);
  assert.equal(c.enabled, true);
  assert.equal(c.minChars, 262_144);
  assert.equal(c.maxCharsPerRun, 1_048_576);
  assert.equal(c.keepRecentTurns, 1);
});

test("resolver: valid partial config merges over defaults", () => {
  const c = resolveContextEmergencyOffloadConfig({ enabled: true, minChars: 10_000 });
  assert.equal(c.enabled, true);
  assert.equal(c.minChars, 10_000);
  assert.equal(c.maxCharsPerRun, 1_048_576);
  assert.equal(c.keepRecentTurns, 1);
});

test("resolver: invalid fields fall back per-field (no throw)", () => {
  const c = resolveContextEmergencyOffloadConfig({
    enabled: "yes",
    minChars: -5,
    maxCharsPerRun: 1,
    keepRecentTurns: -1,
  });
  assert.equal(c.enabled, true);
  assert.equal(c.minChars, 262_144);
  assert.equal(c.maxCharsPerRun, 1_048_576);
  assert.equal(c.keepRecentTurns, 1);
});

test("resolver: non-object shapes (string, array, null) → all defaults", () => {
  for (const bad of ["on", [true], null]) {
    const c = resolveContextEmergencyOffloadConfig(bad);
    assert.equal(c.enabled, true, `bad=${JSON.stringify(bad)}`);
    assert.equal(c.minChars, 262_144);
  }
});

test("getter mirrors the resolver against live settings (fresh reads)", () => {
  writeSettings({ context: { contextEmergencyOffload: { enabled: false } } });
  assert.equal(getContextEmergencyOffloadConfig().enabled, false);
  writeSettings(null);
  assert.equal(getContextEmergencyOffloadConfig().enabled, true);
});

// ── B. Planner ────────────────────────────────────────────────────────────────

function sizedResult(chars, toolName = "bash") {
  return toolResult("x".repeat(chars), { toolName });
}

test("planner: largest-first ordering", () => {
  const messages = [
    user("go"),
    sizedResult(300_000, "grep"), // rank 1
    sizedResult(400_000, "bash"), // rank 0 — rank counts from END: bash is most recent
  ];
  // bash is the MOST RECENT toolResult (rank 0) → guard skips it.
  // grep has rank 1 → eligible.
  const { plan } = planContextEmergencyOffloads(messages, BASE_CFG);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].toolName, "grep");
});

test("planner: two stale candidates — largest first, budget admits both", () => {
  const messages = [
    user("go"),
    sizedResult(300_000, "grep"), // rank 1
    toolResult("filler", { toolName: "read" }), // rank 0 — recent small
    sizedResult(400_000, "find"), // rank 0? — see below
  ];
  // toolResult order: grep (rank 2), read (rank 1), find (rank 0).
  // keepRecentTurns=1 → find guarded, grep eligible.
  const { plan } = planContextEmergencyOffloads(messages, BASE_CFG);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].toolName, "grep");
});

test("planner: keepRecentTurns=0 admits every eligible result (largest first)", () => {
  const cfg = { ...BASE_CFG, keepRecentTurns: 0 };
  const messages = [user("go"), sizedResult(300_000, "grep"), sizedResult(400_000, "bash")];
  const { plan } = planContextEmergencyOffloads(messages, cfg);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].toolName, "bash", "400k (largest) first");
  assert.equal(plan[0].chars, 400_000);
  assert.equal(plan[1].chars, 300_000);
});

test("planner: sub-minChars results are never planned", () => {
  const messages = [user("go"), sizedResult(1_000, "bash")];
  const { plan } = planContextEmergencyOffloads(messages, BASE_CFG);
  assert.equal(plan.length, 0);
});

test("planner: isError results are decision-relevant — never planned", () => {
  const messages = [
    user("go"),
    toolResult("x".repeat(300_000), { toolName: "bash", isError: true }),
  ];
  const { plan } = planContextEmergencyOffloads(messages, { ...BASE_CFG, keepRecentTurns: 0 });
  assert.equal(plan.length, 0);
});

test("planner: internal braid tool results are never planned", () => {
  const messages = [user("go"), toolResult("x".repeat(300_000), { toolName: "think" })];
  const { plan } = planContextEmergencyOffloads(messages, { ...BASE_CFG, keepRecentTurns: 0 });
  assert.equal(plan.length, 0);
});

test("planner: IMAGE (base64) content IS eligible — the 413 source", () => {
  const messages = [
    user("go"),
    {
      role: "toolResult",
      toolCallId: "call_img",
      toolName: "screenshot",
      content: [
        { type: "text", text: "screenshot" },
        { type: "image", data: "A".repeat(300_000), mimeType: "image/png" },
      ],
      isError: false,
    },
    toolResult("recent filler", { toolName: "read" }), // rank 0 — guard
  ];
  // screenshot has rank 1 (read is rank 0) → eligible despite the base64 body.
  const { plan } = planContextEmergencyOffloads(messages, BASE_CFG);
  assert.equal(plan.length, 1, "300k base64 body must be eligible for emergency offload");
  assert.equal(plan[0].toolName, "screenshot");
  assert.equal(plan[0].chars, 300_000 + "screenshot".length);
});

test("planner: already-stubbed entries are recognized and skipped", () => {
  const messages = [
    user("go"),
    {
      role: "toolResult",
      toolCallId: "call_stub",
      toolName: "bash",
      content: [
        {
          type: "text",
          text: "[offloaded: bash result, 300000 chars, 2026-09-08T00:00:00.000Z — flushed to disk: /tmp/x.txt]",
        },
      ],
      isError: false,
    },
  ];
  const { plan, alreadyStubbed } = planContextEmergencyOffloads(messages, {
    ...BASE_CFG,
    keepRecentTurns: 0,
  });
  assert.equal(plan.length, 0);
  assert.equal(alreadyStubbed, 1);
});

// ── C. Apply ──────────────────────────────────────────────────────────────────

const IO = {
  nowIso: () => "2026-09-08T10:00:00.000Z",
  exists: (p) => existsSync(p),
  flush: (p, t) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, t, "utf-8");
  },
  flushPath: (s, id, name) => join(OFFLOAD_DIR, s, `${name}-${id}.json.txt`),
};

test("apply: flushes FULL content to disk as JSON, then returns the stub record", () => {
  resetEmergencyOffloaderHealth();
  const messages = [user("go"), toolResult("R".repeat(300_000), { toolName: "bash" })];
  const { plan } = planContextEmergencyOffloads(messages, {
    ...BASE_CFG,
    keepRecentTurns: 0,
    minChars: 1,
  });
  const result = applyContextEmergencyOffloads(messages, plan, IO, { sessionId: "w115-apply" });
  assert.equal(result.offloaded, 1);
  assert.equal(result.charsSaved, 300_000);
  const rec = Object.values(result.stubs)[0];
  assert.ok(rec.path, "stub record carries the flush path");
  assert.ok(existsSync(rec.path), "flush file exists on disk");
  const parsed = JSON.parse(readFileSync(rec.path, "utf-8"));
  assert.equal(
    parsed[0].text,
    "R".repeat(300_000),
    "flush holds the FULL original (lossless JSON)",
  );
  assert.ok(
    rec.stub.startsWith("[offloaded: bash result, 300000 chars,"),
    `stub: ${rec.stub.slice(0, 80)}`,
  );
  assert.ok(rec.stub.includes(rec.path), "stub points at the flush path");
  assert.ok(rec.stub.includes("[first 500 chars: RRRR"), "stub keeps a 500-char inline head");
  // The messages array itself is untouched — substitution is per-request.
  assert.equal(messages[1].content[0].text, "R".repeat(300_000));
});

test("apply: flush failure → entry skipped, NO stub (never stub without flush)", () => {
  const messages = [user("go"), toolResult("R".repeat(300_000), { toolName: "bash" })];
  const { plan } = planContextEmergencyOffloads(messages, {
    ...BASE_CFG,
    keepRecentTurns: 0,
    minChars: 1,
  });
  const failingIo = {
    nowIso: IO.nowIso,
    exists: () => false,
    flush: () => {
      throw new Error("EACCES: disk full");
    },
    flushPath: IO.flushPath,
  };
  const result = applyContextEmergencyOffloads(messages, plan, failingIo, { sessionId: "fail" });
  assert.equal(result.offloaded, 0);
  assert.equal(result.skipped, 1);
  assert.deepEqual(Object.keys(result.stubs), []);
});

// ── D. Per-request substitution ───────────────────────────────────────────────

test("applyEmergencyStubs: substitutes recorded stubs, preserves all fields, idempotent", () => {
  const messages = [
    user("go"),
    toolResult("R".repeat(300_000), { toolName: "bash", extra: { keep: true } }),
  ];
  const { plan } = planContextEmergencyOffloads(messages, {
    ...BASE_CFG,
    keepRecentTurns: 0,
    minChars: 1,
  });
  const { stubs } = applyContextEmergencyOffloads(messages, plan, IO, { sessionId: "subst" });
  const out = applyEmergencyStubs(messages, stubs);
  assert.notEqual(out, messages, "a new array is returned");
  assert.equal(out[1].toolCallId, messages[1].toolCallId, "toolCallId pairing preserved");
  assert.equal(out[1].toolName, "bash");
  assert.equal(out[1].timestamp, messages[1].timestamp);
  assert.equal(out[1].isError, false);
  assert.ok(out[1].content[0].text.startsWith("[offloaded:"));
  // Idempotent: already-stubbed entries are never re-substituted.
  const out2 = applyEmergencyStubs(out, stubs);
  assert.equal(out2, out, "second pass is a no-op (same reference)");
  // Non-toolResult roles pass through untouched (by reference).
  const nonTool = user("hi");
  const out3 = applyEmergencyStubs([nonTool], stubs);
  assert.equal(out3[0], nonTool, "user messages pass through by reference");
});

// ── E. Runner against a fake ctx (branch scan + CmState persistence) ──────────

function makeFakeCtx(branchMessages, sessionId) {
  return {
    sessionManager: {
      getBranch: () => branchMessages.map((message) => ({ type: "message", message })),
      getSessionId: () => sessionId,
      getSessionFile: () => `${sessionId}.jsonl`,
    },
  };
}

test("runner: scans the branch, flushes to disk, records stubs in CmState", async () => {
  resetEmergencyOffloaderHealth();
  writeSettings(null); // default ON
  const branch = [
    user("go"),
    toolResult("R".repeat(300_000), { toolName: "bash" }),
    toolResult("recent", { toolName: "read" }),
  ];
  const ctx = makeFakeCtx(branch, "w115-runner");
  const result = await runContextEmergencyOffload(ctx, "test");
  assert.equal(result.offloaded, 1);
  assert.ok(result.charsSaved >= 300_000);
  const cmState = (
    await import("../../../dist/extensions/memory/context-manager/handlers/shared.js")
  ).getCmState(ctx);
  const stubs = cmState.emergencyStubsByToolCallId;
  assert.ok(stubs && Object.keys(stubs).length === 1, "stub recorded in CmState");
  const rec = Object.values(stubs)[0];
  assert.ok(existsSync(rec.path), "flush exists");
  assert.equal(JSON.parse(readFileSync(rec.path, "utf-8"))[0].text, "R".repeat(300_000));
  assert.equal(getEmergencyOffloaderHealth().totalRuns, 1);
  // Idempotence: a second run flushes nothing new (file exists) and does not
  // overwrite the recorded stub.
  const before = getEmergencyOffloaderHealth().totalOffloaded;
  await runContextEmergencyOffload(ctx, "heartbeat-gate");
  assert.equal(getEmergencyOffloaderHealth().totalOffloaded, before, "no double offload");
});

test("runner: disabled setting → offloaded=0, error=disabled", async () => {
  writeSettings({ context: { contextEmergencyOffload: { enabled: false } } });
  const ctx = makeFakeCtx([user("go"), toolResult("R".repeat(300_000))], "w115-off");
  const result = await runContextEmergencyOffload(ctx, "test");
  assert.equal(result.offloaded, 0);
  assert.equal(result.error, "disabled");
  writeSettings(null);
});

// ── F. llm-call emergency retry (the revert-proof core) ───────────────────────

const { callLlm } = await import("../../../dist/lib/ai/llm-call.js");

const FAKE_MODEL = { id: "w115-test-model", provider: "test" };

function resetEmergencySlots() {
  resetContextEmergencyOffloadRunner();
  resetContextEmergencyCtxProvider();
  resetLlmCallListeners();
  __resetRateLimitCooldownForTest();
}

test("llm-call: 413 error → emergency offload ran → EXACTLY ONE retry succeeds", async () => {
  resetEmergencySlots();
  let calls = 0;
  const offloadRuns = [];
  setContextEmergencyOffloadRunner((ctx, reason) => {
    offloadRuns.push(reason);
    return Promise.resolve({ offloaded: 2, charsSaved: 700_000 });
  });
  setContextEmergencyCtxProvider(() => ({ fake: true }));
  __setCompleteSimpleForTest(async () => {
    calls++;
    if (calls === 1) {
      return { errorMessage: "413 Request Entity Too Large" };
    }
    return {
      content: [{ type: "text", text: "shrunken-ok" }],
      stopReason: "stop",
    };
  });
  const result = await callLlm(FAKE_MODEL, "key", "sys", "user");
  assert.equal(result.text, "shrunken-ok", "the shrunken retry succeeds");
  assert.equal(calls, 2, "exactly one extra attempt (the emergency retry)");
  assert.deepEqual(offloadRuns, ["llm-retry"], "offloader ran exactly once");
  __setCompleteSimpleForTest(null);
  resetEmergencySlots();
});

test("llm-call: 413 with NO shrink (offloaded=0) → no retry, error returned", async () => {
  resetEmergencySlots();
  let calls = 0;
  setContextEmergencyOffloadRunner(() => Promise.resolve({ offloaded: 0, charsSaved: 0 }));
  setContextEmergencyCtxProvider(() => ({}));
  __setCompleteSimpleForTest(async () => {
    calls++;
    return { errorMessage: "413 Request Entity Too Large" };
  });
  const result = await callLlm(FAKE_MODEL, "key", "sys", "user");
  assert.ok(result.error, "error returned when nothing shrank");
  assert.equal(calls, 1, "no wasted retry when nothing shrank");
  __setCompleteSimpleForTest(null);
  resetEmergencySlots();
});

test("llm-call: second 413 after the emergency retry is NOT retried again", async () => {
  resetEmergencySlots();
  let calls = 0;
  setContextEmergencyOffloadRunner(() => Promise.resolve({ offloaded: 1, charsSaved: 300_000 }));
  setContextEmergencyCtxProvider(() => ({}));
  __setCompleteSimpleForTest(async () => {
    calls++;
    return { errorMessage: "413 Request Entity Too Large" };
  });
  const result = await callLlm(FAKE_MODEL, "key", "sys", "user");
  assert.ok(result.error);
  assert.equal(calls, 2, "shrink + retry once, then honest failure (never a loop)");
  __setCompleteSimpleForTest(null);
  resetEmergencySlots();
});

test("llm-call: context_length_exceeded text also triggers the emergency path", async () => {
  resetEmergencySlots();
  let calls = 0;
  setContextEmergencyOffloadRunner(() => Promise.resolve({ offloaded: 1, charsSaved: 300_000 }));
  setContextEmergencyCtxProvider(() => ({}));
  __setCompleteSimpleForTest(async () => {
    calls++;
    if (calls === 1)
      return { errorMessage: "prompt is too long: 300000 tokens > 128000 maximum context" };
    return { content: [{ type: "text", text: "ok-after-shrink" }], stopReason: "stop" };
  });
  const result = await callLlm(FAKE_MODEL, "key", "sys", "user");
  assert.equal(result.text, "ok-after-shrink");
  assert.equal(calls, 2);
  __setCompleteSimpleForTest(null);
  resetEmergencySlots();
});

test("llm-call: non-context_window errors NEVER trigger the emergency offload", async () => {
  resetEmergencySlots();
  let triggered = false;
  setContextEmergencyOffloadRunner(() => {
    triggered = true;
    return Promise.resolve({ offloaded: 1, charsSaved: 1 });
  });
  setContextEmergencyCtxProvider(() => ({}));
  __setCompleteSimpleForTest(async () => {
    return { errorMessage: "402 insufficient balance" };
  });
  const result = await callLlm(FAKE_MODEL, "key", "sys", "user");
  assert.ok(result.error);
  assert.equal(triggered, false, "balance errors are not shrink conditions");
  __setCompleteSimpleForTest(null);
  resetEmergencySlots();
});

test("llm-call: runner/ctx-provider not published → lossy-safe (no retry, error out)", async () => {
  resetEmergencySlots();
  let calls = 0;
  __setCompleteSimpleForTest(async () => {
    calls++;
    return { errorMessage: "413 Request Entity Too Large" };
  });
  const result = await callLlm(FAKE_MODEL, "key", "sys", "user");
  assert.ok(result.error);
  assert.equal(calls, 1, "absent emergency machinery must not hang or crash the call");
  __setCompleteSimpleForTest(null);
  resetEmergencySlots();
});

// ── G. Registration: publishes the runner + registers the context handler ─────

test("registerContextEmergencyOffloader publishes the runner and stubs per request", async () => {
  resetEmergencySlots();
  const captured = [];
  const fakePi = { on: (type, fn) => captured.push({ type, fn }) };
  registerContextEmergencyOffloader(fakePi);
  const contextHandler = captured.find((h) => h.type === "context")?.fn;
  assert.ok(contextHandler, "context handler registered");

  // No emergency this session → handler returns undefined (zero behavior).
  const fakeCtx = { sessionManager: { getSessionFile: () => "g.jsonl" } };
  const untouched = [user("go"), toolResult("normal", { toolName: "bash" })];
  const snapshot = JSON.stringify(untouched);
  assert.equal(await contextHandler({ type: "context", messages: untouched }, fakeCtx), undefined);
  assert.equal(JSON.stringify(untouched), snapshot);

  // With recorded stubs → substitution applies; original untouched.
  const cmState = (
    await import("../../../dist/extensions/memory/context-manager/handlers/shared.js")
  ).getCmState(fakeCtx);
  cmState.emergencyStubsByToolCallId = {
    call_emergency: {
      stub: "[offloaded: bash result, 1 chars — flushed to disk: /tmp/x.txt]",
      chars: 1,
      iso: "iso",
      path: "/tmp/x.txt",
    },
  };
  const withBlob = [
    user("go"),
    {
      role: "toolResult",
      toolCallId: "call_emergency",
      toolName: "bash",
      content: [{ type: "text", text: "HUGE" }],
      isError: false,
    },
  ];
  const out = await contextHandler({ type: "context", messages: withBlob }, fakeCtx);
  assert.ok(out && out.messages, "handler returns the substituted messages");
  assert.ok(out.messages[1].content[0].text.startsWith("[offloaded:"));
  assert.equal(withBlob[1].content[0].text, "HUGE", "live session entry untouched");
  assert.ok(
    globalThis.__braid_context_emergency_offload_runner,
    "runner published into the process-global slot",
  );
  resetEmergencySlots();
});

await chain;
console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== emergency offloader tests passed ===");
