/**
 * Failure Trace Collector - passive observer that collects failure signatures
 * from existing detectors and stores them for Weakness Mining.
 *
 * Inspired by Opik's trace pipeline: every LLM call, tool invocation, and
 * agent step is recorded. Here, we record failure events from:
 *   - tool-loop-detector (repetitive same-tool calls)
 *   - error-tracking-state (error bursts)
 *   - turn-outcome detector (failed turn classification)
 *   - degradation detector (performance degradation)
 *
 * The collector is PURE OBSERVATION: it reads existing state, does not add
 * new instrumentation. This keeps the coupling minimal and the failure
 * surface bounded.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nextId } from "../utils/id.js";
import { getExtensionState } from "../state/extension-state.js";
import { createLogger } from "../core/logger.js";
import type {
  FailureSignature,
  FailureSignatureType,
  HarnessState,
} from "./types.js";
import { createHarnessState } from "./types.js";
import {
  getToolLoopState,
  detectToolLoop,
} from "../detection/tool-loop-detector.js";

// ── Module-level state key (used by getExtensionState) ─────────────────────

const HARNESS_STATE_KEY = "self-harness";

// ── Logger ─────────────────────────────────────────────────────────────────

const log = createLogger("harness:collector");

// ── State Accessors ────────────────────────────────────────────────────────

export function getHarnessState(ctx: ExtensionContext): HarnessState {
  return getExtensionState(ctx, HARNESS_STATE_KEY, createHarnessState);
}

// ── Dedup helpers ──────────────────────────────────────────────────────────

/**
 * Build a dedup key for a failure signature. Two signatures with the same
 * key are considered duplicates (same type + same tool/error in same turn).
 */
function dedupKey(sig: FailureSignature): string {
  return `${sig.type}:${sig.toolName ?? sig.errorPrefix ?? "unknown"}:${sig.turn}`;
}

/**
 * Check if a signature is already recorded (by dedup key).
 */
function isDuplicate(state: HarnessState, sig: FailureSignature): boolean {
  return state.seenPatterns.includes(dedupKey(sig));
}

/**
 * Record a signature into state, deduplicating.
 */
function recordSignature(state: HarnessState, sig: FailureSignature): void {
  if (isDuplicate(state, sig)) return;
  state.signatures.push(sig);
  state.totalCollected++;
  state.seenPatterns.push(dedupKey(sig));
}

// ── Signal Signatures ──────────────────────────────────────────────────────

/**
 * Create a failure signature from raw signal data.
 */
function makeSignature(
  type: FailureSignatureType,
  source: string,
  toolName: string | undefined,
  count: number,
  turn: number,
  message: string,
  errorPrefix?: string,
): FailureSignature {
  return {
    id: nextId("fsig"),
    type,
    source,
    toolName,
    count,
    turn,
    message,
    timestamp: new Date().toISOString(),
    errorPrefix,
  };
}

// ── Collection from Signal Sources ─────────────────────────────────────────

/**
 * Collect tool-loop signatures from the tool-loop-detector state.
 * Checks for any detected loops and records them as failure signatures.
 */
export function collectToolLoopSignatures(
  state: HarnessState,
  ctx: ExtensionContext,
): FailureSignature[] {
  const collected: FailureSignature[] = [];

  const loopState = getToolLoopState(ctx);
  const result = detectToolLoop(loopState);

  if (result.isLoop) {
    const sig = makeSignature(
      "tool-loop",
      "tool-loop-detector",
      result.tool,
      result.count,
      loopState.turnCount,
      result.message,
    );
    if (!isDuplicate(state, sig)) {
      recordSignature(state, sig);
      collected.push(sig);
      log.info(`Collected tool-loop: ${result.tool} x${result.count}`);
    }
  }

  return collected;
}

/**
 * Collect error-burst signatures from the error-tracking state.
 * Records when consecutive error turns exceed the burst threshold.
 */
export function collectErrorBurstSignatures(
  state: HarnessState,
  ctx: ExtensionContext,
): FailureSignature[] {
  const collected: FailureSignature[] = [];

  const enforcementState = getExtensionState(ctx, "enforcement", () => ({}));
  const errorState = (enforcementState as any).errorTracking;
  if (errorState && errorState.consecutiveErrorTurns >= 3) {
    const sig = makeSignature(
      "error-burst",
      "error-tracking",
      undefined,
      errorState.consecutiveErrorTurns,
      errorState.lastFailedToolTurn,
      `Error burst: ${errorState.consecutiveErrorTurns} consecutive error turns`,
    );
    // For error bursts, use the error count as dedup key
    const burstKey = `error-burst:burst:${errorState.consecutiveErrorTurns}`;
    if (!state.seenPatterns.includes(burstKey)) {
      state.seenPatterns.push(burstKey);
      recordSignature(state, sig);
      collected.push(sig);
      log.info(`Collected error-burst: ${errorState.consecutiveErrorTurns} consecutive`);
    }
  }

  return collected;
}

/**
 * Collect validation-failure signatures from the error-tracking state.
 */
export function collectValidationFailureSignatures(
  state: HarnessState,
  ctx: ExtensionContext,
): FailureSignature[] {
  const collected: FailureSignature[] = [];

  const enforcementState = getExtensionState(ctx, "enforcement", () => ({}));
  const errorState = (enforcementState as any).errorTracking;
  if (errorState && errorState.validationFailures > 0) {
    const sig = makeSignature(
      "validation-failure",
      "error-tracking",
      undefined,
      errorState.validationFailures,
      errorState.lastFailedToolTurn,
      `Validation failures: ${errorState.validationFailures} total`,
      "validation-failure",
    );
    if (!isDuplicate(state, sig)) {
      recordSignature(state, sig);
      collected.push(sig);
      log.info(`Collected validation-failure: ${errorState.validationFailures} total`);
    }
  }

  return collected;
}

/**
 * Collect all failure signatures from all available sources.
 * This is the main entry point for the heartbeat module.
 */
export function collectAllFailureSignatures(
  ctx: ExtensionContext,
): FailureSignature[] {
  const state = getHarnessState(ctx);
  const collected: FailureSignature[] = [];

  collected.push(...collectToolLoopSignatures(state, ctx));
  collected.push(...collectErrorBurstSignatures(state, ctx));
  collected.push(...collectValidationFailureSignatures(state, ctx));

  if (collected.length > 0) {
    log.info(
      `Collected ${collected.length} new failure signatures (total: ${state.totalCollected})`,
    );
  }

  return collected;
}

/**
 * Get the current number of collected signatures.
 */
export function getCollectedCount(ctx: ExtensionContext): number {
  return getHarnessState(ctx).totalCollected;
}

/**
 * Reset the harness state (for testing or session boundary).
 */
export function resetHarnessState(ctx: ExtensionContext): void {
  const state = getHarnessState(ctx);
  state.signatures = [];
  state.clusters = [];
  state.lastMiningTurn = -1;
  state.totalCollected = 0;
  state.hasMined = false;
  state.seenPatterns = [];
  log.info("Harness state reset");
}