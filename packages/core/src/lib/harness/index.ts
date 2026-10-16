/**
 * Self-Harness Loop — Public API
 *
 * Failure Trace Collection + Weakness Mining.
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
} from "./types.js";

export { createHarnessState } from "./types.js";

// ── Failure Trace Collector ────────────────────────────────────────────────

export {
  getHarnessState,
  collectAllFailureSignatures,
  collectToolLoopSignatures,
  getCollectedCount,
  resetHarnessState,
} from "./failure-trace-collector.js";

// ── Weakness Miner ─────────────────────────────────────────────────────────

export { mineWeaknesses, summarizeClusters } from "./weakness-miner.js";
