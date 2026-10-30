/**
 * Tool Loop Detector - single source of truth for "agent stuck repeating
 * the same call".
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
 * IDENTITY, NOT NAME. A recorded call carries the tool name and an
 * identity built from the arguments (toolCallIdentity). Sixteen `bash`
 * calls running sixteen different commands are a chain of work: the agent
 * is exploring, testing, committing, and nothing repeats. Sixteen runs of
 * the same command are a repeat, and sixteen turns of that same command
 * are a loop across turns. Name-only counting could not tell those apart,
 * which is why the detector used to accuse a chain of work at the same
 * threshold as a repeat. Measured over 672 stored accusations before the
 * change: 667 had a tail of twenty distinct calls under one name, none was
 * an identical repeat.
 *
 * STATE LIFECYCLE:
 *   - getToolLoopState(ctx) returns the per-session state via
 *     getExtensionState. Resets on session_start, no manual reset
 *     needed.
 *   - recordToolCall(state, toolName, input) is called from the tool_call
 *     event handler with the call's arguments.
 *   - recordTurnEnd() is called from turn_end to bump the counter
 *     used for cooldown comparison.
 *   - detectToolLoop() reads the state and returns the verdict.
 *
 * THRESHOLDS (one of each - change here, change everywhere):
 *   - TOOL_LOOP_THRESHOLD: 16 consecutive calls with one identity, or 16
 *     strictly alternating calls of two identities, or one identity across
 *     16 consecutive turns
 *   - TOOL_LOOP_WINDOW: 20 calls of history kept
 *   - TOOL_LOOP_COOLDOWN_TURNS: 8 turns between emissions
 *   - TOOL_TURN_WINDOW: 20 turns of per-turn history kept (the cross-turn
 *     shape needs 16 consecutive turns, so this bound is in turns)
 *
 * 16 catches the same call returning sixteen times. It does not catch a chain
 * of work that happens to use one tool, which is the whole point of the
 * identity rule: reading several files, running a build, a commit, and a grep
 * are different calls.
 *
 * Only this file decides a loop. The whisper that reaches the agent is the
 * enforcement handler's, driven by this verdict; the analytics and dreamer
 * paths keep their observations and deliver nothing. If any intentional
 * (metacognitive) tool - think, verify, verify_claim, finalize,
 * hypothesize, scratchpad, memory, memory_store, repl - appears anywhere
 * in the recorded window, the agent is engaged, not stuck, and
 * detectToolLoop()/detectToolLoopFromSequence() return NOT a loop.
 * Per-episode single delivery is enforced here by markLoopFired() + the
 * 8-turn TOOL_LOOP_COOLDOWN_TURNS gate, and the whisper never wakes the
 * agent (triggerTurn:false, see enforcement/handlers/turn-end-handler.ts).
 *
 * The whisper states what was observed - the same call, with identical
 * arguments, repeated - and never claims the absence of progress, which
 * this module cannot see.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../state/extension-state.js";
import { hashForDedup } from "../utils/dedup.js";

/** Minimum consecutive same-identity calls (or turns) in the recent history to flag. */
export const TOOL_LOOP_THRESHOLD = 16;

/** How many recent calls to retain in the rolling window. Must be >= TOOL_LOOP_THRESHOLD + 1. */
export const TOOL_LOOP_WINDOW = 20;

/** Minimum turns between successive loop whispers. */
export const TOOL_LOOP_COOLDOWN_TURNS = 8;

/** How many turns of per-turn history to retain. A cross-turn loop needs
 *  TOOL_LOOP_THRESHOLD consecutive turns, so the bound is turn-shaped rather
 *  than call-shaped: bounding the total call count would evict the older turns
 *  of a busy agent and hide the very run the cross-turn shape looks for. Each
 *  turn's own call list is bounded by TOOL_LOOP_WINDOW. */
export const TOOL_TURN_WINDOW = TOOL_LOOP_THRESHOLD + 4;

/** Longest argument string kept verbatim in an identity. Longer values are
 *  replaced by a digest plus their length: a heredoc command runs to thousands
 *  of characters and would otherwise be retained twenty times over, while
 *  equality - the only thing the detector reads - survives the digest. */
const MAX_IDENTITY_VALUE_CHARS = 80;

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

/** One recorded call: the tool, and the equality key for its arguments. */
export interface ToolCallRecord {
  tool: string;
  identity: string;
}

/** A call to score, or a bare tool name. A bare name is what a caller has when
 *  it kept only names (the dreamer's historical log): it carries no argument
 *  evidence, so it cannot show that two calls are the same call. See
 *  detectToolLoopFromSequence for what that rules out. */
