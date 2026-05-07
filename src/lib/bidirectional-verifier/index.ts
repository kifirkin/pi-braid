/**
 * Bidirectional Verifier — barrel re-export + combined report.
 *
 * Phases:
 *   Phase 1: Forward Trace (file touch graph, localization risk)
 *   Phase 2: Artifact Validator (claimed actions vs actual edits)
 *   Phase 3: Backward Checker (completion against problem context)
 *   Phase 4: Coordination Checker (derived file dependencies)
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getVerifierState } from "./state.js";
import { getTouchGraphSummary } from "./phase1.js";
import { getArtifactValidationSummary, _resetArtifactState } from "./phase2.js";
import { validateCompletion } from "./phase3.js";
import { getCoordinationCheckSummary, _resetCoordinationState } from "./phase4.js";

// ── Phase 1 — re-export all ────────────────────────────────────────────────
export {
  getVerifierState,
  extractFileReferences,
  updateProblemContext,
  recordFileTouch,
  checkLocalizationRisk,
  filesAreRelated,
  getTouchGraphSummary,
} from "./phase1.js";

// ── Phase 2 — re-export all ────────────────────────────────────────────────
export {
  extractClaimedActions,
  recordClaimedActions,
  validateArtifact,
  getArtifactValidationSummary,
} from "./phase2.js";

// ── Phase 3 — re-export all ────────────────────────────────────────────────
export { validateCompletion } from "./phase3.js";

// ── Phase 4 — re-export all ────────────────────────────────────────────────
export {
  recordDerivedFrom,
  markDerivedResolved,
  checkCoordinationRisk,
  scanForDerivedFiles,
  getCoordinationCheckSummary,
} from "./phase4.js";

// ── Combined Report ─────────────────────────────────────────────────────────

export function getFullVerificationReport(ctx: ExtensionContext): string {
  const completion = validateCompletion(ctx);
  const lines: string[] = [];

  lines.push("=== Bidirectional Verifier Report ===", "");
  lines.push("--- Forward Trace (Phase 1) ---");
  lines.push(getTouchGraphSummary(ctx), "");
  lines.push("--- Artifact Validation (Phase 2) ---");
  lines.push(getArtifactValidationSummary(), "");
  lines.push("--- Backward Check (Phase 3) ---");
  lines.push(
    `Problem files touched: ${completion.problemFiles - completion.problemFilesNotTouched.length}/${completion.problemFiles}`,
  );
  if (completion.problemFilesNotTouched.length > 0) {
    lines.push(`Untouched problem files: ${completion.problemFilesNotTouched.join(", ")}`);
  }
  lines.push(`Verification score: ${(completion.verificationScore * 100).toFixed(0)}/100`);
  if (completion.verificationScore < 0.5)
    lines.push("WARNING: Low verification score — fix may not address the problem");
  lines.push("");
  lines.push("--- Coordination Check (Phase 4) ---");
  lines.push(getCoordinationCheckSummary());
  if (getCoordinationCheckSummary().includes("risks:")) {
    lines.push("WARNING: Derived files may need updates — coordination risk detected");
  }
  lines.push("");
  lines.push("To reset verifier state for a new task, call clearVerifierState().");

  return lines.join("\n");
}

// ── Reset ───────────────────────────────────────────────────────────────────

export function clearVerifierState(ctx: ExtensionContext): void {
  const state = getVerifierState(ctx);
  state.problemFiles.clear();
  state.readFiles.clear();
  state.editedFiles.clear();
  state.touchTurns.clear();
  state.localizationRisks = [];
  _resetArtifactState();
  _resetCoordinationState();
}
