/**
 * Timer Extension - Non-blocking Pomodoro-style reminders
 *
 * Agent sets a timer, continues working, gets a reminder when it fires.
 * This replaces bash `sleep` which blocks the tool call.
 *
 * Session scoping:
 * Timers are stored per-session (keyed by ctx.sessionManager.getSessionId()).
 * Each pi session has its own poller that only fires its own timers.
 * This prevents cross-session leaks: when session A's context_compress
 * cancels its resume timers, session B's resume timers are untouched.
 *
 * The sessionId is required for cancelTimersByTag() (fail fast) and is
 * stamped on each ScheduledTimer for traceability.
 *
 * Single-process-per-session assumption:────────
 * The `poller` below is a closure-captured `let` inside the extension
 * factory. Each call to `timerExtension(pi)` creates a fresh closure
 * with its own `poller` variable, which is correct for the standard
 * pi lifecycle (one process per session, one extension registration
 * per session, one poller per session).
 *
 * The assumption breaks if a single Node process ever runs MORE THAN
 * ONE pi session concurrently, because the `poller`, `sessionState`,
 * and `sessionIdResolved` closures would conflict. The `TimerManager`
 * class (above) is already keyed by sessionId and is safe across
 * concurrent sessions; only the extension-factory state is not.
 *
 * If multi-session-per-process ever becomes a real requirement, the
 * fix is to migrate `poller` and `sessionState` to
 * `getExtensionState(ctx, "timer", ...)` keyed by the ctx's session
 * id. The factory pattern of getExtensionState doesn't accept ctx in
 * the factory closure, so this requires either (a) adding a
 * `setExtensionState` setter or (b) a custom WeakMap. Documented
 * here so future contributors know the assumption is load-bearing.
 *
 * A debug-mode counter (`_extensionFactoryCallCount`) at the bottom
 * of this file logs a warning if `timerExtension(pi)` is called more
 * than once in the same process. In dev/CI this catches the
 * accidental double-registration early.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { Type } from "typebox";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { getSessionIdSafe } from "../../../lib/state/extension-state.js";
import {
  getTimerExtensionFactoryState,
  getTurnStartGate,
} from "../../../lib/state/global-state.js";
import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { getTimerFilePath } from "../../../lib/config/braid-paths.js";
import {
  getTerminalBreakerConfig,
  getWakeDeliveryAlertConfig,
} from "../../../lib/config/braid-settings.js";
import {
  getWatchdogWakeDeliveryFeed,
  setWatchdogWakeDueProvider,
} from "../../../lib/state/global-state.js";
import { formatLocalTime } from "../../../lib/utils/local-time.js";
import { describeFireTiming } from "./fire-timing.js";

type PersistedTimer = {
  id: string;
  sessionId: string;
  firesAt: number;
  reason: string;
  tag?: string;
  createdAt: number;
  wake: boolean;
  /** Recurrence interval in ms. Omitted = one-shot (legacy persisted format). */
  intervalMs?: number;
  /** Optional bound on a recurring timer's lifetime (total fires). */
  count?: number;
  /** Fires delivered so far (persisted so a bounded recurrence resumes mid-cadence). */
  fires?: number;
};

/** Get the timer file path for the current process CWD.
 *  Each project CWD has its own timer file for independent timer pools. */
function timerFilePath(): string {
  return getTimerFilePath(process.cwd());
}

function loadPendingTimers(): PersistedTimer[] {
  try {
    const file = timerFilePath();
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, "utf-8").trim();
    if (!raw) return [];
    return raw.split("\n").map((line) => JSON.parse(line) as PersistedTimer);
  } catch {
    return [];
  }
}

function savePendingTimers(timers: PersistedTimer[]): void {
  try {
    writeTimerStore(
      timerFilePath(),
      timers.map((t) => JSON.stringify(t)),
    );
  } catch (err) {
    // Swallowing a persist failure silently drops every pending timer on
    // restart — surface it, but never break the timer fire path.
    log.warn(`timer persistence failed (timers lost on restart): ${err}`);
  }
}

function persistTimerToDisk(timer: PersistedTimer): void {
  try {
    const file = timerFilePath();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(timer) + "\n", "utf-8");
  } catch (err) {
    // Silent loss here means the timer never fires after restart.
    log.warn(`timer append failed (timer lost on restart): ${err}`);
  }
}

function removeTimerFromDisk(id: string): void {
  const timers = loadPendingTimers().filter((t) => t.id !== id);
  savePendingTimers(timers);
}

/**
 * Persist a recurring timer's re-arm: read-modify-write that replaces the
 * line with the matching id (new firesAt / intervalMs) or appends it if
 * missing. Never called for one-shot timers — those use removeTimerFromDisk.
 */
function rearmTimerOnDisk(timer: PersistedTimer): void {
  const timers = loadPendingTimers().filter((t) => t.id !== timer.id);
  timers.push(timer);
  savePendingTimers(timers);
}

import { BRAID_INJECTED, BRAID_SOURCE } from "../../../lib/constants/injection-details.js";
import type { ScheduledTimer } from "../../../lib/events/timer-types.js";
import { TimerPoller } from "./poller.js";
import { wakeRetryQueue, flushRecoveredFires, type WakeRetryCause } from "./wake-retry.js";
import { recoverPersistedTimers, sweepProjectStoresRetention } from "./recovery.js";
import { writeTimerStore } from "./store-file.js";

const log = createLogger("timer");

// Timer Manager

export type { ScheduledTimer };
import { TimerManager, timerManager } from "./timer-manager.js";
export { TimerManager, timerManager };

/**
 * Defensive sessionId extraction. Returns "anonymous" if the ctx is missing
 * or sessionManager is unavailable - those timers will be cancelled together
 * in the "anonymous" bucket. Prefer passing a real sessionId.
 *
 * Delegates to the canonical `getSessionIdSafe` helper in
 * `lib/state/extension-state.ts` — one implementation of the typed
 * extraction, not per-caller `as` casts.
 */
function getSessionId(ctx: unknown): string {
  return getSessionIdSafe(ctx as Parameters<typeof getSessionIdSafe>[0]) ?? "anonymous";
}

/**
 * Programmatic timer API - schedule a timer for a specific session.
 * Returns the timer ID. Timer fires and delivers a CustomMessage
 * (whisper-style) that wakes the agent when wake: true.
 *
 * @param wake if true (default), the fire delivers a CustomMessage
 *   (pi.sendMessage with customType "timer-fire" and triggerTurn: true).
 *   This shows as a whisper in the TUI, not a filled-in input box, and
 *   wakes the agent immediately (subject to the busy guard which defers
 *   mid-tool-execution to TOOL_EXECUTION_END). This is the right path
 *   for automatic timers (post-compaction auto-resume, agent-scheduled
 *   reminders): no human is typing, and the input box should not be
 *   filled with "[TIMER FIRED]". Pass wake: false for silent reminders
 *   (visible in TUI but no forced turn) - used by background heartbeats.
 */
