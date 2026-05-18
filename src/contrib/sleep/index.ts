/**
 * Sleep Tool — pause agent execution for a specified duration
 *
 * The agent calls this when it needs to wait. After the delay expires,
 * a new turn starts automatically. No analysis, no "continue working,"
 * no visible reminder — the agent simply resumes.
 *
 * Use over bash `sleep` because bash blocks the entire process.
 * Use over `timer_set` when you want a fire-once delay without cancellation.
 *
 * Implementation: schedules a single setTimeout that delivers a bare steer
 * to wake the agent after the delay. No timer-bus, no event-bus spam.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../../lib/logger.js";
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

// ── Tool ─────────────────────────────────────────────────────────────────────

const sleepSchema = Type.Object({
  delay_seconds: Type.Number({
    minimum: MIN_DELAY_SECS,
    maximum: MAX_DELAY_SECS,
    default: DEFAULT_DELAY_SECS,
    description: "Seconds to pause (1-86400, default: 30)",
  }),
});

export default function sleepExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "sleep",
    label: "Sleep",
    promptSnippet:
      "Pause agent execution for a duration — use when you need to wait",
    description:
      "Pause agent execution for the specified duration. " +
      "Returns immediately. After the delay expires, a new turn starts automatically. " +
      "Do NOT use bash `sleep` — use this instead. " +
      "Use `timer_set` instead if you need cancellable timers.",
    parameters: sleepSchema,
    execute: async (_toolCallId: string, params: any): Promise<any> => {
      const delaySecs = params?.delay_seconds ?? DEFAULT_DELAY_SECS;

      validateDelay(delaySecs);

      const delayMs = delaySecs * 1000;
      const timerId = `sleep_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      // ── Schedule agent wake-up ──────────────────────────────────────────
      // Single setTimeout — fires exactly once after delayMs.
      // Delivers a bare steer to wake the agent. No visible content,
      // no timer-bus, no event-bus — the agent just resumes quietly.
      setTimeout(() => {
        try {
          sendTrackedMessage(
            pi,
            {
              customType: "sleep-timer",
              content: [{ type: "text" as const, text: "[resume]" }],
              display: false,
            },
            { deliverAs: "steer", triggerTurn: true },
            { type: "heartbeat", source: "sleep/resume" },
          );
          log.info(`[sleep] ${timerId}: resumed after ${delaySecs}s`);
        } catch {
          /* non-fatal */
        }
      }, delayMs);

      log.info(`[sleep] ${timerId}: sleeping ${delaySecs}s`);

      return {
        content: [
          {
            type: "text" as const,
            text: `Paused for ${delaySecs}s. Will resume automatically when the time elapses.`,
          },
        ],
        details: {
          timer_id: timerId,
          delay_seconds: delaySecs,
          note: "This timer is not cancellable. Use timer_set + timer_cancel if you need cancellation.",
        },
      };
    },
  } as any);

  log.info("[sleep] loaded: sleep");
}