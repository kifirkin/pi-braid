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
  /** Last WINDOW tool names, most recent last. */
  history: string[];
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
    history: [],
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
 * with the tool name. Trims history to WINDOW.
 */
export function recordToolCall(state: ToolLoopState, toolName: string): void {
  if (!toolName) return;
  state.history.push(toolName);
  if (state.history.length > TOOL_LOOP_WINDOW) {
    state.history.shift();
  }
}

/**
 * Record the end of a turn. Call this from the turn_end handler to
 * bump the counter used for cooldown comparison.
 */
export function recordTurnEnd(state: ToolLoopState): void {
  state.turnCount++;
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
 * Detect a tool loop in the recent history.
 *
 * Returns:
 *   { isLoop: true, tool, count, message } when the same tool has been
 *     called TOOL_LOOP_THRESHOLD+ times consecutively AND we are not
 *     in cooldown from a recent emission.
 *   { isLoop: false, tool: "", count: 0, message: "" } otherwise.
 *
 * The message is the unified whisper body. Consumers can either emit
 * it verbatim, customize it, or just observe the verdict.
 */
export function detectToolLoop(state: ToolLoopState): ToolLoopResult {
  // Cooldown gate. Only applies once we've fired at least once
  // (lastFiredAtTurn = -1 means "never fired"). Otherwise a fresh state
  // would have diff = 0 - (-1) = 1, which is < 8, suppressing the very
  // first legitimate loop detection.
  if (state.lastFiredAtTurn >= 0 && state.turnCount - state.lastFiredAtTurn < TOOL_LOOP_COOLDOWN_TURNS) {
    return { isLoop: false, tool: "", count: 0, message: "" };
  }

  if (state.history.length < TOOL_LOOP_THRESHOLD) {
    return { isLoop: false, tool: "", count: 0, message: "" };
  }

  // Count the consecutive tail of the most-recent tool name
  const last = state.history[state.history.length - 1];
  let count = 1;
  for (let i = state.history.length - 2; i >= 0; i--) {
    if (state.history[i] === last) count++;
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

// ── Stateless convenience for callers with a sequence in hand ──────────────
//
// The stateful detectToolLoop() above is for callers (the tool_call
// event handler) that record calls incrementally. This helper is for
// callers (the dreamer) that have a complete sequence at hand and
// don't need cross-turn state. Same threshold, same window, same
// message — just no cooldown or history trim.

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
