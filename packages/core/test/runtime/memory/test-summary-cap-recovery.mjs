/**
 * Fixture tests (summary token-cap failure class + bounded recovery):
 * a summarization call whose generation hit its output token cap
 * (stopReason "length" -> pi-core throws "Summarization failed: generation
 * hit the token cap and the summary is incomplete") must be classified as
 * its own failure class (not "unknown"), recovered deterministically with a
 * bounded chunked span (reasoning off), and range-archive spans must never
 * reach the summarizer as one giant call.
 *
 * Coverage:
 *  (a) A manual range-archive summary-cap failure classifies as "summary-cap"
 *      (the exact errorMessage of the range-archive incident). Fails pre-fix:
 *      the classifier fell through to "unknown".
 *  (b) The auto-compaction wording classifies too; a non-cap summarization
 *      failure must NOT classify as summary-cap.
 *  (c) The failed cycle arms a bounded recovery: the retry cycle's
 *      session_before_compact consumes the pending recovery, summarizes the
 *      span in bounded chunks with reasoning off (maxTokens 4096), and
 *      returns an extension compaction result carrying the prepared
 *      boundary. Fails pre-fix: manual summary-cap failures routed to the
 *      plain threshold retry with no span reduction.
 *  (d) An over-bound declared range span is chunked: every call bounded
 *      (chunk size, estimated input tokens, per-call maxTokens), the user
 *      anchor and the previous compaction summary are merged into the chain,
 *      and the final summary lands as an extension compaction result with
 *      the declared boundary. Fails pre-fix: the span went to pi-core's
 *      single unbounded summarization call.
 *  (e) A small declared range span is still summarized by braid's own
 *      bounded call with the anchor folded in (anchor effectiveness), not by
 *      pi-core's instructions path that never reads it back.
 *  (f) A cycle that will hand its span to pi-core's summarizer switches the
 *      session thinking level off for the call and restores it at the cycle
 *      outcome, keeping reasoning out of the summary budget.
 *
 * Run: node test/runtime/memory/test-summary-cap-recovery.mjs
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
const traceMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction-trace.js")
);
const sharedMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/shared.js")
);
const llmCallMod = await import(join(ROOT, "dist/lib/ai/llm-call.js"));
const chunkedMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction-chunked.js")
);
const { getLogBuffer, clearLogBuffer } = await import(join(ROOT, "dist/lib/core/logger.js"));

const { classifyCompactionFailure } = traceMod;
const {
  registerBeforeCompactHandler,
  registerSessionCompactHandler,
  registerSessionCompactOutcomeHandler,
  registerSessionCompactFailedHandler,
} = compactionMod;
const { resetCompactionRetry, resetOverflowRetry, compactionRetryState, getCmState } = sharedMod;
const { __setCompleteSimpleForTest } = llmCallMod;
const logs = () => getLogBuffer().map((l) => l.message ?? String(l)).join("\n");

// The exact failure text pi-core throws when a summarization generation is
// length-stopped (observed verbatim in the range-archive incident).
const MANUAL_SUMMARY_CAP_ERROR =
  "Compaction failed: Summarization failed: generation hit the token cap and the summary is incomplete";
const AUTO_SUMMARY_CAP_ERROR =
  "Auto-compaction failed: Summarization failed: generation hit the token cap and the summary is incomplete";

function makeFakePi() {
  const handlers = new Map();
  const sendMessageCalls = [];
  const thinkingCalls = [];
  let thinkingLevel = "xhigh";
  return {
    handlers,
    sendMessageCalls,
    thinkingCalls,
    get thinkingLevel() {
      return thinkingLevel;
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(params, options) {
      sendMessageCalls.push({ params, options });
    },
    getThinkingLevel() {
      return thinkingLevel;
    },
    setThinkingLevel(level) {
      thinkingCalls.push(level);
      thinkingLevel = level;
    },
    async _emit(event, ...args) {
      let last;
      for (const h of handlers.get(event.type) ?? []) {
        const r = await Promise.resolve(h(event, ...args)).catch((e) => {
          throw e;
        });
        if (r !== undefined) last = r;
      }
      return last;
    },
  };
}

let sessionSeq = 0;
function makeFakeCtx({ branchLength = 10, contextWindow = 196_000, percent = 50 } = {}) {
  const sessionId = `sumcap-${++sessionSeq}`;
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
  const traceEntries = [];
  const compactCalls = [];
  return {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    model: {
      id: "deepseek-v4-1-flash",
      provider: "agent-zero",
      contextWindow,
      maxTokens: 32768,
      reasoning: true,
    },
    getContextUsage: () => ({
      percent,
      tokens: Math.round((percent / 100) * contextWindow),
      contextWindow,
    }),
    compact: (options) => compactCalls.push(options ?? {}),
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
    traceEntries,
    compactCalls,
    branch,
  };
}

function makeMsg(i, text) {
  return {
    role: i % 2 ? "assistant" : "user",
    content: [{ type: "text", text: text ?? `msg ${i}` }],
    timestamp: 1000 + i,
  };
}

function makePrep(count, { firstKeptEntryId = "e-kept", tokensBefore = 12345 } = {}) {
  const messagesToSummarize = [];
  for (let i = 0; i < count; i++) messagesToSummarize.push(makeMsg(i));
  return { messagesToSummarize, turnPrefixMessages: [], isSplitTurn: false, firstKeptEntryId, tokensBefore };
}

async function fireBeforeCompact(pi, ctx, prep) {
  const evt = { type: "session_before_compact", preparation: prep };
  const result = await pi._emit(evt, ctx);
  return { result, evt };
}

/**
 * Stub completeSimple behind callLlm: records every call's options and user
 * prompt, returns a canned chunk summary per call. The canned text labels the
 * call index so chain merging is observable.
 */
