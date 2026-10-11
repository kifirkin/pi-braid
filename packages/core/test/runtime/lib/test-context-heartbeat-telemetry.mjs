/**
 * context-heartbeat telemetry — real scalar fields, no placeholders,
 * sink failure survival .
 *
 * Drives the REAL lib/telemetry/context-heartbeat module (compiled) on a
 * stub ctx and asserts:
 * 1. collectAndEmitContextHeartbeat appends one JSONL line whose scalar
 * fields carry the STUBBED ctx values (contextTokens/contextWindow/
 * contextPercent) — no placeholder constants.
 * 2. The line is scalar-only: a poison field (nested object) is dropped
 * at the sink boundary; growth deltas + whisper counts are numbers.
 * 3. noteAssistantMessageEnd computes tokensPerSec from the assistant
 * message window (usage.output / duration) and feeds tpsEma.
 * 4. Sink append survives failure: an unwritable target (parent path is a
 * regular file) returns false and does NOT throw.
 * 5. Second tick produces a nonzero contextTokensDelta (growth tracking).
 *
 * Run: node test/runtime/lib/test-context-heartbeat-telemetry.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const D = join(ROOT, "dist");

// ── Hermetic settings isolation (re-baseline) ───────────────────────────
// The stub ctx reports a 1M-window model; the telemetry path resolves the
// effective window through the ONE resolver (lib/config/braid-settings.ts)
// whose reader hits <homedir()>/.pi/agent/settings.json — so the pinned
// contextPercent/contextWindow drifted when the live config migrated to 262k.
// Redirect HOME to a temp dir BEFORE the dist imports (os.homedir() reads $HOME
// on POSIX — same seam as test-context-limit-config.mjs; mock.method(os,
// "homedir") is not viable because braid-settings captures the named import and
// bakes SETTINGS_PATH at module-eval time) and write the EXPLICIT
// contextLimitTokens this scenario pins: 1_000_000 — the 1M-window model the
// fixture was written against (the scenario is about 1M windows). The suite now passes regardless of live settings.json.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w85b-heartbeat-telemetry-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(FAKE_HOME, ".pi", "agent", "settings.json"),
  JSON.stringify({ braid: { context: { contextLimitTokens: 1_000_000 } } }),
);

const { appendContextHeartbeatLine, collectAndEmitContextHeartbeat, noteAssistantMessageEnd } =
  await import("file://" + join(D, "lib/telemetry/context-heartbeat.js"));

console.log("=== context-heartbeat telemetry ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

/** Stub ctx: the shape the telemetry module actually reads. */
function makeCtx(overrides = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "hbtest-"));
  const sessionFile = join(tmp, "session.jsonl");
  writeFileSync(sessionFile, "x".repeat(12345), "utf-8");
  const ctx = {
    cwd: tmp,
    getContextUsage: () => ({ tokens: 100_000, contextWindow: 1_000_000, percent: 10 }),
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "test-session-hb",
      getEntries: () => [
        { type: "message", message: { role: "user", content: "hello world".repeat(10) } },
        {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "answer ".repeat(50) }] },
        },
        { type: "custom_message", customType: "watchdog-alert", content: "bark", display: true },
        { type: "custom", customType: "state", data: { a: 1 } },
      ],
    },
    model: { id: "test-model-v1" },
    ...overrides,
  };
  return { ctx, tmp, sessionFile };
}

await test("collectAndEmitContextHeartbeat emits real scalar fields (no placeholders)", async () => {
  const { ctx, tmp, sessionFile } = makeCtx();
  const sink = join(tmp, "hb.jsonl");
  try {
    const sample = collectAndEmitContextHeartbeat(ctx, {
      turnNumber: 7,
      healthMode: "healthy",
      source: "heartbeat",
      sinkFile: sink,
    });
    // Sample mirrors the stubbed ctx.
    assert.equal(sample.entry.contextTokens, 100_000, "context tokens from getContextUsage");
    assert.equal(sample.entry.contextWindow, 1_000_000);
    assert.equal(sample.entry.contextPercent, 10);
    assert.equal(sample.entry.sessionId, "test-session-hb");
    assert.equal(sample.entry.model, "test-model-v1");
    assert.equal(sample.entry.turnNumber, 7);
    assert.equal(sample.entry.healthMode, "healthy");
    assert.equal(
      sample.entry.sessionFileSizeBytes,
      statSync(sessionFile).size,
      "session file size is a real stat",
    );
    // Real process memory (RSS > 0, no placeholder).
    assert.ok(Number(sample.entry.rssBytes) > 1_000_000, "rssBytes is a live RSS value");
    assert.ok(Number(sample.entry.heapUsed) > 0, "heapUsed is live");
    // Whisper pressure from the entries walk: one custom_message (+ role-custom none).
    assert.equal(sample.entry.whisperCountTotal, 1);
    assert.ok(Number(sample.entry.whisperCharsDelta) >= 0, "whisper char delta is a number");
    // JSONL line written, one line, scalar-only.
    const lines = readFileSync(sink, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1, "exactly one JSONL line appended");
    const line = JSON.parse(lines[0]);
    assert.equal(line.source, "heartbeat");
    assert.equal(line.contextTokens, 100_000, "line carries real context tokens");
    assert.ok(line.rssBytes > 1_000_000, "line carries live RSS");
    assert.equal(line.sessionFileSizeBytes, statSync(sessionFile).size);
  } finally {
    rmDir(tmp);
  }
});

