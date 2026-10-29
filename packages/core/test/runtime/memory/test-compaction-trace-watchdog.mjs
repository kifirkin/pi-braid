/**
 * Fixture tests (compaction visibility):
 * failed/aborted/cancelled/empty-summary compactions leave a durable trace,
 * and an in-flight compaction that never completes is detected by the stall
 * watchdog and aborted via ctx.abort().
 *
 * Coverage:
 *  (a) A failing compaction appends a `context_compaction_failure` entry
 *      naming the failure class, span size, and retry count, and logs a line
 *      with the same triad. Fails pre-fix: nothing was written.
 *  (b) A user abort is traced as event "aborted" (class aborted), counted in
 *      telemetry as abort (not failure).
 *  (c) A stalled cycle (no completion past the threshold) fires the watchdog:
 *      log line + trace + cancelSource=watchdog + ctx.abort(); the subsequent
 *      aborted failed event is recorded as a failure and re-issued through
 *      the bounded threshold retry.
 *  (d) A slow but progressing cycle is never fired upon: progress pushes the
 *      deadline; completion clears the watchdog; no abort, no trace.
 *  (e) A verify-failed compaction traces event "verify-failed" with the
 *      coherence class.
 *  (f) Session shutdown clears an armed watchdog.
 *  (g) The trace entry survives in a REAL pi-core session file (durability).
 *
 * Run: node test/runtime/memory/test-compaction-trace-watchdog.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(`  [x] ${name}: ${e.message}`);
      failed++;
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const compactionMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction.js")
);
const watchdogMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction-watchdog.js")
);
const traceMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction-trace.js")
);
const sharedMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/shared.js")
);
const { getLogBuffer, clearLogBuffer } = await import(join(ROOT, "dist/lib/core/logger.js"));

const { COMPACTION_TRACE_ENTRY_TYPE, writeCompactionTrace } = traceMod;
const { armCompactionWatchdog, clearCompactionWatchdog, notifyCompactionProgress } = watchdogMod;
const { registerBeforeCompactHandler, registerSessionCompactHandler, registerSessionCompactOutcomeHandler, registerSessionCompactFailedHandler } = compactionMod;
const { getCompactionHealth, resetCompactionHealth, resetCompactionRetry, getCmState, compactionRetryState } = sharedMod;
const logs = () => getLogBuffer().map((l) => l.message ?? String(l)).join("\n");
const piCore = await import(
  join(ROOT, "../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js")
).catch(() => null);

function makeFakePi() {
  const handlers = new Map();
  const sendMessageCalls = [];
  const entries = [];
  return {
    handlers,
    sendMessageCalls,
    entries,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    // The documented durable-entry seam; the trace must land through it.
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },
    sendMessage(params, options) {
      sendMessageCalls.push({ params, options });
    },
    async _emit(event, ...args) {
      const name = typeof event === "string" ? event : event.type;
      for (const h of handlers.get(name) ?? []) {
        await Promise.resolve(h(event, ...args)).catch((e) => {
          throw e;
        });
      }
    },
  };
}

let sessionSeq = 0;
function makeFakeCtx({ percent = 50, branchLength = 10 } = {}) {
  const sessionId = `sess-${++sessionSeq}`;
  const branch = [];
  for (let i = 0; i < branchLength; i++) {
    branch.push({
      id: `e${i}`,
      type: "message",
      message: {
        role: i % 2 ? "assistant" : "user",
        content: [{ type: "text", text: `msg ${i}` }],
        timestamp: 1000 + i,
      },
    });
  }
  return {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    getContextUsage: () => ({
      percent,
      tokens: Math.round((percent / 100) * 200000),
      contextWindow: 200000,
    }),
    sessionManager: {
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
      getSessionId: () => sessionId,
      getLeafId: () => "leaf-1",
      getBranch: () => branch,
      getTree: () => branch.map((e) => ({ entry: { id: e.id, type: e.type } })),
      getChildren: () => [],
      getLabel: () => undefined,
    },
  };
}

function makePrep(count) {
  const messagesToSummarize = [];
  for (let i = 0; i < count; i++) {
    messagesToSummarize.push({
      role: i % 2 ? "assistant" : "user",
      content: [{ type: "text", text: `msg ${i}` }],
      timestamp: 1000 + i,
    });
  }
  return { messagesToSummarize, turnPrefixMessages: [], isSplitTurn: false };
}

async function fireBeforeCompact(pi, ctx, prepCount = 7) {
  const evt = { type: "session_before_compact", preparation: makePrep(prepCount) };
  await pi._emit(evt, ctx);
  return evt.customInstructions !== undefined;
}

function findTraces(pi) {
  return pi.entries.filter((e) => e.customType === COMPACTION_TRACE_ENTRY_TYPE);
}

console.log("=== compaction failure trace + stall watchdog ===\n");

await test("(a) a failing compaction writes a trace entry with class/span/retry", async () => {
  resetCompactionHealth();
  clearLogBuffer();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 50, branchLength: 10, prepCount: 7 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);

  await fireBeforeCompact(pi, ctx);
  await pi._emit(
    {
      type: "session_compact_failed",
      reason: "threshold",
      aborted: false,
      willRetry: true,
      errorMessage: "Auto-compaction failed: Stream ended without finish_reason",
    },
    ctx,
  );

  const traces = findTraces(pi);
  assert.equal(traces.length, 1, `exactly one trace entry, got ${traces.length}`);
  const data = traces[0].data;
  assert.equal(data.event, "failure");
  assert.equal(data.failureClass, "transient", "stream-ended error classifies as transient");
  assert.equal(data.spanMessages, 7, "span must count the raw summarization input");
  assert.equal(data.retryAttempt, 0, "first attempt of the sequence");
  assert.equal(data.willRetry, true);
  assert.match(data.errorMessage, /Stream ended without finish_reason/);
  const logsText = logs();
  assert.match(
    logsText,
    /Compaction FAILURE: class=transient span=7 msgs retry=0 will-retry/,
    `log line must carry the triad, got:\n${logsText}`,
  );
  clearCompactionWatchdog(ctx);
});

await test("(b) a user abort traces event aborted and counts as abort telemetry", async () => {
  resetCompactionHealth();
  clearLogBuffer();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 50, branchLength: 10, prepCount: 7 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);

  await fireBeforeCompact(pi, ctx);
  await pi._emit(
    { type: "session_compact_failed", reason: "threshold", aborted: true, willRetry: false },
    ctx,
  );

  const traces = findTraces(pi);
  assert.equal(traces.length, 1, "abort must be traced too");
  const data = traces[0].data;
  assert.equal(data.event, "aborted");
  assert.equal(data.failureClass, "aborted");
  assert.equal(data.spanMessages, 7);
  const health = getCompactionHealth();
  assert.equal(health.totalAborted, 1, "abort counts in totalAborted");
  assert.equal(health.totalFailures, 0, "aborts must NOT count as failures");
  clearCompactionWatchdog(ctx);
});

await test("(c) a stalled cycle is aborted by the watchdog and re-issued", async () => {
  resetCompactionHealth();
  resetCompactionRetry();
  clearLogBuffer();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 50, branchLength: 10, prepCount: 7 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);

  await fireBeforeCompact(pi, ctx);
  // Re-arm with a small test threshold over the production default.
  armCompactionWatchdog(pi, ctx, { thresholdMs: 60, reason: "threshold" });
  await sleep(250);

  const traces = findTraces(pi);
  assert.equal(traces.length, 1, `watchdog must trace the stall, got ${traces.length}`);
  assert.equal(traces[0].data.event, "stall");
  assert.equal(traces[0].data.failureClass, "stall");
  assert.equal(traces[0].data.cancelSource, "watchdog");
  const logsText = logs();
  assert.match(logsText, /Compaction STALLED/, `fire must log a loud line, got:\n${logsText}`);
  assert.equal(getCmState(ctx).cancelSource, "watchdog", "cancel source must be tagged");

  // pi-core now emits the aborted failed event; the watchdog cancel must be
  // recorded as a FAILURE and re-issued through the threshold retry ladder.
  await pi._emit(
    { type: "session_compact_failed", reason: "threshold", aborted: true, willRetry: false },
    ctx,
  );
  await sleep(80); // handleThresholdFailure is unawaited; let routing settle
  const health = getCompactionHealth();
  assert.equal(health.totalFailures, 1, "watchdog cancel records as failure");
  assert.equal(health.totalAborted, 0, "watchdog cancel is NOT an operator abort");
  assert.equal(
    compactionRetryState.attempt,
    1,
    "watchdog cancel must re-issue a bounded threshold retry",
  );
  assert.ok(
    pi.sendMessageCalls.some((c) => (c.params.content?.[0]?.text ?? "").includes("Auto-retrying")),
    `retry message must be sent, got: ${JSON.stringify(pi.sendMessageCalls)}`,
  );
  resetCompactionRetry();
});

await test("(d) a slow but progressing compaction is never fired upon", async () => {
  resetCompactionHealth();
  clearLogBuffer();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 50, branchLength: 10, prepCount: 7 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactHandler(pi);

  await fireBeforeCompact(pi, ctx);
  armCompactionWatchdog(pi, ctx, { thresholdMs: 80, reason: "threshold" });
  for (let i = 0; i < 8; i++) {
    await sleep(25);
    notifyCompactionProgress(ctx);
  }
  assert.equal(findTraces(pi).length, 0, "no stall trace while progressing");

  // Cycle completes: parking stage clears the watchdog.
  await pi._emit(
    { type: "session_compact", willRetry: false, compactionEntry: { id: "c1", summary: "ok" } },
    ctx,
  );
  await sleep(200); // > threshold: a stale timer would have fired here
  assert.equal(findTraces(pi).length, 0, "completion must clear the watchdog");
  clearCompactionWatchdog(ctx);
});

await test("(e) a verify-failed compaction traces event verify-failed", async () => {
  resetCompactionHealth();
  clearLogBuffer();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 85, branchLength: 100, prepCount: 100 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactHandler(pi);
  registerSessionCompactOutcomeHandler(pi);

  await fireBeforeCompact(pi, ctx, 100);
  // Empty summary arrives -> coherence verify rejects it.
  await pi._emit(
    {
      type: "session_compact",
      willRetry: false,
      compactionEntry: { id: "c2", summary: "", firstKeptEntryId: "e50" },
    },
    ctx,
  );

  const traces = findTraces(pi);
  assert.equal(traces.length, 1, `verify failure must trace, got ${traces.length}`);
  const data = traces[0].data;
  assert.equal(data.event, "verify-failed");
  assert.equal(data.failureClass, "verify-coherence");
  assert.equal(data.spanMessages, 100);
  const logsText = logs();
  assert.match(logsText, /Compaction VERIFY-FAILED/);
  clearCompactionWatchdog(ctx);
});

await test("(f) session shutdown clears an armed watchdog", async () => {
  clearLogBuffer();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 50, branchLength: 10, prepCount: 7 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);

  await fireBeforeCompact(pi, ctx);
  armCompactionWatchdog(pi, ctx, { thresholdMs: 60, reason: "threshold" });
  await pi._emit({ type: "session_shutdown" }, ctx);
  await sleep(200);
  assert.equal(findTraces(pi).length, 0, "shutdown must clear the watchdog");
  clearCompactionWatchdog(ctx);
});

await test("(g) the trace entry survives in a real session file", async () => {
  if (!piCore) return; // skip when pi-core dist is unavailable
  const dir = mkdtempSync(join(tmpdir(), "watchdog-trace-"));
  const sm = piCore.SessionManager.create(dir, join(dir, "sessions"));
  // pi-core 0.85.1 buffers the session file until the first assistant message
  // lands (session-manager.js _persist "flushed" gate) - seed one so the
  // subsequent custom entry is written through to disk.
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "seed" }] });
  const ctxLike = { sessionManager: sm, cwd: dir, mode: "test", hasUI: false };
  // The API seam doubles as the session-manager write it wraps; this case
  // proves the entry reaches disk, the seam itself is pinned separately.
  const appender = {
    appendEntry(customType, data) {
      sm.appendCustomEntry(customType, data);
    },
  };
  writeCompactionTrace(appender, ctxLike, {
    event: "failure",
    reason: "threshold",
    failureClass: "transient",
    errorMessage: "boom",
    spanMessages: 42,
    retryAttempt: 2,
    willRetry: true,
  });
  const file = sm.getSessionFile();
  assert.ok(file, "session file must exist");
  const raw = readFileSync(file, "utf8");
  assert.match(raw, /"customType":"context_compaction_failure"/);
  assert.match(raw, /"failureClass":"transient"/);
  assert.match(raw, /"spanMessages":42/);
  assert.match(raw, /"retryAttempt":2/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
