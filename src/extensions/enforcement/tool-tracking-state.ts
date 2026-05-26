/**
 * Tool Tracking State — tool usage, edit tracking, calibration.
 *
 * Owns: tool usage tracking, edit/change tracking, confidence calibration,
 *       explore/think patterns.
 */

import type { ToolChainState, ToolSequencePattern } from "./types.js";

// ── Calibration pair ───────────────────────────────────────────────────────

export interface CalibrationPair {
  predicted: number;
  actual: number;
  tool: string;
  turn: number;
}

// ── Tool tracking state ────────────────────────────────────────────────────

export interface ToolTrackingState {
  totalToolCalls: number;
  /** Tool call count at last BPE recommendation — used for progress tracking across turns. */
  toolCallsAtLastRecommendation: number;
  uniqueToolsUsed: Set<string>;
  toolChain: ToolChainState;
  toolSequencePatterns: Map<string, ToolSequencePattern>;
  recentToolSequences: string[][];
  toolLog: string[];
  bashCalls: number;
  thinkCalledInSession: boolean;
  exploreCalledInSession: boolean;
  hasExplored: boolean;
  turnsSinceExplore: number;
  exploreBeforeActNudged: boolean;
  toolDiversityNudged: boolean;
  recentlyReadFiles: Map<string, number>;

  hasCodeChanges: boolean;
  lastCodeChangeTurn: number;
  hasRecalledOnStart: boolean;
  firstWorkDone: boolean;
  planAlignmentData: {
    id: string;
    description: string;
    status: string;
    steps: {
      description: string;
      status: string;
      expectedOutcome: string;
      actualOutcome?: string;
    }[];
  } | null;
  _localizationRisk: string;

  calibrationPairs: CalibrationPair[];
  lastThinkConfidence: number | null;
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createToolTrackingState(): ToolTrackingState {
  return {
    totalToolCalls: 0,
    toolCallsAtLastRecommendation: 0,
    uniqueToolsUsed: new Set<string>(),
    toolChain: {
      lastThinkCall: 0,
      lastPlanCall: 0,
      recentEditWithoutThink: [],
      recentEditWithoutPlan: [],
    },
    toolSequencePatterns: new Map<string, ToolSequencePattern>(),
    recentToolSequences: [],
    toolLog: [],
    bashCalls: 0,
    thinkCalledInSession: false,
    exploreCalledInSession: false,
    hasExplored: false,
    turnsSinceExplore: 0,
    exploreBeforeActNudged: false,
    toolDiversityNudged: false,
    recentlyReadFiles: new Map<string, number>(),

    hasCodeChanges: false,
    lastCodeChangeTurn: 0,
    hasRecalledOnStart: false,
    firstWorkDone: false,
    planAlignmentData: null,
    _localizationRisk: "",

    calibrationPairs: [],
    lastThinkConfidence: null,
  };
}

// ── Reset ──────────────────────────────────────────────────────────────────

export function resetToolTrackingState(s: ToolTrackingState): void {
  s.totalToolCalls = 0;
  s.toolCallsAtLastRecommendation = 0;
  s.uniqueToolsUsed.clear();
  s.toolChain = {
    lastThinkCall: 0,
    lastPlanCall: 0,
    recentEditWithoutThink: [],
    recentEditWithoutPlan: [],
  };
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
  s.hasCodeChanges = false;
  s.lastCodeChangeTurn = 0;
  s.hasRecalledOnStart = false;
  s.firstWorkDone = false;
  s.planAlignmentData = null;
  s._localizationRisk = "";
  s.calibrationPairs = [];
  s.lastThinkConfidence = null;
}

// ── Accessor helpers ───────────────────────────────────────────────────────

export function recordToolChainCall(
  s: ToolTrackingState & { currentTurn: number },
  toolName: string,
): void {
  s.totalToolCalls++;

  if (["bash", "read", "write", "edit", "grep", "find"].includes(toolName)) {
    s.uniqueToolsUsed.add(toolName);
  }

  if (toolName === "think") s.toolChain.lastThinkCall = s.currentTurn;
  if (toolName === "plan") s.toolChain.lastPlanCall = s.currentTurn;

  if (["read", "grep", "find", "ls"].includes(toolName)) {
    s.hasExplored = true;
    s.exploreCalledInSession = true;
    s.turnsSinceExplore = 0;
    s.exploreBeforeActNudged = false;
  }
}
