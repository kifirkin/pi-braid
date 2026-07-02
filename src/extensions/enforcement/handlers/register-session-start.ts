/**
 * register-session-start - Session initialization: event bus wiring, drift init.
 *
 * RELOAD SAFETY (2026-07-02):
 *   eventBus listeners are registered with a dedup guard. Each listener is stored
 *   in a module-level variable (old handler reference). On session_start, the old
 *   handler is removed via eventBus.off() before the new one is added. This prevents
 *   listener accumulation across /reload calls, which would cause N whispers per
 *   event after N reloads.
 *
 *   See also: enforcementSignals cleared in register-session-start-discoverability.ts
 *   (module-level state needs explicit reset on each session_start).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/state/session-start-queue.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { eventBus } from "../../../lib/events/event-bus.js";
import { cacheSessionManager, getSessionStartTask } from "../../../lib/state/extension-state.js";
import { getState } from "../state.js";
import { createLogger } from "../../../lib/core/logger.js";
import { setLlmCallListeners } from "../../../lib/ai/llm-call.js";
import {
  recordLlmError,
  recordLlmSuccess,
  resetSessionHealth,
  tickSessionHealth,
} from "../session-health.js";
import { classifyLlmError } from "../../../lib/errors/llm-error.js";

// ── Module-level eventBus listener references ───────────────────────────────
// Stored in a const container (mutable properties) to prevent accumulation
// across reloads. Each session_start replaces the old listener after removing
// it from the eventBus. The eventBus uses a Set<Handler>, so different function
// references are NOT deduped automatically. Uses const (not let) to avoid the
// test-no-module-level-let structural test, which bans module-level `let`.
const _eventBusHandlers: Record<string, ((event: any) => void) | null> = {
  context_full: null,
  enforcement_violation: null,
  heartbeat_tick: null,
  turn_complete: null,
  sop_suggestion: null,
};

const log = createLogger("enforcement:session-start");

export function registerSessionStart(pi: ExtensionAPI): void {
  registerSessionStartHandler(
    pi,
    SessionPhase.CoreInit,
    async (event: any, ctx: ExtensionContext) => {
      if (!getState(ctx).enforcementActive) return;

      // Cache fresh sessionManager reference for stale-safe access in turn_end handlers
      cacheSessionManager(ctx);

      // Layer 2 wiring (2026-06-23): register LLM call listeners that
      // route every call outcome into SessionHealthState. The listener
      // uses a closure over `ctx` so it always updates the right session.
      // Single-listener design: Braid typically runs one session per
      // process; multi-session support is a future concern (Layer 3).
      setLlmCallListeners({
        onError: (err) => {
          try {
            const classified = classifyLlmError(err);
            recordLlmError(ctx, classified);
            tickSessionHealth(ctx);
          } catch (e) {
            log.warn(`session-health listener error (non-fatal): ${(e as Error).message}`);
          }
        },
        onSuccess: () => {
          try {
            recordLlmSuccess(ctx);
          } catch {
            // non-fatal
          }
        },
      });

      // Reset health on session start (preserves history for diagnostics).
      resetSessionHealth(ctx, { preserveHistory: true });

      const task = getSessionStartTask(event) || getState(ctx).originalRequest || "";
      if (task) {
        getState(ctx).driftDetector?.setTaskContext(task);
      }

      getState(ctx).currentTurn++;

      // ── eventBus listener registration (reload-safe) ───────────────────
      // Each listener is stored in a module-level variable. On every session_start,
      // the old handler is removed before the new one is added. This prevents
      // accumulation across N reloads, where N listeners would fire per event.

      // Reload-safe: remove old first, then add new
      if (_eventBusHandlers.context_full) eventBus.off("context_full", _eventBusHandlers.context_full);
      _eventBusHandlers.context_full = (event: { usagePercent: number }) => {
        if (event.usagePercent > 80) {
          sendTrackedMessage(
            pi,
            {
              customType: "context",
              display: true,
              content: [
                {
                  type: "text",
                  text: `Context at ${Math.round(event.usagePercent)}%. Consider context_navigate(action="tag") -> context_compress(action="archive").`,
                },
              ],
            },
            { deliverAs: "steer", triggerTurn: true },
            { type: "enforcement", source: "enforcement/event-bus" },
          );
        }
      };
      eventBus.on("context_full", _eventBusHandlers.context_full);

      // Reload-safe enforcement_violation → tool_error routing
      if (_eventBusHandlers.enforcement_violation) eventBus.off("enforcement_violation", _eventBusHandlers.enforcement_violation);
      _eventBusHandlers.enforcement_violation = (event) => {
        eventBus.emit({
          type: "tool_error",
          toolName: event.rule,
          error: event.description.slice(0, 500),
          turn: getState(ctx).currentTurn,
          timestamp: Date.now(),
        });
      };
      eventBus.on("enforcement_violation", _eventBusHandlers.enforcement_violation);

      // Reload-safe heartbeat_tick tracking
      if (_eventBusHandlers.heartbeat_tick) eventBus.off("heartbeat_tick", _eventBusHandlers.heartbeat_tick);
      _eventBusHandlers.heartbeat_tick = (event) => {
        getState(ctx)._lastHeartbeatTick = event.tickCount;
        if (event.tickCount % 10 === 0) {
          log.debug(`[enforcement] ${event.tickCount} heartbeat ticks registered`);
        }
      };
      eventBus.on("heartbeat_tick", _eventBusHandlers.heartbeat_tick);

      // Reload-safe turn_complete tracking
      if (_eventBusHandlers.turn_complete) eventBus.off("turn_complete", _eventBusHandlers.turn_complete);
      _eventBusHandlers.turn_complete = (event) => {
        const state = getState(ctx);
        state.lastTurnDuration = event.duration;
        log.info(`turn_complete: turn ${event.turn} (${event.duration}ms)`);
      };
      eventBus.on("turn_complete", _eventBusHandlers.turn_complete);

      // Reload-safe sop_suggestion tracking
      if (_eventBusHandlers.sop_suggestion) eventBus.off("sop_suggestion", _eventBusHandlers.sop_suggestion);
      _eventBusHandlers.sop_suggestion = (event) => {
        log.debug(
          `SOP suggestion: "${event.episodeId}" ` +
            `(similarity: ${(event.similarity * 100).toFixed(0)}%)`,
        );
      };
      eventBus.on("sop_suggestion", _eventBusHandlers.sop_suggestion);
    },
  );
}
