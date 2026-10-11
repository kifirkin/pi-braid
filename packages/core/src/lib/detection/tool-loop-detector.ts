/**
 * Tool Loop Detector - single source of truth for "agent stuck calling
 * the same tool repeatedly."
 *
 * One detector, one threshold, one window, one cooldown, one remedy.
 * Consumers (turn-outcome, dreamer, policy-rules) call detectToolLoop()
 * and either emit the unified whisper or just observe the verdict; none
 * runs its own detector. Separate detectors with separate thresholds
 * firing into the same whisper channel in the same turn hand the agent
 * contradictory remedies ("think", "switch tool", "add reflection").
 *
 * The LLM-based check in turn-outcome is kept as a higher-confidence
 * path: if the heuristic says "no loop" but the LLM sees a subtle
 * pattern (different tools, no progress), the LLM can still fire.
 * The two paths share a tryClaim-based dedup so only ONE whisper
 * per loop event reaches the agent.
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
 *   - TOOL_LOOP_THRESHOLD: 16 consecutive same-tool calls
 *   - TOOL_LOOP_WINDOW: 20 tools of history kept
 *   - TOOL_LOOP_COOLDOWN_TURNS: 8 turns between emissions
 *
 * 16 catches real stuck loops without firing on heavy-but-productive
 * single-tool use (reading several files in succession); a lower
 * threshold false-positives on legitimate batch operations.
 *
 * Only THIS file emits the loop/addiction whisper. If any intentional
 * (metacognitive) tool - think, verify, verify_claim, finalize,
 * hypothesize, scratchpad, memory, memory_store, repl - appears anywhere
 * in the recorded window, the agent is engaged, not stuck, and
 * detectToolLoop()/detectToolLoopFromSequence() return NOT a loop.
 * Per-episode single delivery is enforced here by markLoopFired() + the
 * 8-turn TOOL_LOOP_COOLDOWN_TURNS gate, and the whisper never wakes the
 * agent (triggerTurn:false, see enforcement/handlers/turn-end-handler.ts).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../state/extension-state.js";

/** Minimum consecutive same-tool calls in the recent history to flag. */
export const TOOL_LOOP_THRESHOLD = 16;

/** How many recent tools to retain in the rolling window. Must be >= TOOL_LOOP_THRESHOLD + 1. */
export const TOOL_LOOP_WINDOW = 20;

/** Minimum turns between successive loop whispers. */
export const TOOL_LOOP_COOLDOWN_TURNS = 8;

// Intentional-use filter: metacognitive tools that prove the agent is
// engaged, not stuck. If any of these appears in the recorded window, the
// agent is deliberately reflecting/verifying/closing-out, not mechanically
// repeating a tool - so 16+ reads/greps with an occasional think do not
// read as a loop.
const INTENTIONAL_TOOLS = new Set([
  "think",
  "verify",
  "verify_claim",
  "finalize",
  "hypothesize",
  "scratchpad",
  "memory",
  "memory_store",
  "repl",
]);

/** True when the agent showed any intentional (metacognitive) tool in the
 *  recorded history window. History is already capped at TOOL_LOOP_WINDOW. */
function hasIntentionalToolInHistory(history: string[]): boolean {
  return history.some((t) => INTENTIONAL_TOOLS.has(t));
}

/** True when any per-turn tool set in the window contains an intentional tool. */
function hasIntentionalToolInTurns(perTurn: Set<string>[]): boolean {
  for (const turn of perTurn) {
    for (const tool of turn) {
      if (INTENTIONAL_TOOLS.has(tool)) return true;
    }
  }
  return false;
}

export interface ToolLoopState {
  /** Tool sets per turn, most recent turn first. Each entry is the set of
   *  tool names called in that turn. Using sets instead of a flat history
   *  preserves turn boundaries, preventing false positives from same-tool
   *  calls in different turns appearing adjacent after other tools age out. */
  perTurn: Set<string>[];
  /** Ordered flat history of tool calls (last TOOL_LOOP_WINDOW entries).
   *  Used for tail-run detection: N consecutive same-tool calls whether
   *  within a single turn or across turns. Pushed by recordToolCall,
   *  shifted when exceeding WINDOW. */
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

export function createToolLoopState(): ToolLoopState {
  return {
    perTurn: [],
    history: [],
    lastFiredAtTurn: -1,
    turnCount: 0,
  };
}

export function getToolLoopState(ctx: ExtensionContext): ToolLoopState {
  return getExtensionState(ctx, "tool-loop-detector", createToolLoopState);
}

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
  // Push to ordered history for tail-run detection
  state.history.push(toolName);
  if (state.history.length > TOOL_LOOP_WINDOW) {
    state.history.shift();
  }
}

