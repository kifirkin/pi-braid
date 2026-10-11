/**
 * Fixture tests (split-on-cap inside the bounded chunked summarizer + no
 * fall-through for the summary-cap class):
 *
 * A chunk whose generation is length-stopped (stopReason "length" — the
 * generation hit its own output budget) must NOT abort the whole chain and
 * must NOT escalate the span to pi-core's unbounded single-call
 * summarization. The live failure (Sep 25, 2026 06:51 local, span=750 msgs, chunk
 * 1/13 capped twice, fall-through, retry ladder, owner ESC) is the case.
 *
 * Coverage:
 *  (a) A 750-message range span with a length-stub (cap for chunks > 30
 *      units) completes through split-and-retry: the capped 60-unit chunks
 *      split into 30+30 unit-halves, the chain lands a non-empty summary with
 *      the anchor folded into every call, and the pi-core default summarizer
 *      is never handed the span. Fails pre-fix: the first capped chunk
 *      returns an error, the caller logs the fall-through, and pi-core's
 *      default summarizer is invoked with the full 750-message span.
 *  (b) A cancelled split aborts the chain honestly: the external signal
 *      fired mid-split stops the chain (no half calls beyond the abort,
 *      no synthetic summary). The split is observable in the log pre-abort.
 *      Fails pre-fix: no split ever starts.
 *  (c) The range branch, on a summary-cap bounded failure, does NOT fall
 *      through: the cycle is cancelled (pi-core's unbounded summarizer never
 *      runs) and the failed routing re-arms the bounded recovery with the
 *      range stash. Fails pre-fix: the handler falls through (thinking-off
 *      armed for pi-core's call, no cancel).
 *  (d) The split call budget is a hard bound: a pathological all-length
 *      stub drains exactly the budget and returns the honest summary-cap
 *      failure class. Fails pre-fix: the first cap aborts with no budget
 *      semantics.
 *
 * The "pi-core default summarizer" is modeled, not run: in this fixture
 * harness pi-core itself is absent, so an invocation is the handler
 * returning without a compaction result or cancel (the contract that makes
 * pi-core run its default summarizer over the full prepared span). Asserted
 * via fallthroughInvocations below.
 *
 * Stub contract: completeSimple is stubbed behind callLlm's test seam
 * (conventions of test-summary-cap-recovery.mjs); every span message is a
 * plain one-line text message, so units are single messages and the
 * serialized line count in <conversation-part> equals the unit count.
 *
 * Run: node test/runtime/memory/test-chunked-split-on-cap.mjs
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

const chunkedMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction-chunked.js")
);
const compactionMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction.js")
);
const sharedMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/shared.js")
);
const llmCallMod = await import(join(ROOT, "dist/lib/ai/llm-call.js"));
const { getLogBuffer, clearLogBuffer } = await import(join(ROOT, "dist/lib/core/logger.js"));

const { summarizeSpanInChunks, __setChunkedSummaryFailureForTest, CHUNK_SUMMARY_MAX_TOKENS } =
  chunkedMod;
const { registerBeforeCompactHandler, registerSessionCompactFailedHandler } = compactionMod;
const { resetCompactionRetry, resetOverflowRetry, compactionRetryState, getCmState } = sharedMod;
const { __setCompleteSimpleForTest } = llmCallMod;
const logs = () => getLogBuffer().map((l) => l.message ?? String(l)).join("\n");

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
function makeFakeCtx({ branchLength = 10, contextWindow = 196_000 } = {}) {
  const sessionId = `splitcap-${++sessionSeq}`;
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
      percent: 50,
      tokens: Math.round(0.5 * contextWindow),
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
      appendCustomEntry: () => "e-stub",
    },
    compactCalls,
    branch,
  };
}

function makeMsg(i) {
  return {
    role: i % 2 ? "assistant" : "user",
    content: [{ type: "text", text: `msg ${i}` }],
    timestamp: 1000 + i,
  };
}

function makePrep(count, { firstKeptEntryId = "e-kept", tokensBefore = 12345 } = {}) {
  const messagesToSummarize = [];
  for (let i = 0; i < count; i++) messagesToSummarize.push(makeMsg(i));
  return {
    messagesToSummarize,
    turnPrefixMessages: [],
    isSplitTurn: false,
    firstKeptEntryId,
    tokensBefore,
  };
}

async function fireBeforeCompact(pi, ctx, prep) {
  const evt = { type: "session_before_compact", preparation: prep };
  const result = await pi._emit(evt, ctx);
  return { result, evt };
}

/**
 * Count units in a serialized conversation part: one plain message per unit
 * in this fixture, so the "role: text" line count is the unit count.
 */
function countUnits(userText) {
  const part = userText.split("<conversation-part>")[1] ?? "";
  return (part.match(/^(user|assistant): /gm) ?? []).length;
}

