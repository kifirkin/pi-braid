/**
 * Self-Harness Loop (LP-1) — Public API
 *
 * Phase 1-2: Failure Trace Collection + Weakness Mining + Harness Proposal
 *
 * Usage:
 *   import { collectAllFailureSignatures, mineWeaknesses, summarizeClusters } from "../lib/harness/index.js";
 *
 *   // In heartbeat module or turn-end handler:
 *   const collected = collectAllFailureSignatures(ctx);
 *   const state = getHarnessState(ctx);
 *   const clusters = mineWeaknesses(state.signatures, turnCount);
 *   const summary = summarizeClusters(clusters);
 *   whisper(summary);
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type {
  FailureSignature,
  FailureSignatureType,
  WeaknessCluster,
  HarnessTargetSurface,
  HarnessState,
  HarnessProposal,
  CandidateEdit,
  ProposalStatus,
  ProposalEffort,
  ValidationEval,
  ValidationResult,
} from "./types.js";

export { createHarnessState } from "./types.js";

// ── Failure Trace Collector ────────────────────────────────────────────────

export {
  getHarnessState,
  collectAllFailureSignatures,
  collectToolLoopSignatures,
  collectErrorBurstSignatures,
  collectValidationFailureSignatures,
  getCollectedCount,
  resetHarnessState,
} from "./failure-trace-collector.js";

// ── Weakness Miner ─────────────────────────────────────────────────────────

export {
  mineWeaknesses,
  summarizeClusters,
} from "./weakness-miner.js";

// ── Harness Proposer ────────────────────────────────────────────────────────

export {
  generateProposal,
  generateAllPendingProposals,
} from "./harness-proposer.js";

// ── Harness Validator ───────────────────────────────────────────────────────

export {
  validateCandidate,
  validateProposal,
  generateAllPendingValidations,
  applyParetoAcceptance,
} from "./harness-validator.js";