export function scheduleTimer(
  sessionId: string,
  delayMs: number,
  reason: string,
  tag?: string,
  wake: boolean = true,
  intervalMs?: number,
  count?: number,
): string {
  const id = timerManager.setTimer(sessionId, delayMs, reason, tag, wake, intervalMs, count);
  persistTimerToDisk({
    id,
    sessionId,
    firesAt: Date.now() + delayMs,
    reason: reason ?? "Timer",
    tag,
    createdAt: Date.now(),
    wake,
    ...(intervalMs ? { intervalMs } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(intervalMs ? { fires: 0 } : {}),
  });
  return id;
}

/** Cancel a timer by ID in a specific session.
 *
 *  Cancel retires the fire: the timer's outstanding wake, armed retry
 *  ladder, and parked recovered fires are withdrawn with it, so no further
 *  redeliveries fire for a timer the owner cancelled. Retires even when the
 *  manager lookup misses — a fired one-shot leaves the manager at expiry
 *  (delete-on-detection) but its wake ladder may still be armed; the cancel
 *  must reach it. Returns the manager-cancel result (true only if a live
 *  timer was removed). */
export function cancelTimer(sessionId: string, id: string): boolean {
  const cancelled = timerManager.cancelTimer(sessionId, id);
  if (cancelled) removeTimerFromDisk(id);
  wakeRetryQueue.retireTimer(id);
  return cancelled;
}

/**
 * Restore a persisted timer into memory without writing to disk
 * (the disk entry already exists). Used by process-restart recovery
 * to re-arm unexpired timers so the poller fires them on schedule.
 * Returns the new in-memory timer id.
 */
export function restoreTimer(
  sessionId: string,
  delayMs: number,
  reason: string,
  tag: string | undefined,
  wake: boolean,
  intervalMs?: number,
  count?: number,
  firedCount?: number,
): string {
  return timerManager.setTimer(
    sessionId,
    delayMs,
    reason,
    tag,
    wake,
    intervalMs,
    count,
    firedCount,
  );
}

/** List all active timers for a session. Sorted by firesAt. */
export function listTimers(sessionId: string): ScheduledTimer[] {
  return timerManager.listTimers(sessionId);
}

/**
 * Cancel all active timers for a session matching a tag.
 * Used by compaction paths to invalidate stale resume timers from a
 * previous compaction cycle. CRITICAL: only cancels the given session's
 * timers - does NOT touch other sessions running in the same process.
 * Returns the number of timers cancelled.
 *
 * Cancel retires the fire: every matching timer's wake state (outstanding
 * wake, armed ladder, parked recovered fires) is withdrawn via the queue's
 * own records — which also reaches fired one-shots whose live timer is
 * already gone from the manager map but whose wake ladder is still armed.
 */
export function cancelTimersByTag(sessionId: string, tag: string): number {
  wakeRetryQueue.retireTimersWhere((t) => t.sessionId === sessionId && t.tag === tag);
  return timerManager.cancelTimersByTag(sessionId, tag);
}

/** Clear all timers for a session. Used on session_shutdown to free memory.
 *  Also retires the session's wake fires: a shut-down session's timers can
 *  never fire again, and their armed ladders must not outlive the session
 *  (a lingering retry would otherwise redeliver into whatever session is
 *  live in this process next). */
export function clearSessionTimers(sessionId: string): number {
  wakeRetryQueue.retireTimersWhere((t) => t.sessionId === sessionId);
  return timerManager.clearSession(sessionId);
}

// Fire Handlers (via shared bus)
// We import the shared bus to bridge timer fires -> heartbeat surfacing
import { emitTimerReminder } from "../../../lib/events/timer-bus.js";
import {
  TURN_END,
  TOOL_CALL,
  TOOL_EXECUTION_END,
  SESSION_SHUTDOWN,
  SESSION_START,
  AGENT_SETTLED,
  AGENT_END,
} from "../../../lib/core/event-names.js";

// Fire Handlers (via shared bus)

// Real-time polling (per-pi instance)
// Timer expiry checked every second - independent of turn_end so timers fire
// even when the agent is between turns or blocked in a long tool call.
// This is the primary fire mechanism; turn_end is a backup.
//
// TimerPoller extracted to ./poller.ts. The class is constructed with
// callbacks for expired-timer lookup and fire (so it doesn't depend on
// the closure-scoped timerManager and fireTimer in this file).

/**
 * Should this wake fire run without starting a turn?
 *
 * Consumer gate for the terminal-error breaker: the scheduling layer asks the
 * published turn-start gate one latch question and nothing else — why a turn
 * is blocked stays entirely on the publisher's side of the seam. The flag is
 * read once per fire. Fail-open on a missing ctx, a missing gate or a broken
 * reader — a wake must never be silently swallowed by a health lookup; the
 * reminder is still delivered, just non-waking, when the latch is open.
 */
function terminalBreakerBlocksWake(ctx: unknown): boolean {
  try {
    if (!ctx) return false;
    const cfg = getTerminalBreakerConfig();
    if (!cfg.enabled) return false;
    const gate = getTurnStartGate();
    if (!gate) return false;
    return gate.isBlocked(ctx, cfg.threshold);
  } catch {
    return false;
  }
}

/** The non-waking delivery of a fire whose wake is suppressed. Same message,
 *  `{ delivery: "park", deliverAs: "steer" }`: visible in the TUI, no turn. */
function deliverDemotedFire(
  pi: ExtensionAPI,
  params: { customType: string; text: string; details: Record<string, unknown> },
): void {
  try {
    sendTrackedMessage(
      pi,
      {
        customType: params.customType,
        content: [{ type: "text" as const, text: params.text }],
        display: true,
        details: params.details,
      },
      { delivery: "park", deliverAs: "steer" },
      { type: "heartbeat", source: "timer/fire" },
      { bypassFloodCap: true },
    );
  } catch (e) {
    log.warn(
      `[timer] demoted fire delivery failed (agent may be mid-turn): ${(e as Error).message}`,
    );
  }
}

function fireTimer(timer: ScheduledTimer, pi: ExtensionAPI, ctx?: unknown): void {
  // Cancel retires the fire: a timer cancelled in the deferred-fire window
  // (checkExpired returned it, the setTimeout(0) delivery not yet run) must
  // not deliver. The manager map entry is already gone (delete-on-
  // detection), so this mark is the only thing that can win the race.
  if (wakeRetryQueue.isRetired(timer.id)) {
    log.info(`[timer] fire suppressed — timer cancelled before delivery: ${timer.id}`);
    return;
  }
  emitTimerReminder(timer); // -> heartbeat bus -> agent reminder on next tick

  log.info(`[timer] fired: ${timer.id} (session=${timer.sessionId}) - ${timer.reason}`);

  // Recurring timers (intervalMs set) are NOT removed from disk on fire —
  // they are re-armed instead, so the interval lives across a reload. The
  // next firesAt (and the post-fire fires counter) is read from the live map
  // entry, which checkExpired() already re-armed synchronously (in-place)
  // before this deferred fire ran.
  //
  // If the lookup misses, the live entry is gone: either the timer was
  // cancelled in the deferred-fire window (agent cancelled between expiry
  // detection and this callback), OR its count bound exhausted and
  // checkExpired removed it as completed. In BOTH cases the disk entry is
  // removed so cancel wins and a finished recurrence cannot resurrect on
  // the next reload.
  if (timer.intervalMs && timer.intervalMs > 0) {
    const live = timerManager.listTimers(timer.sessionId ?? "").find((t) => t.id === timer.id);
    if (live) {
      // Re-armed (unbounded, or bounded with fires remaining): persist the
      // new cadence so the recurrence lives across a reload. `live` carries
      // the post-fire fires counter; the count bound is preserved verbatim.
      rearmTimerOnDisk({
        id: timer.id,
        sessionId: timer.sessionId ?? "anonymous",
        firesAt: live.firesAt,
        reason: timer.reason,
        tag: timer.tag,
        createdAt: timer.createdAt,
        wake: timer.wake === true,
        intervalMs: timer.intervalMs,
        count: timer.count,
        fires: live.fires ?? 0,
      });
    } else {
      // The live entry is gone: either the timer was cancelled in the
      // deferred-fire window (cancel wins — don't resurrect it on reload)
      // OR its count bound exhausted and checkExpired removed it as
      // completed. In BOTH cases the disk entry must go: a finished or
      // cancelled recurrence must not fire again on the next restart.
      removeTimerFromDisk(timer.id);
    }
  } else {
    // One-shot: remove from disk persistence so it doesn't fire again on
    // next restart.
    removeTimerFromDisk(timer.id);
  }

  // Timer honesty:
  // Every fire renders scheduled vs actual fire time + drift in the owner
  // TZ (the ONE formatter). Timers can fire late (busy agent, mid-tool
  // deferral, process gap) — the agent needs the drift to reason about
  // what "5 minutes" actually meant. Example:
  //   set for 16:58 MSK (UTC+3), fired 17:05 MSK (UTC+3) — drift 7m
  // Recovered fires reuse the exact same marker (fire-timing.ts).
  const { fireTiming, elapsedSec } = describeFireTiming(timer.createdAt, timer.firesAt, Date.now());

  // Two delivery paths based on `wake`:
  //
  //   wake: true (DEFAULT for all timers — one-shot AND recurring — since
  //         silent requires an explicit wake:false)
  //     -> pi.sendMessage({ customType, content, display: true }, { triggerTurn: true })
  //     A CustomMessage (whisper-style in TUI, distinguishable from
  //     user input) that wakes the agent. Per SDK docs:
  //     'sendUserMessage ... sends an actual user message that appears
  //     as if typed by the user. Always triggers a turn.' That is the
  //     WRONG behavior for an automatic timer: no human is typing, and
  //     filling the input box with "[TIMER FIRED]" looks nonsensical
  //     in the TUI. sendMessage + triggerTurn:true is the correct path
  //     for automatic wake-ups.
  //
  //     Why not deliverAs:'steer'? The 'steer' mode defers delivery
  //     until the current tool call finishes, which means if the agent
  //     is mid-tool when a resume timer fires, the wake is delayed. For
  //     'remind me in 5 min' that's acceptable. For post-compaction
  //     auto-resume it's bad: the agent may be idle, and we want the
  //     wake to land NOW. triggerTurn:true handles both: if the agent
  //     is idle it triggers immediately; if it's mid-stream, the busy
  //     guard (TOOL_EXECUTION_END fallback in the poller) defers to
  //     the next non-busy tick. We do NOT use deliverAs:'steer' here
  //     to avoid the SDK's own deferral that ignores mid-tool state.
  //
  //     HARDENING (busy-send deferral): sending { triggerTurn: true } with NO
  //     deliverAs is the residual exposure — a deferred wake landing while
  //     the session is busy (isStreaming=false: the prompt() pre-flight, the
  //     compaction boundary, or a compaction that outlived the wake-gate's
  //     fail-safe) would make pi-core start a COMPETING agent run and the
  //     outer prompt() throws pi-core's activeRun guard. Two layers cover
  //     this at send time (see lib/utils/wake-gate.ts): the state-based
  //     busy check defers the wake into the wake-retry queue (the onBusy
  //     hook below) whenever the session is busy at send time, and the
  //     run-region gate in injection-tracker additionally rewrites such a
  //     wake to a queued steer while a run region is active.
  //
  //   wake: false (silent reminder, used for background heartbeats etc.)
  //     -> sendTrackedMessage (custom-message whisper, per-source cap applies)
  //     Whisper is visible in TUI and survives compaction (via
  //     _braidInjected) but does NOT force a new turn.
  //
  // Both paths are wrapped by the [braid-whisper - timer] envelope via
  // sendTrackedMessage, so the agent can recognize them in the conversation
  // stream. wake: true includes the elapsed time for context.
  if (timer.wake === true) {
    const wakeText = `${timer.reason} - ${fireTiming}. ${elapsedSec}s elapsed since scheduled. Resume the task.`;
    // Terminal-error breaker open: deliver the reminder without starting a
    // turn, and do NOT track it — there is no turn whose outcome could retry.
    if (terminalBreakerBlocksWake(ctx)) {
      log.info(`[timer] wake demoted to non-waking (turn-start blocked): ${timer.id}`);
      deliverDemotedFire(pi, {
        customType: "timer-fire",
        text: wakeText,
        details: {
          [BRAID_INJECTED]: true,
          [BRAID_SOURCE]: "timer/fire",
          timerId: timer.id,
          sessionId: timer.sessionId,
          wake: true,
          elapsedSec,
          breakerSuppressed: true,
        },
      });
      return;
    }
    // Track the wake BEFORE delivery so its turn outcome is resolved
    // at agent_end/agent_settled — a provider 401/413/5xx on the wake turn
    // re-arms this fire for a bounded-backoff redelivery instead of leaving
    // the content stuck in history until an unrelated turn.
    wakeRetryQueue.trackWake(timer);
    const text = wakeText;
    // sendTrackedMessage (unified delivery path). bypassFloodCap ensures
    // the timer fire reaches the agent even when 2+ timer fires already
    // happened in this turn (per-source cap would otherwise drop this one).
    // trackInjection records the wake for observability.
    try {
      sendTrackedMessage(
        pi,
        {
          customType: "timer-fire",
          content: [{ type: "text" as const, text }],
          display: true,
          details: {
            _braidInjected: true,
            _braidSource: "timer/fire",
            timerId: timer.id,
            sessionId: timer.sessionId,
            wake: true,
            elapsedSec,
          },
        },
        { triggerTurn: true },
        { type: "heartbeat", source: "timer/fire" },
        { bypassFloodCap: true },
        {
          // Cancel retires the wake while this send waits for its macrotask
          // (the isRetired guard at fireTimer's entry ran before that
          // window): the seam asks again at send time and drops it.
          isWithdrawn: () => wakeRetryQueue.isRetired(timer.id),
          // Session busy at send time (compaction / pre-flight window):
          // park the fire for redelivery on a later tick instead of
          // sending a raw triggerTurn into a busy session.
          onBusy: () => wakeRetryQueue.deferBusyWake(timer, 0),
        },
      );
    } catch (e) {
      log.warn(`[timer] whisper-wake delivery failed: ${(e as Error).message}`);
    }
  } else {
    const text = `${timer.reason} (${fireTiming})`;
    // sendTrackedMessage (unified delivery path). bypassFloodCap ensures
    // the silent reminder reaches the agent even when 2+ timer fires
    // already happened in this turn. See wake:true branch above for the
    // rationale.
    try {
      sendTrackedMessage(
        pi,
        {
          customType: "timer",
          content: [{ type: "text" as const, text }],
          display: true,
          details: {
            [BRAID_INJECTED]: true,
            [BRAID_SOURCE]: "timer/fire",
            timerId: timer.id,
            sessionId: timer.sessionId,
            wake: false,
          },
        },
        { delivery: "park", deliverAs: "steer" },
        { type: "heartbeat", source: "timer/fire" },
        { bypassFloodCap: true },
      );
    } catch (e) {
      log.warn(`[timer] steer delivery failed (agent may be mid-turn): ${(e as Error).message}`);
    }
  }
}

// failed-wake redelivery

/**
 * Re-deliver a wake fire after its backoff elapsed: either its turn FAILED
 * (provider 401/413/5xx) or its send was DEFERRED while the session was busy
 * (cause "busy" — the redelivery text says held, not failed). Called from
 * the drain callback on poll ticks and the TOOL_EXECUTION_END / TURN_END
 * path — each call is deferred via setTimeout(0) so the redelivery keeps the
 * same macrotask discipline as the primary fireTimer path. The redelivery
 * re-tracks the wake so a second failure escalates the backoff tier; a
 * redelivery landing in a busy session is parked again (onBusy hook); after
 * the effective cap (default 3, braid.timers.maxWakeAttempts) the fire is
 * dropped with a visible notice + error log (never silently lost).
 */
function redeliverWakeFire(
  pi: ExtensionAPI,
  timer: ScheduledTimer,
  attempt: number,
  cause: WakeRetryCause = "failed",
  ctx?: unknown,
): void {
  // Cancel retires the fire: a retry popped from the ladder but not yet sent
  // (drainDue -> setTimeout(0)) must not deliver for a cancelled timer. The
  // redelivery is not re-tracked, so no chain continues from it.
  if (wakeRetryQueue.isRetired(timer.id)) {
    log.info(
      `[timer] wake retry suppressed — timer cancelled since the retry was armed: ${timer.id}`,
    );
    return;
  }
  const maxAttempts = wakeRetryQueue.getMaxAttempts();
  const heldNote =
    cause === "busy"
      ? "held while the session was busy; re-delivered"
      : cause === "timeout"
        ? "no turn outcome within the window; re-delivered"
        : "an earlier wake-fire turn failed; re-delivered";
  const text =
    `${timer.reason} — [wake retry ${attempt}/${maxAttempts}: ` + `${heldNote}]. Resume the task.`;
  // Terminal-error breaker open: the retry rides non-waking and is not
  // re-tracked, so the ladder stops here instead of spending another doomed
  // model call.
  if (terminalBreakerBlocksWake(ctx)) {
    log.info(`[timer] wake retry demoted to non-waking (turn-start blocked): ${timer.id}`);
    deliverDemotedFire(pi, {
      customType: "timer-fire",
      text,
      details: {
        [BRAID_INJECTED]: true,
        [BRAID_SOURCE]: "timer/fire-retry",
        timerId: timer.id,
        sessionId: timer.sessionId,
        wake: true,
        retryAttempt: attempt,
        breakerSuppressed: true,
      },
    });
    return;
  }
  wakeRetryQueue.trackWake(timer, attempt);
  try {
    sendTrackedMessage(
      pi,
      {
        customType: "timer-fire",
        content: [{ type: "text" as const, text }],
        display: true,
        details: {
          _braidInjected: true,
          _braidSource: "timer/fire-retry",
          timerId: timer.id,
          sessionId: timer.sessionId,
          wake: true,
          retryAttempt: attempt,
        },
      },
      { triggerTurn: true },
      { type: "heartbeat", source: "timer/fire-retry" },
      { bypassFloodCap: true },
      {
        // Cancel retires the fire: this retry spent its macrotask window
        // after the isRetired guard above, so the seam re-asks at send time.
        isWithdrawn: () => wakeRetryQueue.isRetired(timer.id),
        onBusy: () => wakeRetryQueue.deferBusyWake(timer, attempt),
      },
    );
  } catch (e) {
    log.warn(`[timer] wake retry delivery failed: ${(e as Error).message}`);
  }
}

/** Human duration for the busy-held note: `45s`, `3m`, `1h05m`. */
function formatHeldDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin === 0 ? `${hours}h` : `${hours}h${String(remMin).padStart(2, "0")}m`;
}

