/**
 * Fixture tests (compaction fail-safe):
 * the compaction path must always terminate in a landed compaction entry, and
 * no failure class may leave a session above pi-core's threshold unable to
 * compact. Coverage:
 *
 *  (a) A dispatched retry cycle's guard is released by that cycle's own
 *      outcome, and the attempt it spent survives the turn_end its own
 *      dispatch causes (pi-core's manual compact() aborts the in-flight turn
 *      first, so the abort's turn_end lands BEFORE the cycle's outcome).
 *      Fails pre-fix: the guard stayed armed for the session and the turn_end
 *      reset erased the attempt.
 *  (b) The ladder reaches its exhausted rung and re-opens afterwards instead of
 *      pinning the attempt counter at the ceiling for the rest of the session.
 *  (c) Consecutive cycles that land no entry while the session sits above the
 *      critical band arm a deterministic cut and dispatch one compaction; the
 *      next session_before_compact lands that cut with no summarizer call.
 *      Fails pre-fix: nothing was armed and the cycle fell through to the
 *      summarizer that had already failed.
 *  (d) Below the critical band nothing is armed: a retryable failure is not a
 *      reason to destroy context.
 *  (e) A landed compaction clears the counter and any armed cut; an operator
 *      slide keeps precedence over an armed cut instead of consuming it.
 *  (f) A real cycle records the usage the arm rule reads.
 *
 * Run: node test/runtime/memory/test-compaction-failsafe.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
const retryMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction-retry.js")
);
const watchdogMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction-watchdog.js")
);
const sharedMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/shared.js")
);

const { registerBeforeCompactHandler, registerSessionCompactHandler, registerSessionCompactFailedHandler } =
  compactionMod;
const { registerTurnEndRetryReset, triggerCompactionRetry } = retryMod;
const { clearCompactionWatchdog } = watchdogMod;
const { getCmState, compactionRetryState, resetCompactionRetry, resetCompactionHealth } =
  sharedMod;
const { getLogBuffer, clearLogBuffer } = await import(join(ROOT, "dist/lib/core/logger.js"));
const logs = () => getLogBuffer().map((l) => l.message ?? String(l)).join("\n");

/**
 * Fake pi whose emit returns the first handler result, the shape the
 * session_before_compact handler's extension-compaction answer travels in
 * (pi-core's runner takes the handler's returned object).
 */
function makeFakePi() {
  const handlers = new Map();
  const sendMessageCalls = [];
  return {
    handlers,
    sendMessageCalls,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(params, options) {
      sendMessageCalls.push({ params, options });
    },
    async _emit(event, ...args) {
      const name = typeof event === "string" ? event : event.type;
      let result;
      for (const h of handlers.get(name) ?? []) {
        const r = await h(event, ...args);
        if (result === undefined && r !== undefined) result = r;
      }
      return result;
    },
  };
}

let sessionSeq = 0;

/**
 * Fixture context. The branch holds non-message entries on purpose: the live
 * usage measure then degrades to ctx.getContextUsage(), so the percentage the
 * handlers route on is the one this fixture declares instead of a
 * character-count estimate. Tests that need a specific band for the fail-safe
 * arm set cmState.preCompactionUsagePercent directly (the value a real cycle
 * records - asserted by case (f)).
 */
function makeFakeCtx({ percent = 50, branchLength = 20 } = {}) {
  const sessionId = `sess-${++sessionSeq}`;
  const branch = [];
  for (let i = 0; i < branchLength; i++) {
    branch.push({ id: `e${i}`, type: "custom", customType: "fixture", data: { i } });
  }
  const traceEntries = [];
  const compactCalls = [];
  return {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    compactCalls,
    branch,
    traceEntries,
    model: { contextWindow: 200000 },
    ui: { notify() {}, setStatus() {} },
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
      appendCustomEntry: (customType, data) => {
        traceEntries.push({ customType, data });
      },
    },
    compact: (options) => {
      compactCalls.push({ options });
    },
  };
}

