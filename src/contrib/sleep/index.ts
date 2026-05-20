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
 * Implementation: blocks the tool's returned promise by awaiting a delayed
 * resolve, which pauses the agent until the delay elapses. The agent resumes
 * naturally when the promise resolves — no steer or timer-bus needed.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../../lib/logger.js";

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
      "The agent's tool call blocks until the delay elapses, then resumes automatically. " +
      "Do NOT use bash `sleep` — use this instead. " +
      "Use `timer_set` instead if you need cancellable timers.",
    parameters: sleepSchema,
    execute: async (_toolCallId: string, params: any): Promise<any> => {
      const delaySecs = params?.delay_seconds ?? DEFAULT_DELAY_SECS;

      validateDelay(delaySecs);

      const delayMs = delaySecs * 1000;
      const timerId = `sleep_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      log.info(`[sleep] ${timerId}: sleeping ${delaySecs}s`);

      // ── Block tool execution until delay elapses ────────────────────────
      // Unlike timer_set (which returns immediately), sleep MUST block the
      // tool call. The agent framework `await`s the tool's returned promise,
      // so a delayed resolve actually pauses the agent. No setTimeout, no
      // steer — the agent resumes naturally when this promise resolves.
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

      log.info(`[sleep] ${timerId}: resumed after ${delaySecs}s`);

      return {
        content: [
          {
            type: "text" as const,
            text: `Resumed after ${delaySecs}s pause.`,
          },
        ],
        details: {
          timer_id: timerId,
          delay_seconds: delaySecs,
        },
      };
    },
  } as any);

  log.info("[sleep] loaded: sleep");
}