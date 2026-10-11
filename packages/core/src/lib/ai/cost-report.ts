/**
 * Cost Report - aggregate token-usage stats into USD cost estimates.
 *
 * The critic-stats pipeline logs token counts; the heartbeat analytics
 * formatting path (extensions/heartbeat/analytics/format.ts) consumes this
 * module in production. Given a `CriticStats` snapshot and a
 * `CriticPricing` rate table, it computes a structured `CriticCostReport`
 * that breaks down spend per critic, per tier, and per direction (input
 * vs. output). Cache-hit savings are estimated using the average LLM-tier
 * cost per call.
 *
 * Foundational cost-analysis layer for tier-2 LLM call budgeting; enables
 * drift-classifier cache sizing to choose a TTL from actual spend.
 *
 * Defaults are rough Sonnet-tier averages ($3/M input, $15/M output).
 * Override `CriticPricing` per-model when the LLM mix differs (e.g.,
 * GPT-4o, Haiku). The defaults err on the conservative side; users tuning
 * for cost should pass a tighter `inputPer1kUsd` for utility-tier calls.
 */

import type { CriticStats, CriticTier } from "./critic-stats.js";

// ── Pricing model ────────────────────────────────────────────────────────────

export interface CriticPricing {
  /** USD per 1K input tokens (across all LLM tiers). */
  inputPer1kUsd: number;
  /** USD per 1K output tokens (across all LLM tiers). */
  outputPer1kUsd: number;
}

/**
 * Sonnet-class defaults (~$3/M input, ~$15/M output).
 * Override for cheaper or more expensive models.
 */
export const DEFAULT_PRICING: CriticPricing = {
  inputPer1kUsd: 0.003,
  outputPer1kUsd: 0.015,
};

// ── Report shape ─────────────────────────────────────────────────────────────

