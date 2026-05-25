/**
 * Memory Hygiene — sub-state for tracking memory tool usage and nudges.
 *
 * Pattern: sub-state view over EnforcementState properties (no separate store).
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getState, type EnforcementState } from "./state.js";

// ── Focused view ──────────────────────────────────────────────────────────

export interface MemoryHygieneView {
  /** Last turn a memory tool was called. */
  lastMemoryCall: number;
  /** Turns elapsed since last memory tool call. */
  turnsSinceMemory: number;
  /** Whether a memory nudge has been sent this session. */
  nudgeSent: boolean;
  /** Tool calls since last memory access. */
  toolCallsSinceLastMemory: number;
}

// ── Accessor ──────────────────────────────────────────────────────────────

export function getMemoryHygieneView(ctx: ExtensionContext): MemoryHygieneView {
  const s = getState(ctx);
  return {
    get lastMemoryCall() { return s.lastMemoryCall; },
    get turnsSinceMemory() { return s.turnsSinceMemory; },
    get nudgeSent() { return s.memoryNudgeSent; },
    get toolCallsSinceLastMemory() { return s.toolCallsSinceLastMemory; },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

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
export function markNudgeSent(s: EnforcementState): void {
  s.memoryNudgeSent = true;
}

/** Reset all memory hygiene counters (on session start / compaction). */
export function resetMemoryHygiene(s: EnforcementState): void {
  s.lastMemoryCall = 0;
  s.turnsSinceMemory = 0;
  s.memoryNudgeSent = false;
  s.toolCallsSinceLastMemory = 0;
}