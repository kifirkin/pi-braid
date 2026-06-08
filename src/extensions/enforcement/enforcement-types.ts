/**
 * Enforcement types — shared interfaces and constants.
 *
 * This file exists to break the circular dependency between
 * state.ts ↔ session-state.ts (via ENFORCEMENT_PARAMS) and
 * state.ts ↔ verification-judge-state.ts (via EnforcementState).
 *
 * Both sub-state files can import from here without creating cycles.
 *
 * Contents:
 *   - ENFORCEMENT_PARAMS: the tunable thresholds config
 *   - EnforcementState:   the composed interface (intersection of sub-states)
 */

import type { ToolTrackingState } from "./tool-tracking-state.js";
import type { ErrorTrackingState } from "./error-tracking-state.js";
import type { SessionState } from "./session-state.js";
import type { MemoryHygieneState } from "./memory-hygiene-state.js";
import type { ScratchpadState, ContextHygieneState } from "./context-hygiene-state.js";
import type { ThoughtChainState } from "./thought-chain-state.js";

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
} as const;

// ── Composed state type ────────────────────────────────────────────────────

/** Full enforcement state — intersection of all sub-states. */
export interface EnforcementState
  extends
    ToolTrackingState,
    ErrorTrackingState,
    SessionState,
    MemoryHygieneState,
    ScratchpadState,
    ContextHygieneState,
    ThoughtChainState {}
