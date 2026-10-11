/**
 * Context Hygiene & Scratchpad - state interface and helpers for context usage
 * tracking and scratchpad nudge timing. Merged because both track nudge timing
 * and recordCompaction() already cross-references lastScratchpadNudgeTurn.
 * Does NOT import state.ts (breaks circular dependency).
 */

export interface ScratchpadState {
  lastScratchpadNudgeTurn: number;
  claimsDetectedThisTurn: boolean;
  claimsWithoutVerification: number;
  verificationsDone: number;
  // Per-turn think-before-edit nudge cooldown
  lastThinkPerTurnNudge: number;
  // Startup nudge: first 3 turns without scratchpad goal
  lastStartupNudge: number;
  // Whether the startup-plan whisper was sent (drives PLANNING mode)
  startupPlanShown: boolean;
  // Tools called since last scratchpad goal was set (drives PLANNING mode at any turn)
  toolsSinceLastPlan: number;
  // Finalize enforcement nudge
  lastFinalizeNudge: number;
  lastVerifyNudge: number;
  // Phase-aware enforcement: tracks investigation→implementation transitions
  lastInvestigationToolTurn: number;
  lastPhaseNudgeTurn: number;
  consecutiveInvestigationTurns: number;
  // Task complexity from initial request classifier (set on SESSION_START)
  taskComplexity: "simple" | "moderate" | "complex" | "unknown";
}

export function createScratchpadState(): ScratchpadState {
  return {
    lastScratchpadNudgeTurn: -100,
    claimsDetectedThisTurn: false,
    claimsWithoutVerification: 0,
    verificationsDone: 0,
    lastThinkPerTurnNudge: -100,
    lastStartupNudge: -100,
    startupPlanShown: false,
    toolsSinceLastPlan: 0,
    lastFinalizeNudge: -100,
    lastVerifyNudge: -100,
    lastInvestigationToolTurn: -100,
    lastPhaseNudgeTurn: -100,
    consecutiveInvestigationTurns: 0,
    taskComplexity: "unknown",
  };
}

export function resetScratchpadState(s: ScratchpadState): void {
  s.lastScratchpadNudgeTurn = -100;
  s.claimsDetectedThisTurn = false;
  s.claimsWithoutVerification = 0;
  s.verificationsDone = 0;
  s.lastThinkPerTurnNudge = -100;
  s.lastStartupNudge = -100;
  s.startupPlanShown = false;
  s.toolsSinceLastPlan = 0;
  s.lastFinalizeNudge = -100;
  s.lastVerifyNudge = -100;
  s.lastInvestigationToolTurn = -100;
  s.lastPhaseNudgeTurn = -100;
  s.consecutiveInvestigationTurns = 0;
  s.taskComplexity = "unknown";
}

export interface ContextHygieneState {
  contextNudgeSent: boolean;
  lastContextCheckTurn: number;
  lastCompactionTurn: number;
  overflowRecently: number;
  contextCheckInterval: number;
  contextAuditThreshold: number;
  /**
   * Flag set by the context_compress tool before triggering compaction.
   * The session_compact handler checks this flag to determine whether to
   * auto-resume the agent (triggerTurn: true) after compaction.
   * - If true (set by tool): auto-resume (agent-initiated compaction)
   * - If false (unset): reason: "manual" means user typed /compress → skip
   *   reason: "threshold"|"overflow" means auto-compaction → auto-resume anyway
   */
  autoResumeAfterCompaction: boolean;
  /** Turn of the last post-cycle hygiene (auto-tag + inspect). Initialized to -100. */
  lastPostCycleHygieneTurn: number;
  /**
   * Whether the turn immediately preceding the current state was a natural
   * stop (assistant final response, stopReason "stop", no tool calls).
   * Set on turn_end by dispatchTurnEndLoop (turn-end-handler.ts); cleared on
   * turn_start so a new agent run after a natural stop (e.g. user re-prompt)
   * does not carry a stale "natural stop" classification into a mid-work
   * compaction. The session_compact re-orientation whisper reads this to
   * decide triggerTurn: natural stop → advisory (no forced turn); mid-work
   * → wake (compaction must hand the loop back).
   */
  lastTurnWasNaturalStop: boolean;
  /** Hygiene ACT counters: by trigger (token/percent/backstop) and kind (slide/summarize). */
  contextHygieneActs: {
    total: number;
    byTrigger: Record<string, number>;
    byKind: Record<string, number>;
    lastDropped: number;
  };
  /** Turn-end hygiene checks skipped (no usage number, or compaction in progress). */
  contextHygieneSkips: number;
  /** Live usage tokens at turn end (last N samples, oldest first). */
  liveUsageSamples: number[];
}