/**
 * Deliver a wake fire whose SEND was held while the session was busy for
 * longer than the bounded redelivery ladder. The ladder's budget is spent,
 * but nothing failed — the fire was parked (deferBusyWake), never dropped.
 * This is its one late delivery, with the honest held-while-busy cause and
 * the whole hold duration in the text. A send deferred AGAIN is held again
 * (onBusy): one fresh rung, and a re-park only once the cap is hit again.
 */
function deliverParkedBusyFire(
  pi: ExtensionAPI,
  timer: ScheduledTimer,
  heldMs: number,
  ctx?: unknown,
): void {
  // Cancel withdraws the fire: retirement reaches a parked fire (the entry is
  // still in the queue's outstanding map) and this guard covers the in-flight
  // window between the drain tick and the deferred send.
  if (wakeRetryQueue.isRetired(timer.id)) {
    log.info(`[timer] parked wake fire suppressed — timer cancelled before delivery: ${timer.id}`);
    wakeRetryQueue.forgetParkedBusy(timer.id);
    return;
  }
  const held = formatHeldDuration(heldMs);
  const text =
    `${timer.reason} — [held while the session was busy for ${held}; delivered late]. ` +
    `Resume the task.`;
  // Terminal-error breaker open: show the content without starting a turn and
  // stop the chain here (a wake turn would only burn another doomed call).
  if (terminalBreakerBlocksWake(ctx)) {
    log.info(`[timer] parked wake demoted to non-waking (turn-start blocked): ${timer.id}`);
    wakeRetryQueue.forgetParkedBusy(timer.id);
    deliverDemotedFire(pi, {
      customType: "timer-fire",
      text,
      details: {
        [BRAID_INJECTED]: true,
        [BRAID_SOURCE]: "timer/fire-retry",
        timerId: timer.id,
        sessionId: timer.sessionId,
        wake: true,
        heldWhileBusyMs: heldMs,
        breakerSuppressed: true,
      },
    });
    return;
  }
  // Re-tracked at attempt 0: the busy ladder never delivered, so a turn that
  // fails now starts a fresh (still capped) failed-redelivery ladder instead
  // of inheriting the spent busy one. `continueHold` keeps this fire's hold
  // origin across the handoff, so the text and the log state the whole held
  // window rather than only the stretch since this handoff.
  wakeRetryQueue.trackWake(timer, 0, { continueHold: true });
  // The send defers to a macrotask and the busy check that decides send vs
  // hold runs THERE, so "delivered late" cannot be stated before that
  // decision: a handoff landing in a still-busy window is held again
  // (onBusy), never sent, and a line claiming a late delivery would describe
  // a delivery the hold withdrew. The same seam answers a cancel that landed
  // in that window (isWithdrawn), so the line stays silent for a withdrawn
  // fire too. The hooks record both withdrawals; the line rides a later
  // macrotask and fires only for a fire that was actually delivered (the
  // re-held handoff is logged by the queue as a park instead).
  let heldAgain = false;
  let cancelled = false;
  try {
    sendTrackedMessage(
      pi,
      {
        customType: "timer-fire",
        content: [{ type: "text" as const, text }],
        display: true,
        details: {
          _braidInjected: true,
          _braidSource: "timer/fire-retry",
          timerId: timer.id,
          sessionId: timer.sessionId,
          wake: true,
          heldWhileBusyMs: heldMs,
        },
      },
      { triggerTurn: true },
      { type: "heartbeat", source: "timer/fire-retry" },
      { bypassFloodCap: true },
      {
        // Cancel withdraws the fire in this window too: neither the send nor
        // a re-park (deferBusyWake would arm a fresh ladder for the retired
        // id) may happen, and the late-delivery line above must not claim it.
        isWithdrawn: () => {
          if (!wakeRetryQueue.isRetired(timer.id)) return false;
          cancelled = true;
          return true;
        },
        onBusy: () => {
          heldAgain = true;
          wakeRetryQueue.deferBusyWake(timer, 0);
        },
      },
    );
    setTimeout(() => {
      if (heldAgain || cancelled) return;
      log.info(
        `[timer] wake fire held while the session was busy for ${held} — delivered late: ${timer.id}`,
      );
    }, 0);
  } catch (e) {
    log.warn(`[timer] parked wake delivery failed: ${(e as Error).message}`);
  }
}

