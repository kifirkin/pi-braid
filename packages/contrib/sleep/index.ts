/**
 * Sleep Tool — pause agent execution for a specified duration
 *
 * The agent calls this when it needs to wait. After the delay expires,
 * a new turn starts automatically. No analysis, no "continue working,"
 * no visible reminder — the agent simply resumes.
 *
 * Use over bash `sleep` because bash blocks the entire process.
 * Use over the `timer` tool (action=set) when you want a fire-once delay
 * without cancellation.
 *
 * Implementation: blocks the tool's returned promise by awaiting a delayed
 * resolve, which pauses the agent until the delay elapses. The agent resumes
 * naturally when the promise resolves — no steer or timer-bus needed.
 */

import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../logger.js";
import { readToggleVerdict } from "../module-toggle.js";

const log = createLogger("sleep");

const MIN_DELAY_SECS = 1;
const MAX_DELAY_SECS = 86_400; // 24 hours
const DEFAULT_DELAY_SECS = 30;

/** Sleeps longer than this (in seconds) should use timers instead. */
const TIMER_THRESHOLD_SECS = 60;

function validateDelay(seconds: number): void {
  if (
    !Number.isFinite(seconds) ||
    seconds < MIN_DELAY_SECS ||
    seconds > MAX_DELAY_SECS
  ) {
    throw new Error(
      `delay_seconds must be between ${MIN_DELAY_SECS} and ${MAX_DELAY_SECS} (got ${seconds})`,
    );
  }
}

const sleepSchema = Type.Object({
  delay_seconds: Type.Number({
    minimum: MIN_DELAY_SECS,
    maximum: MAX_DELAY_SECS,
    default: DEFAULT_DELAY_SECS,
    description: "Seconds to pause (1-86400, default: 30)",
  }),
});

export default function sleepExtension(pi: ExtensionAPI): void {
  const toggle = readToggleVerdict(["sleep"]);
  if (toggle.disabled) {
    log.info(
      `[sleep] disabled via settings (braid.contrib.${toggle.key}: false).`,
    );
    return;
  }

  pi.registerTool({
    name: "sleep",
    label: "Sleep",
    promptSnippet:
      "Pause agent execution for a duration — use when you need to wait",
    description:
      "Pause agent execution for the specified duration. " +
      "The tool call blocks until the delay elapses, then resumes. " +
      "Do NOT use bash `sleep` — use this instead. " +
      "For cancellable timers, use the `timer` tool (action=set).",
    parameters: sleepSchema,
    execute: async (_toolCallId: string, params: any): Promise<any> => {
      const delaySecs = params?.delay_seconds ?? DEFAULT_DELAY_SECS;

      validateDelay(delaySecs);

      const delayMs = delaySecs * 1000;
      const timerId = `sleep_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      // Guidance: use timers for long sleeps
      // sleep blocks the agent — no escape key, no context management,
      // no parallel work. For delays beyond the threshold, the timer tool is
      // preferred: it returns immediately, lets the agent work, and fires a
      // wake-up.
      if (delaySecs > TIMER_THRESHOLD_SECS) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Sleep >${TIMER_THRESHOLD_SECS}s is not allowed (requested: ${delaySecs}s).`,
                `Use the timer tool instead — it returns immediately and fires a wake-up.`,
                `  timer action=set delay_seconds=${delaySecs} reason="..."`,
                `For delays <= ${TIMER_THRESHOLD_SECS}s, sleep is fine.`,
              ].join("\n"),
            },
          ],
          details: {
            timer_id: timerId,
            delay_seconds: delaySecs,
            blocked: true,
            reason: `sleep >${TIMER_THRESHOLD_SECS}s blocked by policy. Use timer instead.`,
          },
        };
      }

      log.info(`[sleep] ${timerId}: sleeping ${delaySecs}s`);

      // Unlike the timer tool (action=set, which returns immediately), sleep
      // MUST block the
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
  } as ToolDefinition<any, any, any>);

  log.info("[sleep] loaded: sleep");
}
