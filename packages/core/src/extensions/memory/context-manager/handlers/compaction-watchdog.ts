// Compaction stall watchdog.
//
// A stalling in-flight auto-compaction freezes the agent: pi-core's
// summarization stream has no extension-visible progress signal
// between session_before_compact and the outcome events, and when the stream
// stalls mid-flight (headers arrived, body never completes) the compaction
// promise never settles - no session_compact, no session_compact_failed, no
// retry, no timeout (stalls have run 25+ minutes frozen at "Auto-compacting...",
// until an operator Escape). A
// session abort cancels the in-flight compaction via
// AgentSession.abortCompaction() (pi-core agent-session.js:1602-1606, aborting
// the manual + auto + branch-summary AbortControllers) and lands the cycle in
// session_compact_failed, which returns the agent to its loop.
//
// This module automates exactly that. Armed when a compaction cycle starts
// (session_before_compact), cleared when the cycle ends (session_compact /
// session_compact_failed / session_shutdown). If no completion arrives within
// the threshold, it logs one loud line, writes a durable trace entry (the
// compaction-trace module), marks the cancel source, and calls ctx.abort() -
// the extension surface's documented cancel path (runner.js "abort: () =>
// runner.abortFn()" wired to session.abort() at agent-session.js:2064-2070).
//
// Silence semantics: pi-core 0.85.1 exposes NO per-chunk or per-retry progress
// to extensions during a summarization (the retry callbacks
// _summarizationRetryCallbacks, agent-session.js:1470-1489, emit only to
// AgentSession's internal listeners, never to the extension runner). Until a
// progress source exists, notifyCompactionProgress() has no production caller
// and the silence threshold equals the total-cycle deadline. The API exists
// so the moment pi-core exposes progress (or a future braid layer feeds it),
// the deadline extends without redesign - tested by the
// slow-but-progressing fixture.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { log, getCmState, isCompactionActive, armCompactionFailsafeCut } from "./shared.js";
import { triggerFailsafeCompaction } from "./compaction-retry.js";
import { getExtensionState } from "../../../../lib/state/extension-state.js";
import { countSpanMessages, writeCompactionTrace, type EntryAppender } from "./compaction-trace.js";
import { sendTrackedMessage } from "../../../../lib/utils/injection-tracker.js";
import { USAGE_WHISPER_CRITICAL } from "../../../../lib/detection/context-thresholds.js";

/**
 * Silence threshold after which an in-flight compaction is declared stalled
 * and aborted. Justified from the observed data: legitimate summarizations
 * complete in 31-87 s in observed repro runs, the
 * retry backoff ladders add seconds (compaction 3s/6s/12s, overflow 2s/4s/8s,
 * provider retries <= 8s each), while an observed stall ran 25+ minutes with
 * byte-identical token counters. 15 minutes is ~10x the slowest observed
 * legitimate completion and recovers a dead stream well before a
 * multi-minute operator-visible freeze.
 */
export const COMPACTION_STALL_THRESHOLD_MS = 900_000;

interface CompactionWatchdogState {
  /** Pending deadline timer, or null when disarmed. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Monotonic cycle counter; a stale timer must not fire on a newer cycle. */
  cycleId: number;
  /** Epoch ms when the current deadline expires (undefined when disarmed). */
  deadlineAt: number | undefined;
  /** Epoch ms when the current cycle was armed (stall duration measurement). */
  armedAt: number | undefined;
  /** pi-core reason of the armed cycle (manual | threshold | overflow). */
  armedReason: string | undefined;
  /** Raw summarization-input message count captured at arm time. */
  spanMessages: number | undefined;
  /** Progress notifications received for the armed cycle. */
  progressCount: number;
  /** Silence threshold of the armed cycle (test seam). */
  thresholdMs: number;
  /** The extension API appendEntry seam captured at arm time. */
  appender: EntryAppender | undefined;
}

