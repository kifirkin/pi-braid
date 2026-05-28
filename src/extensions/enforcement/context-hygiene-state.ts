/**
 * Context Hygiene & Scratchpad — state interface and helpers for context usage
 * tracking and scratchpad nudge timing. Merged because both track nudge timing
 * and recordCompaction() already cross-references lastScratchpadNudgeTurn.
 * Does NOT import state.ts (breaks circular dependency).
 */

// ── Scratchpad sub-state ──────────────────────────────────────────────────

export interface ScratchpadState {
  lastScratchpadNudgeTurn: number;
  claimsDetectedThisTurn: boolean;
  claimsWithoutVerification: number;
  verificationsDone: number;
}

export function createScratchpadState(): ScratchpadState {
  return {
    lastScratchpadNudgeTurn: -100,
    claimsDetectedThisTurn: false,
    claimsWithoutVerification: 0,
    verificationsDone: 0,
  };
}

export function resetScratchpadState(s: ScratchpadState): void {
  s.lastScratchpadNudgeTurn = -100;
  s.claimsDetectedThisTurn = false;
  s.claimsWithoutVerification = 0;
  s.verificationsDone = 0;
}

// ── Context Hygiene sub-state ──────────────────────────────────────────────

export interface ContextHygieneState {
  contextNudgeSent: boolean;
  lastContextCheckTurn: number;
  lastCompactionTurn: number;
  overflowRecently: number;
  contextCheckInterval: number;
  contextAuditThreshold: number;
}

export function createContextHygieneState(): ContextHygieneState {
  return {
    contextNudgeSent: false,
    lastContextCheckTurn: 0,
    lastCompactionTurn: 0,
    overflowRecently: 0,
    contextCheckInterval: 34,
    contextAuditThreshold: 0.66,
  };
}

export function resetContextHygieneState(s: ContextHygieneState): void {
  s.contextNudgeSent = false;
  s.lastContextCheckTurn = 0;
  s.lastCompactionTurn = 0;
  s.overflowRecently = 0;
  s.contextCheckInterval = 34;
  s.contextAuditThreshold = 0.66;
}

// ── Helpers ────────────────────────────────────────────────────────────

import {
  USAGE_WHISPER_CRITICAL,
  USAGE_COMPACT_MEDIUM,
  USAGE_TOKENS_SOFT,
  USAGE_TOKENS_WARNING,
} from "../../lib/detection/context-thresholds.js";

/** Mark context nudge as sent (system sends nudge to agent). */
export function markNudgeSent(s: ContextHygieneState, turn: number): void {
  s.contextNudgeSent = true;
  s.lastContextCheckTurn = turn;
}

/** Reset context nudge (e.g., after compaction freed space). */
export function resetNudge(s: ContextHygieneState): void {
  s.contextNudgeSent = false;
}

/** Record that a context management tool was used. */
export function recordContextTool(s: ContextHygieneState, turn: number): void {
  s.lastContextCheckTurn = turn;
  s.contextNudgeSent = false;
}

/** Record that compaction happened. Also resets scratchpad nudge timer. */
export function recordCompaction(
  s: ContextHygieneState & { lastScratchpadNudgeTurn?: number },
  turn: number,
): void {
  s.lastCompactionTurn = turn;
  s.lastContextCheckTurn = turn;
  s.contextNudgeSent = false;
  s.overflowRecently = turn;
  if (typeof s.lastScratchpadNudgeTurn === "number") {
    s.lastScratchpadNudgeTurn = turn;
  }
}

/** Record overflow detection. */
export function recordOverflow(s: ContextHygieneState, turn: number): void {
  s.overflowRecently = turn;
}

/** Returns true if still in overflow recovery grace period. */
export function inOverflowRecovery(
  s: ContextHygieneState,
  currentTurn: number,
  graceTurns = 5,
): boolean {
  return currentTurn - s.overflowRecently < graceTurns;
}

/** Should we check context usage this turn? */
export function shouldCheckContext(s: ContextHygieneState, turn: number): boolean {
  return turn - s.lastContextCheckTurn >= s.contextCheckInterval && !s.contextNudgeSent;
}

/** Return the severity-based message for current context usage. */
export function getContextNudgeMessage(usagePercent: number, usageTokens: number): string | null {
  if (usageTokens >= USAGE_TOKENS_WARNING) {
    return (
      `Context at ${Math.round(usageTokens / 1000)}K tokens (${Math.round(usagePercent)}%). ` +
      `Pipeline: context_tag → context_checkout → context_archive → compact (last resort).`
    );
  }
  if (usageTokens >= USAGE_TOKENS_SOFT) {
    return (
      `Context at ${Math.round(usageTokens / 1000)}K tokens. ` +
      `Consider pruning old tool results (context_prune dry-run) or tagging position.`
    );
  }
  if (usagePercent >= USAGE_COMPACT_MEDIUM) {
    return (
      `Context at ${Math.round(usagePercent)}%. Pipeline: context_tag → context_checkout → ` +
      `context_archive → compact (last resort). Tag your position first.`
    );
  }
  if (usagePercent >= USAGE_WHISPER_CRITICAL) {
    return (
      `Context at ${Math.round(usagePercent)}%. Tag with context_tag, then ` +
      `context_checkout to branch with a summary.`
    );
  }
  return null;
}