/**
 * Length-stub: any call whose chunk carries more than capUnits units is
 * length-stopped; chunks at or under capUnits succeed. Optional onCall hook
 * for mid-call aborts.
 */
function installLengthStub({ capUnits, onCall } = {}) {
  const calls = [];
  __setCompleteSimpleForTest(async (_model, context, options) => {
    const userText =
      typeof context.messages?.[0]?.content === "string" ? context.messages[0].content : "";
    calls.push({
      maxTokens: options.maxTokens,
      reasoning: options.reasoning,
      userText,
    });
    if (onCall) onCall(calls.length, calls[calls.length - 1]);
    if (capUnits !== undefined && countUnits(userText) > capUnits) {
      // Non-empty partial text: the live cap failure is a length stop with a
      // truncated summary, not an empty body (the empty-text branch is a
      // different failure class).
      return {
        content: [{ type: "text", text: `PARTIAL-${calls.length}` }],
        stopReason: "length",
        usage: { input: 100, output: options.maxTokens, totalTokens: 100 + options.maxTokens },
      };
    }
    return {
      content: [{ type: "text", text: `CHUNK-SUMMARY-${calls.length}` }],
      stopReason: "end_turn",
      usage: { input: 100, output: 50, totalTokens: 150 },
    };
  });
  return calls;
}

async function withStub(Stub, fn) {
  const calls = installLengthStub(Stub);
  try {
    return await fn(calls);
  } finally {
    __setCompleteSimpleForTest(null);
  }
}

// Modeled pi-core default summarizer: invoked whenever a before_compact
// handler returns neither a compaction result nor a cancel (that is the
// contract under which pi-core runs its own single-call summarizer over the
// full prepared span).
function emulatePiCoreDefault(result, spanLength) {
  if (result && (result.cancel || result.compaction)) return result;
  piCoreDefaultCalls.push(spanLength);
  return undefined;
}
let piCoreDefaultCalls = [];

function resetRetryState() {
  resetCompactionRetry();
  resetOverflowRetry();
}

console.log("=== chunked split-on-cap + summary-cap fall-through removal ===\n");

await test("(a) a capped chunk splits and retries; the span never reaches pi-core's default summarizer", async () => {
  clearLogBuffer();
  resetRetryState();
  piCoreDefaultCalls = [];
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ branchLength: 752 });
  registerBeforeCompactHandler(pi);
  getCmState(ctx).rangeMode = {
    active: true,
    startIndex: 0,
    endIndex: 751,
    summary: "ANCHOR-SPLIT-ON-CAP",
    topic: "w282 fixture",
    firstKeptEntryId: "e752",
    boundaryIsBranchEnd: false,
    timestamp: Date.now(),
  };
  const spanLength = 750;

  await withStub({ capUnits: 30 }, async (calls) => {
    const { result } = await fireBeforeCompact(pi, ctx, makePrep(2, { firstKeptEntryId: "e-kept" }));
    emulatePiCoreDefault(result, spanLength);

    // GREEN: the chain lands; the capped chunks split into halves and retry.
    assert.ok(result?.compaction, `the split chain must land an extension compaction result, got: ${JSON.stringify(result)}`);
    assert.ok(
      (result.compaction.summary ?? "").trim().length > 0,
      "the summary must be non-empty",
    );
    assert.equal(result.compaction.firstKeptEntryId, "e752", "the declared boundary must be honored");

    // 13 chunks of 60 units; each caps once (60 > 30) and splits into 30+30
    // halves that succeed: 13 capped calls + 26 successful halves.
    const cappedCalls = 13;
    assert.equal(calls.length, cappedCalls * 3, `expected 13 capped + 26 half calls, got ${calls.length}`);
    assert.ok(
      calls.length <= chunkedMod.CHUNK_SPLIT_CALL_BUDGET,
      `total calls must stay inside the stated budget (${chunkedMod.CHUNK_SPLIT_CALL_BUDGET}), got ${calls.length}`,
    );
    for (const call of calls) {
      assert.equal(call.reasoning, "off", "every chunk call runs without reasoning");
      assert.equal(call.maxTokens, CHUNK_SUMMARY_MAX_TOKENS, "every chunk call pins the documented output budget");
      assert.ok(call.userText.includes("ANCHOR-SPLIT-ON-CAP"), "the anchor must steer every chunk");
    }
    assert.ok(
      calls[calls.length - 1].userText.includes("CHUNK-SUMMARY-"),
      "the running summary must fold through the split chain",
    );

    // The fall-through must be dead for this class.
    assert.deepEqual(piCoreDefaultCalls, [], "pi-core's default summarizer must never be invoked for a summary-cap cycle");
    assert.doesNotMatch(logs(), /falling through to pi-core's default summarization/, "no fall-through log line");
    assert.match(logs(), /split/i, "the split must be visible in the log");
  });
  resetRetryState();
});