const DEFAULT_WATCHDOG_STATE: Omit<CompactionWatchdogState, "thresholdMs"> = {
  timer: null,
  cycleId: 0,
  deadlineAt: undefined,
  armedAt: undefined,
  armedReason: undefined,
  spanMessages: undefined,
  progressCount: 0,
  appender: undefined,
};

function getWatchdogState(ctx: ExtensionContext): CompactionWatchdogState {
  return getExtensionState<CompactionWatchdogState>(
    ctx,
    "context-manager/compaction-watchdog",
    () => ({
      ...DEFAULT_WATCHDOG_STATE,
      thresholdMs: COMPACTION_STALL_THRESHOLD_MS,
    }),
  );
}

function disarmTimer(state: CompactionWatchdogState): void {
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.deadlineAt = undefined;
}

/** The watchdog fire block, shared by arm and progress re-arm. */
function scheduleStallCheck(ctx: ExtensionContext, cycleId: number, sinceLabel: string): void {
  const state = getWatchdogState(ctx);
  const deadline = Date.now() + state.thresholdMs;
  state.deadlineAt = deadline;
  state.timer = setTimeout(() => {
    // A cleared watchdog (null timer) or a replaced cycle must not fire.
    const st = getWatchdogState(ctx);
    if (st.timer === null || st.cycleId !== cycleId) return;
    // Only fire while a compaction is actually in-flight; the outcome stages
    // clear the watchdog, so an armed timer at fire time means no outcome
    // arrived - but guard against the race anyway.
    if (!isCompactionActive(ctx)) {
      disarmTimer(st);
      return;
    }
    const durationMs = st.armedAt !== undefined ? Date.now() - st.armedAt : undefined;
    disarmTimer(st);
    const reason = st.armedReason;
    const spanMessages = st.spanMessages;
    let traceCycleId: number | undefined;
    try {
      traceCycleId = getCmState(ctx).compactionCycleId;
    } catch {
      /* state unavailable - cycle id degrades to absent */
    }
    log.error(
      `[context-manager] Compaction STALLED: no completion event for ` +
        `${Math.round(st.thresholdMs / 1000)}s ${sinceLabel} ` +
        `(duration=${durationMs !== undefined ? Math.round(durationMs / 1000) : "?"}s, ` +
        `class=stall span=${spanMessages ?? "?"} msgs progress-events=${st.progressCount}) - ` +
        `aborting in-flight compaction so the agent returns to its loop`,
    );
    try {
      if (st.appender) {
        writeCompactionTrace(st.appender, ctx, {
          event: "stall",
          reason,
          failureClass: "stall",
          errorMessage: `no completion event within ${Math.round(st.thresholdMs / 1000)}s ${sinceLabel}`,
          spanMessages,
          retryAttempt: 0,
          willRetry: false,
          cancelSource: "watchdog",
          cycleId: traceCycleId,
          durationMs,
        });
      } else {
        log.warn(
          "[context-manager] watchdog fired without an appendEntry seam - trace entry skipped",
        );
      }
    } catch {
      /* trace failures are already logged and degraded inside */
    }
    // Mark the cancel source so session_compact_failed knows this abort was
    // a stall, not an operator action, and can re-issue a bounded retry.
    try {
      getCmState(ctx).cancelSource = "watchdog";
    } catch {
      /* state unavailable - the cancel then records as an external abort */
    }
    try {
      ctx.abort();
    } catch (e) {
      // The runner context asserts liveness before dispatching abort; a
      // watchdog firing into a dying session must never crash the process.
      log.warn("[context-manager] watchdog abort failed:", e);
    }
  }, state.thresholdMs);
}

/**
 * Arm (or re-arm) the stall watchdog for a compaction cycle. Each call
 * replaces any pending timer: re-firings of the same cycle (pi-core's
 * in-cycle double-fire of session_before_compact) simply refresh the
 * deadline; a genuinely new cycle gets a new cycleId so a stale timer can
 * never fire on it.
 */
