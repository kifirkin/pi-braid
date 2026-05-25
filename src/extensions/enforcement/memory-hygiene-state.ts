/**
 * Memory Hygiene — helpers for tracking memory tool usage and nudges.
 *
 * Pattern: helper functions take EnforcementState directly (no ctx import).
 */

import type { EnforcementState } from "./state.js";

/** Record that a memory tool was called. Resets nudge timer. */
export function recordMemoryAccess(s: EnforcementState, turn: number): void {
  s.lastMemoryCall = turn;
  s.turnsSinceMemory = 0;
  s.toolCallsSinceLastMemory = 0;
  s.memoryNudgeSent = false;
  if (!s.hasRecalledOnStart) s.hasRecalledOnStart = true;
}

/** Increment turns-since-memory counter (call on each non-memory turn). */
export function incrementTurnsSinceMemory(s: EnforcementState): void {
  s.turnsSinceMemory++;
}

/** Reset turns-since-memory (called when memory tool is used). */
export function resetTurnsSinceMemory(s: EnforcementState): void {
  s.turnsSinceMemory = 0;
}

/** Check if memory nudge should fire. Returns true if nudge was sent. */
export function shouldNudgeForMemory(
  s: EnforcementState,
  currentTurn: number,
  threshold = 20,
): boolean {
  return !s.memoryNudgeSent && s.hasCodeChanges && s.turnsSinceMemory >= threshold;
}

/** Mark memory nudge as sent. */
export function markMemoryNudgeSent(s: EnforcementState): void {
  s.memoryNudgeSent = true;
}

/** Reset all memory hygiene counters (on session start / compaction). */
export function resetMemoryHygiene(s: EnforcementState): void {
  s.lastMemoryCall = 0;
  s.turnsSinceMemory = 0;
  s.memoryNudgeSent = false;
  s.toolCallsSinceLastMemory = 0;
}