await test("(b) a cancelled split aborts the chain honestly", async () => {
  clearLogBuffer();
  resetRetryState();
  const ctx = makeFakeCtx();
  const controller = new AbortController();
  const abortOnFirst = () => {
    // Abort as soon as the first (capped) call resolves so the split's half
    // calls never execute.
    controller.abort();
  };

  await withStub({ capUnits: 0, onCall: (n) => (n === 1 ? abortOnFirst() : undefined) }, async (calls) => {
    const result = await summarizeSpanInChunks({
      ctx,
      span: Array.from({ length: 60 }, (_, i) => makeMsg(i)),
      signal: controller.signal,
      logPrefix: "Abort test",
    });
    assert.ok("error" in result, `a cancelled split must abort the chain, got: ${JSON.stringify(result)}`);
    assert.doesNotMatch(
      result.error,
      /hit its own token cap/,
      "an aborted chain must not be misreported as a cap failure",
    );
    assert.equal(calls.length, 1, `no further calls may execute after the abort, got ${calls.length}`);
    assert.match(logs(), /split/i, "the split must have started before the abort");
  });
  resetRetryState();
});

await test("(c) the range branch cancels on summary-cap failure and re-arms the bounded recovery", async () => {
  clearLogBuffer();
  resetRetryState();
  piCoreDefaultCalls = [];
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ branchLength: 4 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);
  getCmState(ctx).rangeMode = {
    active: true,
    startIndex: 0,
    endIndex: 1,
    summary: "ANCHOR-SMALL-CAP",
    topic: "w282 small",
    firstKeptEntryId: "e-kept",
    boundaryIsBranchEnd: false,
    timestamp: Date.now(),
  };

  await withStub({ capUnits: 0 }, async (_calls) => {
    // Force the class: since the length-stop ladder accepts partial merges
    // instead of aborting, an all-cap stub can no longer produce a
    // summary-cap failure by itself. The contract under test (the range branch
    // cancels on that class and the failed routing re-arms the bounded
    // recovery) is unchanged.
    __setChunkedSummaryFailureForTest("summary-cap");
    const { result } = await fireBeforeCompact(pi, ctx, makePrep(2, { firstKeptEntryId: "e-kept" }));
    __setChunkedSummaryFailureForTest(null);
    emulatePiCoreDefault(result, 2);

    assert.ok(result?.cancel === true, `the summary-cap cycle must cancel instead of falling through, got: ${JSON.stringify(result)}`);
    assert.deepEqual(piCoreDefaultCalls, [], "pi-core's default summarizer must never see the span");
    assert.doesNotMatch(logs(), /falling through to pi-core's default summarization/, "no fall-through log line");
    assert.equal(getCmState(ctx).cancelSource, "summary-cap", "the cancel must be attributed to the summary-cap class");
    assert.doesNotMatch(
      pi.thinkingCalls.join(","),
      /off/,
      "a cancelled cycle must not arm the thinking switch for a call that never happens",
    );

    // The failed routing consumes the cancel: bounded recovery re-arms with
    // the range stash folded in, and the retry ladder advances.
    await pi._emit(
      { type: "session_compact_failed", reason: "manual", aborted: true, willRetry: false },
      ctx,
    );
    assert.equal(compactionRetryState.attempt, 1, "the summary-cap cancel must enter the retry ladder");
    assert.ok(getCmState(ctx).pendingSummaryCapRecovery, "the bounded recovery must be re-armed");
    assert.ok(getCmState(ctx).rangeMode?.active, "the range stash must be re-armed as range mode");
    assert.ok(
      pi.sendMessageCalls.some((c) => (c.params.content?.[0]?.text ?? "").includes("token cap")),
      "the retry warning must name the cap",
    );

    await sleep(3350); // compaction retry backoff for attempt 1 is 3s
    assert.equal(ctx.compactCalls.length, 1, "the retry must call ctx.compact()");
  });
  resetRetryState();
});

await test("(d) the split call budget is a hard, stated bound", async () => {
  clearLogBuffer();
  resetRetryState();
  const ctx = makeFakeCtx();

  await withStub({ capUnits: 2 }, async (calls) => {
    const result = await summarizeSpanInChunks({
      ctx,
      span: Array.from({ length: 750 }, (_, i) => makeMsg(i)),
      logPrefix: "Budget test",
    });
    assert.ok("error" in result, "a pathological all-cap span must fail honestly");
    assert.equal(
      result.failureClass,
      "summary-cap",
      `the honest failure must carry the summary-cap class, got: ${JSON.stringify(result)}`,
    );
    assert.equal(
      calls.length,
      chunkedMod.CHUNK_SPLIT_CALL_BUDGET,
      `the budget must bind exactly, got ${calls.length} vs ${chunkedMod.CHUNK_SPLIT_CALL_BUDGET}`,
    );
  });
  resetRetryState();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
