/**
 * Enforcement state - Central state management
 */

import type { JudgeAnalysis } from "./judge.js";
import { TopicDriftDetector } from "../../lib/topic-drift-detector.js";
import type { EnforcementConfig, ToolChainState, ToolSequencePattern, TurnState } from "./types.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "../../lib/extension-state.js";

export const DEFAULT_CONFIG: EnforcementConfig = {
	requireReasoning: true,
	requirePlan: true,
	requireToolJustification: true,
	enforceScratchpad: true,
	enforceThinkBeforeEdit: true,
	enforceHypothesisBeforeFix: true,
	enforceMemory: true,
	enforceMemoryNudge: true,
	// Context tool enforcement

	enforceToolDiversity: true,
	enforceExploreBeforeAct: true,
	memoryNudgeThreshold: 15, // Lower threshold for proactive memory nudges
	maxSilentTurns: 6,
	warnOnToolSequenceRepetition: 3,
	blockThinkBeforeEdit: false, // DEPRECATED: no longer blocks, kept for config compat
	blockExploreBeforeWrite: true,
	thinkCalledInSession: false,
	exploreCalledInSession: false,
	enforceMemoryRecallOnStart: true,
	trackClaimsVsVerifications: true,
	maxClaimsBeforeVerification: 5,
	useJudge: true,
	judgeCooldownMs: 20000,
	judgeSkipTurns: 1,
	// Verification Judge (LLM-based work audit)
	useVerificationJudge: true,
	verificationJudgeInterval: 15,
	verifyAfterCodeChanges: true,
};

// ── State Factory ────────────────────────────────────────────────────────────

export function createState() {
	return {
		config: { ...DEFAULT_CONFIG },
		turnHistory: new Map<number, TurnState>(),
		currentTurn: 0,
		recentToolSequences: [] as string[][],
		toolSequencePatterns: new Map<string, ToolSequencePattern>(),
		recentlyReadFiles: new Map<string, number>(),
		silentTurns: 0,
		enforcementActive: true,
		validationFailures: 0 as number,
		escalationCounts: {} as Record<string, number>,
		lastNudgeTime: 0,
		nudgeCooldownMs: 3600_000,
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
		hasRecordedFailure: false,
		lastFailedToolTurn: -100,
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
		lastCodeChangeTurn: 0,
		lastScratchpadNudgeTurn: -100,
		lastJudgeTime: 0,
		judgeSkipCounter: 0,
		lastJudgeAnalysis: null as JudgeAnalysis | null,
		lastLazyNudgeTime: 0,
		lastVerificationJudgeTurn: 0,
		lastUserMessage: "",
		toolsSinceReflection: 0,
		thoughtChains: [] as Array<{ id: string; parentId: string | null; type: string; timestamp: number }>,
		calibrationPairs: [] as Array<{ predicted: number; actual: number; tool: string; turn: number }>,
		lastThinkConfidence: 0.5,
		verificationJudgeRunning: false,
		toolLog: [] as string[],
		lastContextCheckTurn: 0,
		contextCheckInterval: 21,
		contextNudgeSent: false,
		contextAuditThreshold: 0.66,
		lastCompactionTurn: 0,
		overflowRecently: 0,
		memoryHygieneScore: 1.0,
		lastHygieneNudgeTurn: 0,
		hygieneNudgeInterval: 55,
		originalRequest: undefined as string | undefined,
		planAlignmentData: null as {
			id: string;
			description: string;
			status: string;
			steps: { description: string; status: string; expectedOutcome: string; actualOutcome?: string }[];
		} | null,
		driftDetector: new TopicDriftDetector({ topicThreshold: 0.15, minTurns: 4, enableStructural: true }),
	};
}

export type EnforcementState = ReturnType<typeof createState>;

export function getState(ctx: ExtensionContext): EnforcementState {
	return getExtensionState(ctx, "enforcement", createState);
}

// ── Legacy Global State ──────────────────────────────────────────────────────
// Legacy fallback: callers in index.ts now pass getState(ctx) explicitly. Kept as default param safety net.

export const state = createState();

export function resetState(s: EnforcementState = state): void {
	s.turnHistory.clear();
	s.recentToolSequences = [];
	s.recentlyReadFiles.clear();
	s.toolSequencePatterns.clear();
	s.driftDetector?.reset();
	s.silentTurns = 0;
	s.validationFailures = 0;
	s.currentTurn = 0;
	s.toolChain = {
		lastThinkCall: 0,
		lastPlanCall: 0,
		recentEditWithoutThink: [],
		recentEditWithoutPlan: [],
	};
	s.lastMemoryCall = 0;
	s.turnsSinceMemory = 0;
	s.memoryNudgeSent = false;
	s.totalToolCalls = 0;
	s.toolCallsSinceLastMemory = 0;
	s.uniqueToolsUsed.clear();
	s.bashCalls = 0;
	s.toolDiversityNudged = false;
	s.hasExplored = false;
	s.turnsSinceExplore = 0;
	s.exploreBeforeActNudged = false;
	s.claimsWithoutVerification = 0;
	s.verificationsDone = 0;
	s.hasRecalledOnStart = false;
	s.firstWorkDone = false;
	s.claimsDetectedThisTurn = false;
	s.hasCodeChanges = false;
	s.lastCodeChangeTurn = 0;
	s.config.thinkCalledInSession = false;
	s.config.exploreCalledInSession = false;
	s.hasRecordedFailure = false;
	s.lastFailedToolTurn = -100;
	s.lastScratchpadNudgeTurn = -100;
	// Reset nudge/escalation tracking
	s.lastNudgeTime = 0;
	s.escalationCounts = {};
	s.lastJudgeTime = 0;
	s.judgeSkipCounter = 0;
	s.lastJudgeAnalysis = null;
	s.lastLazyNudgeTime = 0;
	// Reset verification judge tracking
	s.lastVerificationJudgeTurn = 0;
	s.lastUserMessage = "";
	s.toolsSinceReflection = 0;
	s.thoughtChains = [];
	s.calibrationPairs = [];
	s.lastThinkConfidence = 0.5;
	s.verificationJudgeRunning = false;
	s.toolLog = [];
	s.planAlignmentData = null;
	// Reset context hygiene monitoring
	s.lastContextCheckTurn = 0;
	s.contextCheckInterval = 34;
	s.contextNudgeSent = false;
	s.contextAuditThreshold = 0.66;
	s.lastCompactionTurn = 0;
}
