/**
 * Cost, after the harness learned to tell a billed total from an estimate.
 *
 * WHY THIS EXISTS:
 *   A provider response carries a `usage` object whose `cost` holds four
 *   catalog-derived components and a `total`. A provider that bills can replace
 *   that total with what it actually charged and mark it: OpenRouter reports the
 *   settled cost on the response, and the harness rewrites `total` and sets
 *   `cost.totalFromProvider = true`. Absent or false means the total is a
 *   catalog estimate. Braid renders its own USD numbers from token counts
 *   against its own pricing table, so the harness's cost shape must not move
 *   what braid reports — and since no reader takes the flag yet, the readers
 *   that would have to are named here rather than assumed.
 *
 * WHAT THIS GATES:
 *   - the harness writes the flag: `calculateCost` marks its total as an
 *     estimate, and a reported billed cost replaces the total and marks it;
 *   - a model whose catalog rate is missing produces a NaN total, which is why
 *     braid never renders `usage.cost.total` raw;
 *   - braid's reader returns the same finite number for the same tokens
 *     whether the usage carries an estimate, a billed total, the pre-flag shape
 *     with no flag at all, or no cost object at all;
 *   - a billed total far from the token-derived figure leaves braid's number
 *     unchanged: the figure braid prints does not come from the harness.
 *
 * WHAT WOULD NEED THE FLAG:
 *   No braid reader reads `usage.cost` today. The call sites that would pass the
 *   flag on to a reader:
 *     - `src/lib/ai/llm-call.ts` normalizes `result.usage` into the token
 *       counts it records;
 *     - `src/lib/ai/text-classifier.ts` hands `result.usage` to
 *       `recordCriticCall` and prints token counts into triggers;
 *     - `src/lib/ai/cost-report.ts` and
 *       `src/extensions/heartbeat/analytics/format.ts` print the `$` totals.
 *
 * Run: node test/runtime/lib/test-usage-cost-readers.mjs
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { calculateCost } from "@earendil-works/pi-ai/models";

import {
  getCriticStats,
  recordCriticCall,
  resetCriticStats,
} from "../../../dist/lib/ai/critic-stats.js";
import { computeCriticCost, DEFAULT_PRICING } from "../../../dist/lib/ai/cost-report.js";

/**
 * The writer that carries a provider's billed cost. Loaded defensively: it did
 * not exist before the harness gained the flag, and a fixture that died on the
 * import would say nothing about which contract was missing.
 */
const reportedCost = await import("@earendil-works/pi-ai/utils/openrouter-cost").catch(
  () => null,
);

/** A model whose catalog entry carries all four rates the writer multiplies. */
const PRICED_MODEL = { cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };

/** A usage object as a provider response leaves it: zeroed cost, ready to fill. */
function freshUsage(input, output) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Two critic calls, 1000/100 and 500/50 tokens, on the two LLM tiers. */
function recordTwoCalls(usage) {
  resetCriticStats();
  recordCriticCall("topic", "utility", 5, usage);
  recordCriticCall("topic", "session", 5, { ...usage, input: 500, output: 50 });
  return computeCriticCost(getCriticStats());
}

const TOKEN_COST_USD =
  (1500 / 1000) * DEFAULT_PRICING.inputPer1kUsd + (150 / 1000) * DEFAULT_PRICING.outputPer1kUsd;

describe("the harness cost writer", () => {
  it("marks a catalog-derived total as an estimate", () => {
    const usage = freshUsage(1000, 500);
    const cost = calculateCost(PRICED_MODEL, usage);
    assert.equal(cost.totalFromProvider, false);
    assert.equal(typeof cost.total, "number");
    const components = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
    assert.equal(cost.total, components);
    assert.ok(cost.total > 0);
  });

  it("marks a provider-reported total as billed and uses its number", () => {
    assert.ok(reportedCost, "the harness carries no writer for a provider-reported cost");
    const usage = freshUsage(1000, 500);
    calculateCost(PRICED_MODEL, usage);
    reportedCost.applyOpenRouterReportedCost(usage, { cost: 0.02, is_byok: false });
    assert.equal(usage.cost.totalFromProvider, true);
    assert.equal(usage.cost.total, 0.02);
  });

  it("leaves the flag set when a reported cost is unusable", () => {
    assert.ok(reportedCost, "the harness carries no writer for a provider-reported cost");
    const usage = freshUsage(1000, 500);
    calculateCost(PRICED_MODEL, usage);
    const estimate = usage.cost.total;
    reportedCost.applyOpenRouterReportedCost(usage, { cost: null, is_byok: false });
    assert.equal(usage.cost.totalFromProvider, false);
    assert.equal(usage.cost.total, estimate);
  });

  it("produces a NaN total for a model whose catalog rate is missing", () => {
    const usage = freshUsage(1000, 500);
    const cost = calculateCost({ cost: { input: 3, output: 15 } }, usage);
    // The writer multiplies every rate unconditionally, so a generated catalog
    // entry that omits a rate turns the total into NaN rather than a price.
    assert.equal(Number.isNaN(cost.total), true);
  });
});

describe("braid's cost reader", () => {
  const SHAPES = {
    estimate() {
      const usage = freshUsage(1000, 100);
      calculateCost(PRICED_MODEL, usage);
      return usage;
    },
    billed() {
      const usage = freshUsage(1000, 100);
      calculateCost(PRICED_MODEL, usage);
      reportedCost?.applyOpenRouterReportedCost(usage, { cost: 99, is_byok: false });
      return usage;
    },
    "pre-flag"() {
      const usage = freshUsage(1000, 100);
      usage.cost = { input: 0.003, output: 0.0015, cacheRead: 0, cacheWrite: 0, total: 0.0045 };
      return usage;
    },
    "no cost object"() {
      return { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100 };
    },
  };

  for (const [shape, build] of Object.entries(SHAPES)) {
    it(`renders a finite token-derived number from a usage with ${shape}`, () => {
      const report = recordTwoCalls(build());
      assert.equal(Number.isFinite(report.totals.costUsd), true);
      assert.ok(Math.abs(report.totals.costUsd - TOKEN_COST_USD) < 1e-12);
      assert.equal(report.totals.inputTokens, 1500);
      assert.equal(report.totals.outputTokens, 150);
    });
  }

  it("renders the same number for an estimate and for a billed total far above it", () => {
    const estimate = recordTwoCalls(SHAPES.estimate());
    const billed = recordTwoCalls(SHAPES.billed());
    assert.equal(billed.totals.costUsd, estimate.totals.costUsd);
    assert.ok(Math.abs(billed.totals.costUsd - TOKEN_COST_USD) < 1e-12);
  });
});
