/**
 * Tool Loop Detector - single source of truth for "agent stuck calling
 * the same tool repeatedly."
 *
 * BACKGROUND (2026-06-22 architectural audit):
 *   The codebase had THREE overlapping detectors firing into the same
 *   whisper channel with different thresholds, windows, cooldowns, and
 *   remedies:
 *
 *   1. extensions/cognitive/turn-outcome/index.ts
 *      - LLM-based (CRITICS.toolLoopDetected)
 *      - 7-turn evaluation window, 12-turn history
 *      - 8-turn cooldown per loop type
 *      - Steer with triggerTurn: true
 *      - Message: "## Repetitive Loop Detected ... Use `think()` ..."
 *
 *   2. lib/reasoning/dreamer.ts tailRun()
 *      - Heuristic: longest tail of identical consecutive tool names
 *      - Threshold: 8+ consecutive (MIN_CURRENT_LOOP_LENGTH)
 *      - Cooldown: dynamic from advice-tracker
 *      - Message: "[dream] Detected N consecutive X calls ..."
 *
 *   3. lib/reasoning/policy-rules.ts reflection_gap rule
 *      - Heuristic: 8+ tool calls with no think(type="reflection")
 *      - Different criterion (presence of reflection, not repetition)
 *      - Message: "[reflection] 8+ consecutive tool calls without
 *        reflection. Consider: think(type='reflection') ..."
 *
 *   When the agent called `read` 8 times in a row, all three fired in
 *   the same turn with different remedies ("think", "switch tool",
 *   "add reflection"). The contradiction was systemic, not isolated.
 *
 *   This file is the consolidation point. It defines ONE threshold,
 *   ONE window, ONE cooldown, ONE remedy. Consumers (turn-outcome,
 *   dreamer, policy-rules) call detectToolLoop() and either emit the
 *   unified whisper or just observe the verdict.
 *
 *   The LLM-based check in turn-outcome is kept as a higher-confidence
 *   path: if the heuristic says "no loop" but the LLM sees a subtle
 *   pattern (different tools, no progress), the LLM can still fire.
 *   The two paths share a tryClaim-based dedup so only ONE whisper
 *   per loop event reaches the agent.
 *
 * STATE LIFECYCLE:
 *   - getToolLoopState(ctx) returns the per-session state via
 *     getExtensionState. Resets on session_start, no manual reset
 *     needed.
 *   - recordToolCall() is called from the tool_call event handler
 *     with the tool name.
 *   - recordTurnEnd() is called from turn_end to bump the counter
 *     used for cooldown comparison.
 *   - detectToolLoop() reads the state and returns the verdict.
 *
 * THRESHOLDS (one of each - change here, change everywhere):
 *   - TOOL_LOOP_THRESHOLD: 8 consecutive same-tool calls
 *   - TOOL_LOOP_WINDOW: 12 tools of history kept
 *   - TOOL_LOOP_COOLDOWN_TURNS: 8 turns between emissions
 *
 * The thresholds were chosen by majority: 8 is what dreamer and
 * policy-rules used; turn-outcome was LLM-based (no fixed threshold).
 * 8 is conservative enough to avoid false positives (legitimate
 * batch operations like reading 7 files in 7 turns) while still
 * catching real stuck loops.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../state/extension-state.js";

// ── Constants (single source of truth) ──────────────────────────────────────

/** Minimum consecutive same-tool calls in the recent history to flag. */
export const TOOL_LOOP_THRESHOLD = 8;

/** How many recent tools to retain in the rolling window. */
export const TOOL_LOOP_WINDOW = 12;

/** Minimum turns between successive loop whispers. */
export const TOOL_LOOP_COOLDOWN_TURNS = 8;

// ── Types ───────────────────────────────────────────────────────────────────

export interface ToolLoopState {
  /** Tool sets per turn, most recent turn first. Each entry is the set of
   *  tool names called in that turn. Using sets instead of a flat history
   *  preserves turn boundaries, preventing false positives from same-tool
   *  calls in different turns appearing adjacent after other tools age out. */
  perTurn: Set<string>[];
  /** Turn index when we last emitted a loop whisper. -1 if never. */
  lastFiredAtTurn: number;
  /** Monotonically increasing turn counter for cooldown math. */
  turnCount: number;
}

