/**
 * Enforcement Signals - shared L1 signal state for prompt-builder.
 *
 * enforcementSignals is a writable object - prompt-builder reads it directly
 * (same process, no IPC needed). Stale entries are cleaned up on each
 * TURN_END via `pruneSignals(currentTurn)`: entries whose `turn` is more
 * than 1 behind `currentTurn` are deleted. So the live set is bounded
 * to signals from the current and previous turn.
 *
 * Why direct mutation instead of a Map wrapper: callers in 3+ handler
 * files already use `enforcementSignals[key] = signal` and
 * `delete enforcementSignals[key]`. A Map would be safer but require
 * touching all those sites; the bounded set means no actual leak risk.
 *
 * Use `pruneSignals(currentTurn)` from the TURN_END handler to enforce
 * the turn-keyed invariant.
 /** A single signal entry keyed by semantic type */
export interface EnforcementSignalEntry {
  turn: number;
  text: string;
  acted: boolean;
}

/**
 * How many turns behind `currentTurn` an entry can be before eviction.
 *
 * 3 covers the MARS lookback: `tool-usage-analyzer.ts` reads
 * `stabilityTrend.slice(-3)` to detect a stability_decline pattern, so a
 * retention of 1 leaves the trend incomplete by the time MARS fires —
 * effectively dead code. The
 * prompt-builder's RepE contrast consumer still works fine with the
 * larger window; it reads the most-recent signal of each key.
 */
const SIGNAL_RETENTION_TURNS = 3;

/**
 * Known enforcement signal keys. Allows compile-time checking at static
 * call sites while preserving a downcast escape hatch for the dynamic
 * message-analysis pipeline (register-message-end.ts keys from
 * analyzeMessage).
 *
 * Use `(enforcementSignals as Record<string, EnforcementSignalEntry>)`
 * when the key is genuinely runtime-dynamic.
 */
export type EnforcementSignalKey =
  | "probe"
  | "routing"
  | "stability"
  | "truth_seeking_trigger"
  | "unpersisted_learnings";

/**
 * Source-of-truth map for signal keys that appear in multiple files.
 * Using a typo in a literal (`SIGNAL_KEYS.unpersisted_lernings`) now
 * fails at compile time.
 */
export const SIGNAL_KEYS: Record<string, EnforcementSignalKey> = {
  unpersisted_learnings: "unpersisted_learnings",
  truth_seeking_trigger: "truth_seeking_trigger",
} as const;

/**
 * L1 enforcement signals for prompt-builder surfacing.
 * Keyed by semantic type (probe, routing, stability,
 * unpersisted_learnings). Dynamic keys from message-analysis use a
 * downcast escape hatch.
 */
export const enforcementSignals: Partial<Record<EnforcementSignalKey, EnforcementSignalEntry>> = {};

/**
 * Prune enforcement signals whose `turn` is more than
 * `SIGNAL_RETENTION_TURNS` behind `currentTurn`. Call this from the
 * TURN_END handler to enforce the "turn-keyed" invariant.
 *
 * Returns the number of entries deleted (useful for observability).
 */
export function pruneSignals(currentTurn: number): number {
  const cutoff = currentTurn - SIGNAL_RETENTION_TURNS;
  let deleted = 0;
  const signals = enforcementSignals as Record<string, EnforcementSignalEntry>;
  for (const key of Object.keys(signals)) {
    if (signals[key].turn < cutoff) {
      delete signals[key];
      deleted++;
    }
  }
  return deleted;
}
