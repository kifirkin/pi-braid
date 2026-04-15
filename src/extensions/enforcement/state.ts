/**
 * Enforcement state - Central state management
 */

import type { JudgeAnalysis } from "./judge.js";
import type { EnforcementConfig, ToolChainState, ToolSequencePattern, TurnState } from "./types.js";

export const DEFAULT_CONFIG: EnforcementConfig = {
	requireReasoning: true,
	requirePlan: true,
	requireToolJustification: true,
	enforceScratchpad: true,
	enforceThinkBeforeEdit: true,
	enforceHypothesisBeforeFix: true,
	enforceMemory: true,
	enforceMemoryNudge: true,
	enforceMemoryOnFinalize: true,
	// Context tool enforcement
	enforceContextTools: true,
	contextToolNudgeInterval: 20, // Nudge every N turns without context tools
	enforceToolDiversity: true,
	enforceExploreBeforeAct: true,
	memoryNudgeThreshold: 15, // Lower threshold for proactive memory nudges
	minToolCallsBeforeFinalize: 5,
	maxSilentTurns: 2,
	warnOnToolSequenceRepetition: 3,
	blockThinkBeforeEdit: false, // DEPRECATED: no longer blocks, kept for config compat
	blockExploreBeforeWrite: true,
	blockFinalizeWithoutMemory: true,
	blockDangerousCommands: false, // Changed: now warns instead of blocks (see warnDangerousCommandsFirst)
	thinkCalledInSession: false,
	exploreCalledInSession: false,
	enforceVerificationBeforeFinalize: true,
	enforceMemoryRecallOnStart: true,
	trackClaimsVsVerifications: true,
	maxClaimsBeforeVerification: 5,
	useJudge: true,
	judgeCooldownMs: 20000,
	judgeSkipTurns: 1,
	// Tool Analysis Nudge
	toolAnalysisWarningThreshold: 0.15,
	toolAnalysisWarningTurns: 10,
	// Verification Judge (LLM-based work audit)
	useVerificationJudge: true,
	verificationJudgeInterval: 15,
	verifyBeforeFinalize: true,
	verifyAfterCodeChanges: true,
	enforceFinalizeValidation: true,
	minFinalizeCoverageScore: 0.4,
	blockFinalizeOnLowCoverage: false,
	// Dangerous command enforcement
	warnDangerousCommandsFirst: true, // First dangerous: block+warn with retry option. Then: warn only.
};

export const state = {
	config: { ...DEFAULT_CONFIG },
	turnHistory: new Map<number, TurnState>(),
	currentTurn: 0,
	recentToolSequences: [] as string[][],
	toolSequencePatterns: new Map<string, ToolSequencePattern>(),
	recentlyReadFiles: new Map<string, number>(), // path -> last turn read
	silentTurns: 0,
	enforcementActive: true,
	validationFailures: 0 as number,
	escalationCounts: {} as Record<string, number>,
	lastNudgeTime: 0,
	nudgeCooldownMs: 15000,
	toolChain: {
		lastThinkCall: 0,
		lastPlanCall: 0,
		recentEditWithoutThink: [] as number[],
		recentEditWithoutPlan: [] as number[],
	} as ToolChainState,
	lastMemoryCall: 0,
	turnsSinceMemory: 0,
	memoryNudgeSent: false,
	totalToolCalls: 0,
	toolCallsSinceLastMemory: 0,
	finalizeBlocked: 0,
	memoryAnalysisCount: 0,
	toolAnalysisRatio: 0,
	lastAnalysisTurn: 0,
	recordFailureCount: 0,
	hasRecordedFailure: false,
	lastFailedToolTurn: -100,
	taskCompleteCount: 0,
	hasCompletedTask: false,
	uniqueToolsUsed: new Set<string>(),
	bashCalls: 0,
	toolDiversityNudged: false,
	hasExplored: false,
	turnsSinceExplore: 0,
	exploreBeforeActNudged: false,
	claimsWithoutVerification: 0,
	verificationsDone: 0,
	hasRecalledOnStart: false,
	firstWorkDone: false,
	claimsDetectedThisTurn: false,
	hasCodeChanges: false,
	lastScratchpadNudgeTurn: -100,
	pendingToolErrors: null as { toolName: string; turn: number } | null,
	hadToolErrors: false,
	scratchpadContent: "" as string,
	lastJudgeTime: 0,
	judgeSkipCounter: 0,
	lastJudgeAnalysis: null as JudgeAnalysis | null,
	lastLazyNudgeTime: 0,
	// Track one-shot warnings injected into system prompt (avoid repetition)
	memoryNudgeWarned: false,
	silentTurnWarned: false,
	// Verification judge tracking
	lastVerificationJudgeTurn: 0,
	verificationJudgeRunning: false,
	toolLog: [] as string[],
	// Finalize validation context (set by agent/session setup)
	goalAlignmentData: [] as unknown[],
	// Context hygiene monitoring
	lastContextCheckTurn: 0,
	contextCheckInterval: 8, // Check every N turns
	contextNudgeSent: false,
	contextAuditThreshold: 0.7, // Nudge when usage > 70%
	highContextNudged: false,
	// Context tool usage tracking
	lastContextToolCall: 0,
	turnsSinceContextTool: 0,
	contextToolNudged: false,
	// Track warned dangerous commands for 2-stage enforcement (command hash -> turn first warned)
	warnedDangerousCommands: new Map<string, number>(),
	// Memory hygiene: combined score (scratchpad + memory + context)
	memoryHygieneScore: 1.0, // 0-1, derived from usage patterns
	lastHygieneNudgeTurn: 0,
	hygieneNudgeInterval: 25,
	originalRequest: undefined as string | undefined,
	planAlignmentData: null as {
		id: string;
		description: string;
		status: string;
		steps: { description: string; status: string; expectedOutcome: string; actualOutcome?: string }[];
	} | null,
};

