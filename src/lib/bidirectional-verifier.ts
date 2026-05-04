/**
 * Bidirectional Verifier — backward-compatible barrel re-export.
 *
 * All existing imports from "../../../lib/bidirectional-verifier.js" still work.
 * The actual implementation is in bidirectional-verifier/index.ts.
 */

export {
  getVerifierState,
  extractFileReferences,
  updateProblemContext,
  recordFileTouch,
  checkLocalizationRisk,
  filesAreRelated,
  getTouchGraphSummary,
  extractClaimedActions,
  recordClaimedActions,
  validateArtifact,
  getArtifactValidationSummary,
  validateCompletion,
  recordDerivedFrom,
  markDerivedResolved,
  checkCoordinationRisk,
  scanForDerivedFiles,
  getCoordinationCheckSummary,
  getFullVerificationReport,
  clearVerifierState,
} from "./bidirectional-verifier/index.js";
