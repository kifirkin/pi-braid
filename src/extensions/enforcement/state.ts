/**
 * Enforcement state — session-scoped state management.
 *
 * @note This is a God Object (60+ properties). Grouped by concern below.
 *       Future work: split into focused substates with their own accessors.
 *
 * Access pattern:
 *   const enState = getState(ctx);
 *   enState.totalToolCalls++;  // direct property access
 *   recordToolCall("edit", ctx);  // or use helper from handlers/tool-tracker.ts
 */

import { createLogger } from "../../lib/logger.js";
import { TopicDriftDetector } from "../../lib/topic-drift-detector.js";
import type { EnforcementConfig, ToolChainState, ToolSequencePattern, TurnState } from "./types.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "../../lib/extension-state.js";

const log = createLogger("enforcement");

// ── Tunable thresholds ─────────────────────────────────────────────────────

export const ENFORCEMENT_PARAMS = {
  memoryNudgeThreshold: 15,
  maxSilentTurns: 6,
  warnOnToolSequenceRepetition: 3,
  judgeCooldownMs: 20000,
  judgeSkipTurns: 1,
  verificationJudgeInterval: 15,
  maxClaimsBeforeVerification: 5,
  blockExploreBeforeWrite: true,
  blockThinkBeforeEdit: false, // DEPRECATED
} as const;

// ── Shared state types ─────────────────────────────────────────────────────

export interface CalibrationPair {
  predicted: number;
  actual: number;
  tool: string;
  turn: number;
}

export interface ThoughtChainEntry {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: number;
}

// ── State factory ──────────────────────────────────────────────────────────

export function createState() {
  return {
    // ── Session tracking ────────────────────────────────────────────────
    currentTurn: 0,
    turnHistory: new Map<number, TurnState>(),
    originalRequest: undefined as string | undefined,
    lastUserMessage: "",

    // ── Configuration ───────────────────────────────────────────────────
    config: { ...ENFORCEMENT_PARAMS },
    enforcementActive: true,

    // ── Tool tracking ───────────────────────────────────────────────────
    totalToolCalls: 0,
    uniqueToolsUsed: new Set<string>(),
    toolChain: {
      lastThinkCall: 0,
      lastPlanCall: 0,
      recentEditWithoutThink: [] as number[],
      recentEditWithoutPlan: [] as number[],
    } as ToolChainState,
    toolSequencePatterns: new Map<string, ToolSequencePattern>(),
    recentToolSequences: [] as string[][],
    toolLog: [] as string[],
    bashCalls: 0,
    thinkCalledInSession: false,
    exploreCalledInSession: false,
    hasExplored: false,
    turnsSinceExplore: 0,
    exploreBeforeActNudged: false,
    toolDiversityNudged: false,
    recentlyReadFiles: new Map<string, number>(),

    // ── Edit/change tracking ────────────────────────────────────────────
    hasCodeChanges: false,
    lastCodeChangeTurn: 0,
    hasRecalledOnStart: false,
    firstWorkDone: false,
    planAlignmentData: null as {
      id: string;
      description: string;
      status: string;
      steps: { description: string; status: string; expectedOutcome: string; actualOutcome?: string }[];
    } | null,
    _localizationRisk: "",

    // ── Error tracking ──────────────────────────────────────────────────
    consecutiveErrorTurns: 0,
    validationFailures: 0,
    hasRecordedFailure: false,
    lastFailedToolTurn: -100,
    escalationCounts: {} as Record<string, number>,

    // ── Nudge cooldowns ─────────────────────────────────────────────────
    lastNudgeTime: 0,
    nudgeCooldownMs: 60_000,
    lastLazyNudgeTime: 0,
    lastJudgeTime: 0,
    nudgeSuppressedCount: 0,

    // ── Memory hygiene ──────────────────────────────────────────────────
    lastMemoryCall: 0,
    turnsSinceMemory: 0,
    memoryNudgeSent: false,
    toolCallsSinceLastMemory: 0,
    toolCallsAtLastRecommendation: 0,

    // ── Scratchpad ──────────────────────────────────────────────────────
    lastScratchpadNudgeTurn: -100,
    claimsDetectedThisTurn: false,
    claimsWithoutVerification: 0,
    verificationsDone: 0,

    // ── Context hygiene ─────────────────────────────────────────────────
    contextNudgeSent: false,
    lastContextCheckTurn: 0,
    lastCompactionTurn: 0,
    overflowRecently: 0,
    contextCheckInterval: 21,
    contextAuditThreshold: 0.66,

    // ── Verification judge ──────────────────────────────────────────────
    verificationJudgeRunning: false,
    lastVerificationJudgeTurn: 0,
    lastCalibrationWhisperTime: 0,

    // ── Calibration (confidence prediction vs outcome) ──────────────────
    calibrationPairs: [] as CalibrationPair[],
    lastThinkConfidence: null as number | null,

    // ── Thought chain tracking ──────────────────────────────────────────
    thoughtChains: [] as ThoughtChainEntry[],
    toolsSinceReflection: 0,
    silentTurns: 0,
    // ── Topic-drift detector ────────────────────────────────────────────
    driftDetector: new TopicDriftDetector({
      topicThreshold: 0.15,
      minTurns: 4,
      enableStructural: true,
    }),

    // ── Memory hygiene score (deprecated — keep for compat) ─────────────
    memoryHygieneScore: 1.0,
    lastHygieneNudgeTurn: 0,
    hygieneNudgeInterval: 55,
  };
}

