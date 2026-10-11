/**
 * Test: the consolidated topic critic's output budget.
 *
 * BACKGROUND: the critic called the model with a bare `maxTokens: 200` and no
 * reasoning option. Thinking tokens count against max_tokens on every reasoning
 * model braid routes to, so a 200-token ceiling is a ceiling on the thinking
 * channel: the reply length-stopped with no text, extractJson found nothing,
 * the critic returned null, and the caller got the conservative defaults
 * (coverage true, no divergence, complete, classifierDown true) instead - which
 * read as "no drift detected".
 *
 * The judge completion and its one bounded retry live in one shared
 * implementation (lib/ai/judge-budget.ts). This file pins the critic's side of
 * that contract through llm-call.ts's documented test seam,
 * __setCompleteSimpleForTest, with no network:
 *
 *  1. a model that spends its output budget on thinking still yields a verdict:
 *     the first attempt is sized from the prompt, and a completion that ends at
 *     its ceiling gets exactly one retry at an enlarged budget;
 *  2. when the retry cannot help either, the fall-through is unchanged: the
 *     conservative defaults with classifierDown true;
 *  3. a non-empty answer that does not parse is not retried - the retry is
 *     gated on the completion ending at its output ceiling.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { consolidatedTopicCritique } = await import(
  join(ROOT, "dist", "lib", "detection", "consolidated-topic-critic.js")
);
const { __setCompleteSimpleForTest } = await import(join(ROOT, "dist", "lib", "ai", "llm-call.js"));

const VERDICT_JSON = '{"coversTopic": false, "hasDiverged": true, "isComplete": false}';
const RETRY_BUDGET = 8192;

const MODEL = {
  id: "stub-judge",
  name: "stub-judge",
  provider: "stub-provider",
  api: "openai-completions",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  maxTokens: 200_000,
  contextWindow: 128_000,
};

function stubCtx() {
  return {
    model: MODEL,
    modelRegistry: { getApiKeyForProvider: async () => "stub-key" },
  };
}

/** Requests the critic actually issued, in order. */
let calls = [];
/** Budget below which the stub's thinking channel eats the whole allowance. */
let thinkingNeed = 0;
/** What the stub answers once it has enough room (or immediately). */
let answer = VERDICT_JSON;
let answerStopReason = "stop";

function installStub() {
  calls = [];
  __setCompleteSimpleForTest(async (model, _context, options) => {
    const maxTokens = options?.maxTokens ?? 0;
    calls.push({ modelId: model.id, maxTokens });
    const starved = maxTokens < thinkingNeed;
    const text = starved ? "" : answer;
    const stopReason = starved ? "length" : answerStopReason;
    return {
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      api: "openai-completions",
      provider: model.provider,
      model: model.id,
      usage: { input: 10, output: maxTokens, totalTokens: 10 + maxTokens },
      stopReason,
      timestamp: Date.now(),
    };
  });
}

beforeEach(() => {
  thinkingNeed = 0;
  answer = VERDICT_JSON;
  answerStopReason = "stop";
  installStub();
});

after(() => {
  __setCompleteSimpleForTest(null);
});

describe("consolidated topic critic output budget", () => {
  it("returns a verdict when the model spends its budget on thinking", async () => {
    // The stub needs 3000 output tokens to finish. The first attempt gets
    // whatever callLlm sizes from the prompt (1000 floor for a prompt this
    // short), so only the enlarged-budget retry can clear it.
    thinkingNeed = 3000;

    const verdict = await consolidatedTopicCritique("original request", "agent response", stubCtx());

    assert.equal(verdict.classifierDown, false, "a thinking model must still produce a verdict");
    assert.deepEqual(verdict, {
      coverage: false,
      divergence: true,
      completeness: false,
      classifierDown: false,
    });

    // Two completions: the attempt, then one retry with an enlarged budget.
    assert.equal(calls.length, 2, "one retry, not a retry loop");
    assert.ok(
      calls[0].maxTokens >= 1000,
      `the first attempt must not be capped below a usable budget (got ${calls[0].maxTokens})`,
    );
    assert.ok(
      calls[0].maxTokens < 3000,
      "fixture check: the first attempt is meant to be starved by the stub",
    );
    assert.equal(calls[1].maxTokens, RETRY_BUDGET, "the retry must enlarge the budget");
  });

  it("falls through to the conservative defaults when the enlarged budget does not help either", async () => {
    // Nothing the retry can do: this need exceeds every budget in play.
    thinkingNeed = 1_000_000;

    const verdict = await consolidatedTopicCritique("original request", "agent response", stubCtx());

    assert.deepEqual(
      verdict,
      { coverage: true, divergence: false, completeness: true, classifierDown: true },
      "the fall-through must be the unchanged conservative default",
    );
    assert.equal(calls.length, 2, "the starved model still gets its one retry");
  });

  it("does not retry an answer that is not in the shape the critic reads", async () => {
    // Non-empty prose with no JSON object and a normal stop: a prompt-shape
    // problem, not a budget problem, so no retry.
    answer = "I am not able to evaluate that.";

    const verdict = await consolidatedTopicCritique("original request", "agent response", stubCtx());

    assert.equal(verdict.classifierDown, true);
    assert.equal(calls.length, 1, "no retry without the ceiling signature");
  });
});