export function armCompactionWatchdog(
  pi: EntryAppender,
  ctx: ExtensionContext,
  opts?: { thresholdMs?: number; reason?: string },
): void {
  const state = getWatchdogState(ctx);
  const thresholdMs = opts?.thresholdMs ?? COMPACTION_STALL_THRESHOLD_MS;
  disarmTimer(state);
  state.cycleId++;
  state.armedAt = Date.now();
  state.armedReason = opts?.reason;
  state.progressCount = 0;
  state.thresholdMs = thresholdMs;
  state.appender = pi;
  try {
    state.spanMessages = countSpanMessages(getCmState(ctx).pendingCompactionOriginals);
  } catch {
    state.spanMessages = undefined;
  }
  scheduleStallCheck(ctx, state.cycleId, "(cycle start)");
}

/**
 * Report summarization progress for the armed cycle: pushes the stall
 * deadline forward. With no per-chunk progress source in pi-core 0.85.1 this
 * has no production caller yet; it is the seam future progress events wire
 * into (see module header).
 */
export function notifyCompactionProgress(ctx: ExtensionContext): void {
  const state = getWatchdogState(ctx);
  if (state.timer === null) return;
  state.progressCount++;
  disarmTimer(state);
  scheduleStallCheck(ctx, state.cycleId, "since last progress");
}

/**
 * Disarm the watchdog. Called on every cycle outcome (success, failure,
 * abort, cancel) and on session shutdown, so a completed compaction can never
 * leave a live timer behind.
 */
export function clearCompactionWatchdog(ctx: ExtensionContext): void {
  const state = getWatchdogState(ctx);
  disarmTimer(state);
  state.armedAt = undefined;
  state.armedReason = undefined;
}

/**
 * Epoch ms when the currently armed cycle started, or undefined when disarmed.
 * Read BEFORE clearCompactionWatchdog so an outcome trace can carry the cycle
 * wall time: the failure handler clears the watchdog before it writes the
 * trace, so the armed timestamp is otherwise gone by trace time.
 */
export function getCompactionWatchdogArmedAt(ctx: ExtensionContext): number | undefined {
  return getWatchdogState(ctx).armedAt;
}

// A summary token-cap abort is the one compaction failure whose own recovery
// can wedge: the bounded chunked retry is dispatched by a guard
// (compactionRetryActive), and the observed end state was
// "Retry skipped - already active" with no landed entry - the session stayed
// over its threshold and could not compact. The stall watchdog above answers a
// hung stream; this rule answers a failed one: a summary-cap abort lands one
// deterministic keep-recent slide (no model call) and names the action, so the
// class can never be the terminal state of a session. The rule is gated twice
// so it cannot itself loop: it only fires above the critical usage band (below
// it the bounded retry ladder owns recovery), and at most once per cooldown
// window (a second abort inside it is observed, not slid again).

export const SUMMARY_CAP_SLIDE_COOLDOWN_MS = 15 * 60 * 1000;
/** Window over which concurrent summary-cap aborts are counted for the alert. */
export const SUMMARY_CAP_ABORT_WINDOW_MS = 15 * 60 * 1000;
/**
 * Usage band above which a summary-cap abort is a loop signal, not a one-off:
 * below it the bounded retry is the cheaper, lossless recovery. Mirrors the
 * band the no-progress fail-safe arms at (USAGE_WHISPER_CRITICAL).
 */
export const SUMMARY_CAP_SLIDE_USAGE_THRESHOLD = USAGE_WHISPER_CRITICAL;

interface SummaryCapWatchdogState {
  /** Epoch ms of the last automatic deterministic slide (cooldown anchor). */
  lastSlideAt: number | undefined;
  /** Recent summary-cap abort times, pruned to the observation window. */
  abortTimes: number[];
}

function getSummaryCapWatchdogState(ctx: ExtensionContext): SummaryCapWatchdogState {
  return getExtensionState<SummaryCapWatchdogState>(
    ctx,
    "context-manager/summary-cap-watchdog",
    () => ({ lastSlideAt: undefined, abortTimes: [] }),
  );
}

/**
 * Record a summary-cap abort and, when the gates allow, arm and dispatch one
 * deterministic slide. Returns what the rule did so the caller and its
 * fixtures can assert it. Never throws: a watchdog that crashes the failure
 * path it observes is worse than no watchdog.
 */