/**
 * Record the end of a turn. Call this from the turn_end handler to
 * bump the counter and open a new turn for the next round of tool calls.
 * Pushes a fresh perTurn entry so the next recordToolCall adds to the new
 * turn's set. History rotation happens in recordToolCall; perTurn entries
 * are trimmed to TOOL_LOOP_WINDOW here.
 */
export function recordTurnEnd(state: ToolLoopState): void {
  state.turnCount++;
  state.perTurn.unshift(new Set<string>());
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

/**
 * Detect a tool loop. Uses TWO detection paths:
 *
 * 1. Tail-run (intra-turn): checks the ordered `history` array for N
 *    consecutive same-tool calls. Catches the common `read*8` loop even
 *    when all calls happen in a single turn. This is the primary path;
 *    the test suite and the stateless detectToolLoopFromSequence share
 *    the same tail-run semantics.
 *
 * 2. Cross-turn (inter-turn): checks perTurn sets for the same tool
 *    appearing in N consecutive turns. Catches loops where the agent
 *    calls different tools but always returns to the same one.
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
  if (
    state.lastFiredAtTurn >= 0 &&
    state.turnCount - state.lastFiredAtTurn < TOOL_LOOP_COOLDOWN_TURNS
  ) {
    return { isLoop: false, tool: "", count: 0, message: "" };
  }

  // If the agent used any intentional (metacognitive) tool anywhere in the
  // recorded window, it is deliberately engaged, not stuck in a loop.
  // Applies to BOTH detection paths (tail-run on `history` and cross-turn
  // on `perTurn`); a think/verify/finalize inside the window kills the loop
  // verdict even when the tail still runs 16+ same-tool calls (the
  // false-positive class the 16 threshold guards against).
  if (hasIntentionalToolInHistory(state.history) || hasIntentionalToolInTurns(state.perTurn)) {
    return { isLoop: false, tool: "", count: 0, message: "" };
  }

  // Path 1: tail-run detection (ordered history) - count consecutive
  // same-tool calls at the end of the history array. This matches the
  // stateless detectToolLoopFromSequence semantics.
  if (state.history.length >= TOOL_LOOP_THRESHOLD) {
    const last = state.history[state.history.length - 1];
    let count = 1;
    for (let i = state.history.length - 2; i >= 0; i--) {
      if (state.history[i] === last) count++;
      else break;
    }
    if (count >= TOOL_LOOP_THRESHOLD) {
      return {
        isLoop: true,
        tool: last,
        count,
        message:
          `Tool loop detected: \`${last}\` called ${count} times in a row with no progress.` +
          `\n\n**Suggested actions:**\n` +
          `1. Use \`think()\` tool to re-evaluate your approach\n` +
          `2. Check if the problem has changed - you may be solving the wrong issue\n` +
          `3. Consider breaking the task into smaller steps\n` +
          `4. Use the \`memory()\` tool to find past solutions to similar problems`,
      };
    }
  }

  // Only relevant when the agent spans multiple turns with the same tool.
  if (state.perTurn.length < 2) {
    return { isLoop: false, tool: "", count: 0, message: "" };
  }

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
      `Tool loop detected: \`${bestTool}\` called in ${consecutiveTurns} consecutive turns.` +
      (bestExclusive >= 2
        ? ` In ${bestExclusive} of those turns, it was the only tool called.`
        : ``) +
      `\n\n**Suggested actions:**\n` +
      `1. Use \`think()\` tool to re-evaluate your approach\n` +
      `2. Check if the problem has changed - you may be solving the wrong issue\n` +
      `3. Consider breaking the task into smaller steps\n` +
      `4. Use the \`memory()\` tool to find past solutions to similar problems`,
  };
}

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
  const windowed =
    sequence.length > TOOL_LOOP_WINDOW ? sequence.slice(-TOOL_LOOP_WINDOW) : sequence;

  // Intentional-use filter: any metacognitive tool in the windowed
  // slice means the agent is engaged, not stuck — not a loop. Mirrors the
  // stateful detectToolLoop() so the dreamer's stateless path agrees with it.
  if (hasIntentionalToolInHistory(windowed)) {
    return { isLoop: false, tool: "", count: 0, message: "" };
  }

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
      `Tool loop detected: \`${last}\` called ${count} times in a row with no progress.\n\n` +
      `**Suggested actions:**\n` +
      `1. Use \`think()\` tool to re-evaluate your approach\n` +
      `2. Check if the problem has changed - you may be solving the wrong issue\n` +
      `3. Consider breaking the task into smaller steps\n` +
      `4. Use the \`memory()\` tool to find past solutions to similar problems`,
  };
}
