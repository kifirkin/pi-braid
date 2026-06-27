/**
 * Timer Extension - Non-blocking Pomodoro-style reminders
 *
 * Agent sets a timer, continues working, gets a reminder when it fires.
 * This replaces bash `sleep` which blocks the tool call.
 *
 * ── SESSION SCOPING ─────────────────────────────────────────────────────
 * Timers are stored per-session (keyed by ctx.sessionManager.getSessionId()).
 * Each pi session has its own poller that only fires its own timers.
 * This prevents cross-session leaks: when session A's context_compress
 * cancels its resume timers, session B's resume timers are untouched.
 *
 * The sessionId is required for cancelTimersByTag() (fail fast) and is
 * stamped on each ScheduledTimer for traceability.
 *
 * ── ROADMAP DR-C-4: SINGLE-PROCESS-PER-SESSION ASSUMPTION ────────────────
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

import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { nextId } from "../../../lib/utils/id.js";
import { createLogger } from "../../../lib/core/logger.js";
import { Type } from "typebox";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { getSessionIdSafe } from "../../../lib/state/extension-state.js";
import { getTimerExtensionFactoryState } from "../../../lib/state/global-state.js";

import { BRAID_INJECTED, BRAID_SOURCE } from "../../../lib/constants/injection-details.js";
import type { ScheduledTimer } from "../../../lib/events/timer-types.js";
import { TimerPoller } from "./poller.js";

const log = createLogger("timer");

// ── Timer Manager ─────────────────────────────────────────────────────────────

export type { ScheduledTimer };

/**
 * Per-session timer store. Outer map: sessionId → (inner map: timerId → timer).
 *
 * Module-level singleton - this is the global registry. Each session's timers
 * live in their own inner map, so cross-session operations are impossible.
 * Use the exported session-scoped functions below; do NOT touch this class
 * directly from external code.
 */
class TimerManager {
  private timersBySession: Map<string, Map<string, ScheduledTimer>> = new Map();

  setTimer(
    sessionId: string,
    delayMs: number,
    reason: string,
    tag?: string,
    wake: boolean = true,
  ): string {
    const id = nextId('timer');
    const firesAt = Date.now() + delayMs;

    let sessionTimers = this.timersBySession.get(sessionId);
    if (!sessionTimers) {
      sessionTimers = new Map();
      this.timersBySession.set(sessionId, sessionTimers);
    }
    sessionTimers.set(id, { id, firesAt, reason, tag, createdAt: Date.now(), wake, sessionId });
    log.info(
      `[timer] set: ${id} session=${sessionId} fires in ${Math.round(delayMs / 1000)}s - ${reason}${wake ? " (wake)" : " (silent)"}`,
    );
    return id;
  }

  cancelTimer(sessionId: string, id: string): boolean {
    const sessionTimers = this.timersBySession.get(sessionId);
    if (!sessionTimers) return false;
    const deleted = sessionTimers.delete(id);
    if (deleted) log.info(`[timer] cancelled: ${id} (session=${sessionId})`);
    return deleted;
  }

  /** Cancel all timers for a session. Returns number cancelled. Used on session_shutdown. */
  clearSession(sessionId: string): number {
    const sessionTimers = this.timersBySession.get(sessionId);
    if (!sessionTimers) return 0;
    const n = sessionTimers.size;
    this.timersBySession.delete(sessionId);
    if (n > 0) log.info(`[timer] cleared session ${sessionId}: ${n} timer(s)`);
    return n;
  }

  listTimers(sessionId: string): ScheduledTimer[] {
    const sessionTimers = this.timersBySession.get(sessionId);
    if (!sessionTimers) return [];
    return Array.from(sessionTimers.values()).sort((a, b) => a.firesAt - b.firesAt);
  }

  /** Check for expired timers in a session - removes them and returns them. */
  checkExpired(sessionId: string, nowMs: number): ScheduledTimer[] {
    const sessionTimers = this.timersBySession.get(sessionId);
    if (!sessionTimers) return [];
    const expired: ScheduledTimer[] = [];
    for (const [id, timer] of sessionTimers) {
      if (timer.firesAt <= nowMs) {
        expired.push(timer);
        sessionTimers.delete(id);
        log.info(`[timer] fired: ${id} (session=${sessionId}) - ${timer.reason}`);
      }
    }
    return expired;
  }

