/**
 * Enforcement types - Shared interfaces and type definitions
 */

export type EscalationLevel = "info" | "warning" | "critical";

export interface EnforcementConfig {
	requireReasoning: boolean;
	requirePlan: boolean;
	requireToolJustification: boolean;
	enforceScratchpad: boolean;
	enforceThinkBeforeEdit: boolean;
	enforceHypothesisBeforeFix: boolean;
	enforceMemory: boolean;
	enforceMemoryNudge: boolean;
	enforceMemoryOnFinalize: boolean;
	// Context tool enforcement
	enforceContextTools: boolean;
	contextToolNudgeInterval: number;
	enforceToolDiversity: boolean;
	enforceExploreBeforeAct: boolean;
	memoryNudgeThreshold: number;
	minToolCallsBeforeFinalize: number;
	maxSilentTurns: number;
	warnOnToolSequenceRepetition: number;
	// Blocking behavior
	blockThinkBeforeEdit: boolean; // DEPRECATED: no longer blocks, kept for config compat
	blockExploreBeforeWrite: boolean;
	blockFinalizeWithoutMemory: boolean;
	blockDangerousCommands: boolean;
	// Session tracking for blocking decisions
	thinkCalledInSession: boolean;
	exploreCalledInSession: boolean;
	// Agentic Loop Enforcement
	enforceVerificationBeforeFinalize: boolean;
	enforceMemoryRecallOnStart: boolean;
	trackClaimsVsVerifications: boolean;
	maxClaimsBeforeVerification: number;
	// LLM Judge
	useJudge: boolean;
	judgeCooldownMs: number;
	judgeSkipTurns: number;
	// Tool Analysis Nudge
	toolAnalysisWarningThreshold: number;
	toolAnalysisWarningTurns: number;
	// Verification Judge (LLM-based work audit)
	useVerificationJudge: boolean;
	verificationJudgeInterval: number;
	verifyBeforeFinalize: boolean;
	verifyAfterCodeChanges: boolean;
	// Finalize Validation (default: warn-only, not blocking)
	enforceFinalizeValidation: boolean;
	minFinalizeCoverageScore: number;
	blockFinalizeOnLowCoverage: boolean;
}

export interface TurnState {
	turnIndex: number;
	plannedTools: string[];
	actualTools: string[];
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