await test("sink is scalar-only: poison fields are dropped at the boundary", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "hbsink-"));
  const sink = join(tmp, "hb.jsonl");
  try {
    const ok = appendContextHeartbeatLine(
      {
        ts: 123,
        fine: "short string",
        poisoned: { sessionManager: "would-be-8MB-graph", modelRegistry: { apiKey: "REDACTED" } },
        array: [1, 2, 3],
        nan: Number.NaN,
        long: "y".repeat(500),
      },
      sink,
    );
    assert.ok(ok, "append succeeded");
    const line = JSON.parse(readFileSync(sink, "utf-8").trim());
    assert.ok(!("poisoned" in line), "object field dropped");
    assert.ok(!("array" in line), "array field dropped");
    assert.equal(line.fine, "short string");
    assert.equal(line.ts, 123);
    assert.equal(line.long, "y".repeat(128), "long strings truncated to the bound");
    assert.ok(
      !("apiKey" in line) && !readFileSync(sink, "utf-8").includes("REDACTED"),
      "no credential material in the line",
    );
  } finally {
    rmDir(tmp);
  }
});

await test("noteAssistantMessageEnd computes tokensPerSec; tpsEma follows", async () => {
  const { ctx, tmp } = makeCtx();
  const sink = join(tmp, "hb.jsonl");
  try {
    // usage.output 600 tokens over a ~1000ms window -> ~600 tok/s.
    noteAssistantMessageEnd(ctx, {
      role: "assistant",
      timestamp: Date.now() - 1000,
      usage: { input: 50_000, output: 600 },
    });
    const sample = collectAndEmitContextHeartbeat(ctx, { source: "heartbeat", sinkFile: sink });
    assert.ok(
      sample.tokensPerSec > 300 && sample.tokensPerSec < 900,
      `tps ~600, got ${sample.tokensPerSec}`,
    );
    assert.ok(sample.tpsEma !== null, "EMA seeded");
    assert.equal(sample.inputTokens, 50_000, "real input tokens sampled");
    assert.equal(sample.outputTokens, 600, "real output tokens sampled");
    const line = JSON.parse(readFileSync(sink, "utf-8").trim().split("\n").pop());
    assert.ok(line.tokensPerSec > 300 && line.tokensPerSec < 900, "line carries tokensPerSec");
    // Non-assistant messages are ignored.
    noteAssistantMessageEnd(ctx, {
      role: "custom",
      timestamp: Date.now() - 1000,
      usage: { input: 1, output: 9999 },
    });
    const s2 = collectAndEmitContextHeartbeat(ctx, { source: "heartbeat", sinkFile: sink });
    assert.equal(s2.outputTokens, 600, "custom-role message did not clobber the sample");
  } finally {
    rmDir(tmp);
  }
});

await test("sink failure is non-fatal: unwritable target returns false without throwing", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "hbfail-"));
  try {
    // Parent path is a regular FILE -> append must fail (ENOTDIR), not throw.
    const blocker = join(tmp, "blocker");
    writeFileSync(blocker, "not a dir", "utf-8");
    const sink = join(blocker, "hb.jsonl");
    let ok = true;
    assert.doesNotThrow(() => {
      ok = appendContextHeartbeatLine({ ts: 1, k: "v" }, sink);
    }, "sink failure must be non-fatal");
    assert.equal(ok, false, "append reported failure");
  } finally {
    rmDir(tmp);
  }
});

await test("growth deltas: second tick reports a nonzero contextTokensDelta", async () => {
  let tokens = 100_000;
  const { ctx, tmp } = makeCtx({
    getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: tokens / 10_000 }),
  });
  const sink = join(tmp, "hb.jsonl");
  try {
    collectAndEmitContextHeartbeat(ctx, { source: "heartbeat", sinkFile: sink });
    tokens = 112_500; // +12.5k growth (matches the measured 12-27k/turn)
    const s2 = collectAndEmitContextHeartbeat(ctx, { source: "heartbeat", sinkFile: sink });
    assert.equal(s2.entry.contextTokensDelta, 12_500, "growth delta since previous tick");
    assert.ok(Number(s2.entry.rssBytes) > 0);
  } finally {
    rmDir(tmp);
  }
});

function rmDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
