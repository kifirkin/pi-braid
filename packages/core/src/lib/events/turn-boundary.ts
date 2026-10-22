/**
 * The turn-boundary rule: whether a deferred compaction may fire at a given
 * `turn_end`.
 *
 * A deferred `ctx.compact()` aborts the active agent operation, and pi's
 * manual compaction never retries or continues the interrupted turn. So the
 * abort has to land where nothing is in flight, which makes the boundary a
 * question about the run, not about the compaction: is the loop still
 * dispatching?
 *
 * One home for that question. Two sites read it today (the drain in the
 * context_compress batch scheduler and the hygiene act in enforcement), and a
 * copy drifts silently: a wrong answer shows up as a torn turn under load,
 * never as a failing check.
 *
 * The rule is an ALLOW-LIST over `message.stopReason`, not a deny-list, so an
 * unreadable or unrecognized boundary parks instead of firing:
 *
 *   "stop"      the model finished its response.                fire
 *   "length"    the response hit its output ceiling.            fire
 *   "error"     the turn ended in an error.                     fire
 *   "aborted"   the run was aborted.                            fire
 *   "toolUse"   the loop dispatches its next request as         park
 *               soon as the turn_end handlers return.
 *   "pending"   the response is not final yet.                  park
 *   "deferred"  the provider deferred the response.             park
 *   absent, or  the boundary says nothing usable. An             park
 *   any other   unreadable boundary is not evidence that the
 *   value       loop is done.
 *
 * RESIDUAL, and the reason this rule is narrower than the safety property it
 * stands for: a loop-done stop reason is necessary, not sufficient. The loop
 * dispatches anyway in two measured cases, a tool call carrying a non-"toolUse"
 * stop reason ("length" with tool calls, for instance) and a steer queued at
 * any boundary (pi polls steering after the turn_end emit). A boundary the rule
 * reads as loop-done while either holds still reaches the abort it exists to
 * avoid. Reading "is anything left to dispatch" from the loop itself would
 * close that gap; this rule does not, and it is the whole of what the drain
 * and the act share.
 *
 * Two deliberate exceptions:
 *   - The 0.90W hard backstop cuts a live loop anyway. Above 0.90W of the
 *     window the loop is the runaway this exists to stop, so the abort it
 *     risks is cheaper than the overflow it prevents. Usage arrives from the
 *     caller because each site measures it from its own source.
 *   - No boundary at all (`undefined`) fires, keeping the pre-existing
 *     contract for callers that arm without boundary knowledge. The tool path
 *     is parked there by its own tool call identity instead (an arm inside a
 *     live batch still holds an active call id).
 */

import type { StopReason } from "@earendil-works/pi-ai";
import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { tokenArms } from "../detection/context-usage.js";
import { getStopReason } from "../state/extension-state.js";

/**
 * A boundary as this rule reads it: a real `turn_end` payload, or the partial
 * projection a caller may hold. `undefined` means the caller has no boundary
 * knowledge at all, which is a different statement from an empty boundary.
 */
export type TurnBoundary = Partial<Pick<TurnEndEvent, "message">> | undefined;

/** The usage a backstop decision reads. */
export interface TurnBoundaryUsage {
  /** Live tokens in the working set (compaction-aware). */
  tokens: number;
  /** The window the backstop fraction resolves against, when known. */
  contextWindow?: number | null;
}

/**
 * The stop reasons that end the turn's work, keyed by the union pi-ai
 * declares. Typing the record as a total map over the reasons this rule does
 * not park on makes a new provider stop reason a compile error here instead of
 * a silent "park" or a silent "fire": someone has to classify it.
 */
const LOOP_DONE_STOP_REASONS: Record<
  Exclude<StopReason, "toolUse" | "pending" | "deferred">,
  true
> = {
  stop: true,
  length: true,
  error: true,
  aborted: true,
};

const LOOP_DONE = new Set<string>(Object.keys(LOOP_DONE_STOP_REASONS));

/**
 * True when the boundary carries a stop reason that ends the turn's work.
 * Fail-closed: a boundary with no readable reason, or one this rule does not
 * recognize, is not loop-done.
 */
export function turnBoundaryIsLoopDone(boundary: TurnBoundary): boolean {
  const stopReason = getStopReason(boundary?.message);
  return stopReason !== undefined && LOOP_DONE.has(stopReason);
}

/**
 * Whether a deferred compaction may abort the run at this boundary.
 *
 * `readUsage` is called only when the boundary is not loop-done, so a
 * loop-done boundary never pays for a usage measurement.
 */
export function turnBoundaryMayAbortRun(
  boundary: TurnBoundary,
  readUsage?: () => TurnBoundaryUsage | null | undefined,
): boolean {
  if (boundary === undefined) return true;
  if (turnBoundaryIsLoopDone(boundary)) return true;
  const usage = readUsage?.();
  if (!usage) return false;
  return usage.tokens >= tokenArms(usage.contextWindow).backstop;
}
