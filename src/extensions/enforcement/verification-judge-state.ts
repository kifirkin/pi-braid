/**
 * Verification Judge — accessor and helpers for judge/calibration state.
 *
 * This module does NOT own its own state store. Instead it operates on the
 * relevant properties within EnforcementState, exposed via a focused interface.
 *
 * Pattern: sub-state view over a shared state object.
 * Callers can migrate from raw getState(ctx).propertyName to these helpers
 * without breaking backward compatibility.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getState, type EnforcementState } from "./state.js";

// ── Focused view of verification judge properties within EnforcementState ───

export interface VerificationJudgeView {
  /** Whether a verification judge is currently running (prevents re-entry). */
  isRunning: boolean;
  /** Last turn where verification judge completed. */
  lastRunTurn: number;
  /** Last time a judge was attempted (ms). */
  lastRunTime: number;
  /** Last time a calibration whisper was sent (ms). */
  lastCalibrationWhisperTime: number;
  /** Historical predicted vs actual pairs. */
  calibrationPairs: ReadonlyArray<{ predicted: number; actual: number; tool: string; turn: number }>;
  /** Most recent confidence value from think() tool. */
  lastConfidence: number | null;
}

// ── Accessor (returns a live view into EnforcementState) ────────────────────

export function getVerificationJudgeView(ctx: ExtensionContext): VerificationJudgeView {
  const s = getState(ctx);
  return {
    get isRunning() { return s.verificationJudgeRunning; },
    get lastRunTurn() { return s.lastVerificationJudgeTurn; },
    get lastRunTime() { return s.lastJudgeTime; },
    get lastCalibrationWhisperTime() { return s.lastCalibrationWhisperTime; },
    get calibrationPairs() { return s.calibrationPairs; },
    get lastConfidence() { return s.lastThinkConfidence; },
  };
}

// ── Helpers (mutate EnforcementState directly) ──────────────────────────────

/** Start the verification judge. Returns false if already running. */
export function startJudge(s: EnforcementState): boolean {
  if (s.verificationJudgeRunning) return false;
  s.verificationJudgeRunning = true;
  s.lastJudgeTime = Date.now();
  return true;
}

/** Mark the verification judge as complete for the given turn. */
export function completeJudge(s: EnforcementState, turn: number): void {
  s.verificationJudgeRunning = false;
  s.lastVerificationJudgeTurn = turn;
}

/** Check whether the judge should run (cooldown + turn gap). */
export function shouldRunJudge(
  s: EnforcementState,
  currentTurn: number,
  minTurnGap = 1,
  minTimeGapMs = 60_000,
): boolean {
  if (s.verificationJudgeRunning) return false;
  if (currentTurn - s.lastVerificationJudgeTurn < minTurnGap) return false;
  if (Date.now() - s.lastJudgeTime < minTimeGapMs) return false;
  return true;
}

/** Record a calibration pair. */
export function recordCalibration(
  s: EnforcementState,
  predicted: number,
  actual: number,
  tool: string,
  turn: number,
): void {
  s.calibrationPairs.push({ predicted, actual, tool, turn });
  if (s.calibrationPairs.length > 50) {
    s.calibrationPairs = s.calibrationPairs.slice(-50);
  }
}

/** Get average calibration error for recent N pairs, or null if insufficient data. */
export function getCalibrationError(s: EnforcementState, count = 10): number | null {
  if (s.calibrationPairs.length < count) return null;
  const recent = s.calibrationPairs.slice(-count);
  return recent.reduce((sum, p) => sum + Math.abs(p.predicted - p.actual), 0) / recent.length;
}

/** Check calibration and return avg error if above threshold. */
export function checkCalibrationDegradation(s: EnforcementState, threshold = 0.5): number | null {
  const error = getCalibrationError(s);
  if (error !== null && error > threshold) return error;
  return null;
}