/**
 * Session State — turn tracking, configuration, topic drift detector.
 *
 * Owns: current turn, turn history, original request, config,
 *       enforcement active flag, verification judge state, drift detector.
 */

import { TopicDriftDetector } from "../../lib/detection/topic-drift-detector.js";
import { ENFORCEMENT_PARAMS } from "./state.js";
import type { TurnState } from "./types.js";

export interface SessionState {
  currentTurn: number;
  turnHistory: Map<number, TurnState>;
  originalRequest: string | undefined;
  lastUserMessage: string;

  // Configuration
  config: { [K in keyof typeof ENFORCEMENT_PARAMS]: (typeof ENFORCEMENT_PARAMS)[K] };
  enforcementActive: boolean;

  // Verification judge (runs in background)
  verificationJudgeRunning: boolean;
  lastVerificationJudgeTurn: number;
  lastCalibrationWhisperTime: number;

  // Topic drift
  driftDetector: TopicDriftDetector;

  // Event bus integration
  _lastHeartbeatTick: number;
  /** Duration of the most recent turn in ms (from turn_complete event) */
  lastTurnDuration: number;

  // Conflict resolution tracking — IDs of pending conflicts and when they were detected
  pendingConflictIds: string[];
  /** Turn number when each conflict was first detected (conflictId → turn) */
  conflictDetectionTurn: Map<string, number>;
}

export function createSessionState(): SessionState {
  return {
    currentTurn: 0,
    turnHistory: new Map(),
    originalRequest: undefined,
    lastUserMessage: "",
    config: { ...ENFORCEMENT_PARAMS },
    enforcementActive: true,
    verificationJudgeRunning: false,
    lastVerificationJudgeTurn: 0,
    lastCalibrationWhisperTime: 0,
    _lastHeartbeatTick: 0,
    lastTurnDuration: 0,
    pendingConflictIds: [],
    conflictDetectionTurn: new Map(),
    driftDetector: new TopicDriftDetector({
      minTurns: 4,
    }),
  };
}

export function resetSessionState(s: SessionState): void {
  s.currentTurn = 0;
  s.turnHistory.clear();
  s.originalRequest = undefined;
  s.lastUserMessage = "";
  s.verificationJudgeRunning = false;
  s.lastVerificationJudgeTurn = 0;
  s.lastCalibrationWhisperTime = 0;
  s._lastHeartbeatTick = 0;
  s.lastTurnDuration = 0;
  s.pendingConflictIds = [];
  s.conflictDetectionTurn.clear();
  s.driftDetector?.reset();
}
