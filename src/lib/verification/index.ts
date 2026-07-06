/**
 * Verification — LP-2 Bidirectional Verifier public API.
 *
 * Provides forward trace, backward check, and coordination checking
 * for cross-file verification during and after edits.
 *
 * Usage:
 *   import { traceForward, backwardCheck, checkCoordination, checkAll } from "./index.js";
 *
 *   const results = await checkAll(ctx, editedFile, cwd, turn, problem);
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { traceForward, summarizeForwardTrace } from "./forward-tracer.js";
import type { ForwardTraceResult, ConsumerInfo } from "./forward-tracer.js";
import { backwardCheck } from "./backward-checker.js";
import type { BackwardCheckResult } from "./backward-checker.js";
import {
  registerDerived,
  unregisterDerived,
  checkCoordination,
  recordCoordinationEdit,
  getCoordinationState,
  clearCoordinationState,
} from "./coordination-checker.js";
import type {
  CoordinationEntry,
  CoordinationState,
  CoordinationWarning,
} from "./coordination-checker.js";

// ── Re-exports ────────────────────────────────────────────────────────────

export { traceForward, summarizeForwardTrace } from "./forward-tracer.js";
export type { ForwardTraceResult, ConsumerInfo } from "./forward-tracer.js";
export { backwardCheck } from "./backward-checker.js";
export type { BackwardCheckResult } from "./backward-checker.js";
export {
  registerDerived,
  unregisterDerived,
  checkCoordination,
  recordCoordinationEdit,
  getCoordinationState,
  clearCoordinationState,
} from "./coordination-checker.js";
export type {
  CoordinationEntry,
  CoordinationState,
  CoordinationWarning,
} from "./coordination-checker.js";

// ── Convenience: Check All ────────────────────────────────────────────────

/**
 * Results from running all LP-2 checks for a single edit.
 */
export interface AllCheckResults {
  forwardTrace: ForwardTraceResult | null;
  coordinationWarnings: CoordinationWarning[];
  backwardCheck: BackwardCheckResult | null;
  summary: string;
}

/**
 * Run all LP-2 checks for a single edit.
 */
export async function checkAll(
  ctx: ExtensionContext,
  editedFile: string,
  cwd: string,
  currentTurn: number,
  problem?: string,
  changeDescription?: string,
  symptom?: string,
  verifyResult?: string,
): Promise<AllCheckResults> {
  const ftResult = await traceForward(editedFile, cwd).catch(() => null);
  const coordWarnings = checkCoordination(ctx, editedFile, currentTurn);

  let bcResult: BackwardCheckResult | null = null;
  if (problem && changeDescription) {
    bcResult = await backwardCheck(
      ctx,
      problem,
      editedFile,
      changeDescription,
      symptom ?? "N/A",
      verifyResult ?? "Verification completed.",
    ).catch(() => null);
  }

  const lines: string[] = ["## Bidirectional Verification"];
  if (ftResult && ftResult.totalDownstream > 0) {
    lines.push(`Forward trace: ${ftResult.totalDownstream} downstream consumer(s).`);
    for (const c of ftResult.directConsumers.slice(0, 5)) {
      lines.push(`  - ${c.path}`);
    }
    if (ftResult.directConsumers.length > 5) {
      lines.push(`  - ... and ${ftResult.directConsumers.length - 5} more`);
    }
  } else {
    lines.push("Forward trace: no downstream consumers.");
  }

  if (coordWarnings.length > 0) {
    lines.push(`Coordination: ${coordWarnings.length} warning(s).`);
    for (const w of coordWarnings) {
      lines.push(`  - ${w.message}`);
    }
  } else {
    lines.push("Coordination: no warnings.");
  }

  if (bcResult) {
    lines.push(
      `Backward check: ${bcResult.passes ? "PASS" : "FAIL"} ` +
      `(confidence: ${bcResult.confidence}). ${bcResult.reason}`,
    );
  }

  lines.push("");

  return {
    forwardTrace: ftResult,
    coordinationWarnings: coordWarnings,
    backwardCheck: bcResult,
    summary: lines.join("\n"),
  };
}