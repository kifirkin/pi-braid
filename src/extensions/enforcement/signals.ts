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
 *
 * ROADMAP P0-7 / EW-7.6: was 1. Bumped to 3 to cover MARS lookback
 * (`mars-reflector.ts:175` uses `stabilityTrend.slice(-3)` to detect a
 * stability_decline pattern). With retention=1, the trend is incomplete
 * by the time MARS is supposed to fire - effectively dead code. The
 * prompt-builder's RepE contrast consumer still works fine with the
 * larger window; it reads the most-recent signal of each key.
 */
const SIGNAL_RETENTION_TURNS = 3;

/**
 * ROADMAP EW-7.7: known signal keys. The map is also keyed by dynamic
 * keys (e.g. `memory`, `scratchpad` from bundle-sub-signal callers), so
 * the type is widened to `string` at the storage layer. This const is
 * the source of truth for the literal keys that appear in multiple
 * files. Using a typo in a literal (`enforcementSignals["unpersisted-
 * lernings"]`) compiles silently; future compile-time enforcement can
 * be added by switching the storage to a branded key type.
 */
export const SIGNAL_KEYS = {
  unpersisted_learnings: "unpersisted_learnings",
} as const;


/**
 * L1 enforcement signals for prompt-builder surfacing.
 * Keyed by semantic type (memory, scratchpad, context_high, etc.)
 */
export const enforcementSignals: Record<string, EnforcementSignalEntry> = {} as Record<string, EnforcementSignalEntry>;

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
// Originally consumed by contrast-phrase-library.ts (deleted 2026-06-29) which
// rendered truthfulness guardrails into §8 of the system prompt based on the
// active mode.
//
// TODO: review and research — 2026-06-29
// After the guardrails removal, this function is no longer consumed by the
// prompt-builder (the listener and contrast-phrase-library are gone). Kept
// because:
//   1. It encodes a useful enforcement-state → mode mapping (errors →
//      TOOL-RELIABILITY, overflow recovery → EPISTEMIC-CALIBRATION, edit-
//      without-think → CORRECTION, default → TRUTH-SEEKING).
//   2. The mode taxonomy may be reusable for future routing — whisper
//      injection keyed on mode, test fixtures, enforcement dashboards.
//   3. The two emission sites (turn-end-handler.ts, register-session-compact.ts)
//      still fire `enforcement_signals { contrastMode }` but nothing listens.
//      Either wire a new consumer or delete the emissions + this function.
//
// Decision: keep for now, surface for review in next session.
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