export type ToolCallLike = string | ToolCallRecord;

/** One turn's recorded calls, most recent turn first in ToolLoopState.perTurn. */
export interface ToolTurn {
  /** Tool names seen in this turn - what the intentional-use filter reads. */
  tools: Set<string>;
  /** This turn's calls, oldest first, capped at TOOL_LOOP_WINDOW. */
  calls: ToolCallRecord[];
}

export interface ToolLoopState {
  /** Calls per turn, most recent turn first. Turn boundaries are kept so a
   *  cross-turn loop (the same call every turn) can be scored separately from
   *  an intra-turn repeat, whose window spans the flat history below. */
  perTurn: ToolTurn[];
  /** Ordered flat history of the last TOOL_LOOP_WINDOW calls. Used for
   *  identity-run detection: consecutive calls that are the same call,
   *  whether within one turn or across turns. */
  history: ToolCallRecord[];
  /** Turn index when we last emitted a loop whisper. -1 if never. */
  lastFiredAtTurn: number;
  /** Monotonically increasing turn counter for cooldown math. */
  turnCount: number;
}

/** Which shape of repetition produced the verdict. */
export type ToolLoopPattern = "repeat" | "alternation" | "cross-turn" | "";

export interface ToolLoopResult {
  isLoop: boolean;
  tool: string;
  count: number;
  message: string;
  pattern: ToolLoopPattern;
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
 * Normalize an argument value for equality: whitespace collapsed, object keys
 * sorted (argument order is not identity), long strings digested.
 */
function normalizeArgValue(value: unknown): unknown {
  if (typeof value === "string") {
    const collapsed = value.replace(/\s+/g, " ").trim();
    return collapsed.length > MAX_IDENTITY_VALUE_CHARS
      ? `#${hashForDedup(collapsed)}:${collapsed.length}`
      : collapsed;
  }
  if (Array.isArray(value)) return value.map(normalizeArgValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const source = value as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) {
      const normalized = normalizeArgValue(source[key]);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  return value;
}

/**
 * Build the equality key for one tool call: the tool name plus its normalized
 * arguments. Two calls share an identity exactly when they are the same call -
 * same tool, same arguments - which is what "the agent repeated itself" means.
 *
 * A call whose arguments are absent or empty is identified by its name alone;
 * there is no argument evidence to distinguish it from another call of the
 * same tool, so they count as the same call.
 */
export function toolCallIdentity(toolName: string, input?: unknown): string {
  if (!toolName) return "";
  if (input === undefined || input === null) return toolName;
  const normalized = normalizeArgValue(input);
  const serialized = JSON.stringify(normalized);
  if (!serialized || serialized === "{}" || serialized === "null") return toolName;
  return `${toolName} ${serialized}`;
}

function openTurn(): ToolTurn {
  return { tools: new Set<string>(), calls: [] };
}

/** Drop whole turns from the oldest end past the per-turn window. */
function trimPerTurn(state: ToolLoopState): void {
  while (state.perTurn.length > TOOL_TURN_WINDOW) state.perTurn.pop();
}

/**
 * Record a tool invocation. Call this from the tool_call event handler with
 * the tool name and its arguments. Adds the call to the current (most recent)
 * turn. If no turn has started yet, creates one.
 */
export function recordToolCall(state: ToolLoopState, toolName: string, input?: unknown): void {
  if (!toolName) return;
  if (state.perTurn.length === 0) state.perTurn.push(openTurn());
  const turn = state.perTurn[0];
  turn.tools.add(toolName);

  const record: ToolCallRecord = { tool: toolName, identity: toolCallIdentity(toolName, input) };
  turn.calls.push(record);
  if (turn.calls.length > TOOL_LOOP_WINDOW) turn.calls.shift();

  trimPerTurn(state);

  state.history.push(record);
  if (state.history.length > TOOL_LOOP_WINDOW) {
    state.history.shift();
  }
}

/**
 * Record the end of a turn. Call this from the turn_end handler to
 * bump the counter and open a new turn for the next round of tool calls.
 */
export function recordTurnEnd(state: ToolLoopState): void {
  state.turnCount++;
  state.perTurn.unshift(openTurn());
  trimPerTurn(state);
}

/**
 * Mark a loop whisper as fired at the current turn. Call this after
 * actually emitting the whisper so subsequent calls to detectToolLoop
 * respect the cooldown.
 */
export function markLoopFired(state: ToolLoopState): void {
  state.lastFiredAtTurn = state.turnCount;
}

/** True when the agent showed any intentional (metacognitive) tool in the
 *  recorded history window. History is already capped at TOOL_LOOP_WINDOW. */
function hasIntentionalToolInHistory(history: ToolCallRecord[]): boolean {
  return history.some((call) => INTENTIONAL_TOOLS.has(call.tool));
}

/** True when any per-turn tool set in the window contains an intentional tool. */
function hasIntentionalToolInTurns(perTurn: ToolTurn[]): boolean {
  for (const turn of perTurn) {
    for (const tool of turn.tools) {
      if (INTENTIONAL_TOOLS.has(tool)) return true;
    }
  }
  return false;
}

/** Length of the run of one identity at the end of the history. */
function identityTailRun(
  history: ToolCallRecord[],
): { count: number; call: ToolCallRecord } | null {
  if (history.length === 0) return null;
  const last = history[history.length - 1];
  let count = 1;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].identity === last.identity) count++;
    else break;
  }
  return { count, call: last };
}

