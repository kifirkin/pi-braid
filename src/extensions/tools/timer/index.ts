/**
 * Timer Extension — Non-blocking Pomodoro-style reminders
 *
 * Agent sets a timer, continues working, gets a reminder when it fires.
 * This replaces bash `sleep` which blocks the tool call.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../../lib/logger.js";
import { Type } from "typebox";
import { sendTrackedMessage } from "../../../lib/injection-tracker.js";
import { eventBus } from "../../../lib/event-bus.js";

const log = createLogger("timer");

// ── Timer Manager ─────────────────────────────────────────────────────────────

export interface ScheduledTimer {
  id: string;
  firesAt: number; // Unix timestamp (ms)
  reason: string;
  tag?: string;
  createdAt: number;
}

class TimerManager {
  private timers: Map<string, ScheduledTimer> = new Map();

  setTimer(delayMs: number, reason: string, tag?: string): string {
    const id = `timer_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const firesAt = Date.now() + delayMs;

    this.timers.set(id, { id, firesAt, reason, tag, createdAt: Date.now() });
    log.info(`[timer] set: ${id} fires in ${Math.round(delayMs / 1000)}s — ${reason}`);
    return id;
  }

  cancelTimer(id: string): boolean {
    const deleted = this.timers.delete(id);
    if (deleted) log.info(`[timer] cancelled: ${id}`);
    return deleted;
  }

  listTimers(): ScheduledTimer[] {
    return Array.from(this.timers.values()).sort((a, b) => a.firesAt - b.firesAt);
  }

  /** Check for expired timers — removes them from the map and returns them */
  checkExpired(nowMs: number): ScheduledTimer[] {
    const expired: ScheduledTimer[] = [];
    for (const [id, timer] of this.timers) {
      if (timer.firesAt <= nowMs) {
        expired.push(timer);
        this.timers.delete(id);
        log.info(`[timer] fired: ${id} — ${timer.reason}`);
      }
    }
    return expired;
  }

  getActiveCount(): number {
    return this.timers.size;
  }

  /** Check if any timer is expired without removing (for polling guard) */
  hasExpiredIn(nowMs: number): boolean {
    for (const timer of this.timers.values()) {
      if (timer.firesAt <= nowMs) return true;
    }
    return false;
  }
}

const timerManager = new TimerManager();

/**
 * Programmatic timer API — schedule a timer from any extension.
 * Returns the timer ID. Timer fires and delivers a steer to the agent.
 */
export function scheduleTimer(delayMs: number, reason: string, tag?: string): string {
  return timerManager.setTimer(delayMs, reason, tag);
}

/** Cancel a timer by ID. */
export function cancelTimer(id: string): boolean {
  return timerManager.cancelTimer(id);
}

// ── Fire Handlers (via shared bus) ───────────────────────────────────
// We import the shared bus to bridge timer fires → heartbeat surfacing
import { emitTimerReminder } from "../../../lib/timer-bus.js";

// Internal handler count (kept for API compat — currently unused,
// no callers register via onTimerFire. The event bus handles
// timer_fire delivery. Kept for future use but with zero-current-cost.)
type TimerFireHandler = (timer: ScheduledTimer) => void;
const fireHandlers: Set<TimerFireHandler> = new Set();

export function onTimerFire(handler: TimerFireHandler): () => void {
  fireHandlers.add(handler);
  return () => fireHandlers.delete(handler);
}

// ── Real-time polling ───────────────────────────────────────────────────────
// Timer expiry checked every second — independent of turn_end so timers fire
// even when the agent is between turns or blocked in a long tool call.
// This is the primary fire mechanism; turn_end is a backup.
const POLL_INTERVAL_MS = 1000;
let pollHandle: ReturnType<typeof setInterval> | null = null;
let piRef: ExtensionAPI | null = null;

function fireTimer(timer: ScheduledTimer, pi: ExtensionAPI): void {
  for (const h of fireHandlers) {
    try {
      h(timer);
    } catch {}
  }
  emitTimerReminder(timer); // → heartbeat bus → agent reminder on next tick

  // Emit via event bus (unified event-driven path)
  try {
    eventBus.emit({
      type: "timer_fire",
      id: timer.id,
      reason: timer.reason,
      tag: timer.tag,
      payload: `⏰ Timer "${timer.reason}" has fired. Action required.`,
    });
  } catch {}

  log.info(`[timer] fired: ${timer.id} — ${timer.reason}`);
  // Try to wake the agent with a steer message if between turns
  try {
    sendTrackedMessage(
      pi,
      {
        customType: "timer",
        content: [{ type: "text" as const, text: `[timer] ${timer.reason}` }],
        display: true,
      },
      { deliverAs: "steer", triggerTurn: true },
      { type: "heartbeat", source: "timer/fire" },
    );
  } catch {
    /* non-fatal — agent may be mid-turn */
  }
}