export function handleSummaryCapAbort(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  opts: { errorMessage?: string; spanMessages?: number; usagePercent?: number; now?: number } = {},
): { slid: boolean; reason: string } {
  const state = getSummaryCapWatchdogState(ctx);
  const now = opts.now ?? Date.now();
  state.abortTimes.push(now);
  state.abortTimes = state.abortTimes.filter((t) => now - t <= SUMMARY_CAP_ABORT_WINDOW_MS);
  let usagePercent = opts.usagePercent;
  if (usagePercent === undefined) {
    try {
      usagePercent = getCmState(ctx).preCompactionUsagePercent;
    } catch {
      /* state unavailable - the gate degrades to below-threshold */
    }
  }
  const span = opts.spanMessages ?? "?";
  const abortsInWindow = state.abortTimes.length;
  try {
    if (typeof usagePercent !== "number" || usagePercent < SUMMARY_CAP_SLIDE_USAGE_THRESHOLD) {
      log.error(
        `[context-manager] Summary-cap abort: class=summary-cap span=${span} msgs ` +
          `action=deterministic-slide-skipped reason=below-usage-threshold ` +
          `(usage=${usagePercent ?? "?"}% < ${SUMMARY_CAP_SLIDE_USAGE_THRESHOLD}%) - the bounded retry ladder owns recovery`,
      );
      return { slid: false, reason: "below-usage-threshold" };
    }
    if (
      state.lastSlideAt !== undefined &&
      now - state.lastSlideAt < SUMMARY_CAP_SLIDE_COOLDOWN_MS
    ) {
      const remainingSec = Math.ceil(
        (SUMMARY_CAP_SLIDE_COOLDOWN_MS - (now - state.lastSlideAt)) / 1000,
      );
      log.error(
        `[context-manager] Summary-cap abort: class=summary-cap span=${span} msgs ` +
          `action=deterministic-slide-skipped reason=cooldown ${remainingSec}s remaining ` +
          `(aborts-in-window=${abortsInWindow})`,
      );
      return { slid: false, reason: "cooldown" };
    }
    const reason =
      `summary-cap abort (span ${span} msgs, ${abortsInWindow} abort(s) in window, ` +
      `usage ${usagePercent.toFixed(0)}%)`;
    const armed = armCompactionFailsafeCut(ctx, reason);
    if (armed) {
      state.lastSlideAt = now;
      // Deferred: the dispatch must not abort the very turn reporting the
      // failure. If a bounded retry already owns the next cycle the dispatch
      // stands down and that cycle lands the armed cut instead.
      triggerFailsafeCompaction(ctx);
    }
    log.error(
      `[context-manager] Summary-cap abort: class=summary-cap span=${span} msgs ` +
        `action=deterministic-slide-${armed ? "armed" : "already-armed"} usage=${usagePercent.toFixed(0)}%` +
        (opts.errorMessage ? ` error=${opts.errorMessage}` : ""),
    );
    sendTrackedMessage(
      pi,
      {
        customType: "context",
        content: [
          {
            type: "text" as const,
            text:
              `[warn] Summary-cap abort (class=summary-cap, span ${span} msgs) at ${usagePercent.toFixed(0)}% context. ` +
              `A bounded chunked retry can wedge on "already active", so the deterministic keep-recent slide ` +
              `(no LLM) is ${armed ? "armed" : "already armed"} for the next compaction. ` +
              `At most one automatic slide per ${Math.round(SUMMARY_CAP_SLIDE_COOLDOWN_MS / 60000)} min.`,
          },
        ],
        display: true,
      },
      { delivery: "park", deliverAs: "steer" },
      { type: "context", source: "context-manager/compaction/summary-cap-watchdog" },
    );
    return { slid: armed, reason: armed ? "armed" : "already-armed" };
  } catch (e) {
    log.warn("[context-manager] summary-cap watchdog rule failed:", e);
    return { slid: false, reason: "error" };
  }
}