/** Final notice when a wake fire exhausts its retry bound (last resort —
 *  the fire is visible as lost instead of silently vanishing). */
function notifyExhaustedWake(pi: ExtensionAPI, timer: ScheduledTimer): void {
  try {
    sendTrackedMessage(
      pi,
      {
        customType: "timer",
        content: [
          {
            type: "text" as const,
            text: `Wake fire permanently undelivered after ${wakeRetryQueue.getMaxAttempts()} retries: ${timer.reason}`,
          },
        ],
        display: true,
        details: {
          [BRAID_INJECTED]: true,
          [BRAID_SOURCE]: "timer/fire-retry",
          timerId: timer.id,
          exhausted: true,
        },
      },
      { delivery: "park", deliverAs: "steer" },
      { type: "heartbeat", source: "timer/fire-retry" },
    );
  } catch {
    /* notice only — the error log in WakeRetryQueue already recorded it */
  }
}

// Extension

/**
 * Whether wake-delivery alerting is on (`braid.timers.wakeAlert`, read fresh
 * on every event like every braid-settings reader). "off" forwards nothing —
 * the detection feed is the only thing it disables; delivery itself (retry
 * budgets, backoff, caps) is untouched either way.
 */
function wakeAlertOn(): boolean {
  try {
    return getWakeDeliveryAlertConfig().mode === "on";
  } catch {
    return false; // a settings failure must not enable alerting
  }
}

