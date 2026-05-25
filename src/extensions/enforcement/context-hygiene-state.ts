/**
 * Context Hygiene — helpers for context usage, compaction, and overflow tracking.
 *
 * Pattern: helper functions take EnforcementState directly (no ctx import).
 */

import type { EnforcementState } from "./state.js";
import {
  USAGE_WHISPER_CRITICAL,
  USAGE_COMPACT_MEDIUM,
  USAGE_TOKENS_SOFT,
  USAGE_TOKENS_WARNING,
} from "../../lib/context-thresholds.js";

/** Mark context nudge as sent (system sends nudge to agent). */
export function markNudgeSent(s: EnforcementState, turn: number): void {
  s.contextNudgeSent = true;
  s.lastContextCheckTurn = turn;
}

/** Reset context nudge (e.g., after compaction freed space). */
export function resetNudge(s: EnforcementState): void {
  s.contextNudgeSent = false;
}

/** Record that a context management tool was used. */
export function recordContextTool(s: EnforcementState, turn: number): void {
  s.lastContextCheckTurn = turn;
  s.contextNudgeSent = false;
}

/** Record that compaction happened. */
export function recordCompaction(s: EnforcementState, turn: number): void {
  s.lastCompactionTurn = turn;
  s.lastContextCheckTurn = turn;
  s.contextNudgeSent = false;
  s.overflowRecently = turn;
  s.lastScratchpadNudgeTurn = turn;
}

/** Record overflow detection. */
export function recordOverflow(s: EnforcementState, turn: number): void {
  s.overflowRecently = turn;
}

/** Returns true if still in overflow recovery grace period. */
export function inOverflowRecovery(s: EnforcementState, currentTurn: number, graceTurns = 5): boolean {
  return currentTurn - s.overflowRecently < graceTurns;
}

/** Should we check context usage this turn? */
export function shouldCheckContext(s: EnforcementState, turn: number): boolean {
  return turn - s.lastContextCheckTurn >= s.contextCheckInterval && !s.contextNudgeSent;
}

/** Return the severity-based message for current context usage. */
export function getContextNudgeMessage(
  usagePercent: number,
  usageTokens: number,
): string | null {
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