/**
 * Error Tracking State - consecutive errors, validation failures, nudge cooldowns.
 *
 * Owns: error burst tracking, validation failures, nudge rate-limiting timers.
 */

import { ERROR_TRACKING_NUDGE_COOLDOWN_MS } from "../../../lib/constants/session-thresholds.js";

export interface ErrorTrackingState {
  consecutiveErrorTurns: number;
  validationFailures: number;
  hasRecordedFailure: boolean;
  lastFailedToolTurn: number;
  escalationCounts: Record<string, number>;
  lastNudgeTime: number;
  nudgeCooldownMs: number;
  nudgeSuppressedCount: number;
}

export function createErrorTrackingState(): ErrorTrackingState {
  return {
    consecutiveErrorTurns: 0,
    validationFailures: 0,
    hasRecordedFailure: false,
    lastFailedToolTurn: -100,
    escalationCounts: {},
    lastNudgeTime: 0,
    nudgeCooldownMs: ERROR_TRACKING_NUDGE_COOLDOWN_MS,
    nudgeSuppressedCount: 0,
  };
}

export function resetErrorTrackingState(s: ErrorTrackingState): void {
  s.consecutiveErrorTurns = 0;
  s.validationFailures = 0;
  s.hasRecordedFailure = false;
  s.lastFailedToolTurn = -100;
  s.escalationCounts = {};
  s.lastNudgeTime = 0;
  s.nudgeSuppressedCount = 0;
}

// ── Accessor helpers ───────────────────────────────────────────────────────

export function isErrorBurst(s: ErrorTrackingState): boolean {
  return s.consecutiveErrorTurns >= 3;
}

export function updateErrorBurst(s: ErrorTrackingState, hadErrors: boolean): void {
  if (hadErrors) s.consecutiveErrorTurns++;
  else s.consecutiveErrorTurns = 0;
}
