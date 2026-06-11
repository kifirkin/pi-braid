/**
 * Timer Extension — Non-blocking Pomodoro-style reminders
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
 */

import type { ExtensionAPI, ToolDefinition, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { Type } from "typebox";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { eventBus } from "../../../lib/events/event-bus.js";
import type { ScheduledTimer } from "../../../lib/events/timer-types.js";

const log = createLogger("timer");

// ── Timer Manager ─────────────────────────────────────────────────────────────

export type { ScheduledTimer };

/**
 * Per-session timer store. Outer map: sessionId → (inner map: timerId → timer).
 *
 * Module-level singleton — this is the global registry. Each session's timers
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
    const id = `timer_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const firesAt = Date.now() + delayMs;

    let sessionTimers = this.timersBySession.get(sessionId);
    if (!sessionTimers) {
      sessionTimers = new Map();
      this.timersBySession.set(sessionId, sessionTimers);
    }
    sessionTimers.set(id, { id, firesAt, reason, tag, createdAt: Date.now(), wake, sessionId });
    log.info(
      `[timer] set: ${id} session=${sessionId} fires in ${Math.round(delayMs / 1000)}s — ${reason}${wake ? " (wake)" : " (silent)"}`,
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

  /** Check for expired timers in a session — removes them and returns them. */
  checkExpired(sessionId: string, nowMs: number): ScheduledTimer[] {
    const sessionTimers = this.timersBySession.get(sessionId);
    if (!sessionTimers) return [];
    const expired: ScheduledTimer[] = [];
    for (const [id, timer] of sessionTimers) {
      if (timer.firesAt <= nowMs) {
        expired.push(timer);
        sessionTimers.delete(id);
        log.info(`[timer] fired: ${id} (session=${sessionId}) — ${timer.reason}`);
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
 * or sessionManager is unavailable — those timers will be cancelled together
 * in the "anonymous" bucket. Prefer passing a real sessionId.
 */
function getSessionId(ctx: unknown): string {
  const c = ctx as { sessionManager?: { getSessionId?: () => string | undefined } } | undefined;
  return c?.sessionManager?.getSessionId?.() ?? "anonymous";
}

/**
 * Programmatic timer API — schedule a timer for a specific session.
 * Returns the timer ID. Timer fires and delivers a steer to the agent.
 *
 * @param wake if true (default), the fire whisper uses triggerTurn: true
 *   to wake the agent. This matches the principle that user-scheduled
 *   reminders (timer action=set) expect a wake-up. The busy guard prevents
 *   mid-tool-execution firing even when wake: true, so this is safe in
 *   all cases. Pass wake: false for silent reminders (visible in TUI
 *   but no forced turn) — used by background heartbeats and similar.
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
 * timers — does NOT touch other sessions running in the same process.
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
import { TURN_END, TOOL_CALL, TOOL_EXECUTION_END, SESSION_SHUTDOWN, SESSION_START } from "../../../lib/core/event-names.js";

// Internal handler count (kept for API compat — currently unused,
// no callers register via onTimerFire. The event bus handles
// timer_fire delivery. Kept for future use but with zero-current-cost.)
type TimerFireHandler = (timer: ScheduledTimer) => void;
const fireHandlers: Set<TimerFireHandler> = new Set();

export function onTimerFire(handler: TimerFireHandler): () => void {
  fireHandlers.add(handler);
  return () => fireHandlers.delete(handler);
}

// ── Real-time polling (per-pi instance) ──────────────────────────────────────
// Timer expiry checked every second — independent of turn_end so timers fire
// even when the agent is between turns or blocked in a long tool call.
// This is the primary fire mechanism; turn_end is a backup.
//
// PER-PI: each pi instance gets its own poller that only fires its own
// session's timers. Previously the poller was a module-level singleton
// with one piRef — if two sessions ran, only the most recently registered
// session received timer fires. Now each session is independent.
const POLL_INTERVAL_MS = 1000;

class TimerPoller {
  pollHandle: ReturnType<typeof setInterval> | null = null;
  piRef: ExtensionAPI | null = null;
  // busy guard: when true, the poller skips fireTimer() to prevent whisper
  // injection mid-tool-execution (which can chain into synchronous re-entry
  // and overflow the stack — see issue: stack overflow on scratchpad after
  // compaction). Set true on TOOL_CALL, false on TURN_END.
  busy = false;

  constructor(
    private sessionId: string,
    private getCtx: () => ExtensionContext | undefined,
  ) {}

  setPiRef(pi: ExtensionAPI): void {
    this.piRef = pi;
  }

  start(): void {
    if (this.pollHandle) return;
    this.pollHandle = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    log.info(`[timer] polling started (session=${this.sessionId}, every ${POLL_INTERVAL_MS}ms)`);
  }

  stop(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  private poll(): void {
    const pi = this.piRef;
    if (!pi) return;
    if (this.busy) return; // bail — defer fire to next non-busy tick or TURN_END
    const expired = timerManager.checkExpired(this.sessionId, Date.now());
    for (const timer of expired) {
      fireTimer(timer, pi);
    }
  }

  isRunning(): boolean {
    return this.pollHandle !== null;
  }

  /** Fire any expired timers now (called from TOOL_EXECUTION_END / TURN_END). */
  fireExpired(): ScheduledTimer[] {
    if (!this.piRef) return [];
    const expired = timerManager.checkExpired(this.sessionId, Date.now());
    for (const timer of expired) {
      fireTimer(timer, this.piRef);
    }
    return expired;
  }
}

function fireTimer(timer: ScheduledTimer, pi: ExtensionAPI): void {
  for (const h of fireHandlers) {
    try {
      h(timer);
    } catch (e) {
      log.warn(`[timer] fireHandler error: ${(e as Error).message}`);
    }
  }
  emitTimerReminder(timer); // → heartbeat bus → agent reminder on next tick

  // (Previously emitted eventBus.emit({ type: "timer_fire", ... }) here.
  // Removed in fresh-eyes audit 2026-06-11: no listener was ever registered
  // for "timer_fire" — the emit was dead code. The actual wake-up path is
  // via sendUserMessage (wake:true) or sendTrackedMessage (wake:false)
  // below, NOT through the event bus. If a future feature needs to react
  // to timer fires asynchronously, register a listener first.)

  log.info(`[timer] fired: ${timer.id} (session=${timer.sessionId}) — ${timer.reason}`);

  // Compute elapsed time for the wake message
  const elapsedSec = Math.round((Date.now() - timer.createdAt) / 1000);

  // Two delivery paths based on `wake`:
  //
  //   wake: true (post-compaction resume timer, user-explicit auto-resume)
  //     → pi.sendUserMessage(text, { deliverAs: "followUp" })
  //     A USER-STYLE message that "Always triggers a turn" per the SDK
  //     contract. Bypasses the per-source flood cap because auto-resume
  //     is user-explicit and time-critical: if 2 timer fires land in the
  //     same turn, the user wants BOTH. Bypasses sendTrackedMessage
  //     because the soft-nudge nature of sendMessage(steer) can be
  //     ignored by the agent mid-stream.
  //
  //   wake: false (silent reminder, default for user-scheduled timers)
  //     → sendTrackedMessage (custom-message whisper, per-source cap applies)
  //     Whisper is visible in TUI and survives compaction (via
  //     _braidInjected) but does NOT force a new turn. Safer default
  //     for "remind me in 5 minutes" type timers.
  //
  // Both paths emit the [TIMER FIRED] prefix so the agent can recognize
  // them in the conversation stream. wake: true prepends the elapsed
  // time for context; wake: false uses the shorter form.
  if (timer.wake === true) {
    const text = `[TIMER FIRED — ${elapsedSec}s elapsed] ${timer.reason} — Resume the task.`;
    // SDK: ExtensionContext.sendUserMessage is declared as returning `void`
    // (Promise<void> is only on ReplacedSessionContext). At runtime the
    // underlying call is fire-and-forget — the SDK handles the queue and
    // triggers the turn. We log before/after to capture failures (any
    // sync throw lands in the catch; rejections from the underlying
    // promise are absorbed by the SDK's own logging).
    //
    // The previous `as unknown as Promise<void>` cast was a typecheck-only
    // lie: at runtime the return is `undefined`, and `.catch()` on that
    // throws "Cannot read properties of undefined (reading 'catch')".
    try {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    } catch (e) {
      log.warn(`[timer] user-message delivery failed: ${(e as Error).message}`);
    }
  } else {
    const text = `[TIMER FIRED] ${timer.reason}`;
    try {
      sendTrackedMessage(
        pi,
        {
          customType: "timer",
          content: [{ type: "text" as const, text }],
          display: true,
          details: {
            _braidInjected: true,
            _braidSource: "timer/fire",
            timerId: timer.id,
            sessionId: timer.sessionId,
            wake: false,
          },
        },
        { deliverAs: "steer", triggerTurn: false },
        { type: "heartbeat", source: "timer/fire" },
      );
    } catch (e) {
      log.warn(`[timer] steer delivery failed (agent may be mid-turn): ${(e as Error).message}`);
    }
  }
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function timerExtension(pi: ExtensionAPI): void {
  // sessionId is determined lazily on first tool call. We register a
  // session_start handler to capture it eagerly.
  let sessionId = "anonymous";
  let sessionIdResolved = false;

  // Consolidated timer tool with 3 actions (set/list/cancel)
  pi.registerTool({
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
    execute: async (_id: string, params: any, _signal: any, _onUpdate: any, ctx: any): Promise<any> => {
      if (!sessionIdResolved) {
        sessionId = getSessionId(ctx);
        sessionIdResolved = true;
      }
      switch (params?.action) {
        case "set": {
          const { delay_seconds, reason, tag } = params;
          if (tag && !/^[a-zA-Z0-9_-]+$/.test(tag)) {
            throw new Error(`Invalid tag "${tag}" — use alphanumeric + dash/underscore`);
          }
          const delayMs = (delay_seconds ?? 60) * 1000;
          const id = timerManager.setTimer(sessionId, delayMs, reason ?? "Timer", tag);
          const firesAt = Date.now() + delayMs;
          return {
            content: [
              {
                type: "text" as const,
                text: `Timer set for ${delay_seconds}s (ID: ${id}, session=${sessionId}). Will fire at ${new Date(firesAt).toLocaleTimeString()}. Continue working — reminder will arrive automatically. Use timer action=cancel with this ID to cancel.`,
              },
            ],
            details: {
              timer_id: id,
              fires_at: new Date(firesAt).toISOString(),
              fires_in_seconds: delay_seconds,
              active_timers: timerManager.getActiveCount(sessionId),
              session_id: sessionId,
            },
          };
        }
        case "list": {
          const timers = timerManager.listTimers(sessionId);
          const now = Date.now();
          if (timers.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No active timers." }],
              details: { active_timers: 0, timers: [], session_id: sessionId },
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
            details: { active_timers: timers.length, timers: formatted, session_id: sessionId },
          };
        }
        case "cancel": {
          const cancelled = timerManager.cancelTimer(sessionId, params.timer_id);
          if (!cancelled) {
            throw new Error(`Timer "${params.timer_id}" not found in session ${sessionId} or already fired.`);
          }
          return {
            content: [{ type: "text" as const, text: `Timer "${params.timer_id}" cancelled.` }],
            details: { cancelled: true, timer_id: params.timer_id, active_timers: timerManager.getActiveCount(sessionId), session_id: sessionId },
          };
        }
        default:
          throw new Error(`Unknown timer action: ${params?.action}. Use: set, list, cancel.`);
      }
    },
  } as ToolDefinition);

  // ── Per-pi poller: one per session ────────────────────────────────────
  // The poller is created LAZILY on first session-aware event, because we
  // need the sessionId. Once captured, it lives until SESSION_SHUTDOWN.
  let poller: TimerPoller | null = null;
  const ensurePoller = (ctx: unknown): TimerPoller => {
    if (!poller) {
      const sid = getSessionId(ctx);
      sessionId = sid;
      sessionIdResolved = true;
      poller = new TimerPoller(sid, () => ctx as ExtensionContext | undefined);
    }
    return poller;
  };

  // Start polling on session_start so we have a sessionId available
  pi.on(SESSION_START, (event: any, ctx: unknown) => {
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
    // expired mid-tool — they don't have to wait for turn_end.
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
