/**
 * context_compress - Free up context space by compaction, archiving, or deep-clean.
 *
 * One tool for context_compact, context_archive, context_prune, and the
 * tag-based/percentage/keepRecentTurns range params.
 *
 * Capabilities:
 *   - Tag-based archive range (startTag / endTag / beforeTag)
 *   - Percentage-based range (range: "80%")
 *   - Keep-recent-turns shortcut (keepRecentTurns: 20)
 *   - Token-savings feedback after archive
 *   - "deep_clean" meta-action: tag + archive + compact in one call
 */

import { Type } from "typebox";
import type { CompactOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getExtensionState, readExtensionState } from "../../../../../lib/state/extension-state.js";
import { onEvent } from "../../../../../lib/events/event-types.js";
import {
  TOOL_EXECUTION_START,
  TOOL_EXECUTION_END,
  AGENT_SETTLED,
  TURN_END,
} from "../../../../../lib/core/event-names.js";
import { analyzeSession } from "../../analysis.js";
import * as timerMod from "../../../../scheduling/timer/index.js";
import { getState } from "../../../../enforcement/state.js";
import {
  CONTEXT_COMPACT_REFUSE_PERCENT,
  HYGIENE_AUTO_COMPACT_HARD_BACKSTOP,
} from "../../../../../lib/detection/context-thresholds.js";
import { getCmState, isCompactionActive, log, recordNavigationAction } from "../shared.js";
import { snapBoundaryOutsideToolBatch } from "../tool-batch-boundary.js";
import { formatTokensK } from "../../../../../lib/detection/context-usage.js";
import { formatLocalTime } from "../../../../../lib/utils/local-time.js";
import {
  getAutoCompactConfig,
  type ResolvedAutoCompactConfig,
} from "../../../../../lib/config/braid-settings.js";

// Helpers

/**
 * Resolve a tag name to a branch entry index by scanning the session branch
 * for entries whose label matches `tagName`. Returns -1 if not found.
 */
function resolveTagToIndex(ctx: any, tagName: string): number {
  try {
    const sm = ctx.sessionManager;
    if (!sm) return -1;
    const branch = sm.getBranch() ?? [];
    for (let i = 0; i < branch.length; i++) {
      const label = sm.getLabel?.(branch[i].id);
      if (label === tagName) return i;
    }
    return -1;
  } catch {
    return -1;
  }
}

/**
 * Capture current context usage for pre/post feedback.
 */
function captureUsage(ctx: any): { percent: number; tokens: number; contextWindow: number } | null {
  try {
    const audit = analyzeSession(ctx);
    return audit.usage;
  } catch {
    return null;
  }
}

/**
 * Whether a turn boundary is safe to abort: true when the agent loop has
 * nothing left to dispatch, or when usage sits at the 0.90W hard backstop and
 * a runaway loop has to be cut regardless.
 *
 * `stopReason: "toolUse"` means the loop continues. pi-agent-core emits
 * turn_end and then dispatches the next request on the SAME run signal, so a
 * deferred ctx.compact(), which aborts the active run, tears that request
 * mid-stream: the recorded signature is an assistant message with stopReason
 * "aborted", errorMessage "Operation aborted", and a durationMs in the tens,
 * followed by the compaction that replaced the work. Any other stop reason
 * ends the turn's work, so the abort lands between turns.
 *
 * Unreadable usage keeps the loop live (the conservative direction): the queue
 * stays armed for the next loop-done boundary or the AGENT_SETTLED backstop.
 */
function turnBoundaryMayAbortRun(event: any, ctx: any): boolean {
  if (event?.message?.stopReason !== "toolUse") return true;
  const usage = captureUsage(ctx);
  if (!usage) return false;
  return usage.tokens >= HYGIENE_AUTO_COMPACT_HARD_BACKSTOP(usage.contextWindow);
}

// Blank optional selectors.
//
// Some clients emit every schema property and send "" for the ones they do
// not use. A blank string is "absent": a tag lookup or a percent parse on ""
// would otherwise reject a call that named nothing. Blank NUMERIC selectors
// are harder - the framework validates arguments before any handler runs and
// converts "" to 0 - so a numeric optional cannot tell a blank from a typed
// 0; the archive range guard reads the {0,0} index pair as the blank
// signature instead.

/** The non-blank string a selector names, or undefined when it names none. */
function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

/** The finite number a selector names, or undefined when it names none. */
function optionalNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// Batch-settle compaction scheduler.
// Contract: the tool returns its result FIRST (execute() resolves before a
// compaction is armed), but ctx.compact() — which aborts the turn — fires only
// at a boundary where the abort cannot tear live work: agent_settled (the run
// fully settled, abort a clean no-op), or a turn_end whose assistant message
// does not carry stopReason "toolUse" (the loop has nothing left to dispatch,
// so the abort lands between turns, where a queued steer is appended before
// the loop polls the abort signal and its turn runs on the post-compaction
// resume). A "toolUse" boundary ends a turn, not the run: the loop dispatches
// its next request as soon as the handlers return, and a compact deferred from
// there tears that request mid-stream. The 0.90W hard backstop is the one
// deliberate mid-loop cut, kept for a loop whose usage must not be allowed to
// overflow. A boundary with a tool call still active is unsafe for a further
// reason: a parallel sibling's result has not been delivered, so the abort
// drops it while the agent is still streaming its response to the
// context_compress result, surfacing a spurious "This operation was aborted"
// error in the TUI and tearing the finishing turn. agent_settled alone never
// drains a run kept alive by continuous steers, so the armed compaction stalls
// behind live work while usage keeps climbing, hence the turn_end boundary.
// The arm side asks the same question, from the one arm site that can see a
// boundary: the heartbeat's usage-driven auto-arm runs inside a turn_end
// dispatch and hands that event in, so a "toolUse" boundary below the 0.90W
// backstop leaves its entry queued for the next loop-done boundary. Arming
// inside a tool call has no boundary to read, and its own call id parks the
// queue there anyway.
//
// Active work is tracked by TOOL CALL ID, never by a count: tool_execution_start
// registers an id, tool_execution_end deletes its own, and a turn boundary
// deletes every id the turn's persisted toolResults account for. A count can
// only be decremented by the exact end event that was missed, so one lost end
// left it positive and every later boundary returned before the armed
// compaction could drain; an id-set repaired from the boundary's own result
// identity cannot drift that way.

interface PendingCompaction {
  /** Which action armed this entry. */
  kind: "compact" | "archive" | "deep_clean" | "slide";
  trigger: () => void;
  armedAt: number;
  /** Slide entry: branch id of the first kept entry (the deterministic cut). */
  cutEntryId?: string;
  /** Archive entry: branch id of the first kept entry (the declared boundary). */
  firstKeptEntryId?: string;
}