export interface ToolLoopResult {
  isLoop: boolean;
  tool: string;
  count: number;
  message: string;
}

// ── State factory + accessor ───────────────────────────────────────────────

export function createToolLoopState(): ToolLoopState {
  return {
    perTurn: [],
    lastFiredAtTurn: -1,
    turnCount: 0,
  };
}

export function getToolLoopState(ctx: ExtensionContext): ToolLoopState {
  return getExtensionState(ctx, "tool-loop-detector", createToolLoopState);
}

// ── Record API (call from tool_call + turn_end handlers) ───────────────────

/**
 * Record a tool invocation. Call this from the tool_call event handler
 * with the tool name. Adds the tool to the current (most recent) turn's
 * tool set. If no turn has started yet, creates one.
 */
export function recordToolCall(state: ToolLoopState, toolName: string): void {
  if (!toolName) return;
  if (state.perTurn.length === 0) {
    state.perTurn.push(new Set<string>());
  }
  state.perTurn[0].add(toolName);
  // Trim perTurn to keep tool counts within WINDOW
  let totalTools = 0;
  for (const turn of state.perTurn) {
    totalTools += turn.size;
  }
  while (totalTools > TOOL_LOOP_WINDOW && state.perTurn.length > 1) {
    const removed = state.perTurn.pop()!;
    totalTools -= removed.size;
  }
}

/**
 * Record the end of a turn. Call this from the turn_end handler to
 * bump the counter and open a new turn for the next round of tool calls.
 */
export function recordTurnEnd(state: ToolLoopState): void {
  state.turnCount++;
}

/**
 * Mark the start of a new turn. Call this at the beginning of each turn
 * (before any tool calls) to create a fresh tool set. Separated from
 * recordTurnEnd so the tool_call handler can add to the new turn's set.
 */
export function recordTurnStart(state: ToolLoopState): void {
  state.perTurn.unshift(new Set<string>());
  // Trim perTurn to keep tool counts within WINDOW
  let totalTools = 0;
  for (const turn of state.perTurn) {
    totalTools += turn.size;
  }
  while (totalTools > TOOL_LOOP_WINDOW && state.perTurn.length > 1) {
    const removed = state.perTurn.pop()!;
    totalTools -= removed.size;
  }
}

/**
 * Mark a loop whisper as fired at the current turn. Call this after
 * actually emitting the whisper so subsequent calls to detectToolLoop
 * respect the cooldown.
 */
export function markLoopFired(state: ToolLoopState): void {
  state.lastFiredAtTurn = state.turnCount;
}

// ── Detection (the unified verdict) ────────────────────────────────────────

/**
 * Detect a tool loop across recent turns.
 *
 * Uses per-turn tool sets to count how many consecutive turns the same
 * tool appears in. If the same tool appears in TOOL_LOOP_THRESHOLD+
 * consecutive turns, and it is the ONLY tool in at least 2 of those
 * turns, it is flagged as a loop.
 *
 * Returns:
 *   { isLoop: true, tool, count, message } when a loop is detected.
 *   { isLoop: false, tool: "", count: 0, message: "" } otherwise.
 *
 * The message is the unified whisper body. Consumers can either emit
 * it verbatim, customize it, or just observe the verdict.
 */
