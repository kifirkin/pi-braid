/**
 * register-session-start — Session initialization: event bus wiring, drift init.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/session-start-queue.js";
import { sendTrackedMessage } from "../../../lib/injection-tracker.js";
import { eventBus } from "../../../lib/event-bus.js";
import { cacheSessionManager } from "../../../lib/extension-state.js";
import { getState } from "../state.js";
import { createLogger } from "../../../lib/logger.js";

const log = createLogger("enforcement:session-start");

export function registerSessionStart(pi: ExtensionAPI): void {
  registerSessionStartHandler(
    pi,
    SessionPhase.CoreInit,
    async (event: any, ctx: ExtensionContext) => {
      if (!getState(ctx).enforcementActive) return;

      // Cache fresh sessionManager reference for stale-safe access in turn_end handlers
      cacheSessionManager(ctx);

      const task =
        (event as unknown as { task?: string; prompt?: string }).task ||
        (event as unknown as { task?: string; prompt?: string }).prompt ||
        getState(ctx).originalRequest ||
        "";
      if (task) {
        getState(ctx).driftDetector?.setTaskContext(task);
      }

      getState(ctx).currentTurn++;

      eventBus.on("context_full", (event: { usagePercent: number }) => {
        if (event.usagePercent > 80) {
          sendTrackedMessage(
            pi,
            {
              customType: "context",
              display: true,
              content: [
                {
                  type: "text",
                  text: `[enforcement] Context at ${Math.round(event.usagePercent)}%. Consider context_tag → context_checkout → context_archive.`,
                },
              ],
            },
            { deliverAs: "steer", triggerTurn: false },
            { type: "enforcement", source: "enforcement/event-bus" },
          );
        }
      });

      eventBus.on("enforcement_violation", () => {
        // Consumer exists to prevent events from being logged into the void
      });

      eventBus.on("heartbeat_tick", (event) => {
        getState(ctx)._lastHeartbeatTick = event.tickCount;
        if (event.tickCount % 10 === 0) {
          log.debug(`[enforcement] ${event.tickCount} heartbeat ticks registered`);
        }
      });
    },
  );
}
