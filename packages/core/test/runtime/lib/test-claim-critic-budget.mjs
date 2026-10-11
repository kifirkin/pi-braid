/**
 * Test: the consolidated claim critic's output budget, and the end of its
 * silent fall-through.
 *
 * BACKGROUND: the critic called the model with a bare `maxTokens: 200` and no
 * reasoning option. Thinking tokens count against max_tokens on every reasoning
 * model braid routes to, and the channel cannot be switched off for a model
 * whose pi-ai thinkingLevelMap declares no "off" level - clampThinkingLevel
 * then maps "off" to the lowest level the model does declare, so "off" is the
 * one level that is silently unavailable. With a 200-token cap the reply
 * length-stopped with no text, extractJson found nothing, the critic returned
 * null, and the caller ran its three individual classify() calls instead: 27 of
 * 96 real judge prompts ended that way on the session's own judge model.
 *
 * Both behaviors are pinned here through llm-call.ts's documented test seam,
 * __setCompleteSimpleForTest, with no network:
 *
 *  1. A model that spends its output budget on thinking still yields a verdict
 *     - the budget is sized from the prompt (callLlm's default, the path the
 *     judges that are not length-stop-prone take), and a completion that still
 *     ends at its ceiling is retried exactly once at an enlarged budget.
 *  2. A fall-through is observable instead of silent: counted by reason, and
 *     announced once per process rather than once per call.
 *
 * The stub models the mechanism, not a provider: it returns
 * stopReason="length" with no text whenever the requested budget is below a
 * fixed thinking need, which is what a reasoning model does when max_tokens
 * covers only its thinking channel.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const criticModule = await import(join(ROOT, "dist", "lib", "ai", "consolidated-claim-critic.js"));
const { consolidatedClaimCritique } = criticModule;
const { __setCompleteSimpleForTest } = await import(join(ROOT, "dist", "lib", "ai", "llm-call.js"));
const { clearLogBuffer, getLogBuffer } = await import(join(ROOT, "dist", "lib", "core", "logger.js"));

const VERDICT_JSON = '{"contradiction": false, "supported": true, "overconfidence": false}';
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

function warnLines() {
  return getLogBuffer()
    .filter((entry) => entry.level === "warn" && /\[consolidated-claim\]/.test(entry.message))
    .map((entry) => entry.message);
}

/**
 * Reset the counters and the once-per-process warning latch when the module
 * exposes them. The observability tests assert the surface exists themselves,
 * so a missing one fails there instead of blanking out the behavioral test.
 */
function resetObservability() {
  criticModule.__resetConsolidatedClaimStatsForTest?.();
  clearLogBuffer();
}

/** The counters, with a clear failure if the critic does not publish them. */
function stats() {
  assert.equal(
    typeof criticModule.getConsolidatedClaimStats,
    "function",
    "the critic must expose its fall-through counters (getConsolidatedClaimStats)",
  );
  return criticModule.getConsolidatedClaimStats();
}

beforeEach(() => {
  thinkingNeed = 0;
  answer = VERDICT_JSON;
  answerStopReason = "stop";
  installStub();
  resetObservability();
});

after(() => {
  __setCompleteSimpleForTest(null);
});

