/**
 * Verification Judge — helpers for judge/calibration state.
 *
 * Pattern: helper functions take EnforcementState directly (no ctx import).
 * View functions (getVerificationJudgeView) live in state.ts to avoid
 * circular dependencies.
 */

import type { EnforcementState } from "./state.js";

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