interface BatchSettleState {
  /** Active tool calls of the current batch (per session): call ids and the
   *  unidentifiable-start marker below, which no call id can equal. */
  activeToolCallIds: Set<string | symbol>;
  /** Pending compactions armed by context_compress actions, drained at settle. */
  pending: PendingCompaction[];
}

/**
 * Marker for a tool_execution_start whose event carries no usable call id.
 * A SYMBOL, never a string: every string is a possible call id and a marker
 * that is one can be deleted by a persisted result that happens to name it,
 * which drained the batch at a boundary the unidentifiable start had not
 * reached. A symbol cannot equal any persisted id, so the marker keeps every
 * boundary conservative and is released only by the AGENT_SETTLED backstop.
 */
const UNIDENTIFIED_TOOL_CALL = Symbol("unidentified-tool-call-start");

/** The non-empty call id an event names, or undefined when it names none. */
function toolCallIdOf(event: any): string | undefined {
  const id = event?.toolCallId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * The pending list is bounded: one entry per armed action, capped so a
 * pathological re-arming loop cannot grow it without bound. Beyond the cap the
 * NEWEST entry is dropped (log) — at drain time the FIRST-armed entry is the
 * one that fires (first-armed-wins for LLM-class, earliest-cut for slides), so
 * dropping the oldest would discard the very compaction the queue exists to
 * land. Slides beyond the first are redundant by construction (the drain
 * coalesces to the earliest cut), so a dropped newest entry loses nothing.
 */
const PENDING_COMPACT_QUEUE_MAX = 8;

function getBatchSettleState(ctx: any): BatchSettleState {
  return getExtensionState(ctx, "context-manager/batch-settle", () => ({
    activeToolCallIds: new Set<string | symbol>(),
    pending: [],
  }));
}

/**
 * Release the call ids a turn's persisted tool results account for. A result
 * with no usable id is ignored: an unmatched active id stays protective, so a
 * malformed event can only delay a drain to a later boundary or the settle
 * backstop, never release a sibling that is still executing.
 */
function releaseSettledToolCallIds(st: BatchSettleState, toolResults: unknown): void {
  if (!Array.isArray(toolResults)) return;
  for (const result of toolResults) {
    const id = toolCallIdOf(result);
    if (id) st.activeToolCallIds.delete(id);
  }
}

/**
 * Read the pending queue without creating state (inspect surfaces it).
 * Exported so context_inspect and the heartbeat advisory can report
 * armed-but-unfired compactions.
 */
export function readPendingCompactions(ctx: any): Array<{ kind: string; armedAt: number }> {
  try {
    const st = readExtensionState<BatchSettleState>(ctx, "context-manager/batch-settle");
    return (st?.pending ?? []).map(({ kind, armedAt }) => ({ kind, armedAt }));
  } catch {
    return [];
  }
}

/** LLM-class kinds carry a declared range/anchor state at arm time. */
function isLlmClass(kind: string): boolean {
  return kind === "compact" || kind === "archive" || kind === "deep_clean";
}

/**
 * True when an LLM-class compaction is already armed and unfired. A second
 * LLM-class arm must be refused BEFORE it writes its own range/anchor state:
 * the drain fires the first-armed trigger, so a later arm would silently
 * overwrite the range state the first trigger consumes (clobber-class loss).
 */
export function hasPendingLlmCompaction(ctx: any): boolean {
  return readPendingCompactions(ctx).some((p) => isLlmClass(p.kind));
}

/**
 * One pending-state line for the armed-but-unfired compaction queue
 * ("slide armed 17:28 — fires at the next turn boundary; live usage drops
 * when it lands"). Null when nothing is pending: no surface may fabricate an
 * expectation of a drop that is not armed. Shared by context_inspect and the
 * heartbeat advisory so both state the same fact the same way.
 */
export function formatPendingCompactionsLine(ctx: any): string | null {
  const pending = readPendingCompactions(ctx);
  if (pending.length === 0) return null;
  const newest = pending.reduce((a, b) => (b.armedAt > a.armedAt ? b : a));
  const kinds = [...new Set(pending.map((p) => p.kind))].join("+");
  const armedClock = formatLocalTime(new Date(newest.armedAt));
  return (
    `${kinds} armed ${armedClock} — fires at the next turn boundary (turn end or run settle); ` +
    `until then live usage reads pre-compaction state`
  );
}

/**
 * Coalesce a multi-entry queue into ONE deterministic slide compaction:
 * the cut lands at the EARLIEST declared boundary (a pending slide's cut or
 * an archive's firstKeptEntryId), so everything each declaration promised to
 * keep stays live, and the archive anchor/summary record (appended to the
 * session at arm time, inside the kept span) survives. Returns the trigger
 * to fire, or null when no cut point resolves (fire-first fallback).
 */
function coalesceIntoSlide(ctx: any, queue: PendingCompaction[]): { trigger: () => void } | null {
  try {
    const branch: Array<{ id: string }> = ctx?.sessionManager?.getBranch?.() ?? [];
    const indexById = new Map(branch.map((e, i) => [e.id, i] as const));
    let cutIndex = -1;
    for (const entry of queue) {
      const id = entry.kind === "slide" ? entry.cutEntryId : entry.firstKeptEntryId;
      if (!id) continue;
      const idx = indexById.get(id);
      if (idx !== undefined && (cutIndex === -1 || idx < cutIndex)) cutIndex = idx;
    }
    if (cutIndex < 0) return null;
    // The coalesced cut is a supplied boundary: snap it out of any tool batch
    // it lands in (HTTP 400: a kept slice that opens with a tool result has no
    // preceding tool_calls).
    const snappedIndex = snapBoundaryOutsideToolBatch(branch, cutIndex);
    const cutEntryId = branch[snappedIndex].id;
    // Re-point the slide state the SLIDE_MODE compaction branch consumes.
    getCmState(ctx).slideMode = {
      active: true,
      cutEntryId,
      keepCount: branch.length - snappedIndex,
      droppedCount: snappedIndex,
      timestamp: Date.now(),
    };
    const slideEntry = queue.find((p) => p.kind === "slide")!;
    return { trigger: slideEntry.trigger };
  } catch {
    return null;
  }
}

function firePendingCompactionsIfSettled(ctx: any, st: BatchSettleState): void {
  if (st.pending.length === 0 || st.activeToolCallIds.size > 0) return;
  const queue = st.pending;
  st.pending = [];
  let trigger = queue[0].trigger;
  let summary = queue.map((p) => p.kind).join(", ");
  if (queue.length > 1) {
    const coalesced = queue.some((p) => p.kind === "slide") ? coalesceIntoSlide(ctx, queue) : null;
    if (coalesced) {
      trigger = coalesced.trigger;
      summary = `slide subsuming (${summary})`;
    } else if (queue.some((p) => p.kind === "slide")) {
      // Slide present but no cut point resolved: the slide trigger still runs
      // (its own slide state was armed at arm time).
      trigger = queue.find((p) => p.kind === "slide")!.trigger;
      summary = `slide-first (${summary})`;
    } else {
      // LLM-class only (compact/archive/deep_clean): the FIRST armed wins.
      // Its range/anchor state was persisted at arm time and steers the
      // compaction it fires; a second back-to-back LLM compaction would run
      // on the first's output for nothing.
      summary = `first-armed (${summary})`;
    }
    log.info(
      `[context-compress] ${queue.length} pending compactions coalesced at settle: ${summary}`,
    );
  }
  // Defer to a macrotask so the current batch's tool-result messages (emitted
  // right after each tool_execution_end) land before the aborting compact.
  setTimeout(() => {
    try {
      trigger();
    } catch {
      // Tool already disconnected - non-fatal
    }
  }, 0);
}

/**
 * Bounded deferral for the DEGRADED compaction path (batch-settle bookkeeping
 * unavailable): a few ticks so a still-executing parallel sibling has a chance
 * to land its result, but NEVER a raw setTimeout(0) — that is the exact
 * mid-batch abort race this scheduler exists to remove. Exported (with
 * `scheduleDegradedCompact`) so the deferral contract is directly testable.
 */
export const DEGRADED_DEFERRAL_MS = 150;

/** Schedule `trigger` on the bounded degraded deferral (see DEGRADED_DEFERRAL_MS). */
export function scheduleDegradedCompact(trigger: () => void): void {
  setTimeout(trigger, DEGRADED_DEFERRAL_MS);
}

/**
 * The turn boundary an arm is happening inside, when the caller has one: the
 * turn_end payload, read for the stop reason the loop left behind.
 */
type TurnBoundary = { message?: { stopReason?: string } };

/**
 * Whether an arm may fire its own entry. Firing a compact aborts whatever run
 * is live, so an arm that happens inside a turn boundary dispatch hands that
 * boundary in and is judged by the same rule the TURN_END handler applies.
 * Every other arm site runs inside a tool call, where there is no boundary to
 * read and the prior contract stands: the arm drains unless a batch is still
 * active (the arm's own call id keeps it parked, so it does not fire there).
 */
function armMayDrainNow(boundary: TurnBoundary | undefined, ctx: any): boolean {
  if (boundary === undefined) return true;
  return turnBoundaryMayAbortRun(boundary, ctx);
}

/**
 * Arm a one-shot compaction at a safe boundary (next turn end or run settle).
 * Returns "pending-exists" when an LLM-class compaction is already armed: the
 * caller must NOT have written its own range/anchor state in that case (the
 * drain fires the first-armed trigger with the FIRST declaration's state).
 * If batch-settle bookkeeping is unavailable (extension state failed), falls
 * back to a bounded DEGRADED_DEFERRAL_MS deferral so a sibling still executing
 * at schedule time has a chance to land its result before the aborting compact
 * fires — never a raw setTimeout(0) (the mid-batch abort race this scheduler
 * removes).
 */
function scheduleCompactionAtBatchSettle(
  pi: ExtensionAPI,
  ctx: any,
  options: CompactOptions,
  meta: { kind: PendingCompaction["kind"]; cutEntryId?: string; firstKeptEntryId?: string } = {
    kind: "compact",
  },
  boundary?: TurnBoundary,
): "queued" | "pending-exists" {
  const trigger = () => {
    try {
      // Signal to session_compact handler that this is agent-initiated
      // compaction (via context_compress tool), so it should auto-resume.
      // If user typed /compress, this flag is NOT set.
      getState(ctx).autoResumeAfterCompaction = true;
    } catch {
      // Non-fatal - enforcement state unavailable
    }
    ctx.compact(options);
  };
  try {
    const st = getBatchSettleState(ctx);
    // LLM-class dedup at arm: a second LLM-class arm while one is pending is
    // refused here so its range/anchor state never clobbers the first's (the
    // drain fires the first-armed trigger). Slides always queue — the drain
    // coalesces them to the earliest cut.
    if (isLlmClass(meta.kind) && st.pending.some((p) => isLlmClass(p.kind))) {
      log.info(
        `[context-compress] ${meta.kind} arm refused: an LLM-class compaction is ` +
          `already armed and will fire at the next boundary.`,
      );
      return "pending-exists";
    }
    st.pending.push({ trigger, armedAt: Date.now(), ...meta });
    if (st.pending.length > PENDING_COMPACT_QUEUE_MAX) {
      const dropped = st.pending.pop();
      log.warn(
        `[context-compress] Pending queue overflow: dropped the newest armed ${dropped?.kind}` +
          ` (cap ${PENDING_COMPACT_QUEUE_MAX}); the first-armed entry still fires.`,
      );
    }
    // Arming fires only where that is safe. Firing a compaction aborts whatever
    // run is live, and an arm site is not in a position to tell: the tool path
    // arms inside its own call (whose id parks the queue anyway), and the
    // heartbeat's arm runs inside a turn_end dispatch, where whether the loop
    // still has work to dispatch is a fact the event carries. That caller hands
    // its boundary in; every other caller keeps the prior contract.
    if (armMayDrainNow(boundary, ctx)) firePendingCompactionsIfSettled(ctx, st);
    return "queued";
  } catch {
    // Degraded path: batch-settle bookkeeping is unavailable (extension state
    // failed), so we cannot track in-flight tool executions. Do NOT fall back
    // to a raw setTimeout(0) — that is the exact mid-batch abort race this
    // scheduler exists to remove (a still-running parallel sibling's result
    // would be discarded). Use the bounded DEGRADED_DEFERRAL_MS deferral
    // instead so a sibling still executing at schedule time has a chance to
    // land its result before the aborting compact fires; the compact is still
    // best-effort here, but the race window is materially narrowed.
    scheduleDegradedCompact(trigger);
    return "queued";
  }
}

/**
 * Arm a deterministic slide compaction (no LLM call): cut the oldest entries
 * so the most recent `keepCount` stay live. Shared by the slide tool action
 * and the usage-driven auto-arm, so both produce the same cut shape: the
 * boundary is snapped out of any tool batch, the slide state is persisted for
 * the SLIDE_MODE compaction branch, an audit entry is appended, and the
 * trigger is queued for the next safe boundary. Returns null when the branch
 * is not longer than the keep window (nothing to slide).
 */
function armSlideCompaction(
  pi: ExtensionAPI,
  ctx: any,
  keepCount: number,
  boundary?: TurnBoundary,
): { cutEntryId: string; keptCount: number; droppedCount: number } | null {
  const sm = ctx.sessionManager;
  if (!sm || typeof sm.getBranch !== "function") return null;
  const branch = sm.getBranch() ?? [];
  if (branch.length <= keepCount) return null;

  // The slide cut is a supplied boundary: snap it out of any tool batch it
  // lands in (HTTP 400: a kept slice that opens with a tool result has no
  // preceding tool_calls).
  const cutIndex = snapBoundaryOutsideToolBatch(branch, branch.length - keepCount);
  const cutEntryId = branch[cutIndex].id;
  const keptCount = branch.length - cutIndex;
  const droppedCount = cutIndex;

  // Persist slide-mode state for session_before_compact to consume.
  try {
    getCmState(ctx).slideMode = {
      active: true,
      cutEntryId,
      keepCount: keptCount,
      droppedCount,
      timestamp: Date.now(),
    };
  } catch {
    log.warn("[context-compress] Failed to persist slideMode");
  }

  // Record the slide operation as a custom entry for audit trail.
  try {
    pi.appendEntry("context_compress_slide", {
      keep: keepCount,
      dropped: droppedCount,
      branchLength: branch.length,
      timestamp: Date.now(),
    });
  } catch {
    // Non-fatal - audit trail is best-effort
  }

  // Cancel stale resume timers from previous compaction cycles.
  try {
    const sessionId =
      (
        ctx as { sessionManager?: { getSessionId?: () => string } }
      )?.sessionManager?.getSessionId?.() ?? "anonymous";
    timerMod.cancelTimersByTag(sessionId, "compaction-resume");
    timerMod.cancelTimersByTag(sessionId, "auto-compaction-resume");
  } catch {
    // Non-fatal
  }

  scheduleCompactionAtBatchSettle(
    pi,
    ctx,
    { customInstructions: "SLIDE_MODE:true" },
    { kind: "slide", cutEntryId },
    boundary,
  );
  return { cutEntryId, keptCount, droppedCount };
}

/** Per-session hysteresis counter for the usage-driven auto-arm. */
interface AutoArmState {
  aboveCount: number;
}

/**
 * Keep window for an auto-armed slide: the recent HALF of the branch, floor
 * 10 kept entries. Entry-proportional because the arming trigger is usage,
 * not size — a fixed keep (the slide tool's 50) refuses on small fat branches
 * and over-cuts relative to a session's own scale; halving a sustained-
 * over-threshold branch lands post-cut usage near the low band, and the
 * dropped span stays recoverable in the session file.
 */
export function resolveAutoSlideKeep(branchLength: number): number {
  return Math.max(10, Math.ceil(branchLength / 2));
}

function getAutoArmState(ctx: any): AutoArmState {
  return getExtensionState(ctx, "context-manager/auto-arm", () => ({ aboveCount: 0 }));
}

/**
 * Usage-driven auto-arm: when live usage sits above the configured threshold
 * for `confirmTicks` consecutive observations, arm ONE deterministic slide so
 * a session that never gets a manual cleanup still gets relief. Reuses the
 * accounting context_inspect computes (analyzeSession), the same pending
 * queue the tool arms drain through, and the same boundary discipline: arming
 * only queues; the compaction itself still fires at the next turn boundary or
 * settle, never mid-run.
 *
 * Called from the heartbeat tick — the only cadence that runs while a session
 * works, and the only arm site that runs inside a turn boundary dispatch. It
 * hands that boundary in, so the arm is judged by the same rule the drain
 * applies: a "toolUse" boundary below the 0.90W backstop leaves the entry
 * queued for the next loop-done boundary instead of aborting the request the
 * loop is about to dispatch. Returns what happened and why, so the caller can
 * log it.
 */
export function maybeArmAutoCompaction(
  pi: ExtensionAPI,
  ctx: any,
  boundary?: TurnBoundary,
): { armed: boolean; reason: string } {
  const config: ResolvedAutoCompactConfig = getAutoCompactConfig();
  if (!config.enabled) return { armed: false, reason: "disabled" };
  if (isCompactionActive(ctx)) return { armed: false, reason: "compaction-active" };
  if (readPendingCompactions(ctx).length > 0) {
    return { armed: false, reason: "already-pending" };
  }
  const usage = captureUsage(ctx);
  if (!usage) return { armed: false, reason: "usage-unavailable" };
  if (usage.percent < config.armPercent) {
    getAutoArmState(ctx).aboveCount = 0;
    return { armed: false, reason: `below-arm-percent (${usage.percent.toFixed(1)}%)` };
  }
  const st = getAutoArmState(ctx);
  st.aboveCount += 1;
  if (st.aboveCount < config.confirmTicks) {
    return { armed: false, reason: `warming ${st.aboveCount}/${config.confirmTicks}` };
  }
  const branchLength = ctx?.sessionManager?.getBranch?.().length ?? 0;
  const keep = resolveAutoSlideKeep(branchLength);
  const armed = armSlideCompaction(pi, ctx, keep, boundary);
  st.aboveCount = 0;
  if (!armed) return { armed: false, reason: "branch-too-short" };
  log.info(
    `[context-compress] Auto-arm: usage sustained at ${usage.percent.toFixed(1)}% ` +
      `(>= ${config.armPercent}% for ${config.confirmTicks} observations) — slide armed ` +
      `(${armed.droppedCount} entries before the cut), fires at the next boundary.`,
  );
  return { armed: true, reason: `usage ${usage.percent.toFixed(1)}% sustained` };
}

// Schema

export const contextCompressSchema = Type.Object({
  action: Type.String({
    enum: ["compact", "archive", "deep_clean", "slide"],
    description:
      "compact = remove obsolete/duplicate entries (like context_compact). " +
      "archive = compress a range of messages into a topic summary (like context_archive). " +
      "deep_clean = tag current position, archive everything before the tag, then compact. All-in-one. " +
      "slide = deterministic sliding-window compaction. Drops oldest entries, keeps recent N intact. No LLM summarization.",
  }),
  // compact params (also used by slide)
  keep: Type.Optional(
    Type.Number({
      description:
        "Messages to preserve: action=compact (token-based LLM) or action=slide (deterministic, no LLM). Default slide: 50.",
    }),
  ),
  // archive params (original numeric range)
  startIndex: Type.Optional(
    Type.Number({
      description: "First message index to compress (auto when omitted); action=archive only.",
    }),
  ),
  endIndex: Type.Optional(
    Type.Number({
      description: "Last message index to compress (auto when omitted); action=archive only.",
    }),
  ),
  // archive params (tag-based range)
  startTag: Type.Optional(
    Type.String({
      description: "Archive start-boundary tag; overrides startIndex; action=archive only.",
    }),
  ),
  endTag: Type.Optional(
    Type.String({
      description: "Archive end-boundary tag; overrides endIndex; action=archive only.",
    }),
  ),
  beforeTag: Type.Optional(
    Type.String({
      description:
        "Archive all entries before this tag; equals startTag+endIndex; action=archive only.",
    }),
  ),
  // percentage-based range,
  range: Type.Optional(
    Type.String({
      description:
        'Percent of session to archive (e.g. "80%"); overrides startIndex/endIndex; action=archive only.',
    }),
  ),
  // keep-recent-turns shortcut,
  keepRecentTurns: Type.Optional(
    Type.Number({
      description:
        "Keep last N user turns, archive the rest; overrides startIndex/endIndex; action=archive only.",
    }),
  ),
  // archive params (shared)
  topic: Type.Optional(
    Type.String({
      description: "Topic label; required for action=archive and action=deep_clean.",
    }),
  ),
  summary: Type.Optional(
    Type.String({
      description:
        "Summary of what was accomplished; required for archive/deep_clean. Use explicit speaker labels to prevent misattribution.",
    }),
  ),
  // deep_clean params
  tagName: Type.Optional(
    Type.String({
      description: "Tag to create at current position; deep_clean only. Default: 'before-cleanup'.",
    }),
  ),
});

export function registerContextCompress(pi: ExtensionAPI): void {
  // Batch-settle scheduling: track the ACTIVE tool calls of every running
  // batch by call id and fire the deferred compaction only at a safe boundary
  // (a loop-done turn_end or agent_settled). Never mid-batch (would drop a
  // parallel sibling's result) and never at tool_execution_end (the run is
  // still live there — an aborting compact would surface a spurious "This
  // operation was aborted" error and tear the finishing turn).
  onEvent(pi, TOOL_EXECUTION_START, (event: any, ctx: any) => {
    try {
      const st = getBatchSettleState(ctx);
      st.activeToolCallIds.add(toolCallIdOf(event) ?? UNIDENTIFIED_TOOL_CALL);
    } catch {
      // Settle tracking is unavailable — the pending compact then only fires
      // via AGENT_SETTLED below, which is the conservative path.
    }
  });
  onEvent(pi, TOOL_EXECUTION_END, (event: any, ctx: any) => {
    try {
      const id = toolCallIdOf(event);
      // Only this call's id is released: a sibling's id survives its own end
      // event, so the batch stays active until that sibling releases too.
      if (id) getBatchSettleState(ctx).activeToolCallIds.delete(id);
      // NOTE: do NOT fire here. The run is still active (the agent is
      // processing this tool's result and streaming its next response); an
      // aborting compact now would surface a spurious "This operation was
      // aborted" error and tear the finishing turn. Safe boundaries are
      // turn_end (below) and agent_settled.
    } catch {
      // Settle tracking unavailable — see TOOL_EXECUTION_START above; the
      // AGENT_SETTLED handler remains the conservative trigger.
    }
  });
  onEvent(pi, TURN_END, (event: any, ctx: any) => {
    // Turn boundary. The turn's assistant message and tool results are already
    // persisted here, but that alone does not make the run safe to abort: a
    // "toolUse" stop means the loop dispatches its next request the moment the
    // handlers return, so the deferred ctx.compact() tears that request
    // mid-stream and the compaction replaces the work it was about to do (see
    // turnBoundaryMayAbortRun). Only a loop-done boundary drains, except at
    // the 0.90W hard backstop, which exists precisely to stop a runaway live
    // loop before it overflows.
    //
    // The persisted results carry the toolCallIds of the calls they answer,
    // which releases a call whose tool_execution_end never arrived; an active
    // id with NO result in this event is kept (it may still be executing, and
    // a count could not tell which sibling completed). A run kept alive by
    // continuous steers never reaches agent_settled — this boundary keeps an
    // armed compaction from stalling behind live work. Ids are never blanket-
    // reset here (only agent_settled owns that backstop, which is what keeps a
    // missed end event from parking the queue forever).
    try {
      const st = getBatchSettleState(ctx);
      releaseSettledToolCallIds(st, event?.toolResults);
      if (st.pending.length === 0 || st.activeToolCallIds.size > 0) return;
      if (isCompactionActive(ctx)) return;
      if (!turnBoundaryMayAbortRun(event, ctx)) return;
      firePendingCompactionsIfSettled(ctx, st);
    } catch {
      // A failed boundary drain must not tear the turn_end event pipeline;
      // the pending compactions retry on the next boundary.
    }
  });
  onEvent(pi, AGENT_SETTLED, (_event: any, ctx: any) => {
    // Backstop boundary: the run has fully settled, so ctx.compact()'s
    // abort() is a clean no-op — no spurious abort error, no torn turn, and
    // the post-compaction resume wake lands when the session is
    // idle/promptable. The whole pending queue drains here (coalesced); the
    // active set is cleared so parked compactions always fire even when a
    // start never saw its end and no turn boundary ever accounted for it.
    // Turn boundaries drain first when a run stays alive; this handler catches
    // everything they cannot reach.
    try {
      const st = getBatchSettleState(ctx);
      st.activeToolCallIds.clear();
      firePendingCompactionsIfSettled(ctx, st);
    } catch {
      // A failed settle trigger must not tear down the AGENT_SETTLED event
      // pipeline; the pending compactions retry on the next settle cycle.
    }
  });

  pi.registerTool({
    name: "context_compress",
    label: "Context Compress",
    promptSnippet:
      "Free context space by compaction or archiving; archive first, slide or compact when it can run safely",
    description:
      "Free up context space; prefer archive over compact. " +
      "For long sessions, tag your position with context_navigate(action=tag) and archive deliberately with " +
      "context_compress(action=archive) BEFORE considering compaction — compaction is a bounded safety net " +
      "(substantive, skippable when input unchanged, verifiable, originals recoverable). " +
      "Never in a parallel batch (it aborts the turn). Use explicit speaker labels in summaries.",
    parameters: contextCompressSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
      const action = params.action;

      // COMPACT
      if (action === "compact") {
        try {
          const usage = captureUsage(ctx);

          // SAFETY GUARD: compaction (action="compact") causes "max call stack" errors
          // when context exceeds the CONTEXT_COMPACT_REFUSE_PERCENT threshold (owner:
          // lib/detection/context-thresholds.ts). The destructive AI-supervised compaction can
          // leave the session in an unstable state (corrupted messages, 403 blocks).
          // Use action="slide" instead — it's deterministic, entry-based, no LLM call.
          if (usage && usage.percent > CONTEXT_COMPACT_REFUSE_PERCENT) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: [
                    `**Compact refused — context at ${usage.percent.toFixed(1)}% (>${CONTEXT_COMPACT_REFUSE_PERCENT}% threshold).**`,
                    `Destructive AI-supervised compaction (action="compact") causes max-call-stack`,
                    `crashes and session corruption above ${CONTEXT_COMPACT_REFUSE_PERCENT}% usage.`,
                    ``,
                    `Use **action="slide"** instead — deterministic, entry-based, no LLM:`,
                    `  context_compress(action="slide")`,
                    `  context_compress(action="slide", keep=80)  # keep recent 80 entries`,
                    ``,
                    `Run context_inspect(detail="quick") first to assess current state.`,
                  ].join("\n"),
                },
              ],
              details: {
                action,
                refused: true,
                reason: `context ${usage.percent.toFixed(1)}% > ${CONTEXT_COMPACT_REFUSE_PERCENT}% threshold`,
                suggestion: { tool: "context_compress", action: "slide" },
              },
            };
          }

          const usageLine2 = usage
            ? `${usage.percent.toFixed(1)}% used (${formatTokensK(usage.tokens)} tokens)`
            : "unknown";

          const result = {
            content: [
              {
                type: "text" as const,
                text: [
                  `**Compaction scheduled.**`,
                  `  Before: ${usageLine2}`,
                  `  Keep recent: ${params?.keep ?? "auto"}`,
                  ``,
                  `Compaction armed; it fires at the next turn boundary (turn end or run settle) — live usage will NOT drop until it lands.`,
                  `Agent will resume automatically after compaction completes.`,
                  `Run context_inspect(detail='quick') after resume to verify.`,
                ].join("\n"),
              },
            ],
            details: {
              action,
              compactionTriggered: true,
              keep: params?.keep ?? "auto",
              nextStep: { tool: "context_inspect", detail: "quick", note: "after auto-resume" },
            },
          };

          try {
            // Cancel any stale resume timer from a previous compaction cycle.
            const sessionId =
              (
                ctx as { sessionManager?: { getSessionId?: () => string } }
              )?.sessionManager?.getSessionId?.() ?? "anonymous";
            timerMod.cancelTimersByTag(sessionId, "compaction-resume");
            timerMod.cancelTimersByTag(sessionId, "auto-compaction-resume");
          } catch {
            // Non-fatal - timer unavailable
          }

          const options: CompactOptions = {};
          if (params?.keep != null) {
            options.customInstructions = `Keep the most recent ${params.keep} messages.`;
          }

          // Skip compact if context is already low — pi-core returns
          // "nothing to compact" as a whisper, which is confusing noise.
          if (usage && usage.percent < 30) {
            return {
              ...result,
              content: [
                {
                  type: "text" as const,
                  text: [
                    `**Compact skipped — context at ${usage.percent.toFixed(1)}% (already low).**`,
                    `No compaction needed. Use context_inspect(detail="quick") to verify.`,
                  ].join("\n"),
                },
              ],
              details: {
                ...result.details,
                skipped: true,
                reason: `context ${usage.percent.toFixed(1)}% < 30% threshold`,
              },
            };
          }

          scheduleCompactionAtBatchSettle(pi, ctx, options, { kind: "compact" });

          // Compact was scheduled (a real compaction is armed) — count it.
          recordNavigationAction(ctx, "compact");
          return result;
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `Failed to compact: ${e.message}` }],
            details: { action, error: e.message },
          };
        }
      }

      // ARCHIVE
      if (action === "archive") {
        const { topic, summary } = params;
        if (!topic || !summary) {
          return {
            content: [
              {
                type: "text" as const,
                text: "topic and summary are required for action=archive",
              },
            ],
            details: { action, error: "missing required params" },
          };
        }

        // LLM-class dedup: refuse BEFORE any state write. An already-armed
        // compaction fires at the next boundary with the FIRST declaration's
        // range; a second arm here would overwrite rangeMode (clobber-class
        // loss) and queue an entry that can never fire.
        if (hasPendingLlmCompaction(ctx)) {
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `**Archive skipped — a compaction is already armed and will fire at the next turn boundary.**`,
                  `Nothing was recorded for "${topic}"; the pending compaction covers the cleanup.`,
                  `After it lands, re-run this archive if the range still needs a record.`,
                ].join("\n"),
              },
            ],
            details: {
              action,
              skipped: true,
              reason: "compaction-already-pending",
              topic,
            },
          };
        }

        const usageBefore = captureUsage(ctx);
        const sessionLength = analyzeSession(ctx).branchLength;

        // Resolve range via priority: startTag/endTag > beforeTag > range > keepRecentTurns > startIndex/endIndex > auto
        const startTag = optionalString(params.startTag);
        const endTag = optionalString(params.endTag);
        const beforeTag = optionalString(params.beforeTag);
        const range = optionalString(params.range);
        const keepRecentTurns = optionalNumber(params.keepRecentTurns);
        const rawStartIndex = optionalNumber(params.startIndex);
        const rawEndIndex = optionalNumber(params.endIndex);
        let startIndex: number | undefined = rawStartIndex;
        let endIndex: number | undefined = rawEndIndex;

        const hasStringSelector =
          startTag !== undefined ||
          endTag !== undefined ||
          beforeTag !== undefined ||
          range !== undefined;
        // 0 turns is never a usable instruction (priority 3 refuses it), so a
        // 0 here is a blank conversion too.
        const keepRecentTurnsNamed = keepRecentTurns !== undefined && keepRecentTurns > 0;

        // The blank numeric signature: a blank-filled call arrives as
        // {startIndex: 0, endIndex: 0}, a pair that selects nothing a caller
        // could have meant (a real 0 start bound travels with a non-zero
        // end). Refuse before any state write when nothing else names a
        // span; otherwise read the pair as absent and let the named selector
        // decide.
        if (rawStartIndex === 0 && rawEndIndex === 0) {
          if (!hasStringSelector && !keepRecentTurnsNamed) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    "context_compress archive: startIndex/endIndex both resolved to 0 and no " +
                    "tag/range/keepRecentTurns was given; blank numeric selectors cannot select " +
                    "a span. Name startTag/endTag/beforeTag/range/keepRecentTurns instead.",
                },
              ],
              details: { action, error: "blank numeric selectors named no span" },
            };
          }
          startIndex = undefined;
          endIndex = undefined;
        }

        // Priority 1: Tag-based range
        if (startTag !== undefined) {
          const idx = resolveTagToIndex(ctx, startTag);
          if (idx < 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Tag '${startTag}' not found in session branch. Use context_navigate action=log to see available tags.`,
                },
              ],
              details: { action, error: `tag not found: ${startTag}` },
            };
          }
          startIndex = idx;

          if (endTag !== undefined) {
            const idxEnd = resolveTagToIndex(ctx, endTag);
            if (idxEnd < 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Tag '${endTag}' not found in session branch. Use context_navigate action=log to see available tags.`,
                  },
                ],
                details: { action, error: `tag not found: ${endTag}` },
              };
            }
            endIndex = idxEnd;
          }
        }

        // A start tag names where the archive begins, not where it ends:
        // without a usable end bound the resolution below would either
        // auto-clobber the resolved start index (endIndex absent) or die on
        // the generic invalid-range sentence (endIndex 0 from a blank).
        if (
          startTag !== undefined &&
          endTag === undefined &&
          (endIndex === undefined || endIndex <= 0)
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: "startTag requires endTag or endIndex; use beforeTag to archive everything before a tag.",
              },
            ],
            details: { action, error: "startTag without endTag or endIndex" },
          };
        }

        // Priority 1b: beforeTag convenience (archive everything before this tag)
        if (startIndex === undefined && beforeTag !== undefined) {
          const idx = resolveTagToIndex(ctx, beforeTag);
          if (idx < 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Tag '${beforeTag}' not found in session branch. Use context_navigate action=log to see available tags.`,
                },
              ],
              details: { action, error: `tag not found: ${beforeTag}` },
            };
          }
          startIndex = 0;
          endIndex = Math.max(0, idx - 1);
        }

        // Priority 2: Percentage-based range
        if (range !== undefined && (startIndex === undefined || endIndex === undefined)) {
          const match = range.match(/^(\d+)%$/);
          if (!match) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Invalid range format: '${range}'. Use 'N%' e.g. '80%'.`,
                },
              ],
              details: { action, error: `invalid range: ${range}` },
            };
          }
          const pct = parseInt(match[1], 10);
          if (pct <= 0 || pct > 100) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Range must be 1-100%. Got ${pct}%.`,
                },
              ],
              details: { action, error: `invalid percentage: ${pct}` },
            };
          }
          const count = Math.max(1, Math.floor((sessionLength * pct) / 100));
          startIndex = 0;
          endIndex = count - 1;
        }

        // Priority 3: Keep-recent-turns
        if ((startIndex === undefined || endIndex === undefined) && keepRecentTurns !== undefined) {
          const keep = keepRecentTurns;
          if (keep <= 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "keepRecentTurns must be >= 1.",
                },
              ],
              details: { action, error: "invalid keepRecentTurns" },
            };
          }

          const sm = ctx.sessionManager;
          const branch = sm.getBranch() ?? [];
          // Branch entries wrap the message: a user turn is
          // entry.type === "message" with entry.message.role === "user".
          // Matching entry.type/entry.role directly never matches, which
          // collapsed every keepRecentTurns span to [0..0].
          let userMessagesSeen = 0;
          let cutIndex = 0;
          for (let i = branch.length - 1; i >= 0; i--) {
            const entry = branch[i];
            if (entry?.type === "message" && (entry as any).message?.role === "user") {
              userMessagesSeen++;
              if (userMessagesSeen >= keep) {
                cutIndex = i;
                break;
              }
            }
          }
          startIndex = 0;
          endIndex = Math.max(0, cutIndex - 1);
        }

        // Default: auto-select oldest ~20%
        if (startIndex === undefined || endIndex === undefined) {
          const archiveCount = Math.min(Math.max(Math.floor(sessionLength * 0.2), 10), 100);
          startIndex = 0;
          endIndex = archiveCount - 1;
        }

        if (startIndex < 0 || endIndex < startIndex) {
          // endIndex 0 under a positive startIndex is the blank-selector
          // signature, not a number the caller typed: name the hypothesis.
          // Genuinely invalid numbers keep the generic sentence.
          if (endIndex === 0 && startIndex > 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Invalid range: endIndex is 0 while startIndex is ${startIndex} - a blank ` +
                    `endIndex selector ("") is converted to 0 by argument validation; send a ` +
                    `real endIndex or name the span with beforeTag/range.`,
                },
              ],
              details: { action, error: "endIndex 0 (blank selector) below startIndex" },
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: "Invalid range: startIndex must be >= 0 and endIndex must be >= startIndex",
              },
            ],
            details: { action, error: true },
          };
        }

        const sm = ctx.sessionManager;

        // Persist range-mode state so session_before_compact honors the declared
        // range as the real compaction boundary (commitment-preserving anchor).
        const branch: Array<{ id: string; type?: string; message?: unknown }> =
          typeof sm.getBranch === "function" ? (sm.getBranch() ?? []) : [];
        // The declared boundary is a supplied one: snap it out of any tool
        // batch it lands in (HTTP 400: a kept slice that opens with a tool
        // result has no preceding tool_calls). A boundary at the branch end
        // stays undefined - there is no entry to keep.
        const candidateBoundary = endIndex + 1;
        const boundaryIndex =
          candidateBoundary < branch.length
            ? snapBoundaryOutsideToolBatch(branch, candidateBoundary)
            : candidateBoundary;
        const firstKeptEntryId = branch[boundaryIndex]?.id;
        try {
          const cmState = getCmState(ctx);
          cmState.rangeMode = {
            active: true,
            startIndex,
            endIndex,
            summary,
            topic,
            firstKeptEntryId,
            boundaryIsBranchEnd: boundaryIndex >= branch.length,
            timestamp: Date.now(),
          };
        } catch {
          log.warn("[context-compress] Failed to persist rangeMode");
        }

        pi.appendEntry("context_compression", {
          topic,
          startIndex,
          endIndex,
          summary,
          timestamp: Date.now(),
        });

        // Honest-by-understatement feedback.
        // The declared range + summary are recorded as the archive anchor
        // (audit metadata entry + rangeMode), but the feedback NEVER claims a
        // specific removed range ("entries N..M removed" / "Compressed N
        // messages") and never promises a specific boundary — the actual cut
        // is pi-core's compaction decision, so the tool reports an ESTIMATED
        // cut only. Contract: claim less than what happened, never more. The
        // REAL before-% is still reported (no fabricated post-% — a
        // linear-token estimate would be misleading).
        const count = endIndex - startIndex + 1;
        const feedbackLines: string[] = [
          `Archive recorded: "${topic}" — ~${count} entries before the archive point, estimated.`,
        ];
        if (usageBefore) {
          feedbackLines.push(
            `  Before: ${usageBefore.percent.toFixed(1)}% used (${formatTokensK(usageBefore.tokens)} tokens)`,
          );
        }
        feedbackLines.push(
          "",
          "Compaction is armed and fires at the next turn boundary (turn end or run settle) — it may " +
            "land while the run stays alive; live usage will NOT drop until it fires.",
          "Verify after it lands: context_inspect(detail='quick') shows the drop and any still-pending arm.",
        );

        // Cancel any stale resume timer from a previous compaction cycle.
        try {
          const sessionId =
            (
              ctx as { sessionManager?: { getSessionId?: () => string } }
            )?.sessionManager?.getSessionId?.() ?? "anonymous";
          timerMod.cancelTimersByTag(sessionId, "compaction-resume");
          timerMod.cancelTimersByTag(sessionId, "auto-compaction-resume");
        } catch {
          // Non-fatal - timer unavailable
        }

        // Skip follow-up compact only when REAL usage is genuinely low (<30%).
        // Never skip on a linear-token estimate — that drops a needed
        // compaction while claiming a freed percentage.
        let compactionTriggered = true;
        if (usageBefore && usageBefore.percent < 30) {
          compactionTriggered = false;
          feedbackLines.push(
            "",
            `  Skipped follow-up compact (real context ${usageBefore.percent.toFixed(1)}% — already low). No estimation used.`,
          );
        } else {
          scheduleCompactionAtBatchSettle(
            pi,
            ctx,
            {},
            {
              kind: "archive",
              firstKeptEntryId,
            },
          );
        }

        // The archive range was declared and compaction armed — count it.
        recordNavigationAction(ctx, "archive");

        // An untagged session just archived without a
        // navigation checkpoint — gently remind that tagging before archiving
        // makes recovery lossless. Only on the archive SUCCESS path, only when
        // the session has zero recorded tags (adopters are not nagged).
        if ((getCmState(ctx).navigationAdoption?.tags ?? 0) === 0) {
          feedbackLines.push(
            "",
            "Tip: context_navigate(action=tag) before archives makes recovery lossless.",
          );
        }

        return {
          content: [
            {
              type: "text" as const,
              text: feedbackLines.join("\n"),
            },
          ],
          details: {
            action,
            compressed: count,
            topic,
            startIndex,
            endIndex,
            honorRange: true,
            compactionTriggered,
            nextStep: { tool: "context_inspect", detail: "quick", note: "after auto-resume" },
          },
        };
      }

      // DEEP_CLEAN
      if (action === "deep_clean") {
        const topic = params.topic;
        const summary = params.summary;
        if (!topic || !summary) {
          return {
            content: [
              {
                type: "text" as const,
                text: "topic and summary are required for action=deep_clean",
              },
            ],
            details: { action, error: "missing required params" },
          };
        }

        // LLM-class dedup (same contract as archive): an armed compaction
        // fires at the next boundary; refuse before writing the tag or the
        // archive anchor so the first declaration stands unmodified.
        if (hasPendingLlmCompaction(ctx)) {
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `**Deep clean skipped — a compaction is already armed and will fire at the next turn boundary.**`,
                  `Nothing was tagged for "${topic}"; the pending compaction covers the cleanup.`,
                ].join("\n"),
              },
            ],
            details: {
              action,
              skipped: true,
              reason: "compaction-already-pending",
              topic,
            },
          };
        }

        const tagName = optionalString(params.tagName) ?? "before-cleanup";
        const usageBefore = captureUsage(ctx);

        try {
          const sm = ctx.sessionManager;
          const branch = sm.getBranch() ?? [];
          const currentLeaf = branch.length > 0 ? branch[branch.length - 1].id : null;
          if (currentLeaf) {
            sm.appendLabelChange(currentLeaf, tagName);
          }

          const tagIndex = currentLeaf ? resolveTagToIndex(ctx, tagName) : -1;
          const archiveEnd = tagIndex > 0 ? tagIndex - 1 : -1;

          if (archiveEnd >= 0) {
            pi.appendEntry("context_compression", {
              topic,
              startIndex: 0,
              endIndex: archiveEnd,
              summary,
              timestamp: Date.now(),
              fromDeepClean: true,
            });
          }

          const options: CompactOptions = {};
          scheduleCompactionAtBatchSettle(pi, ctx, options, { kind: "deep_clean" });

          // The deep-clean pipeline actually ran (tag + archive + compact).
          recordNavigationAction(ctx, "deep_clean");

          const count = archiveEnd >= 0 ? archiveEnd + 1 : 0;
          const usageLine = usageBefore ? ` (before: ${usageBefore.percent.toFixed(1)}%)` : "";

          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `**Deep clean triggered.**`,
                  `  1. Tagged '${tagName}' at current position`,
                  `  2. ~${count} entries before the tag point, estimated`,
                  `  3. Compaction scheduled${usageLine}`,
                  "",
                  `Compaction armed; it fires at the next turn boundary (turn end or run settle) — live usage will NOT drop until it lands.`,
                  `Agent will resume automatically after compaction completes.`,
                  `Run context_inspect(detail='quick') after resume to verify.`,
                  "",
                  `Topic: ${topic}`,
                ].join("\n"),
              },
            ],
            details: {
              action: "deep_clean",
              tagName,
              archived: count,
              compactionTriggered: true,
              topic,
              nextStep: { tool: "context_inspect", detail: "quick", note: "after auto-resume" },
            },
          };
        } catch (e: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to deep clean: ${e.message}`,
              },
            ],
            details: { action, error: e.message },
          };
        }
      }

      // SLIDE
      if (action === "slide") {
        try {
          const sm = ctx.sessionManager;
          if (!sm || typeof sm.getBranch !== "function") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Session manager not available.",
                },
              ],
              details: { action, error: "no session manager" },
            };
          }

          const keepCount = params?.keep != null ? params.keep : 50;
          if (typeof keepCount !== "number" || keepCount < 1 || !Number.isFinite(keepCount)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "keep must be a positive integer >= 1.",
                },
              ],
              details: { action, error: "invalid keep" },
            };
          }

          const branch = sm.getBranch() ?? [];
          if (branch.length <= keepCount) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Branch has ${branch.length} entries, which is <= keep (${keepCount}). Nothing to slide.`,
                },
              ],
              details: {
                action,
                keep: keepCount,
                branchLength: branch.length,
                slid: 0,
              },
            };
          }

          const usage = captureUsage(ctx);
          const usageLine = usage
            ? `${usage.percent.toFixed(1)}% used (${formatTokensK(usage.tokens)} tokens)`
            : "unknown";

          // Skip slide compact if context is already low — pi-core returns
          // "nothing to compact" as a confusing whisper. Checked BEFORE any
          // state write: a skipped slide must not leave slideMode armed for a
          // later compaction cycle to consume.
          if (usage && usage.percent < 30) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: [
                    `**Slide skipped — context at ${usage.percent.toFixed(1)}% (already low).**`,
                    `No entries need dropping. Use context_inspect(detail="quick") to verify.`,
                  ].join("\n"),
                },
              ],
              details: {
                action,
                skipped: true,
                reason: `context ${usage.percent.toFixed(1)}% < 30% threshold`,
                branchLength: branch.length,
              },
            };
          }

          const armedSlide = armSlideCompaction(pi, ctx, keepCount);
          if (!armedSlide) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Session manager not available.",
                },
              ],
              details: { action, error: "no session manager" },
            };
          }
          const { keptCount, droppedCount } = armedSlide;

          // Slide window armed — count it as navigation adoption.
          recordNavigationAction(ctx, "slide");

          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `**Slide window compaction triggered.**`,
                  `  Keep recent: ${keptCount} entries`,
                  `  ~${droppedCount} entries before the slide point, estimated`,
                  `  Before: ${usageLine}`,
                  ``,
                  `Compaction armed; it fires at the next turn boundary (turn end or run settle) — live usage will NOT drop until it lands.`,
                  `Agent will resume automatically after compaction completes.`,
                  `Run context_inspect(detail='quick') after resume to verify.`,
                ].join("\n"),
              },
            ],
            details: {
              action,
              slideTriggered: true,
              keep: keepCount,
              dropped: droppedCount,
              branchLength: branch.length,
              nextStep: {
                tool: "context_inspect",
                detail: "quick",
                note: "after auto-resume",
              },
            },
          };
        } catch (e: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to slide: ${e.message}`,
              },
            ],
            details: { action, error: e.message },
          };
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: "Unknown action. Use compact, archive, deep_clean, or slide.",
          },
        ],
        details: { action, error: true },
      };
    },
  });
}
