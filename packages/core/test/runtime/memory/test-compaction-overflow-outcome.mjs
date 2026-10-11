/**
 * Fixture tests (compaction outcome + trace fidelity):
 *
 *  (a) A SUCCESSFUL overflow-recovery compaction (session_compact with
 *      willRetry:true) runs the full outcome stage: verify, telemetry, and the
 *      always-on originals archive. Pre-fix the outcome handler returned early
 *      on willRetry, so the one compaction that rescued the session from
 *      overflow was never verified and its originals were never archived.
 *  (b) A failed cycle's durable trace carries fromExtension, the monotonic
 *      cycle id, and the cycle wall time (durationMs, previously populated only
 *      by the stall watchdog path).
 *  (c) keptMessages does not count message entries that a context_edit with
 *      replacement === null omitted from model context (overflow recovery
 *      appends exactly those omissions after the anchor).
 *
 * Run: node test/runtime/memory/test-compaction-overflow-outcome.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
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
const sharedMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/shared.js")
);
const traceMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction-trace.js")
);
const watchdogMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction-watchdog.js")
);
const { getLogBuffer, clearLogBuffer } = await import(join(ROOT, "dist/lib/core/logger.js"));

const {
  registerBeforeCompactHandler,
  registerSessionCompactOutcomeHandler,
  registerSessionCompactFailedHandler,
} = compactionMod;
const { getCompactionHealth, resetCompactionHealth, resetCompactionRetry, resetOverflowRetry, getCmState } =
  sharedMod;
const { clearCompactionWatchdog } = watchdogMod;
const { COMPACTION_TRACE_ENTRY_TYPE } = traceMod;
const logs = () => getLogBuffer().map((l) => l.message ?? String(l)).join("\n");

function makeFakePi() {
  const handlers = new Map();
  const entries = [];
  return {
    handlers,
    entries,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },
    setThinkingLevel() {},
    sendMessage() {},
    async _emit(event, ...args) {
      const name = typeof event === "string" ? event : event.type;
      for (const h of handlers.get(name) ?? []) {
        await Promise.resolve(h(event, ...args));
      }
    },
  };
}

let sessionSeq = 0;
/**
 * Branch of `branchLength` message entries sized so the session-tree measure
 * reports `percent`; `setLivePercent` rescales + syncs the usage accessor so a
 * test can drop usage between session_before_compact (pre capture) and
 * session_compact (post recompute).
 */
function makeFakeCtx({ percent = 50, branchLength = 12, sessionId } = {}) {
  sessionId ??= `sess-${++sessionSeq}`;
  const tmp = mkdtempSync(join(tmpdir(), "cm-overflow-outcome-"));
  const sessionFilePath = join(tmp, "session.jsonl");
  const branch = [];
  for (let i = 0; i < branchLength; i++) {
    branch.push({
      id: `e${i}`,
      type: "message",
      message: {
        role: i % 2 ? "assistant" : "user",
        content: [
          {
            type: "text",
            text: `msg ${i} ${"x".repeat(
              Math.max(0, Math.round(((percent / 100) * 200000 * 4) / branchLength) - 7),
            )}`,
          },
        ],
        timestamp: 1000 + i,
      },
    });
  }
  const usage = {
    percent,
    tokens: Math.round((percent / 100) * 200000),
    contextWindow: 200000,
  };
  const ctx = {
    cwd: tmp,
    mode: "test",
    hasUI: false,
    getContextUsage: () => usage,
    // The failure router defers a bounded retry via ctx.compact(); the watchdog
    // path may call ctx.abort(). Both are no-ops here - the test asserts the
    // trace and telemetry, not the retry dispatch.
    compact: () => {},
    abort: () => {},
    sessionManager: {
      session: { filePath: sessionFilePath },
      getSessionFile: () => sessionFilePath,
      getSessionId: () => sessionId,
      getLeafId: () => "leaf-1",
      getBranch: () => branch,
      getTree: () => branch.map((e) => ({ entry: { id: e.id, type: e.type } })),
      getChildren: () => [],
      getLabel: () => undefined,
    },
  };
  function setLivePercent(pct) {
    const per = Math.max(0, Math.round(((pct / 100) * 200000 * 4) / branchLength) - 7);
    for (const e of branch) {
      if (e.type !== "message") continue;
      const idx = Number(e.id.slice(1));
      e.message.content[0].text = `msg ${idx} ${"x".repeat(per)}`;
    }
    usage.percent = pct;
    usage.tokens = Math.round((pct / 100) * 200000);
  }
  return { ctx, branch, usage, tmp, sessionId, setLivePercent };
}

function makePrep(messages, firstKeptEntryId) {
  return {
    messagesToSummarize: messages,
    turnPrefixMessages: [],
    isSplitTurn: false,
    firstKeptEntryId,
  };
}