function installChunkStub() {
  const calls = [];
  __setCompleteSimpleForTest(async (_model, context, options) => {
    const userText =
      typeof context.messages?.[0]?.content === "string" ? context.messages[0].content : "";
    calls.push({
      maxTokens: options.maxTokens,
      reasoning: options.reasoning,
      systemPrompt: context.systemPrompt ?? "",
      userText,
    });
    return {
      content: [{ type: "text", text: `CHUNK-SUMMARY-${calls.length}` }],
      stopReason: "end_turn",
      usage: { input: 100, output: 50, totalTokens: 150, cacheRead: 0, cacheWrite: 0 },
    };
  });
  return calls;
}

async function withChunkStub(fn) {
  const calls = installChunkStub();
  try {
    return await fn(calls);
  } finally {
    __setCompleteSimpleForTest(null);
  }
}

function resetRetryState() {
  resetCompactionRetry();
  resetOverflowRetry();
}

console.log("=== summary token-cap classification + bounded recovery ===\n");

await test("(a) a manual summary-cap failure classifies as summary-cap, not unknown", async () => {
  clearLogBuffer();
  const cls = classifyCompactionFailure({ errorMessage: MANUAL_SUMMARY_CAP_ERROR, reason: "manual" });
  assert.equal(cls, "summary-cap", `expected summary-cap, got ${cls}`);
});

await test("(b) the auto wording classifies too, and a non-cap summarization failure does not", async () => {
  clearLogBuffer();
  assert.equal(
    classifyCompactionFailure({ errorMessage: AUTO_SUMMARY_CAP_ERROR, reason: "threshold" }),
    "summary-cap",
    "the auto-compaction prefix must not hide the cap class",
  );
  assert.notEqual(
    classifyCompactionFailure({ errorMessage: "Compaction failed: Summarization attempted to call a tool" }),
    "summary-cap",
    "a non-cap summarization failure must keep its own class",
  );
});