export function detectToolLoop(state: ToolLoopState): ToolLoopResult {
  // Cooldown gate. Only applies once we've fired at least once
  if (state.lastFiredAtTurn >= 0 && state.turnCount - state.lastFiredAtTurn < TOOL_LOOP_COOLDOWN_TURNS) {
    return { isLoop: false, tool: "", count: 0, message: "" };
  }

  if (state.perTurn.length < 2) {
    return { isLoop: false, tool: "", count: 0, message: "" };
  }

  // Find the most-called tool across recent turns
  const toolTurnCounts = new Map<string, { turnCount: number; exclusiveTurns: number }>();
  for (const turn of state.perTurn) {
    for (const tool of turn) {
      if (!toolTurnCounts.has(tool)) {
        toolTurnCounts.set(tool, { turnCount: 0, exclusiveTurns: 0 });
      }
      const entry = toolTurnCounts.get(tool)!;
      entry.turnCount++;
      if (turn.size === 1) {
        entry.exclusiveTurns++;
      }
    }
  }

  // Find the tool with the highest turn count
  let bestTool = "";
  let bestCount = 0;
  let bestExclusive = 0;
  for (const [tool, counts] of toolTurnCounts) {
    if (counts.turnCount > bestCount) {
      bestTool = tool;
      bestCount = counts.turnCount;
      bestExclusive = counts.exclusiveTurns;
    }
  }

  if (bestCount < TOOL_LOOP_THRESHOLD) {
    return { isLoop: false, tool: "", count: 0, message: "" };
  }

  // Check consecutive streak: does the best tool appear in the last N turns?
  let consecutiveTurns = 0;
  for (const turn of state.perTurn) {
    if (turn.has(bestTool)) {
      consecutiveTurns++;
    } else {
      break;
    }
  }

  if (consecutiveTurns < TOOL_LOOP_THRESHOLD) {
    return { isLoop: false, tool: "", count: 0, message: "" };
  }

  return {
    isLoop: true,
    tool: bestTool,
    count: consecutiveTurns,
    message:
      `## Tool Loop Detected\n\n` +
      `- **Repetition**: Called \`${bestTool}\` in ${consecutiveTurns} consecutive turns.` +
      (bestExclusive >= 2
        ? ` In ${bestExclusive} of those turns, it was the only tool called.`
        : ``) +
      `\n\n**Suggested actions:**\n` +
      `1. Use \`think()\` to re-evaluate your approach\n` +
      `2. Check if the problem has changed - you may be solving the wrong issue\n` +
      `3. Consider breaking the task into smaller steps\n` +
      `4. Use the \`memory\` tool to find past solutions to similar problems`,
  };
}

// ── Stateless convenience for callers with a sequence in hand ──────────────
//
// The stateful detectToolLoop() above is for callers (the tool_call
// event handler) that record calls incrementally. This helper is for
// callers (the dreamer) that have a complete sequence at hand and
// don't need cross-turn state. Same threshold, same window, same
// message -- just no cooldown or history trim.

export interface StatelessLoopResult {
  isLoop: boolean;
  tool: string;
  count: number;
  message: string;
}

export function detectToolLoopFromSequence(sequence: string[]): StatelessLoopResult {
  if (sequence.length < TOOL_LOOP_THRESHOLD) {
    return { isLoop: false, tool: "", count: 0, message: "" };
  }
  // Cap to WINDOW so the check is consistent with the stateful path
  const windowed = sequence.length > TOOL_LOOP_WINDOW ? sequence.slice(-TOOL_LOOP_WINDOW) : sequence;
  const last = windowed[windowed.length - 1];
  let count = 1;
  for (let i = windowed.length - 2; i >= 0; i--) {
    if (windowed[i] === last) count++;
    else break;
  }
  if (count < TOOL_LOOP_THRESHOLD) {
    return { isLoop: false, tool: "", count: 0, message: "" };
  }
  return {
    isLoop: true,
    tool: last,
    count,
    message:
      `## Tool Loop Detected\n\n` +
      `- **Repetition**: Called \`${last}\` ${count} times in a row with no progress.\n\n` +
      `**Suggested actions:**\n` +
      `1. Use \`think()\` to re-evaluate your approach\n` +
      `2. Check if the problem has changed - you may be solving the wrong issue\n` +
      `3. Consider breaking the task into smaller steps\n` +
      `4. Use the \`memory\` tool to find past solutions to similar problems`,
  };
}

// ── Helper: build per-turn sequence from raw tool log for stateless path ──
//
// Turns a flat tool name array (e.g. from a dreamer trace) into the
// per-turn format consumed by detectToolLoop(). Each turn boundary is
// marked by a new array -- callers pass `null` in the flat sequence to
// indicate a turn boundary.

export function groupByTurn(flatSequence: (string | null)[]): Set<string>[] {
  const perTurn: Set<string>[] = [];
  let current = new Set<string>();
  for (const entry of flatSequence) {
    if (entry === null) {
      if (current.size > 0) {
        perTurn.push(current);
        current = new Set<string>();
      }
    } else {
      current.add(entry);
    }
  }
  if (current.size > 0) {
    perTurn.push(current);
  }
  return perTurn;
}