export interface CriticTierCost {
  count: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CriticCostBreakdown {
  /** Cost per tier within this critic (heuristic/utility/session/failed/cache). */
  byTier: Partial<Record<CriticTier, CriticTierCost>>;
  /** Total USD spent on this critic across all tiers. */
  totalCostUsd: number;
}

export interface CriticCostReport {
  perCritic: Record<string, CriticCostBreakdown>;
  totals: {
    inputTokens: number;
    outputTokens: number;
    /** Sum of per-critic costs. */
    costUsd: number;
    /**
     * Estimated savings from cache hits. Computed as
     * `cacheCount x averageLLMCallCost`, where the average is taken
     * over all non-cache LLM tiers in the report. This is an
     * approximation: a cache hit avoids whatever the average LLM
     * call would have cost, regardless of which specific critic
     * produced the hit.
     */
    cacheSavingsUsd: number;
    /** Number of cache hits across all critics. */
    cacheHits: number;
  };
  /** The pricing rates used to produce this report. */
  pricing: CriticPricing;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function tierCostUsd(inputTokens: number, outputTokens: number, pricing: CriticPricing): number {
  // Pricing is per 1K tokens; divide by 1000 then multiply.
  return (
    (inputTokens / 1000) * pricing.inputPer1kUsd + (outputTokens / 1000) * pricing.outputPer1kUsd
  );
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Compute a cost report from critic stats. Pure function: takes a
 * `CriticStats` snapshot (e.g., from `getCriticStats()`) and returns
 * a fresh report object. Does not mutate `stats`.
 *
 * Cache savings are estimated by assuming each cache hit replaced an
 * average-cost LLM call. The average is taken over all non-cache,
 * non-failed, non-heuristic LLM tiers (utility + session) in the
 * report. If no LLM tiers have fired, `cacheSavingsUsd` is 0.
 */
export function computeCriticCost(
  stats: CriticStats,
  pricing: CriticPricing = DEFAULT_PRICING,
): CriticCostReport {
  const perCritic: Record<string, CriticCostBreakdown> = {};
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheHits = 0;
  let llmCallCount = 0;
  let llmTotalCostUsd = 0;

  // First pass: per-critic breakdown + accumulate LLM call cost for cache baseline.
  for (const [label, byTier] of Object.entries(stats.perCritic)) {
    const breakdown: CriticCostBreakdown = { byTier: {}, totalCostUsd: 0 };

    for (const [tier, entry] of Object.entries(byTier) as [
      CriticTier,
      {
        count: number;
        totalInputTokens: number;
        totalOutputTokens: number;
      },
    ][]) {
      const cost = tierCostUsd(entry.totalInputTokens, entry.totalOutputTokens, pricing);
      breakdown.byTier[tier] = {
        count: entry.count,
        inputTokens: entry.totalInputTokens,
        outputTokens: entry.totalOutputTokens,
        costUsd: cost,
      };
      breakdown.totalCostUsd += cost;
      totalInputTokens += entry.totalInputTokens;
      totalOutputTokens += entry.totalOutputTokens;

      if (tier === "cache") {
        totalCacheHits += entry.count;
      } else if (tier === "utility" || tier === "session") {
        // LLM tiers contribute to the cache-baseline average.
        llmCallCount += entry.count;
        llmTotalCostUsd += cost;
      }
    }

    perCritic[label] = breakdown;
  }

  const avgLlmCostUsd = llmCallCount > 0 ? llmTotalCostUsd / llmCallCount : 0;
  const cacheSavingsUsd = totalCacheHits * avgLlmCostUsd;

  return {
    perCritic,
    totals: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: Object.values(perCritic).reduce((sum, b) => sum + b.totalCostUsd, 0),
      cacheSavingsUsd,
      cacheHits: totalCacheHits,
    },
    pricing,
  };
}

/**
 * Format a `CriticCostReport` as a human-readable Markdown table.
 * Used by the analytics extension to surface cost in `get_session_metrics`.
 */
export function formatCriticCostReport(report: CriticCostReport): string {
  const lines: string[] = [];
  lines.push("## Critic Cost Report");
  lines.push("");
  lines.push(
    `Pricing: $${report.pricing.inputPer1kUsd.toFixed(4)}/1K input, $${report.pricing.outputPer1kUsd.toFixed(4)}/1K output`,
  );
  lines.push("");
  lines.push("| Critic | Calls | Input | Output | Cost (USD) |");
  lines.push("|---|---:|---:|---:|---:|");

  const sortedCritics = Object.entries(report.perCritic).sort(
    ([, a], [, b]) => b.totalCostUsd - a.totalCostUsd,
  );

  for (const [label, breakdown] of sortedCritics) {
    const totalCount = Object.values(breakdown.byTier).reduce((s, t) => s + (t?.count ?? 0), 0);
    const totalIn = Object.values(breakdown.byTier).reduce((s, t) => s + (t?.inputTokens ?? 0), 0);
    const totalOut = Object.values(breakdown.byTier).reduce(
      (s, t) => s + (t?.outputTokens ?? 0),
      0,
    );
    lines.push(
      `| ${label} | ${totalCount} | ${totalIn.toLocaleString()} | ${totalOut.toLocaleString()} | $${breakdown.totalCostUsd.toFixed(4)} |`,
    );
  }

  lines.push(
    `| **TOTAL** | | ${report.totals.inputTokens.toLocaleString()} | ${report.totals.outputTokens.toLocaleString()} | **$${report.totals.costUsd.toFixed(4)}** |`,
  );
  lines.push("");
  lines.push(
    `Cache hits: ${report.totals.cacheHits} (estimated savings: $${report.totals.cacheSavingsUsd.toFixed(4)})`,
  );

  return lines.join("\n");
}

// Re-export for convenience so callers can `import { computeCriticCost, getCriticStats } from "./cost-report.js"`.
export { getCriticStats, resetCriticStats } from "./critic-stats.js";
