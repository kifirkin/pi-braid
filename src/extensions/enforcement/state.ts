/**
 * Enforcement state - session-scoped state management.
 *
 * Composed from focused sub-state interfaces instead of one flat factory.
 * Each sub-state file owns its properties, factory, and reset logic.
 * Sub-state files do NOT import state.ts (avoids circular dependency).
 *
 * ENFORCEMENT_PARAMS and EnforcementState live in `enforcement-types.ts`
 * to break the state.ts ↔ session-state.ts cycle.
 *
 * Sub-state files:
 *   tool-tracking-state.ts      - tool usage, edit tracking, calibration
 *   error-tracking-state.ts     - errors, validation failures, nudge cooldowns
 *   session-state.ts            - turn tracking, config, drift detector
 *   memory-hygiene-state.ts     - memory tool usage and nudges
 *   scratchpad-state.ts         - scratchpad usage and verification nudges
 *   context-hygiene-state.ts    - context usage, compaction, overflow
 *   thought-chain-state.ts      - think() tracking and reflection gaps
 *   verification-judge-state.ts - judge/calibration helpers
 */

// ── Shared Constants ─────────────────────────────────────────────────────────

/** Consecutive error turns before a burst is declared. Centralized here. */
export const ERROR_BURST_THRESHOLD = 3;

/** Turns of grace after overflow recovery before signal priority resets. */
export const RECOVERY_GRACE_TURNS = 5;


import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../../lib/state/extension-state.js";

// Import shared types/constants for in-file use
import { type EnforcementState } from "./enforcement-types.js";

// Re-export shared types/constants (backward compat - consumers import from state.ts)
export { ENFORCEMENT_PARAMS, type EnforcementState } from "./enforcement-types.js";

// Import sub-state factories and resets
import {
  createToolTrackingState,
  resetToolTrackingState,
} from "./substate/tool-tracking-state.js";
import {
  createErrorTrackingState,
  resetErrorTrackingState,
} from "./substate/error-tracking-state.js";
import { createSessionState, resetSessionState } from "./substate/session-state.js";
import {
  createMemoryHygieneState,
  resetMemoryHygieneState,
} from "./substate/memory-hygiene-state.js";
import {
  createScratchpadState,
  resetScratchpadState,
  createContextHygieneState,
  resetContextHygieneState,
  type ScratchpadState,
} from "./substate/context-hygiene-state.js";
import {
  createThoughtChainState,
  resetThoughtChainState,
} from "./substate/thought-chain-state.js";

// Re-export sub-module helpers (backward compat - consumers import from state.ts)
export {
  startJudge,
  completeJudge,
  shouldRunJudge,
  recordCalibration,
  getCalibrationError,
} from "./substate/verification-judge-state.js";
export {
  markNudgeSent,
  resetNudge,
  recordContextTool,
  recordCompaction,
  recordOverflow,
  inOverflowRecovery,
  shouldCheckContext,
  getContextNudgeMessage,
} from "./substate/context-hygiene-state.js";
export {
  recordMemoryAccess,
  incrementTurnsSinceMemory,
  resetTurnsSinceMemory,
  shouldNudgeForMemory,
  markMemoryNudgeSent,
  resetMemoryHygiene,
} from "./substate/memory-hygiene-state.js";
export {
  recordThink,
  incrementToolsSinceReflection,
  recordSilentTurn,
  resetSilentTurns,
  isTooSilent,
  getReflectionGapMessage,
  resetThoughtChain,
} from "./substate/thought-chain-state.js";
export { isErrorBurst, updateErrorBurst } from "./substate/error-tracking-state.js";
export { recordToolChainCall, type CalibrationPair } from "./substate/tool-tracking-state.js";



// ── State factory (composed from sub-states) ───────────────────────────────

export function createState(): EnforcementState {
  // NOTE: No `as EnforcementState` cast here. If TypeScript reports an error,
  // it means two sub-states have overlapping keys with incompatible types -
  // which is a real bug the cast was hiding. Fix the sub-states, don't add the cast back.
  const state: EnforcementState = {
    ...createToolTrackingState(),
    ...createErrorTrackingState(),
    ...createSessionState(),
    ...createMemoryHygieneState(),
    ...createScratchpadState(),
    ...createContextHygieneState(),
    ...createThoughtChainState(),
  };
  return state;
}

export function getState(ctx: ExtensionContext): EnforcementState {
  return getExtensionState(ctx, "enforcement", createState);
}

// ── Resets (delegates to each sub-state) ───────────────────────────────────

export function resetState(s: EnforcementState): void {
  resetToolTrackingState(s);
  resetErrorTrackingState(s);
  resetSessionState(s);
  resetMemoryHygieneState(s);
  resetScratchpadState(s);
  resetContextHygieneState(s);
  resetThoughtChainState(s);
}

// ── Cross-cutting accessors ────────────────────────────────────────────────

/** Reset scratchpad nudge timer (called when agent uses scratchpad). */
export function resetScratchpadNudge(s: ScratchpadState): void {
  s.lastScratchpadNudgeTurn = -100;
}
