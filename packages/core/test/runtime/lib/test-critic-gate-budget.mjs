/**
 * Regression test for critic-gate.ts's classify budget.
 *
 * The gate used to send an explicit `maxTokens: 5`, which text-classifier.ts
 * treats as a caller hard cap and therefore refuses to retry. On a model whose
 * thinking cannot be switched off (clampThinkingLevel walks an absent "off" up
 * to the lowest declared level) those 5 tokens are spent on the thinking
 * channel: the completion ends at its ceiling with no text, the tier loop
 * falls through, and the gate settles without a model verdict.
 *
 * Contract pinned here:
 * - The gate sends no budget of its own, so the first attempt is sized from
 *   the prompt (callLlm: 1000-4000) and a starved completion gets the
 *   classifier's one-shot 8192-token retry.
 * - A caller's explicit budget stays a hard cap: one attempt, no retry.
 * - A completion that produced text is never retried.
 *
 * classify() runs against a stubbed completeSimple (__setCompleteSimpleForTest)
 * and a minimal fake ctx - no provider/network needed.
 */

import { join, dirname } from "node:path";
import { strict as assert } from "node:assert";

const __dirname = dirname(new URL(import.meta.url).pathname);
const ROOT = join(__dirname, "..", "..", "..");

console.log("=== critic-gate budget Regression Tests ===\n");

const { criticGate } = await import(join(ROOT, "dist", "lib", "ai", "critic-gate.js"));
const { classify } = await import(join(ROOT, "dist", "lib", "ai", "text-classifier.js"));
const { __setCompleteSimpleForTest } = await import(join(ROOT, "dist", "lib", "ai", "llm-call.js"));

function message({ text, stopReason, outputTokens }) {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "openai-completions",
    provider: "test",
    model: "stub",
    usage: { input: 10, output: outputTokens, totalTokens: 10 + outputTokens },
    stopReason,
    timestamp: Date.now(),
  };
}

function makeCtx() {
  return {
    model: {
      id: "forced-thinker",
      provider: "test",
      api: "openai-completions",
      reasoning: true,
      // No "off" entry: an absent "off" is clamped up, not honored.
      thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high" },
      maxTokens: 32000,
    },
    modelRegistry: { getApiKeyForProvider: async () => "fake-key" },
    signal: undefined,
  };
}

/**
 * Runs one gate/classify call with a stub whose completion starves below
 * `thinkingNeed` output tokens (returns empty text with stopReason=length)
 * and answers "yes" otherwise. Records every completion's options.
 */
async function runWithStub(thinkingNeed, fn) {
  const calls = [];
  __setCompleteSimpleForTest(async (_model, _context, options) => {
    const cap = options.maxTokens;
    const effective = cap ?? Math.min(Math.max(1000, Math.floor(200 / 8)), 4000);
    calls.push({ maxTokens: cap, reasoning: options.reasoning });
    if (effective < thinkingNeed) {
      return message({ text: "", stopReason: "length", outputTokens: effective });
    }
    return message({ text: "yes", stopReason: "stop", outputTokens: 2 });
  });
  try {
    const result = await fn();
    return { calls, result };
  } finally {
    __setCompleteSimpleForTest(null);
  }
}

let n = 0;
const gateArgs = (overrides = {}) => ({
  name: `budget-test-${++n}`,
  criteria: { systemPrompt: "Answer yes, no, or deep.", userPrompt: "Problem: {{p}}" },
  input: { p: "x".repeat(200) },
  // An ambiguous fallback keeps the tier-1 heuristic out of the way, so the
  // LLM tier loop is the only path to a label.
  fallback: () => "",
  timeoutMs: 60_000,
  ...overrides,
});

// (a) No gate budget of its own: a starved first attempt is retried at 8192
//     and the gate gets a model verdict instead of settling at "failed".
{
  const { calls, result } = await runWithStub(1200, () =>
    criticGate(makeCtx(), gateArgs()),
  );
  assert.equal(calls.length, 3, "tier-0 probe + first attempt + one retry");
  assert.equal(calls[1].maxTokens, 1000, "the gate's first LLM attempt is prompt-sized, not 5");
  assert.equal(calls[2].maxTokens, 8192, "the starved attempt is retried at the enlarged budget");
  assert.equal(result.tier, "session", "the gate keeps the model's tier");
  assert.equal(result.shouldProceed, true, "the recovered label is 'yes' -> proceed");
  assert.ok(
    result.message.includes("proceeding (session)"),
    `the gate reports the model tier, got: ${result.message}`,
  );
  console.log(" [ok] (a) gate recovery: 1000-token attempt -> starved -> 8192 retry -> session verdict");
}