function createTimerTool(sessionState: {
  id: string;
  resolved: boolean;
}): ToolDefinition<any, any, any> {
  return {
    name: "timer",
    label: "Timer",
    promptSnippet: "Set, list, or cancel non-blocking session-scoped timers",
    description:
      "Manage non-blocking timers for the current session. " +
      "Use action=set with delay_seconds/reason (and optional tag, interval_seconds, count, wake) to schedule. " +
      "Use action=list to see active timers. " +
      "Use action=cancel with timer_id to cancel. " +
      "Provide interval_seconds to make a timer re-fire on that cadence until cancelled; " +
      "add count=N to bound it to exactly N total fires (then it stops itself). " +
      "Timers WAKE the agent on each fire by default (recurring included); pass wake:false for a silent advisory reminder. " +
      "Timers are scoped to the current session; another session's timer_cancel will not affect this one.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("set"), Type.Literal("list"), Type.Literal("cancel")], {
        description: "Action: set | list | cancel",
      }),
      delay_seconds: Type.Optional(
        Type.Number({ minimum: 1, maximum: 86400, description: "Delay in seconds (set)" }),
      ),
      reason: Type.Optional(Type.String({ minLength: 1, description: "Reason text (set)" })),
      tag: Type.Optional(Type.String({ description: "Optional tag for grouping (set)" })),
      interval_seconds: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 86400,
          description:
            "Repeat interval in seconds (set). Recurring timer re-fires every interval until cancelled.",
        }),
      ),
      count: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 100000,
          description:
            "Total fires for a recurring timer (set). Bounds the recurrence: after count fires the timer removes itself (e.g. repeat every 60s x5 then stop). Omit for unbounded recurrence until cancelled.",
        }),
      ),
      wake: Type.Optional(
        Type.Boolean({
          description:
            "Wake the agent on each fire (set). Defaults to true for ALL timers (recurring included); pass false for a silent (advisory) reminder.",
        }),
      ),
      // cancel-only
      timer_id: Type.Optional(Type.String({ description: "Timer ID to cancel (cancel)" })),
    }),
    execute: async (
      _id: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
      if (!sessionState.resolved) {
        sessionState.id = getSessionId(ctx);
        sessionState.resolved = true;
      }
      switch (params?.action) {
        case "set": {
          const { delay_seconds, reason, tag, interval_seconds, count, wake } = params;
          if (tag && !/^[a-zA-Z0-9_-]+$/.test(tag)) {
            throw new Error(`Invalid tag "${tag}" - use alphanumeric + dash/underscore`);
          }
          const delayMs = (delay_seconds ?? 60) * 1000;
          const intervalMs = (interval_seconds ?? 0) * 1000;
          const isRecurring = intervalMs > 0;
          if (count !== undefined && !isRecurring) {
            throw new Error(
              "count requires interval_seconds (a recurring timer). One-shot timers fire once by definition.",
            );
          }
          // Every timer wakes by default at the tool surface —
          // recurring included; without a default wake, recurring fires
          // arrive only as whispers attached to the next user turn (stacked
          // overnight, delivered many hours late). Silence is strictly
          // opt-in via wake:false.
          const effectiveWake = wake ?? true;
          const id = scheduleTimer(
            sessionState.id,
            delayMs,
            reason ?? "Timer",
            tag,
            effectiveWake,
            isRecurring ? intervalMs : undefined,
            isRecurring ? count : undefined,
          );
          const firesAt = Date.now() + delayMs;
          // The confirmation carries the owner-TZ wall-clock (the ONE
          // formatter), not the raw server-TZ toLocaleTimeString.
          const when = isRecurring
            ? `Repeats every ${interval_seconds}s${count !== undefined ? `, ${count} times total` : " until cancelled"}${effectiveWake ? " (waking)" : " (silent)"}; next fires at ${formatLocalTime(new Date(firesAt), true)}`
            : `Will fire at ${formatLocalTime(new Date(firesAt), true)}`;
          return {
            content: [
              {
                type: "text" as const,
                text: `Timer set for ${delay_seconds}s (ID: ${id}, session=${sessionState.id}). ${when}. Continue working - reminder will arrive automatically. Use timer action=cancel with this ID to cancel.`,
              },
            ],
            details: {
              timer_id: id,
              fires_at: new Date(firesAt).toISOString(),
              fires_in_seconds: delay_seconds,
              interval_seconds: isRecurring ? interval_seconds : undefined,
              count: isRecurring ? count : undefined,
              fires: isRecurring ? 0 : undefined,
              recurring: isRecurring,
              wake: effectiveWake,
              active_timers: timerManager.getActiveCount(sessionState.id),
              session_id: sessionState.id,
            },
          };
        }
        case "list": {
          const timers = timerManager.listTimers(sessionState.id);
          const now = Date.now();
          if (timers.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No active timers." }],
              details: { active_timers: 0, timers: [], session_id: sessionState.id },
            };
          }
          const formatted = timers.map((t) => ({
            timer_id: t.id,
            tag: t.tag ?? "(untagged)",
            reason: t.reason,
            interval_seconds: t.intervalMs ? Math.round(t.intervalMs / 1000) : undefined,
            count: t.count,
            fires: t.fires ?? 0,
            fires_in_seconds: Math.max(0, Math.ceil((t.firesAt - now) / 1000)),
            fires_at: formatLocalTime(new Date(t.firesAt)),
          }));
          return {
            content: [
              {
                type: "text" as const,
                text: `${timers.length} active timer(s). ${formatted.map((t) => `ID:${t.timer_id} [${t.tag}]${t.interval_seconds ? ` every ${t.interval_seconds}s (repeat ${t.fires}/${t.count ?? "∞"}), next in` : " fires in"} ${t.fires_in_seconds}s: ${t.reason}`).join("; ")}`,
              },
            ],
            details: {
              active_timers: timers.length,
              timers: formatted,
              session_id: sessionState.id,
            },
          };
        }
        case "cancel": {
          // Was there a fire to retire (outstanding wake, armed ladder, or
          // parked recovered fire)? Checked BEFORE the cancel: a fired
          // one-shot is already gone from the manager map, but its wake
          // ladder may still be armed — that cancel must succeed (the
          // retirement is its whole effect), not throw "not found".
          const hadFireState = wakeRetryQueue.hasWakeFireState(params.timer_id);
          const cancelled = cancelTimer(sessionState.id, params.timer_id);
          if (!cancelled && !hadFireState) {
            throw new Error(
              `Timer "${params.timer_id}" not found in session ${sessionState.id} or already fired.`,
            );
          }
          const note = cancelled
            ? `Timer "${params.timer_id}" cancelled.`
            : `Timer "${params.timer_id}" already fired; its outstanding wake ladder was retired.`;
          return {
            content: [{ type: "text" as const, text: note }],
            details: {
              cancelled: true,
              retired_fire: hadFireState,
              timer_id: params.timer_id,
              active_timers: timerManager.getActiveCount(sessionState.id),
              session_id: sessionState.id,
            },
          };
        }
        default:
          throw new Error(`Unknown timer action: ${params?.action}. Use: set, list, cancel.`);
      }
    },
  };
}

