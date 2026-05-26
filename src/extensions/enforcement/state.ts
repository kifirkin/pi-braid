/**
 * Enforcement state — session-scoped state management.
 *
 * Composed from focused sub-state interfaces instead of one flat factory.
 * Each sub-state file owns its properties, factory, and reset logic.
 * Sub-state files do NOT import state.ts (avoids circular dependency).
 *
 * Sub-state files:
 *   tool-tracking-state.ts      — tool usage, edit tracking, calibration
 *   error-tracking-state.ts     — errors, validation failures, nudge cooldowns
 *   session-state.ts            — turn tracking, config, drift detector
 *   memory-hygiene-state.ts     — memory tool usage and nudges
 *   scratchpad-state.ts         — scratchpad usage and verification nudges
 *   context-hygiene-state.ts    — context usage, compaction, overflow
 *   thought-chain-state.ts      — think() tracking and reflection gaps
 *   verification-judge-state.ts — judge/calibration helpers
 */

import { createLogger } from "../../lib/logger.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "../../lib/extension-state.js";

// Import sub-state factories and resets
import {
  createToolTrackingState,
  resetToolTrackingState,
  type ToolTrackingState,
} from "./tool-tracking-state.js";
import {
  createErrorTrackingState,
  resetErrorTrackingState,
  type ErrorTrackingState,
} from "./error-tracking-state.js";
import { createSessionState, resetSessionState, type SessionState } from "./session-state.js";
import {
  createMemoryHygieneState,
  resetMemoryHygieneState,
  type MemoryHygieneState,
} from "./memory-hygiene-state.js";
import {
  createScratchpadState,
  resetScratchpadState,
  type ScratchpadState,
} from "./scratchpad-state.js";
import {
  createContextHygieneState,
  resetContextHygieneState,
  type ContextHygieneState,
} from "./context-hygiene-state.js";
import {
  createThoughtChainState,
  resetThoughtChainState,
  type ThoughtChainState,
} from "./thought-chain-state.js";

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
export interface EnforcementState
  extends ToolTrackingState, ErrorTrackingState, SessionState,
    MemoryHygieneState, ScratchpadState, ContextHygieneState, ThoughtChainState {}

// ── State factory (composed from sub-states) ───────────────────────────────

export function createState(): EnforcementState {
  const state = {
    ...createToolTrackingState(),
    ...createErrorTrackingState(),
    ...createSessionState(),
    ...createMemoryHygieneState(),
    ...createScratchpadState(),
    ...createContextHygieneState(),
    ...createThoughtChainState(),
  } as EnforcementState;
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
