/**
 * Thought Chain — state interface and helpers for think() tracking.
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

// ── Helpers ────────────────────────────────────────────────────────────

/** Record a think() call in the chain. */
export function recordThink(
  s: ThoughtChainState & { lastThinkConfidence?: number | null },
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

  if (typeof confidence === "number" && "lastThinkConfidence" in s) {
    (s as { lastThinkConfidence?: number | null }).lastThinkConfidence = confidence;
  }
}

/** Increment tools-since-reflection counter (call on non-think tool calls). */
export function incrementToolsSinceReflection(s: ThoughtChainState): void {
  s.toolsSinceReflection++;
}

/** Record a silent turn (no tool calls). */
export function recordSilentTurn(s: ThoughtChainState): void {
  s.silentTurns++;
}

/** Reset silent turns (call when tools are used). */
export function resetSilentTurns(s: ThoughtChainState): void {
  s.silentTurns = 0;
}

/** Check if silence has exceeded the threshold. */
export function isTooSilent(s: ThoughtChainState, maxSilentTurns = 6): boolean {
  return s.silentTurns >= maxSilentTurns;
}

/** Get the reflection gap message, or null if no gap. */
export function getReflectionGapMessage(
  s: ThoughtChainState,
  minToolsSinceReflection = 8,
): string | null {
  if (s.toolsSinceReflection < minToolsSinceReflection) return null;
  return `${minToolsSinceReflection} turns without think() — consider think(observation, decision, reason) to track reasoning`;
}

/** Reset thought chain state. */
export function resetThoughtChain(s: ThoughtChainState): void {
  s.thoughtChains = [];
  s.toolsSinceReflection = 0;
  s.silentTurns = 0;
}
