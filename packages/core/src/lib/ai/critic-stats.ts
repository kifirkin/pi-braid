/**
 * Critic Stats - lightweight runtime observability for LLM judge calls.
 *
 * Tracks per-critic call counts by tier (heuristic/utility/session/failed),
 * latency, and token usage (Q16: for cost analysis). Module-level counters
 * are safe within a single-agent session; call `resetCriticStats()` on
 * session boundaries.
 *
 * Integrates with heartbeat/analytics to surface in `get_session_metrics`.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type CriticTier = "heuristic" | "utility" | "session" | "failed" | "cache" | "gate";

export interface CriticCallEntry {
  tier: CriticTier;
  /** Total calls to this critic resolved at this tier. */
  count: number;
  /** Total latency across all calls (ms) - for average calculation. */
  totalLatencyMs: number;
  /**
   * Q16: total input tokens across all LLM-tier calls. Heuristic and
   * failed tiers do not consume tokens (heuristic is local; failed means
   * we never got a successful LLM response). Use this + totalOutputTokens
   * to compute cost = (input * $in/1k) + (output * $out/1k) at report time.
   */
  totalInputTokens: number;
  /**
   * Q16: total output tokens across all LLM-tier calls. See
   * `totalInputTokens` for cost formula.
   */
  totalOutputTokens: number;
}

export interface CriticStats {
  /** Per-critic stats, keyed by critic label. */
  perCritic: Record<string, Record<CriticTier, CriticCallEntry>>;
  /** Aggregate across all critics. */
  totals: Record<CriticTier, number>;
  /**
   * Q16: aggregate input tokens across all LLM-tier calls. Heuristic and
   * failed tiers contribute 0.
   */
  totalsInputTokens: number;
  /** Q16: aggregate output tokens across all LLM-tier calls. */
  totalsOutputTokens: number;
  /** Labels in insertion order. */
  criticLabels: string[];
  /** Total critic calls tracked. */
  totalCalls: number;
}

/**
 * Q16: optional token usage passed by callers that have access to the
 * LLM result. `input` and `output` are provider-reported token counts
 * (typically from `result.usage` on the LLM response). Both are optional
 * because some providers omit them, and the heuristic/failed paths never
 * have a successful LLM response.
 */
export interface CriticUsage {
  input?: number;
  output?: number;
}

// ── Module-level counter store ───────────────────────────────────────────────

const perCritic = new Map<string, Map<CriticTier, CriticCallEntry>>();

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * Record a single critic classification result.
 *
 * @param label - Human-readable critic label (e.g. "Topic Coverage")
 * @param tier - Which tier produced the result
 * @param latencyMs - Duration of the classification call
 * @param usage - Q16: optional LLM token usage (input/output). Heuristic
 *   and failed tiers should omit this; LLM tiers should pass the usage
 *   from the LLM response.
 */
export function recordCriticCall(
  label: string,
  tier: CriticTier,
  latencyMs: number,
  usage?: CriticUsage,
): void {
  let byTier = perCritic.get(label);
  if (!byTier) {
    byTier = new Map();
    perCritic.set(label, byTier);
  }

  let entry = byTier.get(tier);
  if (!entry) {
    entry = {
      tier,
      count: 0,
      totalLatencyMs: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };
    byTier.set(tier, entry);
  }

  entry.count++;
  entry.totalLatencyMs += latencyMs;
  entry.totalInputTokens += usage?.input ?? 0;
  entry.totalOutputTokens += usage?.output ?? 0;
}

/**
 * Return aggregated critic stats since last reset.
 */
export function getCriticStats(): CriticStats {
  const perCriticOut: Record<string, Record<CriticTier, CriticCallEntry>> = {};
  const totals: Record<CriticTier, number> = {
    heuristic: 0,
    utility: 0,
    session: 0,
    failed: 0,
    cache: 0,
    gate: 0,
  };
  let totalsInputTokens = 0;
  let totalsOutputTokens = 0;
  const criticLabels: string[] = [];
  let totalCalls = 0;

  for (const [label, byTier] of perCritic) {
    const tierMap: Record<CriticTier, CriticCallEntry> = {} as Record<CriticTier, CriticCallEntry>;
    for (const [tier, entry] of byTier) {
      tierMap[tier] = entry;
      totals[tier] += entry.count;
      totalsInputTokens += entry.totalInputTokens;
      totalsOutputTokens += entry.totalOutputTokens;
      totalCalls += entry.count;
    }
    perCriticOut[label] = tierMap;
    criticLabels.push(label);
  }

  return {
    perCritic: perCriticOut,
    totals,
    totalsInputTokens,
    totalsOutputTokens,
    criticLabels,
    totalCalls,
  };
}

/**
 * Reset all counters. Call on session boundaries (`session_start` handler).
 */
export function resetCriticStats(): void {
  perCritic.clear();
}
