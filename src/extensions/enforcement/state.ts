/**
 * Enforcement state — session-scoped state management.
 *
 * REFACTORED: Composed from focused sub-states instead of one flat factory.
 * Each sub-state file owns its properties and provides its own reset logic.
 * All exports preserved for backward compatibility.
 *
 * Access pattern:
 *   const enState = getState(ctx);
 *   enState.totalToolCalls++;  // direct property access (same as before)
 *   recordToolChainCall(enState, "edit", ctx);  // helper from tool-tracking-state
 *
 * Sub-state files:
 *   session-state.ts          — turn tracking, config, drift detector
 *   tool-tracking-state.ts    — tool usage, edit tracking, calibration
 *   error-tracking-state.ts   — errors, validation failures, nudge cooldowns
 *   behavioral-state.ts       — memory hygiene, scratchpad, context hygiene, thought chains
 *   context-hygiene-state.ts  — context nudge helpers (accesses shared state)
 *   memory-hygiene-state.ts   — memory nudge helpers
 *   thought-chain-state.ts    — think() tracking helpers
 *   verification-judge-state.ts — judge/calibration helpers
 */

import { createLogger } from "../../lib/logger.js";
import type { TurnState } from "./types.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "../../lib/extension-state.js";

// Import sub-state factories and resets
import { createToolTrackingState, resetToolTrackingState, type ToolTrackingState } from "./tool-tracking-state.js";
import { createErrorTrackingState, resetErrorTrackingState, type ErrorTrackingState } from "./error-tracking-state.js";
import { createBehavioralState, resetBehavioralState, type BehavioralState } from "./behavioral-state.js";
import { createSessionState, resetSessionState, type SessionState } from "./session-state.js";

// Re-export sub-module helpers (backward compat — consumers import from state.ts)
export {
  startJudge,
  completeJudge,
  shouldRunJudge,
  recordCalibration,
  getCalibrationError,
} from "./verification-judge-state.js";
export {
  markNudgeSent,
  resetNudge,
  recordContextTool,
  recordCompaction,
  recordOverflow,
  inOverflowRecovery,
  shouldCheckContext,
  getContextNudgeMessage,
} from "./context-hygiene-state.js";
export {
  recordMemoryAccess,
  incrementTurnsSinceMemory,
  resetTurnsSinceMemory,
  shouldNudgeForMemory,
  markMemoryNudgeSent,
  resetMemoryHygiene,
} from "./memory-hygiene-state.js";
export {
  recordThink,
  incrementToolsSinceReflection,
  recordSilentTurn,
  resetSilentTurns,
  isTooSilent,
  getReflectionGapMessage,
  resetThoughtChain,
} from "./thought-chain-state.js";
export { isErrorBurst, updateErrorBurst } from "./error-tracking-state.js";
export { recordToolChainCall, type CalibrationPair } from "./tool-tracking-state.js";

const log = createLogger("enforcement");

// ── Tunable thresholds ─────────────────────────────────────────────────────

export const ENFORCEMENT_PARAMS = {
  memoryNudgeThreshold: 15,
  maxSilentTurns: 6,
  warnOnToolSequenceRepetition: 3,
  judgeCooldownMs: 20000,
  judgeSkipTurns: 1,
  verificationJudgeInterval: 15,
  maxClaimsBeforeVerification: 5,
  blockExploreBeforeWrite: true,
  blockThinkBeforeEdit: false, // DEPRECATED
} as const;

// ── Composed state type ────────────────────────────────────────────────────

/** Full enforcement state — intersection of all sub-states. */
export interface EnforcementState extends ToolTrackingState, ErrorTrackingState, BehavioralState, SessionState {}

// ── State factory (composed from sub-states) ───────────────────────────────

export function createState(): EnforcementState {
  return {
    ...createToolTrackingState(),
    ...createErrorTrackingState(),
    ...createBehavioralState(),
    ...createSessionState(),
  } as EnforcementState;
}

export function getState(ctx: ExtensionContext): EnforcementState {
  return getExtensionState(ctx, "enforcement", createState);
}

// ── Resets (delegates to each sub-state) ───────────────────────────────────

export function resetState(s: EnforcementState): void {
  resetSessionState(s);
  resetToolTrackingState(s);
  resetErrorTrackingState(s);
  resetBehavioralState(s);
}

// ── Accessor helpers (cross-cutting — not owned by any single sub-state) ───

/** Reset scratchpad nudge timer (called when agent uses scratchpad). */
export function resetScratchpadNudge(s: EnforcementState): void {
  s.lastScratchpadNudgeTurn = -100;
}
