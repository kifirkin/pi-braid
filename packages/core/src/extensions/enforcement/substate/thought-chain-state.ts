import { nextId } from "../../../lib/utils/id.js";
/**
 * Thought Chain - state interface and helpers for think() tracking.
 * Does NOT import state.ts (breaks circular dependency).
 */

export interface ThoughtChainState {
  thoughtChains: { id: string; parentId: string | null; type: string; timestamp: number }[];
  toolsSinceReflection: number;
  silentTurns: number;
}

export function createThoughtChainState(): ThoughtChainState {
  return {
    thoughtChains: [],
    toolsSinceReflection: 0,
    silentTurns: 0,
  };
}

export function resetThoughtChainState(s: ThoughtChainState): void {
  s.thoughtChains = [];
  s.toolsSinceReflection = 0;
  s.silentTurns = 0;
}

/** Record a think() call in the chain. */
export function recordThink(
  s: ThoughtChainState & { lastThinkConfidence?: number | null },
  type: string,
  parentId: string | null,
  confidence: number | undefined,
): void {
  const thoughtId = nextId("t");
  s.thoughtChains.push({
    id: thoughtId,
    parentId,
    type,
    timestamp: Date.now(),
  });
  // Ring cap 500 — one small record per think() call; consumers only read
  // recent entries (reflection-gap counts are scalar, parent lookups target
  // recent chains).
  if (s.thoughtChains.length > 500) {
    s.thoughtChains = s.thoughtChains.slice(-500);
  }

  if (type === "reflection" || type === "conclusion") {
    s.toolsSinceReflection = 0;
  } else {
    s.toolsSinceReflection++;
  }

  if (typeof confidence === "number" && "lastThinkConfidence" in s) {
    (s as { lastThinkConfidence?: number | null }).lastThinkConfidence = confidence;
  }
}

/** Increment tools-since-reflection counter (call on non-think tool calls). */
export function incrementToolsSinceReflection(s: ThoughtChainState): void {
  s.toolsSinceReflection++;
}
