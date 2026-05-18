/**
 * Sleep Tool — non-blocking delay with deferred reminder
 *
 * Unlike a blocking bash `sleep`, this tool returns immediately and fires a
 * reminder after the requested delay expires. The agent can continue working
 * and will be notified when the sleep period ends.
 *
 * Implementation: schedules a single `setTimeout` callback that, when fired,
 * pushes to the timer-bus, emits a timer_fire event, and sends a steer message.
 * Does NOT touch TimerManager (no timer_list/timer_cancel visibility — use
 * `timer_set` if you need cancellable, trackable timers).
 *
 * Relationship to timer_set:
 *   - timer_set: canonical, cancellable, visible in timer_list, uses setInterval polling
 *   - sleep: minimal, fire-once, no cancellation, uses single setTimeout per call
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../../lib/logger.js";
import { eventBus } from "../../lib/event-bus.js";
import { emitTimerReminder } from "../../lib/timer-bus.js";
import { sendTrackedMessage } from "../../lib/injection-tracker.js";

const log = createLogger("sleep");

// ── Constants ────────────────────────────────────────────────────────────────

const MIN_DELAY_SECS = 1;
const MAX_DELAY_SECS = 86_400; // 24 hours
const DEFAULT_DELAY_SECS = 30;

// ── Helpers ──────────────────────────────────────────────────────────────────

function validateDelay(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < MIN_DELAY_SECS || seconds > MAX_DELAY_SECS) {
    throw new Error(
      `delay_seconds must be between ${MIN_DELAY_SECS} and ${MAX_DELAY_SECS} (got ${seconds})`,
    );
  }
}

function makeReason(requested?: string, delaySecs?: number): string {
  return requested ?? `Sleep for ${delaySecs ?? DEFAULT_DELAY_SECS}s — resume when timer fires`;
}

/**
 * Fire the reminder after the delay expires. Called exactly once per sleep() call.
 */
function fireReminder(
  pi: ExtensionAPI,
  timerId: string,
  firesAt: number,
  reason: string,
): void {
  // Push to timer-bus so heartbeat's timerReminderModule surfaces it as a whisper
  emitTimerReminder({
    id: timerId,
    firesAt,
    reason,
    createdAt: Date.now(),
  });

  // Event-bus notification
  eventBus.emit({
    type: "timer_fire",
    id: timerId,
    reason,
    payload: `⏰ [sleep] ${reason}`,
  });

  // Steer message to wake / notify the agent
  try {
    sendTrackedMessage(
      pi,
      {
        customType: "sleep-timer",
        content: [{ type: "text" as const, text: `[sleep] ${reason}` }],
        display: true,
      },
      { deliverAs: "steer", triggerTurn: true },
      { type: "heartbeat", source: "sleep/fire", steer: true },
    );
  } catch {
    /* non-fatal — agent may not accept steer messages in all states */
  }

  log.info(`[sleep] reminder fired: ${timerId} — ${reason}`);
}

// ── Tool ─────────────────────────────────────────────────────────────────────

const sleepSchema = Type.Object({
  delay_seconds: Type.Number({
    minimum: MIN_DELAY_SECS,
    maximum: MAX_DELAY_SECS,
    default: DEFAULT_DELAY_SECS,
    description: "Seconds to wait before the reminder fires (1-86400, default: 30)",
  }),
  reason: Type.Optional(
    Type.String({
      description: "Why you are sleeping — shown in the reminder when the timer fires",
    }),
  ),
});

export default function sleepExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "sleep",
    label: "Sleep",
    promptSnippet:
      "Delay execution for a specified duration without blocking — use for polling, rate limiting, or waiting for a condition",
    description:
      "Delay execution for a specified duration without blocking — use for polling, rate limiting, or waiting for a condition. " +
      "Returns immediately. When the delay expires, a reminder is injected into the next agent turn so you can check " +
      "the condition and continue. " +
      "Do NOT use bash `sleep` — use this instead. " +
      "Use `timer_set` instead if you need cancellable timers or want to see active timers.",
    parameters: sleepSchema,
    execute: async (_toolCallId: string, params: any): Promise<any> => {
      const delaySecs = params?.delay_seconds ?? DEFAULT_DELAY_SECS;
      const reason = params?.reason;

      validateDelay(delaySecs);

      const delayMs = delaySecs * 1000;
      const firesAt = Date.now() + delayMs;
      const timerId = `sleep_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const resolvedReason = makeReason(reason, delaySecs);

      // ── Schedule the deferred reminder ──────────────────────────────────
      // setTimeout is the only mechanism — no TimerManager involvement,
      // no setInterval polling. The callback fires exactly once after delayMs.
      const handle = setTimeout(() => {
        fireReminder(pi, timerId, firesAt, resolvedReason);
      }, delayMs);

      // Unref so the timer doesn't keep the Node.js event loop alive on its own.
      // The reminder is best-effort: if the process exits before the delay,
      // the agent session is already gone anyway.
      (handle as any)?.unref?.();

      log.info(`[sleep] ${timerId}: sleeping ${delaySecs}s — "${resolvedReason}"`);

      return {
        content: [
          {
            type: "text" as const,
            text: `Sleeping for ${delaySecs}s. A reminder will arrive when the timer fires. Continue working — you will be notified.`,
          },
        ],
        details: {
          timer_id: timerId,
          delay_seconds: delaySecs,
          fires_at: new Date(firesAt).toISOString(),
          reason: resolvedReason,
          note: "This timer is not cancellable. Use timer_set + timer_cancel if you need cancellation.",
        },
      };
    },
  } as any);

  log.info("[sleep] loaded: sleep");
}