/** Length of a strict two-identity oscillation at the end of the history
 *  (A,B,A,B,... - never A,A). Returns null when the last two calls are the
 *  same call, which is the repeat path's case, not this one. */
function alternationTailRun(
  history: ToolCallRecord[],
): { count: number; a: ToolCallRecord; b: ToolCallRecord } | null {
  if (history.length < 2) return null;
  const a = history[history.length - 1];
  const b = history[history.length - 2];
  if (a.identity === b.identity) return null;
  let count = 2;
  for (let i = history.length - 3; i >= 0; i--) {
    const expected = count % 2 === 0 ? a : b;
    if (history[i].identity === expected.identity) count++;
    else break;
  }
  return { count, a, b };
}

const SUGGESTED_ACTIONS =
  `\n\n**Suggested actions:**\n` +
  `1. Use \`think()\` tool to re-evaluate your approach\n` +
  `2. Check if the problem has changed - you may be solving the wrong issue\n` +
  `3. Consider breaking the task into smaller steps\n` +
  `4. Use the \`memory()\` tool to find past solutions to similar problems`;

function repeatMessage(call: ToolCallRecord, count: number, acrossTurns: boolean): string {
  const observed = acrossTurns
    ? `the same \`${call.tool}\` call, with identical arguments, ran in ${count} consecutive turns.`
    : `the same \`${call.tool}\` call, with identical arguments, repeated ${count} times in a row.`;
  return `Tool loop detected: ${observed}${SUGGESTED_ACTIONS}`;
}

function alternationMessage(a: ToolCallRecord, b: ToolCallRecord, count: number): string {
  const pair =
    a.tool === b.tool
      ? `\`${a.tool}\` with two different arguments`
      : `\`${a.tool}\`, \`${b.tool}\``;
  return (
    `Tool loop detected: two calls alternated ${count} times in a row ` +
    `(${pair}), each call identical to its counterpart.` +
    SUGGESTED_ACTIONS
  );
}

const NOT_A_LOOP: ToolLoopResult = { isLoop: false, tool: "", count: 0, message: "", pattern: "" };

/**
 * Detect a loop at the tail of a call sequence. Three shapes:
 *
 * 1. Repeat: one identity at the end of the history, TOOL_LOOP_THRESHOLD or
 *    more calls long. The common `read the same file 16 times` loop.
 * 2. Alternation: two identities oscillating strictly (A,B,A,B,...) for
 *    TOOL_LOOP_THRESHOLD or more calls. Each call is distinct from the one
 *    before it, so only the whole-window shape names this as a loop.
 * 3. Cross-turn: one identity present in TOOL_LOOP_THRESHOLD consecutive
 *    turns. Catches an agent that does other work in between but returns to
 *    the same call every turn.
 *
 * A tail of one tool name whose calls are all distinct is a chain of work and
 * matches none of the three.
 */
