/**
 * Scratchpad State — tracking scratchpad usage and verification nudges.
 * Does NOT import state.ts (breaks circular dependency).
 */

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
