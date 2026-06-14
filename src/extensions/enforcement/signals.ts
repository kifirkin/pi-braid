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
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getState, RECOVERY_GRACE_TURNS } from "./state.js";

/** A single signal entry keyed by semantic type */
export interface EnforcementSignalEntry {
  turn: number;
  text: string;
  acted: boolean;
}

/**
 * How many turns behind `currentTurn` an entry can be before eviction.
 * 1 means we keep entries from the current and previous turn; older
 * entries are deleted. This bounds the set to ~2 turns of data.
 */
const SIGNAL_RETENTION_TURNS = 1;

/**
 * L1 enforcement signals for prompt-builder surfacing.
 * Keyed by semantic type (memory, scratchpad, context_high, etc.)
 */
export const enforcementSignals: Record<string, EnforcementSignalEntry> = {};

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
  for (const key of Object.keys(enforcementSignals)) {
    if (enforcementSignals[key].turn < cutoff) {
      delete enforcementSignals[key];
      deleted++;
    }
  }
  return deleted;
}

// ── RepE Contrast Mode Detection (P0.3) ────────────────────────────────────────
// Determines which RepE contrast mode should be active based on enforcement state.
// Emitted with enforcement_signals event → prompt-builder renders active mode in §8.
// Priority: errors > overflow > correction-edits > default.
// Modes: TRUTH-SEEKING | TOOL-RELIABILITY | CORRECTION | EPISTEMIC-CALIBRATION.

export function determineContrastMode(ctx: ExtensionContext): string {
  const state = getState(ctx);

  // Priority 1: Error burst → TOOL RELIABILITY
  if (state.consecutiveErrorTurns >= 1) return "TOOL-RELIABILITY";

  // Priority 2: Overflow recovery → EPISTEMIC CALIBRATION
  const inOverflowRecovery = state.currentTurn - state.overflowRecently < RECOVERY_GRACE_TURNS;
  if (state.overflowRecently > 0 && inOverflowRecovery) return "EPISTEMIC-CALIBRATION";

  // Priority 3: Edit without think recently → CORRECTION
  const recentEditsWithoutThink = state.toolChain.recentEditWithoutThink.filter(
    (turn: number) => state.currentTurn - turn <= 3,
  );
  if (recentEditsWithoutThink.length > 0) return "CORRECTION";

  // Default: TRUTH-SEEKING
  return "TRUTH-SEEKING";
}