export function resetState(): void {
	state.turnHistory.clear();
	state.recentToolSequences = [];
	state.recentlyReadFiles.clear();
	state.toolSequencePatterns.clear();
	state.silentTurns = 0;
	state.validationFailures = 0;
	state.currentTurn = 0;
	state.toolChain = {
		lastThinkCall: 0,
		lastPlanCall: 0,
		recentEditWithoutThink: [],
		recentEditWithoutPlan: [],
	};
	state.lastMemoryCall = 0;
	state.turnsSinceMemory = 0;
	state.memoryNudgeSent = false;
	state.totalToolCalls = 0;
	state.toolCallsSinceLastMemory = 0;
	state.finalizeBlocked = 0;
	state.uniqueToolsUsed.clear();
	state.bashCalls = 0;
	state.toolDiversityNudged = false;
	state.hasExplored = false;
	state.turnsSinceExplore = 0;
	state.exploreBeforeActNudged = false;
	state.claimsWithoutVerification = 0;
	state.verificationsDone = 0;
	state.hasRecalledOnStart = false;
	state.firstWorkDone = false;
	state.claimsDetectedThisTurn = false;
	state.hasCodeChanges = false;
	state.config.thinkCalledInSession = false;
	state.config.exploreCalledInSession = false;
	state.pendingToolErrors = null;
	state.hadToolErrors = false;
	// Reset analysis tracking
	state.memoryAnalysisCount = 0;
	state.toolAnalysisRatio = 0;
	state.lastAnalysisTurn = 0;
	state.recordFailureCount = 0;
	state.hasRecordedFailure = false;
	state.lastFailedToolTurn = -100;
	state.taskCompleteCount = 0;
	state.hasCompletedTask = false;
	state.lastScratchpadNudgeTurn = -100;
	state.claimsWithoutVerification = 0;
	state.verificationsDone = 0;
	// Reset nudge/escalation tracking
	state.lastNudgeTime = 0;
	state.escalationCounts = {};
	state.lastJudgeTime = 0;
	state.judgeSkipCounter = 0;
	state.lastJudgeAnalysis = null;
	state.lastLazyNudgeTime = 0;
	// Reset one-shot tracking
	state.memoryNudgeWarned = false;
	state.silentTurnWarned = false;
	// Reset verification judge tracking
	state.lastVerificationJudgeTurn = 0;
	state.verificationJudgeRunning = false;
	state.toolLog = [];
	// Reset finalize validation context
	state.originalRequest = undefined;
	state.goalAlignmentData = [];
	state.planAlignmentData = null;
	// Reset context hygiene monitoring
	state.lastContextCheckTurn = 0;
	state.contextCheckInterval = 10;
	state.contextNudgeSent = false;
	state.contextAuditThreshold = 0.7;
	state.lastContextToolCall = 0;
	state.turnsSinceContextTool = 0;
	state.contextToolNudged = false;
	state.highContextNudged = false;
	// Reset dangerous command warnings
	state.warnedDangerousCommands = new Map();
}
