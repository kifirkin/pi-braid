/**
 * Thought Chain — helpers for think() tool tracking and reflection gaps.
 *
 * Pattern: helper functions take EnforcementState directly (no ctx import).
 */

import type { EnforcementState } from "./state.js";

/** Record a think() call in the chain. */
export function recordThink(
  s: EnforcementState,
  type: string,
  parentId: string | null,
  confidence: number | undefined,
): void {
  const thoughtId = `t${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  s.thoughtChains.push({
    id: thoughtId,
    parentId,
    type,
    timestamp: Date.now(),
  });

  if (type === "reflection" || type === "conclusion") {
    s.toolsSinceReflection = 0;
  } else {
    s.toolsSinceReflection++;
  }

  if (typeof confidence === "number") {
    s.lastThinkConfidence = confidence;
  }
}

/** Increment tools-since-reflection counter (call on non-think tool calls). */
export function incrementToolsSinceReflection(s: EnforcementState): void {
  s.toolsSinceReflection++;
}

/** Record a silent turn (no tool calls). */
export function recordSilentTurn(s: EnforcementState): void {
  s.silentTurns++;
}

/** Reset silent turns (call when tools are used). */
export function resetSilentTurns(s: EnforcementState): void {
  s.silentTurns = 0;
}

/** Check if silence has exceeded the threshold. */
export function isTooSilent(s: EnforcementState, maxSilentTurns = 6): boolean {
  return s.silentTurns >= maxSilentTurns;
}

/** Get the reflection gap message, or null if no gap. */
export function getReflectionGapMessage(s: EnforcementState, minToolsSinceReflection = 8): string | null {
  if (s.toolsSinceReflection < minToolsSinceReflection) return null;
  return `${minToolsSinceReflection} turns without think() — consider think(observation, decision, reason) to track reasoning`;
}

/** Reset thought chain state. */
export function resetThoughtChain(s: EnforcementState): void {
  s.thoughtChains = [];
  s.toolsSinceReflection = 0;
  s.silentTurns = 0;
}