function makePrep(count = 7) {
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

function fireBeforeCompact(pi, ctx, { customInstructions, prepCount = 7 } = {}) {
  return pi._emit(
    {
      type: "session_before_compact",
      preparation: makePrep(prepCount),
      ...(customInstructions ? { customInstructions } : {}),
    },
    ctx,
  );
}

function fireFailedCycle(pi, ctx, { reason = "threshold", aborted = false, errorMessage } = {}) {
  return pi._emit(
    {
      type: "session_compact_failed",
      reason,
      aborted,
      willRetry: false,
      ...(errorMessage ? { errorMessage } : {}),
    },
    ctx,
  );
}

/** The cut arithmetic buildDeterministicCut uses (mirrors compaction.ts). */
function expectedCut(branch) {
  const keepCount = Math.min(50, Math.max(10, Math.floor(branch.length * 0.3)));
  const cutIndex = Math.max(0, branch.length - keepCount);
  return { keepCount, cutIndex, cutEntryId: branch[cutIndex].id };
}

console.log("=== compaction fail-safe ===\n");

await test("(a) a retry cycle releases its guard and keeps its attempt across turn_end", async () => {
  resetCompactionHealth();
  resetCompactionRetry();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 50 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);
  registerTurnEndRetryReset(pi);

  await fireBeforeCompact(pi, ctx);
  await fireFailedCycle(pi, ctx, {
    reason: "threshold",
    errorMessage: "Auto-compaction failed: Summarization failed: 500: server error",
  });
  assert.equal(compactionRetryState.attempt, 1, "the failed cycle arms attempt 1");

  // The armed retry dispatches after its delay: the dispatch is what sets the
  // cycle guard, mirroring triggerCompactionRetry's timer.
  await sleep(3300);
  assert.equal(ctx.compactCalls.length, 1, "the armed retry must dispatch a compaction");
  assert.equal(
    getCmState(ctx).compactionRetryActive,
    true,
    "the dispatched cycle holds the guard while it runs",
  );

  // The dispatch is pi-core's manual entry point, which aborts the in-flight
  // turn first: this turn_end lands before the cycle reports its outcome.
  await pi._emit({ type: "turn_end", message: { role: "assistant", stopReason: "aborted" } }, ctx);
  assert.equal(
    compactionRetryState.attempt,
    1,
    "turn_end must not erase the attempt a dispatched retry is spending",
  );

  // The retry's own outcome: the cycle ended, so the guard it held is spent.
  await fireFailedCycle(pi, ctx, {
    reason: "threshold",
    errorMessage: "Auto-compaction failed: Summarization failed: 500: server error",
  });
  assert.equal(
    getCmState(ctx).compactionRetryActive,
    false,
    "a failed cycle must release the guard so the next retry can dispatch",
  );
  assert.equal(compactionRetryState.attempt, 2, "the ladder advances past the retry cycle");

  // And the released guard lets the next attempt actually dispatch.
  triggerCompactionRetry(pi, ctx, compactionRetryState.attempt, "retry again");
  resetCompactionRetry(); // drop the 6s timer this armed; the dispatch is asserted next
  clearCompactionWatchdog(ctx);
});

await test("(b) the ladder exhausts its attempts and re-opens afterwards", async () => {
  resetCompactionHealth();
  resetCompactionRetry();
  clearLogBuffer();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 50 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);

  const max = sharedMod.COMPACTION_RETRY_MAX_ATTEMPTS;
  await fireBeforeCompact(pi, ctx);
  for (let i = 1; i <= max; i++) {
    await fireFailedCycle(pi, ctx, {
      reason: "threshold",
      errorMessage: "Auto-compaction failed: Summarization failed: 502: bad gateway",
    });
    assert.equal(compactionRetryState.attempt, i, `failure ${i} advances the ladder to ${i}`);
  }
  await fireFailedCycle(pi, ctx, {
    reason: "threshold",
    errorMessage: "Auto-compaction failed: Summarization failed: 502: bad gateway",
  });
  assert.match(
    logs(),
    /Retry ladder exhausted after 3 attempts/,
    "the exhausted rung must be reachable and must be visible to an operator",
  );
  assert.equal(
    compactionRetryState.attempt,
    0,
    "the exhausted ladder re-opens instead of pinning the counter at the ceiling",
  );
  resetCompactionRetry();
  clearCompactionWatchdog(ctx);
});

