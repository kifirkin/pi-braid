/**
 * Enforcement Signals — shared L1 signal state for prompt-builder.
 *
 * enforcementSignals is a writable object - prompt-builder reads it directly
 * (same process, no IPC needed). Turn-keyed so stale signals are dropped
 * when the turn advances without new signals.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getState } from "./state.js";

/** A single signal entry keyed by semantic type */
export interface EnforcementSignalEntry {
  turn: number;
  text: string;
  acted: boolean;
}

/**
 * L1 enforcement signals for prompt-builder surfacing.
 * Keyed by semantic type (memory, scratchpad, context_high, etc.)
 */
export const enforcementSignals: Record<string, EnforcementSignalEntry> = {};

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
  const RECOVERY_GRACE_TURNS = 5;
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
