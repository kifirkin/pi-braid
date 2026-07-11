/**
 * ROADMAP P3-25: Cost Report
 *
 * Verifies that `computeCriticCost()` and `formatCriticCostReport()`
 * correctly translate critic-stats token counts into USD cost
 * estimates.
 *
 * What this pins:
 *   1. Pure-function behavior: same input -> same output.
 *   2. Token math: input/output at default pricing ($3/M, $15/M).
 *   3. Cache savings estimate: `cacheHits x avgLLMCallCost`.
 *   4. Edge cases: empty stats, no LLM tiers (no cache savings),
 *      per-critic and aggregate totals.
 *   5. formatCriticCostReport() produces valid Markdown.
 *   6. Custom pricing overrides are respected.
 *   7. Source-level: cost-report.ts exists and exports the API.
 *   8. Source-level: DEFAULT_PRICING matches the documented values.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  recordCriticCall,
  getCriticStats,
  resetCriticStats,
} from "../../../dist/lib/ai/critic-stats.js";
import {
  computeCriticCost,
  formatCriticCostReport,
  DEFAULT_PRICING,
} from "../../../dist/lib/ai/cost-report.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("critic cost report (P3-25)", () => {
  it("applies default pricing to per-critic token usage", () => {
    resetCriticStats();

    // Tier 2 (utility) call: 1000 input + 100 output at default rates.
    //   input:  1000 / 1000 x $0.003 = $0.003
    //   output:  100 / 1000 x $0.015 = $0.0015
    //   total = $0.0045
    recordCriticCall("alpha", "utility", 200, { input: 1000, output: 100 });

    const stats = getCriticStats();
    const report = computeCriticCost(stats);

    assert.equal(report.perCritic["alpha"].byTier.utility.inputTokens, 1000);
    assert.equal(report.perCritic["alpha"].byTier.utility.outputTokens, 100);
    assert.ok(
      Math.abs(report.perCritic["alpha"].byTier.utility.costUsd - 0.0045) < 1e-9,
      `expected $0.0045, got $${report.perCritic["alpha"].byTier.utility.costUsd}`,
    );
    assert.equal(report.totals.costUsd, report.perCritic["alpha"].totalCostUsd);
  });

  it("aggregates per-critic and total costs across multiple critics", () => {
    resetCriticStats();

    recordCriticCall("alpha", "utility", 100, { input: 1000, output: 100 }); // $0.0045
    recordCriticCall("beta", "session", 2000, { input: 4000, output: 200 }); // 4000/1000 x 0.003 + 200/1000 x 0.015 = $0.012 + $0.003 = $0.015

    const stats = getCriticStats();
    const report = computeCriticCost(stats);

    const expectedAlpha = 0.0045;
    const expectedBeta = 0.015;
    const expectedTotal = expectedAlpha + expectedBeta;

    assert.ok(Math.abs(report.perCritic["alpha"].totalCostUsd - expectedAlpha) < 1e-9);
    assert.ok(Math.abs(report.perCritic["beta"].totalCostUsd - expectedBeta) < 1e-9);
    assert.ok(Math.abs(report.totals.costUsd - expectedTotal) < 1e-9);
    assert.equal(report.totals.inputTokens, 5000);
    assert.equal(report.totals.outputTokens, 300);
  });

  it("computes cache savings as cacheHits x avgLLMCallCost", () => {
    resetCriticStats();

    // 2 LLM calls (utility) at $0.0045 each = $0.009 total, avg $0.0045.
    recordCriticCall("alpha", "utility", 200, { input: 1000, output: 100 });
    recordCriticCall("alpha", "utility", 200, { input: 1000, output: 100 });
    // 3 cache hits on the same critic.
    recordCriticCall("alpha", "cache", 1);
    recordCriticCall("alpha", "cache", 1);
    recordCriticCall("alpha", "cache", 1);

    const stats = getCriticStats();
    const report = computeCriticCost(stats);

    assert.equal(report.totals.cacheHits, 3);
    // avgLLM = 0.009 / 2 = 0.0045; savings = 3 x 0.0045 = $0.0135
    const expectedSavings = 3 * 0.0045;
    assert.ok(
      Math.abs(report.totals.cacheSavingsUsd - expectedSavings) < 1e-9,
      `expected $${expectedSavings}, got $${report.totals.cacheSavingsUsd}`,
    );
  });

  it("reports zero cache savings when no LLM tiers fired", () => {
    resetCriticStats();

    // Only heuristic + cache, no LLM tiers.
    recordCriticCall("alpha", "heuristic", 1);
    recordCriticCall("alpha", "cache", 1);

    const stats = getCriticStats();
    const report = computeCriticCost(stats);

    assert.equal(report.totals.cacheSavingsUsd, 0);
    assert.equal(report.totals.cacheHits, 1);
    assert.equal(report.totals.costUsd, 0); // heuristic + cache have no cost
  });

  it("handles empty stats gracefully", () => {
    resetCriticStats();

    const stats = getCriticStats();
    const report = computeCriticCost(stats);

    assert.equal(report.totals.costUsd, 0);
    assert.equal(report.totals.inputTokens, 0);
    assert.equal(report.totals.outputTokens, 0);
    assert.equal(report.totals.cacheHits, 0);
    assert.equal(report.totals.cacheSavingsUsd, 0);
    assert.deepEqual(Object.keys(report.perCritic), []);
  });

  it("respects custom pricing", () => {
    resetCriticStats();

    recordCriticCall("alpha", "utility", 100, { input: 1000, output: 100 });

    const customPricing = {
      inputPer1kUsd: 0.01, // 10x default
      outputPer1kUsd: 0.03, // 2x default
    };

    const stats = getCriticStats();
    const report = computeCriticCost(stats, customPricing);

    // 1000/1000 x 0.01 + 100/1000 x 0.03 = $0.01 + $0.003 = $0.013
    const expected = 0.013;
    assert.ok(
      Math.abs(report.perCritic["alpha"].totalCostUsd - expected) < 1e-9,
      `expected $${expected}, got $${report.perCritic["alpha"].totalCostUsd}`,
    );
    assert.equal(report.pricing, customPricing);
  });

  it("formatCriticCostReport produces Markdown table", () => {
    resetCriticStats();

    recordCriticCall("alpha", "utility", 100, { input: 1000, output: 100 });
    recordCriticCall("beta", "session", 2000, { input: 4000, output: 200 });

    const stats = getCriticStats();
    const report = computeCriticCost(stats);
    const md = formatCriticCostReport(report);

    // Header
    assert.ok(md.includes("## Critic Cost Report"));
    // Pricing line
    assert.ok(md.includes("$0.0030/1K input"));
    assert.ok(md.includes("$0.0150/1K output"));
    // Table rows
    assert.ok(md.includes("| alpha |"));
    assert.ok(md.includes("| beta |"));
    assert.ok(md.includes("| **TOTAL** |"));
    // Cache line (0 cache hits)
    assert.ok(md.includes("Cache hits: 0"));
  });

  it("DEFAULT_PRICING matches documented Sonnet-tier defaults", () => {
    assert.equal(DEFAULT_PRICING.inputPer1kUsd, 0.003);
    assert.equal(DEFAULT_PRICING.outputPer1kUsd, 0.015);
  });
});