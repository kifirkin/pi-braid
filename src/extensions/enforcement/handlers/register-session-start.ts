/**
 * register-session-start - Session initialization: event bus wiring, drift init.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/state/session-start-queue.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { eventBus } from "../../../lib/events/event-bus.js";
import { cacheSessionManager, getSessionStartTask } from "../../../lib/state/extension-state.js";
import { getState } from "../state.js";
import { createLogger } from "../../../lib/core/logger.js";

const log = createLogger("enforcement:session-start");

export function registerSessionStart(pi: ExtensionAPI): void {
  registerSessionStartHandler(
    pi,
    SessionPhase.CoreInit,
    async (event: any, ctx: ExtensionContext) => {
      if (!getState(ctx).enforcementActive) return;

      // Cache fresh sessionManager reference for stale-safe access in turn_end handlers
      cacheSessionManager(ctx);

      const task = getSessionStartTask(event) || getState(ctx).originalRequest || "";
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
                  text: `[enforcement] Context at ${Math.round(event.usagePercent)}%. Consider context_navigate(action="tag") → context_compress(action="archive").`,
                },
              ],
            },
            // triggerTurn: true - context at 80%+ needs proactive action
            // (context_navigate("tag") / context_compress("archive")). Wakes the
            // agent so it can respond before the next compact escalation.
            { deliverAs: "steer", triggerTurn: true },
            { type: "enforcement", source: "enforcement/event-bus" },
          );
        }
      });

      eventBus.on("enforcement_violation", (event) => {
        // Route enforcement violations to error tracking via tool_error event
        eventBus.emit({
          type: "tool_error",
          toolName: event.rule,
          error: event.description.slice(0, 500),
          turn: getState(ctx).currentTurn,
          timestamp: Date.now(),
        });
      });

      eventBus.on("heartbeat_tick", (event) => {
        getState(ctx)._lastHeartbeatTick = event.tickCount;
        if (event.tickCount % 10 === 0) {
          log.debug(`[enforcement] ${event.tickCount} heartbeat ticks registered`);
        }
      });

      // Track turn_complete events from heartbeat scheduler for turn duration analytics.
      // turn_complete fires at the end of each heartbeat tick cycle and carries
      // the turn number and duration. We log it for consolidation analytics.
      eventBus.on("turn_complete", (event) => {
        const state = getState(ctx);
        state.lastTurnDuration = event.duration;
        log.info(`turn_complete: turn ${event.turn} (${event.duration}ms)`);
      });

      // Track sop_suggestion events for injection feedback monitoring.
      // When SOP suggestions are injected by sop-suggestion.ts, this handler
      // logs the event and records it for the enforcement feedback loop.
      eventBus.on("sop_suggestion", (event) => {
        log.debug(
          `SOP suggestion: "${event.episodeId}" ` +
            `(similarity: ${(event.similarity * 100).toFixed(0)}%)`,
        );
      });
    },
  );
}