/** True only when the ctx positively reports an idle session. Undetermined
 *  (missing isIdle reader, stale ctx whose getters throw) counts as NOT idle:
 *  the post-settle flush stays the fallback, never a race. */
function sessionIsIdle(ctx: unknown): boolean {
  try {
    const isIdle = (ctx as { isIdle?: () => boolean } | null)?.isIdle;
    return typeof isIdle === "function" && isIdle.call(ctx) === true;
  } catch {
    return false;
  }
}

/** True only when the ctx POSITIVELY reports a busy session: a run, its
 *  pre-flight/bookkeeping, or a compaction is in flight (isIdle() live-reads
 *  current runtime state — a ctx captured at any earlier event still answers
 *  truthfully minutes later; see wake-gate.ts). Undetermined ctx (missing
 *  reader, stale getters) counts as NOT busy: the wake-retry queue's outcome
 *  timeout then arms as before — a broken reader must never suppress retries
 *  (a wake is never silently lost), it only costs a spurious-retry risk.
 *  Wired into the queue as the long-run grace predicate. */
function sessionBusy(ctx: unknown): boolean {
  try {
    const isIdle = (ctx as { isIdle?: () => boolean } | null)?.isIdle;
    return typeof isIdle === "function" && isIdle.call(ctx) === false;
  } catch {
    return false;
  }
}

