/**
 * Behavioral State — memory hygiene, scratchpad, context hygiene, thought chains.
 *
 * Owns: memory tracking, scratchpad nudges, context usage, thought chains,
 *       claim verification, memory hygiene scoring.
 */

export interface BehavioralState {
  // Memory hygiene
  lastMemoryCall: number;
  turnsSinceMemory: number;
  memoryNudgeSent: boolean;
  toolCallsSinceLastMemory: number;
  toolCallsAtLastRecommendation: number;

  // Scratchpad
  lastScratchpadNudgeTurn: number;
  claimsDetectedThisTurn: boolean;
  claimsWithoutVerification: number;
  verificationsDone: number;

  // Context hygiene
  contextNudgeSent: boolean;
  lastContextCheckTurn: number;
  lastCompactionTurn: number;
  overflowRecently: number;
  contextCheckInterval: number;
  contextAuditThreshold: number;

  // Thought chains
  thoughtChains: { id: string; parentId: string | null; type: string; timestamp: number }[];
  toolsSinceReflection: number;
  silentTurns: number;

  // Memory hygiene score (deprecated — keep for compat)
  memoryHygieneScore: number;
  lastHygieneNudgeTurn: number;
  hygieneNudgeInterval: number;
}

export function createBehavioralState(): BehavioralState {
  return {
    lastMemoryCall: 0,
    turnsSinceMemory: 0,
    memoryNudgeSent: false,
    toolCallsSinceLastMemory: 0,
    toolCallsAtLastRecommendation: 0,
    lastScratchpadNudgeTurn: -100,
    claimsDetectedThisTurn: false,
    claimsWithoutVerification: 0,
    verificationsDone: 0,
    contextNudgeSent: false,
    lastContextCheckTurn: 0,
    lastCompactionTurn: 0,
    overflowRecently: 0,
    contextCheckInterval: 34,
    contextAuditThreshold: 0.66,
    thoughtChains: [],
    toolsSinceReflection: 0,
    silentTurns: 0,
    memoryHygieneScore: 1.0,
    lastHygieneNudgeTurn: 0,
    hygieneNudgeInterval: 55,
  };
}

export function resetBehavioralState(s: BehavioralState): void {
  s.lastMemoryCall = 0;
  s.turnsSinceMemory = 0;
  s.memoryNudgeSent = false;
  s.toolCallsSinceLastMemory = 0;
  s.toolCallsAtLastRecommendation = 0;
  s.lastScratchpadNudgeTurn = -100;
  s.claimsDetectedThisTurn = false;
  s.claimsWithoutVerification = 0;
  s.verificationsDone = 0;
  s.contextNudgeSent = false;
  s.lastContextCheckTurn = 0;
  s.lastCompactionTurn = 0;
  s.overflowRecently = 0;
  s.contextCheckInterval = 34;
  s.contextAuditThreshold = 0.66;
  s.thoughtChains = [];
  s.toolsSinceReflection = 0;
  s.silentTurns = 0;
  s.memoryHygieneScore = 1.0;
  s.lastHygieneNudgeTurn = 0;
  s.hygieneNudgeInterval = 55;
}