export function detectToolLoop(state: ToolLoopState): ToolLoopResult {
  // Cooldown gate. Only applies once we've fired at least once.
  if (
    state.lastFiredAtTurn >= 0 &&
    state.turnCount - state.lastFiredAtTurn < TOOL_LOOP_COOLDOWN_TURNS
  ) {
    return NOT_A_LOOP;
  }

  // If the agent used any intentional (metacognitive) tool anywhere in the
  // recorded window, it is deliberately engaged, not stuck in a loop. Applies
  // to all three shapes; a think/verify/finalize inside the window kills the
  // loop verdict even when the tail still repeats.
  if (hasIntentionalToolInHistory(state.history) || hasIntentionalToolInTurns(state.perTurn)) {
    return NOT_A_LOOP;
  }

  if (state.history.length >= TOOL_LOOP_THRESHOLD) {
    const repeat = identityTailRun(state.history);
    if (repeat && repeat.count >= TOOL_LOOP_THRESHOLD) {
      return {
        isLoop: true,
        tool: repeat.call.tool,
        count: repeat.count,
        message: repeatMessage(repeat.call, repeat.count, false),
        pattern: "repeat",
      };
    }

    const alternation = alternationTailRun(state.history);
    if (alternation && alternation.count >= TOOL_LOOP_THRESHOLD) {
      return {
        isLoop: true,
        tool: alternation.a.tool,
        count: alternation.count,
        message: alternationMessage(alternation.a, alternation.b, alternation.count),
        pattern: "alternation",
      };
    }
  }

  // Cross-turn: only relevant when the agent spans multiple turns. Empty
  // turns are transparent: recordTurnEnd() opens the next turn, so the newest
  // entry is empty at detection time by construction, and a turn that made no
  // tool calls carries no evidence either way. A populated turn without the
  // call ends the run.
  const populated = state.perTurn.filter((turn) => turn.calls.length > 0);
  if (populated.length >= 2) {
    let best: { call: ToolCallRecord; turns: number } | null = null;
    const seen = new Set<string>();
    for (const call of populated[0].calls) {
      if (seen.has(call.identity)) continue;
      seen.add(call.identity);
      let turns = 0;
      for (const turn of populated) {
        if (turn.calls.some((c) => c.identity === call.identity)) turns++;
        else break;
      }
      if (!best || turns > best.turns) best = { call, turns };
    }
    if (best && best.turns >= TOOL_LOOP_THRESHOLD) {
      return {
        isLoop: true,
        tool: best.call.tool,
        count: best.turns,
        message: repeatMessage(best.call, best.turns, true),
        pattern: "cross-turn",
      };
    }
  }

  return NOT_A_LOOP;
}

//
// The stateful detectToolLoop() above is for callers that record calls
// incrementally (the tool_call event handler and the failure-trace collector).
// This helper is for callers that hold a complete sequence at hand (the
// dreamer) and need no cooldown or cross-turn state. Same threshold, same
// window, same messages.
//
// It accepts recorded calls, and it accepts bare tool names for callers that
// kept only names - and a name is not a call. Sixteen identical names are
// indistinguishable from sixteen different commands under that name, which is
// exactly the false accusation this module was rewritten to stop making. A
// sequence that carries no identities therefore returns NOT a loop: the
// stateless path can only accuse when it can show the same call repeating, and
// a caller that wants that verdict must pass what recordToolCall recorded
// (ToolLoopState.history) rather than a name log.

export interface StatelessLoopResult {
  isLoop: boolean;
  tool: string;
  count: number;
  message: string;
  pattern: ToolLoopPattern;
}

/** Narrow a ToolCallLike to a record, or null when it is a bare name. */
function asRecord(entry: ToolCallLike): ToolCallRecord | null {
  if (typeof entry === "string") return null;
  if (!entry || typeof entry.tool !== "string" || typeof entry.identity !== "string") return null;
  return entry;
}

export function detectToolLoopFromSequence(sequence: ToolCallLike[]): StatelessLoopResult {
  if (sequence.length < TOOL_LOOP_THRESHOLD) {
    return { isLoop: false, tool: "", count: 0, message: "", pattern: "" };
  }
  // Cap to WINDOW so the check is consistent with the stateful path.
  const windowed =
    sequence.length > TOOL_LOOP_WINDOW ? sequence.slice(-TOOL_LOOP_WINDOW) : sequence;

  const records: ToolCallRecord[] = [];
  for (const entry of windowed) {
    const record = asRecord(entry);
    if (!record) {
      // A bare name is not a call: no argument evidence, no identity.
      return { isLoop: false, tool: "", count: 0, message: "", pattern: "" };
    }
    records.push(record);
  }

  // Intentional-use filter: any metacognitive tool in the windowed slice means
  // the agent is engaged, not stuck. Mirrors the stateful path.
  if (hasIntentionalToolInHistory(records)) {
    return { isLoop: false, tool: "", count: 0, message: "", pattern: "" };
  }

  const repeat = identityTailRun(records);
  if (repeat && repeat.count >= TOOL_LOOP_THRESHOLD) {
    return {
      isLoop: true,
      tool: repeat.call.tool,
      count: repeat.count,
      message: repeatMessage(repeat.call, repeat.count, false),
      pattern: "repeat",
    };
  }

  const alternation = alternationTailRun(records);
  if (alternation && alternation.count >= TOOL_LOOP_THRESHOLD) {
    return {
      isLoop: true,
      tool: alternation.a.tool,
      count: alternation.count,
      message: alternationMessage(alternation.a, alternation.b, alternation.count),
      pattern: "alternation",
    };
  }

  return { isLoop: false, tool: "", count: 0, message: "", pattern: "" };
}
