/**
 * Critic Stats — lightweight runtime observability for LLM judge calls.
 *
 * Tracks per-critic call counts by tier (heuristic/utility/session/failed)
 * and latency. Module-level counters are safe within a single-agent session;
 * call `resetCriticStats()` on session boundaries.
 *
 * Integrates with heartbeat/analytics to surface in `get_session_metrics`.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type CriticTier = "heuristic" | "utility" | "session" | "failed";

export interface CriticCallEntry {
  tier: CriticTier;
  /** Total calls to this critic resolved at this tier. */
  count: number;
  /** Total latency across all calls (ms) — for average calculation. */
  totalLatencyMs: number;
}

export interface CriticStats {
  /** Per-critic stats, keyed by critic label. */
  perCritic: Record<string, Record<CriticTier, CriticCallEntry>>;
  /** Aggregate across all critics. */
  totals: Record<CriticTier, number>;
  /** Labels in insertion order. */
  criticLabels: string[];
  /** Total critic calls tracked. */
  totalCalls: number;
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
 */
export function recordCriticCall(label: string, tier: CriticTier, latencyMs: number): void {
  let byTier = perCritic.get(label);
  if (!byTier) {
    byTier = new Map();
    perCritic.set(label, byTier);
  }

  let entry = byTier.get(tier);
  if (!entry) {
    entry = { tier, count: 0, totalLatencyMs: 0 };
    byTier.set(tier, entry);
  }

  entry.count++;
  entry.totalLatencyMs += latencyMs;
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
  };
  const criticLabels: string[] = [];
  let totalCalls = 0;

  for (const [label, byTier] of perCritic) {
    const tierMap: Record<CriticTier, CriticCallEntry> = {} as Record<CriticTier, CriticCallEntry>;
    for (const [tier, entry] of byTier) {
      tierMap[tier] = entry;
      totals[tier] += entry.count;
      totalCalls += entry.count;
    }
    perCriticOut[label] = tierMap;
    criticLabels.push(label);
  }

  return { perCritic: perCriticOut, totals, criticLabels, totalCalls };
}

/**
 * Reset all counters. Call on session boundaries (`session_start` handler).
 */
export function resetCriticStats(): void {
  perCritic.clear();
}