export default function timerExtension(pi: ExtensionAPI): void {
  // Runtime check on that assumption: count factory invocations and warn if the
  // single-process-per-session assumption is violated. The counter lives
  // in global-state.ts (not as a module-level let here) so the
  // no-module-level-let contract is satisfied. See the top-of-file
  // comment block (lines 16-41) for the full assumption + migration path.
  const factoryState = getTimerExtensionFactoryState();
  factoryState.callCount += 1;
  if (factoryState.callCount > 1) {
    log.warn(
      `[timer] timerExtension(pi) called ${factoryState.callCount} times in this process. ` +
        `The single-process-per-session assumption is violated; ` +
        `poller/sessionState closures may conflict across sessions. ` +
        `See src/extensions/scheduling/timer/index.ts:16-41 for the migration path.`,
    );
  }

  // Long-run grace wiring
  // The wake-retry queue's outcome timeout (240s with no settle) must not
  // arm a redelivery while the session is actively running the turn the
  // fire landed in: a multi-minute run is not a lost send, and an arming
  // mid-run both redelivers mid-turn and (via the watchdog feed) pages a
  // "wedged loop" for a healthy run. The queue takes a read-only predicate;
  // this extension owns the wiring. The ctx getters are LIVE (each call
  // reads current runtime state — wake-gate.ts), so the last-seen ctx
  // answers truthfully whenever a drain tick consults it, however long ago
  // it was captured. No ctx captured yet (before session_start) or a broken
  // reader: the predicate answers false — the pre-grace arming applies
  // (a wake is never silently lost), never the grace.
  let lastSeenCtx: unknown = null;
  const captureCtx = (ctx: unknown): void => {
    if (ctx) lastSeenCtx = ctx;
  };
  wakeRetryQueue.setActiveRunCheck(() => sessionBusy(lastSeenCtx));

  // Wake-delivery liveness feed (watchdog seam)
  // The retry queue is where dead wake delivery is KNOWN first (repeated
  // outcome timeouts for one fire, exhausted redelivery chains); the
  // watchdog engine owns the episode latch + out-of-band escalation. This
  // observer is the thread between them: threshold-crossing facts only,
  // delivery untouched, disabled entirely by braid.timers.wakeAlert.mode
  // = "off". The threshold (outcomeTimeouts, default 2) is applied here so
  // one 240s outcome window — a normal long turn — never forwards. A
  // timeout fact can only exist when NO agent run was active at arming
  // time (drainDue's long-run grace), so what reaches the watchdog is a
  // dead delivery, not a busy loop; a wedged ACTIVE run pages via the
  // turn-stall condition instead.
  wakeRetryQueue.setWakeObserver({
    onOutcomeTimeout: (timer, timeouts) => {
      if (!wakeAlertOn()) return;
      try {
        const cfg = getWakeDeliveryAlertConfig();
        if (timeouts < cfg.outcomeTimeouts) return;
        getWatchdogWakeDeliveryFeed()?.recordWakeOutcomeTimeout(timer.id, timer.reason, timeouts);
      } catch {
        // alerting never breaks retry arming
      }
    },
    onWakeDelivered: (timer) => {
      if (!wakeAlertOn()) return;
      try {
        getWatchdogWakeDeliveryFeed()?.recordWakeDelivered(timer.id);
      } catch {
        // alerting never breaks outcome resolution
      }
    },
    onCleanTurn: () => {
      // A wake turn settled without a failure outcome: a real clean turn.
      // The breaker resets its counter only here (not on internal LLM calls),
      // so a session whose wakes are working closes the latch naturally.
      if (lastSeenCtx) {
        try {
          getTurnStartGate()?.noteCleanTurn(lastSeenCtx);
        } catch {
          // a throwing gate must never break settlement
        }
      }
    },
  });

  // sessionId is determined lazily on first tool call. We register a
  // session_start handler to capture it eagerly.
  // Wrapped in a state object so the createTimerTool() factory can
  // mutate it (objects pass by reference; primitives don't).
  const sessionState = { id: "anonymous", resolved: false };

  // Consolidated timer tool with 3 actions (set/list/cancel)
  pi.registerTool(createTimerTool(sessionState));

  // Per-pi poller: one per session
  // The poller is created LAZILY on first session-aware event, because we
  // need the sessionId. Once captured, it lives until SESSION_SHUTDOWN.
  let poller: TimerPoller | null = null;
  // Busy-held fires whose bounded ladder is spent are parked, not dropped;
  // deliver each one late, once the session is idle (the send's own onBusy
  // hook re-parks a delivery that still lands in a busy window). Called from
  // the same ticks as the retry drain AND at the settle, so the held fire
  // lands at the next settle rather than at the next ladder rung.
  const flushParkedBusyFires = (): void => {
    for (const { timer, heldMs } of wakeRetryQueue.drainParkedBusy()) {
      setTimeout(() => deliverParkedBusyFire(pi, timer, heldMs, lastSeenCtx), 0);
    }
  };
  // Drain due failed-wake retries on the same ticks that fire expired
  // timers. Each due retry is redelivered via setTimeout(0) (same macrotask
  // discipline as the fire path); exhausted fires get a final silent notice.
  const drainWakeRetries = (): void => {
    for (const { timer, attempt, cause } of wakeRetryQueue.drainDue()) {
      setTimeout(() => redeliverWakeFire(pi, timer, attempt, cause, lastSeenCtx), 0);
    }
    flushParkedBusyFires();
    for (const timer of wakeRetryQueue.takeExhausted()) {
      notifyExhaustedWake(pi, timer);
      // Drop = dead-delivery episode signal (first event or absorbed by the
      // watchdog's episode latch — one bark per episode either way).
      if (wakeAlertOn()) {
        try {
          getWatchdogWakeDeliveryFeed()?.recordWakeUndelivered(
            timer.id,
            timer.reason,
            wakeRetryQueue.getMaxAttempts(),
          );
        } catch {
          // alerting never breaks the exhausted notice
        }
      }
    }
  };
  const ensurePoller = (ctx: unknown): TimerPoller => {
    if (!poller) {
      const sid = getSessionId(ctx);
      sessionState.id = sid;
      sessionState.resolved = true;
      poller = new TimerPoller(
        sid,
        (sessionId, now) => timerManager.checkExpired(sessionId, now),
        (timer) => fireTimer(timer, pi, lastSeenCtx),
        log,
        drainWakeRetries,
      );
    }
    return poller;
  };

  // Start polling on session_start so we have a sessionId available
  pi.on(SESSION_START, (_event: any, ctx: unknown) => {
    captureCtx(ctx);
    const p = ensurePoller(ctx);
    p.setPiRef(pi);
    p.start();
    // Publish the wake-due question for the watchdog's stall classifier: a
    // due timer/wake is a legitimate reason for a session to look quiet.
    // Answered live from the manager (not captured) so a re-arm or cancel is
    // visible immediately; cleared at shutdown below.
    setWatchdogWakeDueProvider(() => {
      try {
        if (!sessionState.resolved) return false;
        return timerManager.listTimers(sessionState.id).some((t) => t.firesAt <= Date.now());
      } catch {
        return false;
      }
    });
    // A restart converts active timers into passive ones: recovery parks
    // overdue fires in before_agent_start and only an agent_settled flush
    // delivered them, so a recovered wake waited for an unrelated turn to
    // settle (observed: a wake fire recovered after a restart sat 23 minutes
    // until a turn started for entirely different reasons). At session_start
    // the sweep can run itself: recover now, and when the session is idle
    // with parked fires, flush on the next macrotask — no turn, no settle
    // needed. The post-settle flush stays the fallback when the session is
    // busy here, and the send-time onBusy hook re-parks a flush whose
    // macrotask lands in a busy window, so this path is safe by the same
    // machinery, not by luck.
    recoverPersistedTimers(pi, sessionState.id);
    sweepProjectStoresRetention(sessionState.id);
    if (!sessionIsIdle(ctx)) return;
    if (wakeRetryQueue.deferredRecoveredCount() === 0) return;
    setTimeout(() => flushRecoveredFires(pi, lastSeenCtx), 0);
  });

  // Busy guard: set true on tool_call, false on tool_execution_end.
  //
  // Earlier this guard used TURN_END to reset busy, but that had a bug:
  // a long-running tool followed by a long LLM thinking phase would keep
  // busy=true for the entire turn, even though the actual tool was long
  // done. A 30s timer set just before a slow tool would be stuck waiting
  // for turn_end (which might be minutes away if the LLM is thinking).
  //
  // The correct guard is per-tool-execution:
  // - tool_call (before tool runs) -> busy=true
  // - tool_execution_end (after tool returns) -> busy=false
  // - turn_end -> busy=false (safety net for turns with no tool calls)
  //
  // This is still safe against the post-compaction stack overflow because
  // it blocks whisper injection only during actual tool execution, not
  // during LLM thinking (which can't chain into synchronous re-entry).
  pi.on(TOOL_CALL, (_event: unknown, ctx: unknown) => {
    captureCtx(ctx);
    const p = ensurePoller(ctx);
    p.setBusy(true);
  });
  pi.on(TOOL_EXECUTION_END, (_event: unknown, ctx: unknown) => {
    captureCtx(ctx);
    const p = ensurePoller(ctx);
    p.setBusy(false);
    // Opportunistically fire any expired timers that piled up during the
    // tool execution. This is the primary fire path for timers that
    // expired mid-tool - they don't have to wait for turn_end.
    p.fireExpired();
  });
  pi.on(TURN_END, (_event: unknown, ctx: unknown) => {
    captureCtx(ctx);
    const p = ensurePoller(ctx);
    p.setBusy(false);
    // Backup fire path: catch any expired timers the per-tool path missed
    // (e.g., turns with no tool calls, or edge cases where TOOL_EXECUTION_END
    // didn't fire).
    p.fireExpired();
  });

  // failed-wake retry wiring
  // agent_end carries the run's messages: the LAST assistant message's
  // stopReason === "error" marks a provider/auth failure (401/413/5xx).
  // "aborted" is a deliberate user stop — content is already in history,
  // so it resolves as delivered, not retried.
  pi.on(AGENT_END, (event: unknown, ctx: unknown) => {
    captureCtx(ctx);
    // The errorMessage rides along — a retryable class
    // (transport/timeout/5xx) starts the wake-retry hold so the outcome
    // timeout cannot arm a redelivery while pi-core is still auto-retrying
    // the run.
    const messages =
      (
        event as {
          messages?: Array<{
            role?: string;
            stopReason?: string;
            errorMessage?: string;
            details?: Record<string, unknown>;
          }>;
        }
      )?.messages ?? [];
    // Delivery confirmation (delivered-once invariant): a wake fire whose
    // injected CustomMessage is among the run's messages LANDED, even when
    // the run later failed — the failure belongs to the agent's own work,
    // not to the delivery. Collected for the queue so the failed settle
    // re-arms only fires whose message is absent here.
    const landedTimerIds = new Set<string>();
    for (const m of messages) {
      const details = m?.details;
      if (!details || m.role !== "custom") continue;
      if (details[BRAID_INJECTED] !== true) continue;
      const source = details[BRAID_SOURCE];
      if (typeof source !== "string" || !source.startsWith("timer/")) continue;
      if (typeof details.timerId === "string") landedTimerIds.add(details.timerId);
    }
    let failed = false;
    let errorMessage: string | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") {
        failed = messages[i].stopReason === "error";
        errorMessage = messages[i].errorMessage;
        break;
      }
    }
    wakeRetryQueue.onAgentEnd(failed, errorMessage, landedTimerIds);
  });
  // agent_settled fires in the prompt() finally — AFTER auto-retries,
  // compaction, and queued continuations are done, even for failed runs —
  // so resolving here cannot race a pi-core retry. Idempotent (empty
  // outstanding → no-op), so the prompt-builder fallback listener cannot
  // double-resolve. flushRecoveredFires delivers the recovered persisted
  // fires deferred by recoverPersistedTimers post-settle, where a
  // wake:true fire safely starts its own turn.
  pi.on(AGENT_SETTLED, (_event: unknown, ctx: unknown) => {
    captureCtx(ctx);
    wakeRetryQueue.onAgentSettled();
    flushRecoveredFires(pi, lastSeenCtx);
    // The session just went idle: a busy-held fire parked during the run gets
    // its one late delivery now, at the settle — not at the next ladder rung.
    flushParkedBusyFires();
  });

  // Clean up polling + clear session timers on shutdown to prevent leaks
  pi.on(SESSION_SHUTDOWN, (_event: unknown, ctx: unknown) => {
    setWatchdogWakeDueProvider(null);
    if (poller) {
      poller.stop();
      poller = null;
    }
    const sid = getSessionId(ctx);
    const cleared = timerManager.clearSession(sid);
    if (cleared > 0) {
      log.info(`[timer] session ${sid} shutdown: cleared ${cleared} timer(s)`);
    }
  });

  log.info("[timer] loaded: timer (set/list/cancel actions)");
}