describe("consolidated claim critic output budget", () => {
  it("returns a verdict when the model spends its budget on thinking", async () => {
    // The stub needs 3000 output tokens to finish. The first attempt gets
    // whatever callLlm sizes from the prompt (1000 floor for a prompt this
    // short), so only the enlarged-budget retry can clear it.
    thinkingNeed = 3000;

    const verdict = await consolidatedClaimCritique("The TTL is 300 seconds.", "TTL: 300s.", stubCtx());

    assert.notEqual(verdict, null, "a thinking model must still produce a verdict");
    assert.deepEqual(verdict, {
      contradiction: false,
      supported: true,
      overconfidence: false,
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

    const observed = stats();
    assert.equal(observed.retries, 1);
    assert.equal(observed.retryRecoveries, 1, "the retry must be credited with the verdict");
    assert.equal(observed.budgetExhausted, 1, "the starved completion must be counted");
    assert.equal(observed.fallthroughs, 0);
    assert.equal(warnLines().length, 0, "no fall-through means no warning");
  });

  it("counts each fall-through by reason and warns once per process", async () => {
    // Nothing the retry can do: this need exceeds every budget in play.
    thinkingNeed = 1_000_000;

    const first = await consolidatedClaimCritique("The TTL is 300 seconds.", "TTL: 300s.", stubCtx());
    const second = await consolidatedClaimCritique("The TTL is 300 seconds.", "TTL: 300s.", stubCtx());

    assert.equal(first, null, "a null return is the caller's fall-through signal");
    assert.equal(second, null);
    assert.equal(calls.length, 4, "each starved model gets its one retry");

    const observed = stats();
    assert.equal(observed.invocations, 2);
    assert.equal(observed.fallthroughs, 2);
    assert.equal(observed.fallthroughReasons["budget-exhausted"], 2);
    assert.equal(observed.budgetExhausted, 4);
    assert.equal(observed.retries, 2);
    assert.equal(observed.retryRecoveries, 0);
    assert.equal(observed.verdicts, 0);

    const warnings = warnLines();
    assert.equal(warnings.length, 1, "two fall-throughs, one warning");
    assert.match(warnings[0], /budget-exhausted/);
    assert.match(warnings[0], /getConsolidatedClaimStats/);
  });

  it("does not retry an answer that is not in the shape the critic reads", async () => {
    // Non-empty prose with no JSON object: a prompt-shape problem, not a
    // budget problem, so no retry and a distinct reason.
    answer = "I am not able to evaluate that.";

    const verdict = await consolidatedClaimCritique("The TTL is 300 seconds.", "TTL: 300s.", stubCtx());

    assert.equal(verdict, null);
    assert.equal(calls.length, 1, "no retry without the budget-exhausted signature");

    const observed = stats();
    assert.equal(observed.fallthroughReasons.unparseable, 1);
    assert.equal(observed.fallthroughReasons["budget-exhausted"], 0);
    assert.equal(observed.retries, 0);
    assert.equal(observed.budgetExhausted, 0);

    const warnings = warnLines();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unparseable/);
  });

  it("clamps the retry budget to the model's own output ceiling", async () => {
    thinkingNeed = 3000;
    // A model that cannot emit more than 4096 tokens: the retry must ask for
    // 4096, not 8192 - a budget above the model's ceiling is a client-side
    // error, not a bigger answer.
    const small = { ...MODEL, maxTokens: 4096 };
    const ctx = {
      model: small,
      modelRegistry: { getApiKeyForProvider: async () => "stub-key" },
    };

    const verdict = await consolidatedClaimCritique("The TTL is 300 seconds.", "TTL: 300s.", ctx);

    assert.notEqual(verdict, null);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].maxTokens, 4096);
  });

  it("returns a first-attempt verdict with exactly one call when the completion ends at its ceiling", async () => {
    // A reasoning model can write the JSON and then keep emitting past it,
    // so a completion can stop at max_tokens WITH a verdict in hand. The
    // retry exists for the ceiling that cost the verdict; a delivered verdict
    // must short-circuit it. This pins that clause: without it the ceiling
    // signature alone sends the call back out and the spend doubles.
    thinkingNeed = 0;
    answer = VERDICT_JSON;
    answerStopReason = "length";

    const verdict = await consolidatedClaimCritique("The TTL is 300 seconds.", "TTL: 300s.", stubCtx());

    assert.deepEqual(verdict, {
      contradiction: false,
      supported: true,
      overconfidence: false,
      classifierDown: false,
    });
    assert.equal(calls.length, 1, "a delivered verdict must not be retried, ceiling or not");

    const observed = stats();
    assert.equal(observed.modelCalls, 1, "one backend call — the spend must not be doubled");
    assert.equal(observed.retries, 0, "no enlarged-budget retry once a verdict is in hand");
    assert.equal(observed.retryRecoveries, 0);
    assert.equal(observed.budgetExhausted, 0, "a verdict at the ceiling is not a budget exhaustion");
    assert.equal(observed.verdicts, 1);
    assert.equal(observed.fallthroughs, 0);
  });
});