await test("(c) a summary-cap failure arms a bounded chunked recovery on the retry cycle", async () => {
  clearLogBuffer();
  resetRetryState();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ branchLength: 20 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);

  // Prime the cycle state the way the failed cycle would have (dedup, watchdog,
  // originals capture).
  const prime = await fireBeforeCompact(pi, ctx, makePrep(10));
  assert.equal(prime.result, undefined, "the priming normal cycle must not produce a result");
  assert.ok(pi.thinkingCalls.includes("off"), "the priming cycle arms the thinking-off switch");

  await pi._emit(
    {
      type: "session_compact_failed",
      reason: "manual",
      aborted: false,
      willRetry: false,
      errorMessage: MANUAL_SUMMARY_CAP_ERROR,
    },
    ctx,
  );

  assert.equal(compactionRetryState.attempt, 1, "the summary-cap failure enters the retry ladder");
  assert.ok(
    pi.sendMessageCalls.some((c) => (c.params.content?.[0]?.text ?? "").includes("token cap")),
    `the retry warning must name the cap, got: ${JSON.stringify(pi.sendMessageCalls)}`,
  );
  assert.ok(getCmState(ctx).pendingSummaryCapRecovery, "recovery state must be armed");

  await sleep(3350); // compaction retry backoff for attempt 1 is 3s

  assert.equal(ctx.compactCalls.length, 1, "the retry must call ctx.compact()");

  await withChunkStub(async (calls) => {
    const prep = makePrep(10, { firstKeptEntryId: "e9", tokensBefore: 4321 });
    const { result } = await fireBeforeCompact(pi, ctx, prep);
    assert.ok(result?.compaction, `the recovery cycle must land an extension compaction result, got: ${JSON.stringify(result)}`);
    assert.equal(result.compaction.firstKeptEntryId, "e9", "the prepared boundary must be honored");
    assert.equal(result.compaction.tokensBefore, 4321);
    assert.match(result.compaction.summary, /CHUNK-SUMMARY-1/);
    assert.equal(calls.length, 1, "a 10-message span is one bounded chunk");
    assert.equal(calls[0].reasoning, "off", "the recovery call must run without reasoning");
    assert.equal(
      calls[0].maxTokens,
      chunkedMod.CHUNK_SUMMARY_MAX_TOKENS,
      "the recovery call must pin its own output budget",
    );
    assert.ok(
      getCmState(ctx).pendingSummaryCapRecovery === undefined,
      "recovery state must be consumed by the cycle",
    );
  });

  assert.equal(pi.thinkingLevel, "xhigh", "the recovery cycle (extension result) must not re-arm or leave the switch armed");
  assert.deepEqual(pi.thinkingCalls, ["off", "xhigh"], "only the priming cycle armed the switch; the failed path restored it");
  const logsText = logs();
  assert.match(
    logsText,
    /summary-cap/,
    "the failed cycle's trace line must name the summary-cap class",
  );
  resetRetryState();
});

await test("(d) an over-bound declared range span is summarized in bounded chunks with the anchor merged", async () => {
  clearLogBuffer();
  resetRetryState();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ branchLength: 220, contextWindow: 196_000 });
  // Previous compaction summary that must survive the archive (supersession).
  ctx.branch[0] = { id: "c0", type: "compaction", summary: "PREV-SUMMARY-CONTENT", timestamp: 0 };
  registerBeforeCompactHandler(pi);

  const rangeMode = {
    active: true,
    startIndex: 0,
    endIndex: 215,
    summary: "ANCHOR-TEXT-SUBSTANCE",
    topic: "w260 fixture",
    firstKeptEntryId: "e216",
    boundaryIsBranchEnd: false,
    timestamp: Date.now(),
  };
  getCmState(ctx).rangeMode = rangeMode;

  await withChunkStub(async (calls) => {
    const prep = makePrep(4, { firstKeptEntryId: "e-kept" });
    const { result } = await fireBeforeCompact(pi, ctx, prep);
    assert.ok(result?.compaction, `the range cycle must land an extension compaction result, got: ${JSON.stringify(result)}`);
    assert.equal(result.compaction.firstKeptEntryId, "e216", "the declared boundary must be honored");
    assert.match(result.compaction.summary, /CHUNK-SUMMARY/);
    const planned = chunkedMod.planChunks(ctx.branch.filter((e) => e.type === "message").map((e) => e.message), 196_000);
    assert.ok(planned && planned.length >= 2, `planChunks must chunk the over-bound span, got ${JSON.stringify(planned?.length)}`);
    assert.equal(calls.length, planned.length, "every planned chunk must produce exactly one call");
    assert.ok(calls.length <= 16, `chunk count must stay bounded, got ${calls.length}`);
    for (const call of calls) {
      assert.equal(call.reasoning, "off", "every chunk call runs without reasoning");
      assert.equal(
        call.maxTokens,
        chunkedMod.CHUNK_SUMMARY_MAX_TOKENS,
        "every chunk call pins its output budget",
      );
      assert.ok(call.userText.includes("ANCHOR-TEXT-SUBSTANCE"), "the anchor must steer every chunk");
    }
    assert.ok(calls[0].userText.includes("PREV-SUMMARY-CONTENT"), "the chain must merge the previous compaction summary");
    assert.ok(
      calls[calls.length - 1].userText.includes("CHUNK-SUMMARY-") || calls.length === 1,
      "later chunks must receive the running summary (summary-of-summary)",
    );
    assert.ok(
      getCmState(ctx).rangeMode === null && getCmState(ctx).pendingRangeArchive === undefined,
      "range mode and its retry stash must be consumed",
    );
  });
  resetRetryState();
});