function startTimerPolling(pi: ExtensionAPI): void {
  if (pollHandle) return; // Already polling
  piRef = pi;
  pollHandle = setInterval(() => {
    const expired = timerManager.checkExpired(Date.now());
    for (const timer of expired) {
      fireTimer(timer, pi);
    }
  }, POLL_INTERVAL_MS);
  log.info(`[timer] real-time polling started (every ${POLL_INTERVAL_MS}ms)`);
}

function stopTimerPolling(): void {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function timerExtension(pi: ExtensionAPI): void {
  // timer_set
  pi.registerTool({
    name: "timer_set",
    label: "Timer Set",
    promptSnippet: "Set a non-blocking timer for background processes",
    description:
      "Set a non-blocking timer for builds, background processes, and long-running tasks — use when you need a process to run in the background without blocking. Returns immediately without hanging. " +
      "Use for: builds, background processes, pomodoro cycles, escalation chains.",
    parameters: Type.Object({
      delay_seconds: Type.Number({ minimum: 1, maximum: 86400 }),
      reason: Type.String({ minLength: 1 }),
      tag: Type.Optional(Type.String()),
    }),
    execute: async (_id: string, params: any): Promise<any> => {
      const { delay_seconds, reason, tag } = params ?? {};

      if (tag && !/^[a-zA-Z0-9_-]+$/.test(tag)) {
        throw new Error(`Invalid tag "${tag}" — use alphanumeric + dash/underscore`);
      }

      const delayMs = (delay_seconds ?? 60) * 1000;
      const id = timerManager.setTimer(delayMs, reason ?? "Timer", tag);
      const firesAt = Date.now() + delayMs;

      return {
        content: [
          {
            type: "text" as const,
            text: `Timer set for ${delay_seconds}s (ID: ${id}). Will fire at ${new Date(firesAt).toLocaleTimeString()}. Continue working — reminder will arrive automatically. Use timer_cancel with this ID to cancel.`,
          },
        ],
        details: {
          timer_id: id,
          fires_at: new Date(firesAt).toISOString(),
          fires_in_seconds: delay_seconds,
          active_timers: timerManager.getActiveCount(),
        },
      };
    },
  } as any);

  // timer_list
  pi.registerTool({
    name: "timer_list",
    label: "Timer List",
    promptSnippet: "List all active timers",
    description:
      "List all active timers — use to check if background processes have completed or need attention.",
    parameters: Type.Object({}),
    execute: async (): Promise<any> => {
      const timers = timerManager.listTimers();
      const now = Date.now();

      if (timers.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No active timers." }],
          details: { active_timers: 0, timers: [] },
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
        details: { active_timers: timers.length, timers: formatted },
      };
    },
  } as any);

  // timer_cancel
  pi.registerTool({
    name: "timer_cancel",
    label: "Timer Cancel",
    promptSnippet: "Cancel an active timer before it fires",
    description: "Cancel an active timer when the timed task is no longer needed. The timer_id is returned by timer_set and shown in timer_list output.",
    parameters: Type.Object({ timer_id: Type.String() }),
    execute: async (_id: string, params: any): Promise<any> => {
      const { timer_id } = params ?? {};
      const cancelled = timerManager.cancelTimer(timer_id);
      if (!cancelled) {
        throw new Error(`Timer "${timer_id}" not found or already fired.`);
      }
      return {
        content: [{ type: "text" as const, text: `Timer "${timer_id}" cancelled.` }],
        details: { cancelled: true, timer_id, active_timers: timerManager.getActiveCount() },
      };
    },
  } as any);

  // Start real-time polling on load
  startTimerPolling(pi);

  // Fallback: check expired timers on turn_end (catches anything the poll missed)
  pi.on("turn_end", () => {
    const expired = timerManager.checkExpired(Date.now());
    for (const timer of expired) {
      fireTimer(timer, pi);
    }
  });

  // Clean up polling on shutdown
  pi.on("session_shutdown" as any, () => {
    stopTimerPolling();
  });

  log.info("[timer] loaded: timer_set, timer_list, timer_cancel");
}
