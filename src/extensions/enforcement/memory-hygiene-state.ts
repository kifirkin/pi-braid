/**
 * Memory Hygiene — state interface and helpers for tracking memory tool usage.
 * Does NOT import state.ts (breaks circular dependency). Helpers use
 * intersection types instead of EnforcementState.
 */

export interface MemoryHygieneState {
  lastMemoryCall: number;
  turnsSinceMemory: number;
  memoryNudgeSent: boolean;
  toolCallsSinceLastMemory: number;
}

export function createMemoryHygieneState(): MemoryHygieneState {
  return {
    lastMemoryCall: 0,
    turnsSinceMemory: 0,
    memoryNudgeSent: false,
    toolCallsSinceLastMemory: 0,
  };
}

export function resetMemoryHygieneState(s: MemoryHygieneState): void {
  s.lastMemoryCall = 0;
  s.turnsSinceMemory = 0;
  s.memoryNudgeSent = false;
  s.toolCallsSinceLastMemory = 0;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Record that a memory tool was called. Resets nudge timer. */
export function recordMemoryAccess(
  s: MemoryHygieneState & { hasRecalledOnStart?: boolean },
  turn: number,
): void {
  s.lastMemoryCall = turn;
  s.turnsSinceMemory = 0;
  s.toolCallsSinceLastMemory = 0;
  s.memoryNudgeSent = false;
  if (!s.hasRecalledOnStart) s.hasRecalledOnStart = true;
}

/** Increment turns-since-memory counter (call on each non-memory turn). */
export function incrementTurnsSinceMemory(s: MemoryHygieneState): void {
  s.turnsSinceMemory++;
}

/** Reset turns-since-memory (called when memory tool is used). */
export function resetTurnsSinceMemory(s: MemoryHygieneState): void {
  s.turnsSinceMemory = 0;
}

/** Check if memory nudge should fire. Returns true if nudge was sent. */
export function shouldNudgeForMemory(
  s: MemoryHygieneState & { hasCodeChanges?: boolean },
  currentTurn: number,
  threshold = 20,
): boolean {
  return !s.memoryNudgeSent && !!s.hasCodeChanges && s.turnsSinceMemory >= threshold;
}

/** Mark memory nudge as sent. */
export function markMemoryNudgeSent(s: MemoryHygieneState): void {
  s.memoryNudgeSent = true;
}

/** Reset all memory hygiene counters (on session start / compaction). */
export function resetMemoryHygiene(s: MemoryHygieneState): void {
  s.lastMemoryCall = 0;
  s.turnsSinceMemory = 0;
  s.memoryNudgeSent = false;
  s.toolCallsSinceLastMemory = 0;
}