export function createContextHygieneState(): ContextHygieneState {
  return {
    contextNudgeSent: false,
    lastContextCheckTurn: 0,
    lastCompactionTurn: 0,
    overflowRecently: 0,
    contextCheckInterval: 15,
    contextAuditThreshold: 0.66,
    autoResumeAfterCompaction: false,
    lastPostCycleHygieneTurn: -100,
    lastTurnWasNaturalStop: false,
    contextHygieneActs: { total: 0, byTrigger: {}, byKind: {}, lastDropped: 0 },
    contextHygieneSkips: 0,
    liveUsageSamples: [],
  };
}

export function resetContextHygieneState(s: ContextHygieneState): void {
  s.contextNudgeSent = false;
  s.lastContextCheckTurn = 0;
  s.lastCompactionTurn = 0;
  s.overflowRecently = 0;
  s.autoResumeAfterCompaction = false;
  s.contextCheckInterval = 15;
  s.contextAuditThreshold = 0.66;
  s.lastPostCycleHygieneTurn = -100;
  s.lastTurnWasNaturalStop = false;
  s.contextHygieneActs = { total: 0, byTrigger: {}, byKind: {}, lastDropped: 0 };
  s.contextHygieneSkips = 0;
  s.liveUsageSamples = [];
}

export type HygieneActTrigger = "token" | "percent" | "backstop";
export type HygieneActKind = "slide" | "summarize";

/** Max live-usage samples kept per session. */
const LIVE_USAGE_SAMPLE_CAP = 20;

/** Record one hygiene ACT with its trigger, kind and dropped-entry count. */
export function recordHygieneAct(
  s: ContextHygieneState,
  trigger: HygieneActTrigger,
  kind: HygieneActKind,
  droppedEntries: number,
): void {
  s.contextHygieneActs.total++;
  s.contextHygieneActs.byTrigger[trigger] = (s.contextHygieneActs.byTrigger[trigger] ?? 0) + 1;
  s.contextHygieneActs.byKind[kind] = (s.contextHygieneActs.byKind[kind] ?? 0) + 1;
  s.contextHygieneActs.lastDropped = droppedEntries;
}

/** Count a turn-end hygiene check skipped without a usable usage number. */
export function recordHygieneSkip(s: ContextHygieneState): void {
  s.contextHygieneSkips++;
}

/** Push one live-usage sample at turn end, keeping the last N. */
export function recordLiveUsageSample(s: ContextHygieneState, tokens: number): void {
  s.liveUsageSamples.push(tokens);
  if (s.liveUsageSamples.length > LIVE_USAGE_SAMPLE_CAP) {
    s.liveUsageSamples = s.liveUsageSamples.slice(-LIVE_USAGE_SAMPLE_CAP);
  }
}

/** Mark context nudge as sent (system sends nudge to agent). */
export function markNudgeSent(s: ContextHygieneState, turn: number): void {
  s.contextNudgeSent = true;
  s.lastContextCheckTurn = turn;
}

/** Reset context nudge (e.g., after compaction freed space). */
export function resetNudge(s: ContextHygieneState): void {
  s.contextNudgeSent = false;
}

/** Record that a context management tool was used. */
export function recordContextTool(s: ContextHygieneState, turn: number): void {
  s.lastContextCheckTurn = turn;
  s.contextNudgeSent = false;
}

/** Record that compaction happened. Also resets scratchpad nudge timer. */
export function recordCompaction(
  s: ContextHygieneState & { lastScratchpadNudgeTurn?: number },
  turn: number,
): void {
  s.lastCompactionTurn = turn;
  s.lastContextCheckTurn = turn;
  s.contextNudgeSent = false;
  s.overflowRecently = turn;
  if (typeof s.lastScratchpadNudgeTurn === "number") {
    s.lastScratchpadNudgeTurn = turn;
  }
}

/** Returns true if still in overflow recovery grace period. */
export function inOverflowRecovery(
  s: ContextHygieneState,
  currentTurn: number,
  graceTurns = 5,
): boolean {
  return currentTurn - s.overflowRecently < graceTurns;
}