await test("(c) no-progress cycles above the critical band land a deterministic cut", async () => {
  resetCompactionHealth();
  resetCompactionRetry();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 50, branchLength: 20 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);

  for (let i = 1; i <= 3; i++) {
    await fireBeforeCompact(pi, ctx);
    // The band the cycle just recorded: a session over pi-core's threshold is
    // what makes a no-progress cycle a loop instead of an incident.
    getCmState(ctx).preCompactionUsagePercent = 86;
    await fireFailedCycle(pi, ctx, { reason: "threshold", aborted: true });
  }
  assert.equal(
    getCmState(ctx).compactionNoProgress,
    3,
    "every cycle that lands no entry counts as no progress",
  );
  assert.ok(
    getCmState(ctx).compactionFailsafeCut,
    "three no-progress cycles above the critical band arm the cut",
  );
  await sleep(10); // the fail-safe dispatch is deferred past the handler that armed it
  assert.equal(ctx.compactCalls.length, 1, "the armed cut dispatches one compaction");

  // The next ordinary cycle lands the armed cut with no summarizer call.
  const { cutIndex, cutEntryId } = expectedCut(ctx.branch);
  const result = await fireBeforeCompact(pi, ctx);
  assert.ok(result?.compaction, "the armed cut must land as an extension compaction");
  assert.equal(
    result.compaction.firstKeptEntryId,
    cutEntryId,
    `the cut anchor must be the computed cut point (index ${cutIndex})`,
  );
  assert.match(
    result.compaction.summary,
    /Deterministic cut/,
    "the landed cut must say it is a deterministic cut",
  );
  assert.match(
    result.compaction.summary,
    /fail-safe/i,
    "the landed cut must say why it was taken",
  );
  assert.equal(
    result.compaction.tokensBefore,
    0,
    "tokensBefore comes from the preparation, absent in this fixture",
  );
  assert.ok(
    getCmState(ctx).slideMode?.active,
    "the landed cut records the cut shape for the outcome stage",
  );
  assert.equal(
    getCmState(ctx).compactionFailsafeCut,
    undefined,
    "the armed cut is one-shot: its cycle consumed it",
  );
  clearCompactionWatchdog(ctx);
});

await test("(c2) the operator's own slide wins over an armed cut", async () => {
  resetCompactionHealth();
  resetCompactionRetry();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 50, branchLength: 20 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);

  for (let i = 1; i <= 3; i++) {
    await fireBeforeCompact(pi, ctx);
    getCmState(ctx).preCompactionUsagePercent = 86;
    await fireFailedCycle(pi, ctx, { reason: "threshold", aborted: true });
  }
  assert.ok(getCmState(ctx).compactionFailsafeCut, "the cut is armed before the slide");

  getCmState(ctx).slideMode = {
    active: true,
    cutEntryId: ctx.branch[15].id,
    keepCount: 5,
    droppedCount: 15,
    timestamp: Date.now(),
  };
  const slideResult = await fireBeforeCompact(pi, ctx, { customInstructions: "SLIDE_MODE" });
  assert.match(
    slideResult.compaction.summary,
    /Sliding window compaction/,
    "an operator slide must win over the armed cut",
  );
  assert.equal(
    slideResult.compaction.firstKeptEntryId,
    ctx.branch[15].id,
    "the slide's own cut point must be persisted",
  );
  assert.ok(
    getCmState(ctx).compactionFailsafeCut,
    "the operator's slide must not spend the cut - it is still armed if that slide does not land",
  );
  clearCompactionWatchdog(ctx);
});

