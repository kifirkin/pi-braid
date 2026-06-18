/**
 * Q16: Critic Stats Token Tracking
 *
 * Verifies that recordCriticCall() and getCriticStats() track
 * per-critic LLM token usage (input + output) for cost analysis.
 *
 * The infrastructure was added in Q16 (v2.0) to give us the
 * measurement foundation needed for the P2-11 B-class fallback
 * conversions. Tokens are the missing piece: counts and latency
 * were already tracked, but without tokens we can't compute cost.
 *
 * The test exercises the runtime behavior (not source-pattern):
 *   1. Reset stats
 *   2. Record a few calls across all four tiers
 *   3. Verify getCriticStats() returns the right shape
 *   4. Verify per-critic and aggregate token totals are correct
 *   5. Verify backward compat: calls without usage still work
 *   6. Verify the CriticUsage type is exported for downstream callers
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  recordCriticCall,
  getCriticStats,
  resetCriticStats,
} from "../../../dist/lib/ai/critic-stats.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("critic-stats token tracking (Q16)", () => {
  beforeEach(() => {
    resetCriticStats();
  });

  it("records input + output tokens for LLM tiers", () => {
    // Tier 2 (utility) call with token usage
    recordCriticCall("test-utility", "utility", 200, { input: 100, output: 5 });
    // Tier 3 (session) call with token usage
    recordCriticCall("test-session", "session", 1500, { input: 200, output: 8 });

    const stats = getCriticStats();

    // Per-critic entries
    assert.equal(stats.perCritic["test-utility"].utility.count, 1);
    assert.equal(stats.perCritic["test-utility"].utility.totalInputTokens, 100);
    assert.equal(stats.perCritic["test-utility"].utility.totalOutputTokens, 5);

    assert.equal(stats.perCritic["test-session"].session.count, 1);
    assert.equal(stats.perCritic["test-session"].session.totalInputTokens, 200);
    assert.equal(stats.perCritic["test-session"].session.totalOutputTokens, 8);

    // Aggregate
    assert.equal(stats.totalsInputTokens, 300);
    assert.equal(stats.totalsOutputTokens, 13);
    assert.equal(stats.totalCalls, 2);
  });

  it("treats omitted usage as zero tokens (backward compat)", () => {
    // Heuristic call (no LLM, no usage expected)
    recordCriticCall("test-heuristic", "heuristic", 1);
    // Failed call (no successful LLM response, no usage)
    recordCriticCall("test-failed", "failed", 8000);
    // Utility call without usage (caller didn't pass it)
    recordCriticCall("test-no-usage", "utility", 250);

    const stats = getCriticStats();

    // All entries should have totalInputTokens = 0
    assert.equal(stats.perCritic["test-heuristic"].heuristic.totalInputTokens, 0);
    assert.equal(stats.perCritic["test-heuristic"].heuristic.totalOutputTokens, 0);
    assert.equal(stats.perCritic["test-failed"].failed.totalInputTokens, 0);
    assert.equal(stats.perCritic["test-failed"].failed.totalOutputTokens, 0);
    assert.equal(stats.perCritic["test-no-usage"].utility.totalInputTokens, 0);
    assert.equal(stats.perCritic["test-no-usage"].utility.totalOutputTokens, 0);

    assert.equal(stats.totalsInputTokens, 0);
    assert.equal(stats.totalsOutputTokens, 0);
    assert.equal(stats.totalCalls, 3);
  });

  it("accumulates tokens across multiple calls", () => {
    // Same critic, 3 LLM calls
    recordCriticCall("repeater", "utility", 100, { input: 50, output: 2 });
    recordCriticCall("repeater", "utility", 150, { input: 75, output: 3 });
    recordCriticCall("repeater", "utility", 120, { input: 60, output: 4 });

    const stats = getCriticStats();
    const entry = stats.perCritic["repeater"].utility;

    assert.equal(entry.count, 3);
    assert.equal(entry.totalLatencyMs, 370);
    assert.equal(entry.totalInputTokens, 185); // 50+75+60
    assert.equal(entry.totalOutputTokens, 9); // 2+3+4
  });

  it("surfaces tokens in CriticStats totals", () => {
    recordCriticCall("a", "utility", 200, { input: 1000, output: 50 });
    recordCriticCall("b", "session", 2000, { input: 2000, output: 100 });
    recordCriticCall("c", "utility", 150, { input: 500, output: 25 });

    const stats = getCriticStats();

    // Aggregate token totals across all critics and all tiers
    assert.equal(stats.totalsInputTokens, 3500); // 1000 + 2000 + 500
    assert.equal(stats.totalsOutputTokens, 175); // 50 + 100 + 25

    // Tier-level call counts are still tracked
    assert.equal(stats.totals.utility, 2);
    assert.equal(stats.totals.session, 1);
  });

  it("exports CriticUsage type and recordCriticCall accepts it", () => {
    // Type-level contract: the source declares CriticUsage and the
    // recordCriticCall function accepts it as the 4th argument.
    // This pins the API shape so downstream callers (text-classifier
    // already wired) can rely on the optional usage parameter.
    const src = readFileSync(
      join(ROOT, "src/lib/ai/critic-stats.ts"),
      "utf-8",
    );
    assert.ok(
      src.includes("export interface CriticUsage"),
      "CriticUsage should be exported for downstream callers to type their usage argument",
    );
    assert.ok(
      src.includes("usage?: CriticUsage"),
      "recordCriticCall should accept optional CriticUsage argument",
    );
  });
});
