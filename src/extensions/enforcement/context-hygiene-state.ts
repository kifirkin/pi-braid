/**
 * Context Hygiene — sub-state for context usage, compaction, and overflow tracking.
 *
 * Pattern: sub-state view over EnforcementState properties (no separate store).
 * Follows the same design as verification-judge-state.ts.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getState, type EnforcementState } from "./state.js";
import {
  USAGE_WHISPER_CRITICAL,
  USAGE_COMPACT_MEDIUM,
  USAGE_TOKENS_SOFT,
  USAGE_TOKENS_WARNING,
} from "../../lib/context-thresholds.js";

// ── Focused view ──────────────────────────────────────────────────────────

export interface ContextHygieneView {
  /** Whether a context nudge has been sent this session. */
  nudgeSent: boolean;
  /** Last turn we checked context usage. */
  lastCheckTurn: number;
  /** Last turn compaction occurred. */
  lastCompactionTurn: number;
  /** The turn when overflow was last detected (0 = none). */
  overflowTurn: number;
  /** Turns between context usage checks. */
  checkInterval: number;
  /** Percentage threshold for audit triggering. */
  auditThreshold: number;
}

// ── Accessor ──────────────────────────────────────────────────────────────

export function getContextHygieneView(ctx: ExtensionContext): ContextHygieneView {
  const s = getState(ctx);
  return {
    get nudgeSent() { return s.contextNudgeSent; },
    get lastCheckTurn() { return s.lastContextCheckTurn; },
    get lastCompactionTurn() { return s.lastCompactionTurn; },
    get overflowTurn() { return s.overflowRecently; },
    get checkInterval() { return s.contextCheckInterval; },
    get auditThreshold() { return s.contextAuditThreshold; },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

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
  // Token-based (preventive, fires before percentage)
  if (usageTokens >= (USAGE_TOKENS_WARNING as number)) {
    return (
      `Context at ${Math.round(usageTokens / 1000)}K tokens (${Math.round(usagePercent)}%). ` +
      `Pipeline: context_tag → context_checkout → context_archive → compact (last resort).`
    );
  }
  if (usageTokens >= (USAGE_TOKENS_SOFT as number)) {
    return (
      `Context at ${Math.round(usageTokens / 1000)}K tokens. ` +
      `Consider pruning old tool results (context_prune dry-run) or tagging position.`
    );
  }
  // Percentage-based (original)
  if (usagePercent >= (USAGE_COMPACT_MEDIUM as number)) {
    return (
      `Context at ${Math.round(usagePercent)}%. Pipeline: context_tag → context_checkout → ` +
      `context_archive → compact (last resort). Tag your position first.`
    );
  }
  if (usagePercent >= (USAGE_WHISPER_CRITICAL as number)) {
    return (
      `Context at ${Math.round(usagePercent)}%. Tag with context_tag, then ` +
      `context_checkout to branch with a summary.`
    );
  }
  return null;
}