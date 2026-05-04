/**
 * Bidirectional Verifier — Phase 3: Backward Checker.
 *
 * Checks that completed tasks address the original problem context.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getVerifierState } from "./state.js";
import { filesAreRelated } from "./phase1.js";
import type { CompletionValidation } from "./types.js";

export function validateCompletion(ctx: ExtensionContext): CompletionValidation {
  const state = getVerifierState(ctx);
  const editedFiles = [...state.editedFiles];
  const problemFiles = [...state.problemFiles];

  const allTouched = new Set([...state.readFiles, ...state.editedFiles]);
  const problemFilesNotTouched = problemFiles.filter((pf) => {
    for (const touched of allTouched) {
      if (filesAreRelated(pf, touched)) return false;
    }
    return true;
  });

  let score = 1.0;
  if (problemFiles.length > 0) {
    score -= (problemFilesNotTouched.length / problemFiles.length) * 0.5;
  }
  if (state.localizationRisks.length > 0) {
    score -= Math.min(0.3, state.localizationRisks.length * 0.1);
  }
  if (state.editedFiles.size === 0 && state.readFiles.size > 0) {
    score -= 0.2;
  }
  score = Math.max(0, score);

  return {
    completedTurns: state.touchTurns.size ? Math.max(...state.touchTurns.values()) : 0,
    problemFiles: problemFiles.length,
    editedFiles: editedFiles.length,
    problemFilesNotTouched,
    verificationScore: score,
  };
}