await test("(g) an armed retry owns the next cycle: no second dispatch", async () => {
  resetCompactionHealth();
  resetCompactionRetry();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 50, branchLength: 20 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);

  await fireBeforeCompact(pi, ctx);
  for (let i = 1; i <= 3; i++) {
    getCmState(ctx).preCompactionUsagePercent = 86;
    await fireFailedCycle(pi, ctx, {
      reason: "threshold",
      errorMessage: "Auto-compaction failed: Summarization failed: generation hit the token cap",
    });
  }
  assert.ok(getCmState(ctx).compactionFailsafeCut, "the fail-safe cut is armed");
  assert.ok(
    compactionRetryState.retryTimeout,
    "the summary-cap routing armed its own retry cycle",
  );
  await sleep(10);
  assert.equal(
    ctx.compactCalls.length,
    0,
    "the fail-safe must not dispatch a cycle while an armed retry owns the next one",
  );
  assert.ok(getCmState(ctx).compactionFailsafeCut, "the cut stays armed for that cycle");
  resetCompactionRetry();
  clearCompactionWatchdog(ctx);
});

await test("(d) below the critical band nothing is armed", async () => {
  resetCompactionHealth();
  resetCompactionRetry();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 50 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);

  getCmState(ctx).preCompactionUsagePercent = 50;
  for (let i = 1; i <= 3; i++) {
    await fireBeforeCompact(pi, ctx);
    getCmState(ctx).preCompactionUsagePercent = 50;
    await fireFailedCycle(pi, ctx, { reason: "threshold", aborted: true });
  }
  assert.equal(getCmState(ctx).compactionNoProgress, 3, "the counter still climbs");
  assert.equal(
    getCmState(ctx).compactionFailsafeCut,
    undefined,
    "no cut is armed while the session is not under threshold pressure",
  );
  assert.equal(ctx.compactCalls.length, 0, "no compaction is dispatched");

  const result = await fireBeforeCompact(pi, ctx);
  assert.equal(result, undefined, "the cycle falls through to the summarizer, not to a cut");
  clearCompactionWatchdog(ctx);
});

await test("(e) a landed compaction clears the counter and any armed cut", async () => {
  resetCompactionHealth();
  resetCompactionRetry();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 50 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);

  getCmState(ctx).preCompactionUsagePercent = 86;
  await fireBeforeCompact(pi, ctx);
  getCmState(ctx).preCompactionUsagePercent = 86;
  await fireFailedCycle(pi, ctx, { reason: "threshold", aborted: true });
  getCmState(ctx).preCompactionUsagePercent = 86;
  await fireFailedCycle(pi, ctx, { reason: "threshold", aborted: true });
  assert.equal(getCmState(ctx).compactionNoProgress, 2, "two no-progress cycles counted");

  await pi._emit(
    { type: "session_compact", willRetry: false, compactionEntry: { id: "c1", summary: "ok" } },
    ctx,
  );
  assert.equal(
    getCmState(ctx).compactionNoProgress,
    0,
    "a landed compaction is progress: the counter is cleared",
  );
  assert.equal(getCmState(ctx).compactionFailsafeCut, undefined, "and no cut stays armed");
  clearCompactionWatchdog(ctx);
});

await test("(f) a real cycle records the usage the arm rule reads", async () => {
  resetCompactionHealth();
  resetCompactionRetry();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 50 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);

  assert.equal(
    getCmState(ctx).preCompactionUsagePercent,
    undefined,
    "no cycle has run yet, so the arm rule sees no usage",
  );
  await fireBeforeCompact(pi, ctx);
  assert.equal(
    typeof getCmState(ctx).preCompactionUsagePercent,
    "number",
    "the cycle's own usage capture is what the no-progress arm reads",
  );
  clearCompactionWatchdog(ctx);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