  cancelTimersByTag(sessionId: string, tag: string): number {
    const sessionTimers = this.timersBySession.get(sessionId);
    if (!sessionTimers) return 0;
    let cancelled = 0;
    for (const [id, t] of sessionTimers) {
      if (t.tag === tag) {
        sessionTimers.delete(id);
        cancelled++;
      }
    }
    if (cancelled > 0) {
      log.info(`[timer] cancelled ${cancelled} timer(s) with tag="${tag}" (session=${sessionId})`);
    }
    return cancelled;
  }

  getActiveCount(sessionId: string): number {
    return this.timersBySession.get(sessionId)?.size ?? 0;
  }

  /** Total across all sessions. For diagnostics/tests only. */
  getTotalCount(): number {
    let n = 0;
    for (const s of this.timersBySession.values()) n += s.size;
    return n;
  }
}

const timerManager = new TimerManager();

/**
 * Defensive sessionId extraction. Returns "anonymous" if the ctx is missing
 * or sessionManager is unavailable - those timers will be cancelled together
 * in the "anonymous" bucket. Prefer passing a real sessionId.
 *
 * ROADMAP P3-16 / DR-L-2: delegates to the canonical `getSessionIdSafe`
 * helper in `lib/state/extension-state.ts`. The old inline `as` cast
 * pattern duplicated logic that the typed helper was created to centralize.
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
): string {
  return timerManager.setTimer(sessionId, delayMs, reason, tag, wake);
}

/** Cancel a timer by ID in a specific session. */
export function cancelTimer(sessionId: string, id: string): boolean {
  return timerManager.cancelTimer(sessionId, id);
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
 */
export function cancelTimersByTag(sessionId: string, tag: string): number {
  return timerManager.cancelTimersByTag(sessionId, tag);
}

/** Clear all timers for a session. Used on session_shutdown to free memory. */
export function clearSessionTimers(sessionId: string): number {
  return timerManager.clearSession(sessionId);
}

// ── Fire Handlers (via shared bus) ───────────────────────────────────
// We import the shared bus to bridge timer fires → heartbeat surfacing
import { emitTimerReminder } from "../../../lib/events/timer-bus.js";
import {
  TURN_END,
  TOOL_CALL,
  TOOL_EXECUTION_END,
  SESSION_SHUTDOWN,
  SESSION_START,
} from "../../../lib/core/event-names.js";

// ROADMAP P3-15 / DR-L-1: removed dead onTimerFire API. The handler set
// was exported but no callers ever registered. The fireTimer loop that
// invoked fireHandlers is now a no-op (the emitTimerReminder call below
// is the real delivery path). If a future feature needs this hook,
// re-introduce it with a real consumer.

// ── Fire Handlers (via shared bus) ───────────────────────────────────

// ── Real-time polling (per-pi instance) ──────────────────────────────────────
// Timer expiry checked every second - independent of turn_end so timers fire
// even when the agent is between turns or blocked in a long tool call.
// This is the primary fire mechanism; turn_end is a backup.
//
// TimerPoller extracted to ./poller.ts. The class is constructed with
// callbacks for expired-timer lookup and fire (so it doesn't depend on
// the closure-scoped timerManager and fireTimer in this file).

function fireTimer(timer: ScheduledTimer, pi: ExtensionAPI): void {
  emitTimerReminder(timer); // → heartbeat bus → agent reminder on next tick

  // (Previously emitted eventBus.emit({ type: "timer_fire", ... }) here.
  // Removed in fresh-eyes audit 2026-06-11: no listener was ever registered
  // for "timer_fire" - the emit was dead code. The actual wake-up path is
  // via sendUserMessage (wake:true) or sendTrackedMessage (wake:false)
  // below, NOT through the event bus. If a future feature needs to react
  // to timer fires asynchronously, register a listener first.)

  log.info(`[timer] fired: ${timer.id} (session=${timer.sessionId}) - ${timer.reason}`);

  // Compute elapsed time for the wake message
  const elapsedSec = Math.round((Date.now() - timer.createdAt) / 1000);

  // Two delivery paths based on `wake`:
  //
  //   wake: true (default for user/agent-scheduled timers AND
  //         post-compaction auto-resume)
  //     → pi.sendMessage({ customType, content, display: true }, { triggerTurn: true })
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
  //   wake: false (silent reminder, used for background heartbeats etc.)
  //     → sendTrackedMessage (custom-message whisper, per-source cap applies)
  //     Whisper is visible in TUI and survives compaction (via
  //     _braidInjected) but does NOT force a new turn.
  //
  // Both paths emit the [TIMER FIRED] prefix so the agent can recognize
  // them in the conversation stream. wake: true prepends the elapsed
  // time for context; wake: false uses the shorter form.
  if (timer.wake === true) {
    const text = `[TIMER FIRED - ${elapsedSec}s elapsed] ${timer.reason} - Resume the task.`;
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
      );
    } catch (e) {
      log.warn(`[timer] whisper-wake delivery failed: ${(e as Error).message}`);
    }
  } else {
    const text = `[TIMER FIRED] ${timer.reason}`;
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
        { deliverAs: "steer", triggerTurn: false },
        { type: "heartbeat", source: "timer/fire" },
        { bypassFloodCap: true },
      );
    } catch (e) {
      log.warn(`[timer] steer delivery failed (agent may be mid-turn): ${(e as Error).message}`);
    }
  }
}