// (b) A caller's explicit budget is a hard cap: one attempt, no retry, and
//     the gate sees the failure rather than a recovery.
{
  const { calls, result } = await runWithStub(1200, () =>
    criticGate(makeCtx(), gateArgs({ maxTokens: 64 })),
  );
  const llmCalls = calls.filter((c) => c.maxTokens !== 1);
  assert.equal(llmCalls.length, 1, "an explicit budget disables the retry");
  assert.equal(llmCalls[0].maxTokens, 64, "the caller's cap is preserved");
  assert.equal(result.tier, "heuristic", "an explicitly capped starvation leaves no model verdict");
  console.log(" [ok] (b) explicit gate budget stays a hard cap (1 attempt at 64, no retry)");
}

// (c) A caller passing a budget still gets its answer on the first try.
{
  const { calls, result } = await runWithStub(64, () =>
    criticGate(makeCtx(), gateArgs({ maxTokens: 64 })),
  );
  const llmCalls = calls.filter((c) => c.maxTokens !== 1);
  assert.equal(llmCalls.length, 1, "an answered completion is not retried");
  assert.equal(llmCalls[0].maxTokens, 64, "the caller's budget is the one attempted");
  assert.equal(result.tier, "session", "the answer is attributed to the model tier");
  console.log(" [ok] (c) caller budget + answer within it: one attempt, no retry");
}

// (d) A completion that produced text is never retried, even without a budget.
{
  const calls = [];
  __setCompleteSimpleForTest(async (_model, _context, options) => {
    calls.push({ maxTokens: options.maxTokens });
    return message({ text: "maybe", stopReason: "stop", outputTokens: 3 });
  });
  let result;
  try {
    result = await criticGate(makeCtx(), gateArgs());
  } finally {
    __setCompleteSimpleForTest(null);
  }
  const llmCalls = calls.filter((c) => c.maxTokens !== 1);
  assert.equal(llmCalls.length, 1, "an unparseable answer with text is a format problem, not starvation");
  assert.equal(result.tier, "heuristic", "no verdict was recovered from the format failure");
  console.log(" [ok] (d) completion with text is not retried");
}

// (e) The classifier's own hard-cap contract is untouched.
{
  const { calls, result } = await runWithStub(1200, () =>
    classify(
      makeCtx(),
      { systemPrompt: "Answer yes or no.", userPrompt: "{{q}}" },
      { q: "x".repeat(200) },
      { maxTokens: 5, timeoutMs: 5000, binaryGate: false },
    ),
  );
  assert.equal(calls.length, 1, "text-classifier still refuses to exceed an explicit budget");
  assert.equal(calls[0].maxTokens, 5, "the explicit budget is the one attempted");
  assert.equal(result.tier, "failed", "the capped starvation still fails the tier");
  console.log(" [ok] (e) classify() explicit budget still disables the retry");
}

// (f) The metacognition handler shape (fallback + tierPolicy fallback-only) is
//     unchanged: tier 1 answers with the fallback label before any LLM tier
//     call, whether or not the model would have answered.
{
  const { calls, result } = await runWithStub(1200, () =>
    criticGate(
      makeCtx(),
      gateArgs({
        name: "budget-test-fallback-only",
        fallback: () => "yes",
        tierPolicy: "fallback-only",
        modelPreference: "quality",
      }),
    ),
  );
  assert.equal(calls.length, 1, "only the tier-0 probe runs; the fallback answers at tier 1");
  assert.equal(result.tier, "heuristic", "the fallback label keeps the heuristic attribution");
  assert.equal(result.shouldProceed, true, "the fallback label is 'yes' -> proceed");
  console.log(" [ok] (f) handler shape (fallback-only) unchanged");
}

console.log("\n======================================================");
console.log("All critic-gate budget regression tests passed");
console.log("======================================================");

process.exit(0);
