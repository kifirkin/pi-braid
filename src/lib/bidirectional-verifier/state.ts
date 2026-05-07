/**
 * Bidirectional Verifier — state management.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "../extension-state.js";
import type { BidirectionalVerifierState } from "./types.js";

function createState(): BidirectionalVerifierState {
  return {
    problemFiles: new Set(),
    readFiles: new Set(),
    editedFiles: new Set(),
    touchTurns: new Map(),
    localizationRisks: [],
  };
}

export function getVerifierState(ctx: ExtensionContext): BidirectionalVerifierState {
  return getExtensionState(ctx, "bidirectional-verifier", createState);
}