function readArchiveLine(tmp) {
  let files;
  try {
    files = readdirSync(join(tmp, "archives")).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const raw = readFileSync(join(tmp, "archives", files[0]), "utf8");
  return JSON.parse(raw.trim());
}

function findTraces(pi) {
  return pi.entries.filter((e) => e.customType === COMPACTION_TRACE_ENTRY_TYPE);
}

console.log("=== compaction outcome: overflow recovery, trace fidelity, kept count ===\n");

await test("(a) successful overflow-recovery compaction (willRetry:true) runs verify + telemetry + archive", async () => {
  resetCompactionHealth();
  clearLogBuffer();
  const { ctx, branch, setLivePercent, tmp } = makeFakeCtx({ percent: 50, branchLength: 12 });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactOutcomeHandler(pi);

  // Cycle starts at 50% (pre capture), the overflow shrinks the session to 20%.
  await pi._emit(
    {
      type: "session_before_compact",
      preparation: makePrep(
        branch.map((e) => e.message),
        "e5",
      ),
      reason: "overflow",
    },
    ctx,
  );
  setLivePercent(20);
  await pi._emit(
    {
      type: "session_compact",
      reason: "overflow",
      willRetry: true,
      compactionEntry: { id: "c1", summary: "recovered from overflow", firstKeptEntryId: "e5" },
    },
    ctx,
  );

  const health = getCompactionHealth();
  assert.equal(
    health.lastOutcome,
    "success",
    "overflow-recovery compaction must record its outcome (pre-fix: early return on willRetry)",
  );
  assert.equal(health.totalCompactions, 1, "the landed overflow compaction counts as a compaction");
  assert.equal(
    health.totalVerifyFailures,
    0,
    "a coherent, budget-recovering compaction must not be reported as a verify failure",
  );
  assert.equal(health.lastCompactedMessages, 12, "compacted side counts the raw summarization input");
  const line = readArchiveLine(tmp);
  assert.ok(line, "originals archive must be written for the overflow-recovery compaction");
  assert.equal(line.reason, "compact", "healthy path archives with reason=compact");
  assert.equal(line.compactedMessages, 12);
  assert.match(logs(), /Compaction completed successfully/);
  // The outcome handler does not own the watchdog/dispatch lifecycle; clear the
  // timers the cycle armed so the process can exit.
  clearCompactionWatchdog(ctx);
  resetCompactionRetry();
});

await test("(b) failed trace carries fromExtension, cycleId, and durationMs", async () => {
  resetCompactionHealth();
  clearLogBuffer();
  const { ctx } = makeFakeCtx({ percent: 50, branchLength: 12 });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);

  await pi._emit(
    {
      type: "session_before_compact",
      preparation: makePrep(
        ctx.sessionManager.getBranch().map((e) => e.message),
        "e5",
      ),
      reason: "threshold",
    },
    ctx,
  );
  assert.equal(getCmState(ctx).compactionCycleId, 1, "first cycle gets id 1");
  await sleep(30);
  await pi._emit(
    {
      type: "session_compact_failed",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      errorMessage: "Auto-compaction failed: Stream ended without finish_reason",
      fromExtension: true,
    },
    ctx,
  );

  const traces = findTraces(pi);
  assert.equal(traces.length, 1, "one durable trace for the failed cycle");
  const data = traces[0].data;
  assert.equal(data.fromExtension, true, "fromExtension must round-trip into the trace record");
  assert.equal(data.cycleId, 1, "trace must name the cycle it belongs to");
  assert.ok(
    typeof data.durationMs === "number" && data.durationMs >= 30,
    `durationMs must be measured from the watchdog arm, got ${data.durationMs}`,
  );
  const line = logs();
  assert.match(line, /from-extension/, "log line must name the extension-sourced failure");
  assert.match(line, /cycle=1/, "log line must carry the cycle id");

  // A second firing advances the counter: cycle id is per firing, not per leaf.
  await pi._emit(
    {
      type: "session_before_compact",
      preparation: makePrep(
        ctx.sessionManager.getBranch().map((e) => e.message),
        "e5",
      ),
      reason: "threshold",
    },
    ctx,
  );
  assert.equal(getCmState(ctx).compactionCycleId, 2, "next cycle gets id 2");
  clearCompactionWatchdog(ctx);
  resetCompactionRetry();
  resetOverflowRetry();
});

await test("(c) keptMessages excludes context_edit omissions after the anchor", async () => {
  resetCompactionHealth();
  clearLogBuffer();
  const { ctx, branch, setLivePercent, tmp } = makeFakeCtx({ percent: 50, branchLength: 12 });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactOutcomeHandler(pi);

  await pi._emit(
    {
      type: "session_before_compact",
      preparation: makePrep(
        branch.map((e) => e.message),
        "e5",
      ),
      reason: "overflow",
    },
    ctx,
  );
  // Overflow recovery omits the failed assistant attempt(s) from model context
  // via append-only context_edit entries; the entries stay in the branch.
  branch.push(
    { id: "x1", type: "context_edit", targetId: "e6", replacement: null },
    { id: "x2", type: "context_edit", targetId: "e7", replacement: null },
  );
  setLivePercent(20);
  await pi._emit(
    {
      type: "session_compact",
      reason: "overflow",
      willRetry: true,
      compactionEntry: { id: "c1", summary: "recovered", firstKeptEntryId: "e5" },
    },
    ctx,
  );

  // Messages e5..e11 = 7 live, minus the two omitted attempts = 5.
  assert.equal(
    getCompactionHealth().lastKeptMessages,
    5,
    "omitted messages must not be counted as kept",
  );
  const line = readArchiveLine(tmp);
  assert.ok(line, "archive must be written");
  assert.equal(line.keptMessages, 5, "archive line must carry the corrected kept count");
  clearCompactionWatchdog(ctx);
  resetCompactionRetry();
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
