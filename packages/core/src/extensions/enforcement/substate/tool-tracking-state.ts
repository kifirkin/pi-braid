/**
 * Tool Tracking State - tool usage, edit tracking, calibration.
 *
 * Owns: tool usage tracking, edit/change tracking, confidence calibration,
 *       explore/think patterns.
 */

import type { ToolChainState, ToolSequencePattern } from "../types.js";

/**
 * Tools that signal real progress. A re-read after one of these is a
 * legitimate refresh, not waste; turn validation's read-streak check uses
 * the same set.
 */
export const PROGRESS_TOOLS = new Set<string>(["edit", "write", "bash"]);

export interface CalibrationPair {
  predicted: number;
  actual: number;
  tool: string;
  turn: number;
}

export interface ToolTrackingState {
  totalToolCalls: number;
  /** Tool call count at last BPE recommendation - used for progress tracking across turns. */
  toolCallsAtLastRecommendation: number;
  /** Type of the last BPE recommendation (e.g. "verify", "consolidate"). Reported back
   *  to the policy engine on the next TURN_END so it can track outcomes. */
  lastRecommendationType: string | null;
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
  /** Paths re-read this turn while a prior read was still current (no
   *  edit/write/bash since). Filled by recordToolInput; validateTurn consumes
   *  the list and clears it. */
  turnReReadWastePaths: string[];
  /** totalToolCalls position of the most recent progress tool. */
  lastProgressToolCall: number;

  hasCodeChanges: boolean;
  lastCodeChangeTurn: number;
  pendingFinalize: boolean;
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
  localizationRisk: string;

  calibrationPairs: CalibrationPair[];
  lastThinkConfidence: number | null;
}

export function createToolTrackingState(): ToolTrackingState {
  return {
    totalToolCalls: 0,
    toolCallsAtLastRecommendation: 0,
    lastRecommendationType: null,
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
    turnReReadWastePaths: [],
    lastProgressToolCall: 0,

    hasCodeChanges: false,
    lastCodeChangeTurn: 0,
    pendingFinalize: false,
    hasRecalledOnStart: false,
    firstWorkDone: false,
    planAlignmentData: null,
    localizationRisk: "",

    calibrationPairs: [],
    lastThinkConfidence: null,
  };
}

export function resetToolTrackingState(s: ToolTrackingState): void {
  s.totalToolCalls = 0;
  s.toolCallsAtLastRecommendation = 0;
  s.lastRecommendationType = null;
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
  s.turnReReadWastePaths = [];
  s.lastProgressToolCall = 0;
  s.hasCodeChanges = false;
  s.lastCodeChangeTurn = 0;
  s.pendingFinalize = false;
  s.hasRecalledOnStart = false;
  s.firstWorkDone = false;
  s.planAlignmentData = null;
  s.localizationRisk = "";
  s.calibrationPairs = [];
  s.lastThinkConfidence = null;
}

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