export type EnforcementState = ReturnType<typeof createState>;

export function getState(ctx: ExtensionContext): EnforcementState {
  return getExtensionState(ctx, "enforcement", createState);
}

// ── Resets ─────────────────────────────────────────────────────────────────

export function resetState(s: EnforcementState): void {
  // Session tracking
  s.currentTurn = 0;
  s.turnHistory.clear();
  s.originalRequest = undefined;
  s.lastUserMessage = "";

  // Tool tracking
  s.totalToolCalls = 0;
  s.uniqueToolsUsed.clear();
  s.toolChain = { lastThinkCall: 0, lastPlanCall: 0, recentEditWithoutThink: [], recentEditWithoutPlan: [] };
  s.toolSequencePatterns.clear();
  s.recentToolSequences = [];
  s.toolLog = [];
  s.bashCalls = 0;
  s.thinkCalledInSession = false;
  s.exploreCalledInSession = false;
  s.hasExplored = false;
  s.turnsSinceExplore = 0;
  s.exploreBeforeActNudged = false;
  s.toolDiversityNudged = false;
  s.recentlyReadFiles.clear();

  // Edit tracking
  s.hasCodeChanges = false;
  s.lastCodeChangeTurn = 0;
  s.hasRecalledOnStart = false;
  s.firstWorkDone = false;
  s.planAlignmentData = null;
  s._localizationRisk = "";

  // Error tracking
  s.consecutiveErrorTurns = 0;
  s.validationFailures = 0;
  s.hasRecordedFailure = false;
  s.lastFailedToolTurn = -100;
  s.escalationCounts = {};

  // Nudge cooldowns
  s.lastNudgeTime = 0;
  s.lastLazyNudgeTime = 0;
  s.lastJudgeTime = 0;
  s.nudgeSuppressedCount = 0;

  // Memory hygiene
  s.lastMemoryCall = 0;
  s.turnsSinceMemory = 0;
  s.memoryNudgeSent = false;
  s.toolCallsSinceLastMemory = 0;
  s.toolCallsAtLastRecommendation = 0;

  // Scratchpad
  s.lastScratchpadNudgeTurn = -100;
  s.claimsDetectedThisTurn = false;
  s.claimsWithoutVerification = 0;
  s.verificationsDone = 0;

  // Context hygiene
  s.contextNudgeSent = false;
  s.lastContextCheckTurn = 0;
  s.lastCompactionTurn = 0;
  s.overflowRecently = 0;
  s.contextCheckInterval = 34;
  s.contextAuditThreshold = 0.66;

  // Verification judge
  s.verificationJudgeRunning = false;
  s.lastVerificationJudgeTurn = 0;
  s.lastCalibrationWhisperTime = 0;

  // Calibration
  s.calibrationPairs = [];
  s.lastThinkConfidence = null;

  // Thought chains
  s.thoughtChains = [];
  s.toolsSinceReflection = 0;
  s.silentTurns = 0;

  // Drift detector
  s.driftDetector?.reset();
}

// ── Accessor helpers (planned: extract to focused sub-modules) ─────────────

/** Reset scratchpad nudge timer (called when agent uses scratchpad). */
export function resetScratchpadNudge(s: EnforcementState): void {
  s.lastScratchpadNudgeTurn = -100;
}

/** Record a tool call in the chain and increment total. */
export function recordToolChainCall(s: EnforcementState, toolName: string): void {
  s.totalToolCalls++;
  s.toolCallsSinceLastMemory++;

  if (["bash", "read", "write", "edit", "grep", "find"].includes(toolName)) {
    s.uniqueToolsUsed.add(toolName);
  }

  if (toolName === "think") s.toolChain.lastThinkCall = s.currentTurn;
  if (toolName === "plan") s.toolChain.lastPlanCall = s.currentTurn;

  const exploreTools = ["read", "grep", "find", "ls"];
  if (exploreTools.includes(toolName)) {
    s.hasExplored = true;
    s.exploreCalledInSession = true;
    s.turnsSinceExplore = 0;
    s.exploreBeforeActNudged = false;
  }
}

/** Check if the session is in an error burst (3+ consecutive error turns). */
export function isErrorBurst(s: EnforcementState): boolean {
  return s.consecutiveErrorTurns >= 3;
}

/** Update consecutive error counter on turn end. */
export function updateErrorBurst(s: EnforcementState, hadErrors: boolean): void {
  if (hadErrors) s.consecutiveErrorTurns++;
  else s.consecutiveErrorTurns = 0;
}