// ── Extension ───────────────────────────────────────────────────────────────

function createTimerTool(sessionState: { id: string; resolved: boolean }): ToolDefinition<any, any, any> {
  return {
    name: "timer",
    label: "Timer",
    promptSnippet: "Set, list, or cancel non-blocking session-scoped timers",
    description:
      "Manage non-blocking timers for the current session. " +
      "Use action=set with delay_seconds/reason (and optional tag) to schedule. " +
      "Use action=list to see active timers. " +
      "Use action=cancel with timer_id to cancel. " +
      "Timers are scoped to the current session; another session's timer_cancel will not affect this one.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("set"), Type.Literal("list"), Type.Literal("cancel")], {
        description: "Action: set | list | cancel",
      }),
      // set-only
      delay_seconds: Type.Optional(
        Type.Number({ minimum: 1, maximum: 86400, description: "Delay in seconds (set)" }),
      ),
      reason: Type.Optional(Type.String({ minLength: 1, description: "Reason text (set)" })),
      tag: Type.Optional(Type.String({ description: "Optional tag for grouping (set)" })),
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
          const { delay_seconds, reason, tag } = params;
          if (tag && !/^[a-zA-Z0-9_-]+$/.test(tag)) {
            throw new Error(`Invalid tag "${tag}" - use alphanumeric + dash/underscore`);
          }
          const delayMs = (delay_seconds ?? 60) * 1000;
          const id = timerManager.setTimer(sessionState.id, delayMs, reason ?? "Timer", tag);
          const firesAt = Date.now() + delayMs;
          return {
            content: [
              {
                type: "text" as const,
                text: `Timer set for ${delay_seconds}s (ID: ${id}, session=${sessionState.id}). Will fire at ${new Date(firesAt).toLocaleTimeString()}. Continue working - reminder will arrive automatically. Use timer action=cancel with this ID to cancel.`,
              },
            ],
            details: {
              timer_id: id,
              fires_at: new Date(firesAt).toISOString(),
              fires_in_seconds: delay_seconds,
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
            fires_in_seconds: Math.max(0, Math.ceil((t.firesAt - now) / 1000)),
            fires_at: new Date(t.firesAt).toLocaleTimeString(),
          }));
          return {
            content: [
              {
                type: "text" as const,
                text: `${timers.length} active timer(s). ${formatted.map((t) => `ID:${t.timer_id} [${t.tag}] fires in ${t.fires_in_seconds}s: ${t.reason}`).join("; ")}`,
              },
            ],
            details: { active_timers: timers.length, timers: formatted, session_id: sessionState.id },
          };
        }
        case "cancel": {
          const cancelled = timerManager.cancelTimer(sessionState.id, params.timer_id);
          if (!cancelled) {
            throw new Error(
              `Timer "${params.timer_id}" not found in session ${sessionState.id} or already fired.`,
            );
          }
          return {
            content: [{ type: "text" as const, text: `Timer "${params.timer_id}" cancelled.` }],
            details: {
              cancelled: true,
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

export default function timerExtension(pi: ExtensionAPI): void {
  // DR-C-4 runtime check: count factory invocations and warn if the
  // single-process-per-session assumption is violated. The counter lives
  // in global-state.ts (not as a module-level let here) so the
  // no-module-level-let contract is satisfied. See the top-of-file
  // comment block (lines 16-41) for the full assumption + migration path.
  const factoryState = getTimerExtensionFactoryState();
  factoryState.callCount += 1;
  if (factoryState.callCount > 1) {
    log.warn(
      `[timer] DR-C-4: timerExtension(pi) called ${factoryState.callCount} times in this process. ` +
        `The single-process-per-session assumption is violated; ` +
        `poller/sessionState closures may conflict across sessions. ` +
        `See src/extensions/scheduling/timer/index.ts:16-41 for the migration path.`,
    );
  }

  // sessionId is determined lazily on first tool call. We register a
  // session_start handler to capture it eagerly.
  // Wrapped in a state object so the createTimerTool() factory can
  // mutate it (objects pass by reference; primitives don't).
  const sessionState = { id: "anonymous", resolved: false };

  // Consolidated timer tool with 3 actions (set/list/cancel)
  pi.registerTool(createTimerTool(sessionState));

  // ── Per-pi poller: one per session ────────────────────────────────────
  // The poller is created LAZILY on first session-aware event, because we
  // need the sessionId. Once captured, it lives until SESSION_SHUTDOWN.
  let poller: TimerPoller | null = null;
  const ensurePoller = (ctx: unknown): TimerPoller => {
    if (!poller) {
      const sid = getSessionId(ctx);
      sessionState.id = sid;
      sessionState.resolved = true;
      poller = new TimerPoller(
        sid,
        (sessionId, now) => timerManager.checkExpired(sessionId, now),
        fireTimer,
        log,
      );
    }
    return poller;
  };

  // Start polling on session_start so we have a sessionId available
  pi.on(SESSION_START, (_event: any, ctx: unknown) => {
    const p = ensurePoller(ctx);
    p.setPiRef(pi);
    p.start();
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
  // - tool_call (before tool runs) → busy=true
  // - tool_execution_end (after tool returns) → busy=false
  // - turn_end → busy=false (safety net for turns with no tool calls)
  //
  // This is still safe against the post-compaction stack overflow because
  // it blocks whisper injection only during actual tool execution, not
  // during LLM thinking (which can't chain into synchronous re-entry).
  pi.on(TOOL_CALL, (_event: unknown, ctx: unknown) => {
    const p = ensurePoller(ctx);
    p.setBusy(true);
  });
  pi.on(TOOL_EXECUTION_END, (_event: unknown, ctx: unknown) => {
    const p = ensurePoller(ctx);
    p.setBusy(false);
    // Opportunistically fire any expired timers that piled up during the
    // tool execution. This is the primary fire path for timers that
    // expired mid-tool - they don't have to wait for turn_end.
    p.fireExpired();
  });
  pi.on(TURN_END, (_event: unknown, ctx: unknown) => {
    const p = ensurePoller(ctx);
    p.setBusy(false);
    // Backup fire path: catch any expired timers the per-tool path missed
    // (e.g., turns with no tool calls, or edge cases where TOOL_EXECUTION_END
    // didn't fire).
    p.fireExpired();
  });

  // Clean up polling + clear session timers on shutdown to prevent leaks
  pi.on(SESSION_SHUTDOWN, (_event: unknown, ctx: unknown) => {
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