await test("(e) a small declared range span is summarized by braid's bounded call with the anchor folded in", async () => {
  clearLogBuffer();
  resetRetryState();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ branchLength: 12, contextWindow: 196_000 });
  registerBeforeCompactHandler(pi);

  getCmState(ctx).rangeMode = {
    active: true,
    startIndex: 0,
    endIndex: 11,
    summary: "ANCHOR-SMALL-SPAN",
    topic: "w260 fixture small",
    firstKeptEntryId: "e-kept",
    boundaryIsBranchEnd: false,
    timestamp: Date.now(),
  };

  await withChunkStub(async (calls) => {
    const prep = makePrep(4, { firstKeptEntryId: "e-kept" });
    const { result } = await fireBeforeCompact(pi, ctx, prep);
    assert.ok(result?.compaction, `a small range span must still land an extension result, got: ${JSON.stringify(result)}`);
    assert.equal(result.compaction.firstKeptEntryId, "e-kept");
    assert.equal(calls.length, 1, "one bounded call");
    assert.ok(calls[0].userText.includes("ANCHOR-SMALL-SPAN"), "the anchor must reach the summarizer");
    assert.equal(calls[0].reasoning, "off");
  });
  resetRetryState();
});

await test("(f) a pi-core-summarized cycle switches thinking off for the call and restores it at the outcome", async () => {
  clearLogBuffer();
  resetRetryState();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ branchLength: 10 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactHandler(pi);
  registerSessionCompactOutcomeHandler(pi);
  registerSessionCompactFailedHandler(pi);

  const { result } = await fireBeforeCompact(pi, ctx, makePrep(10));
  assert.equal(result, undefined, "the normal path leaves summarization to pi-core");
  assert.ok(pi.thinkingCalls.includes("off"), "the cycle must switch the summarizer to reasoning off");

  await pi._emit({ type: "session_compact", compactionEntry: { id: "ce1" }, reason: "manual" }, ctx);
  assert.equal(pi.thinkingLevel, "xhigh", "the level must be restored at the outcome");

  // A failed cycle restores too (belt and braces on both outcome events).
  // Fresh input: an identical span to the cycle that just landed is
  // fingerprint-skipped (correct production behavior), which would never arm
  // the switch for a second cycle.
  await fireBeforeCompact(pi, ctx, makePrep(12, { firstKeptEntryId: "e-kept-2" }));
  assert.equal(pi.thinkingLevel, "off", "armed again for the next pi-core call");
  await pi._emit(
    { type: "session_compact_failed", reason: "threshold", aborted: false, willRetry: false, errorMessage: "boom" },
    ctx,
  );
  assert.equal(pi.thinkingLevel, "xhigh", "the failed path must restore the level");
  resetRetryState();
});

console.log(`\n${passed} passed, ${failed} failed`);
// Explicit exit: the retry machinery's scheduled timers would otherwise keep
// the event loop alive after a fully passing run.
process.exit(failed === 0 ? 0 : 1);
