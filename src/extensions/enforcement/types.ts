


/**
 * Enforcement types - Shared interfaces and type definitions
 */

export type EscalationLevel = "info" | "warning" | "critical";

export interface EnforcementConfig {
  // Tunable parameters (thresholds and intervals)
  memoryNudgeThreshold: number;
  maxSilentTurns: number;
  warnOnToolSequenceRepetition: number;
  judgeCooldownMs: number;
  judgeSkipTurns: number;
  verificationJudgeInterval: number;
  maxClaimsBeforeVerification: number;
  // Blocking behavior
  blockExploreBeforeWrite: boolean;
}

export interface TurnState {
  turnIndex: number;
  plannedTools: string[];
  actualTools: string[];
  /** Truncated output summaries for verification-relevant tools (bash, verify, edit/write).
   *  Each entry: "toolName: <first ~300 chars of output>".
   *  Used by the verification judge at MESSAGE_END to see actual tool results. */
  toolOutputs: string[];
  scratchpadUpdated: boolean;
  memoryUpdated: boolean;
  sequenceRepetitionCount: number;
  thinkCalledBeforeEdit: boolean;
  planCalledForBugFix: boolean;
}

export interface ValidationResult {
  passed: boolean;
  issues: string[];
  nudge: string | null;
  severity: "info" | "warning" | "critical";
}

export interface ToolSequencePattern {
  sequence: string[];
  count: number;
  lastSeen: number;
}

export interface ToolChainState {
  lastThinkCall: number;
  lastPlanCall: number;
  recentEditWithoutThink: number[];
  recentEditWithoutPlan: number[];
}

export interface LazyPattern {
  regex: RegExp;
  message: string;
}

export interface ClaimPattern {
  regex: RegExp;
  message: string;
}
