/**
 * register-session-start - Session initialization: event bus wiring, drift init.
 *
 * RELOAD SAFETY:
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
import {
  registerSessionStartHandler,
  SessionPhase,
} from "../../../lib/state/session-start-queue.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { eventBus } from "../../../lib/events/event-bus.js";
import { cacheSessionManager } from "../../../lib/state/extension-state.js";
import { getState } from "../state.js";
import { createLogger } from "../../../lib/core/logger.js";
import { classify } from "../../../lib/ai/text-classifier.js";
import { CRITICS } from "../../../lib/ai/critic-registry.js";
import { setLlmCallListeners } from "../../../lib/ai/llm-call.js";
import {
  clearTerminalBreaker,
  isTurnStartBlocked,
  recordLlmError,
  recordLlmSuccess,
  resetSessionHealth,
  tickSessionHealth,
} from "../session-health.js";
import { classifyLlmError } from "../../../lib/errors/llm-error.js";
import {
  setExtensionCtxProvider,
  setTurnStartGate,
  type TurnStartGate,
} from "../../../lib/state/global-state.js";

// Module-level eventBus listener references.
// Stored in globalThis (process-global) to survive module re-evaluation on /reload.
// Each session_start replaces the old listener after removing it from the eventBus.
// The eventBus uses a Set<Handler>, so different function references are NOT deduped
// automatically. Without this guard, N reloads produce N listeners per event.
//
// Key: process-global, not module-global. Module-level `const` or `let` is re-created
// on /reload (extension module tree is re-evaluated), so all old handler refs are lost.
function getEventBusHandlers(): Record<string, ((event: any) => void) | null> {
  const KEY = "__braid_eventbus_handlers";
  if (!(globalThis as any)[KEY]) {
    (globalThis as any)[KEY] = {
      context_full: null,
      enforcement_violation: null,
      heartbeat_tick: null,
      turn_complete: null,
      sop_suggestion: null,
    };
  }
  return (globalThis as any)[KEY];
}

const log = createLogger("enforcement:session-start");

export function registerSessionStart(pi: ExtensionAPI): void {
  // Publish the turn-start gate: the enforcement layer owns the health state
  // (it classifies the LLM errors); the scheduler's wake path consumes it
  // through this lib-level slot because it may not import an extension
  // sibling. Registered once at setup — the two methods are pure functions of
  // the per-session ctx, so nothing leaks between sessions.
  const turnStartGate: TurnStartGate = {
    isBlocked: (ctx, threshold) => isTurnStartBlocked(ctx as ExtensionContext, threshold),
    noteCleanTurn: (ctx) => clearTerminalBreaker(ctx as ExtensionContext),
  };
  setTurnStartGate(turnStartGate);

  // A route change is the one signal that the wake breaker's premise ("this
  // route is terminal") is false: close the latch so wakes resume against the
  // new route. In-memory state only; no owner surface.
  pi.on("model_select", (_event: unknown, ctx: ExtensionContext) => {
    try {
      clearTerminalBreaker(ctx);
    } catch {
      // non-fatal
    }
  });

  registerSessionStartHandler(
    pi,
    SessionPhase.CoreInit,
    async (event: any, ctx: ExtensionContext) => {
      if (!getState(ctx).enforcementActive) return;

      // Cache fresh sessionManager reference for stale-safe access in turn_end handlers
      cacheSessionManager(ctx);

      // Layer 2 wiring: register LLM call listeners that
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

      // Publish the CURRENT session's ctx so out-of-extension consumers
      // (lib/ai: the emergency offloader and the auxiliary LLM path's
      // registry/headers/session-id lookup) act on the live session. The
      // provider closure always hands back the latest ctx this session-start
      // saw.
      setExtensionCtxProvider(() => ctx);

      const task = getState(ctx).originalRequest || "";
      if (task) {
        getState(ctx).driftDetector?.setTaskContext(task);
      }

      getState(ctx).currentTurn++;

      // Classify initial request complexity (fire-and-forget)
      // Determines whether phase-boundary enforcement should be active.
      // Complex tasks get full enforcement; simple tasks skip it to avoid noise.
      if (task) {
        classify(
          ctx,
          CRITICS.initialRequestComplexity.criteria,
          { request: task.slice(0, 1500) },
          {
            timeoutMs: 30_000,
            fallback: () => "moderate",
            tierPolicy: "fallback-only",
          },
        )
          .then((result) => {
            const label = result.label.trim().toLowerCase();
            if (["simple", "moderate", "complex"].includes(label)) {
              getState(ctx).taskComplexity = label as "simple" | "moderate" | "complex";
              log.info(
                `[complexity] Initial request classified as "${label}"` +
                  (label === "simple"
                    ? " — phase-boundary enforcement will be minimal"
                    : " — phase-boundary enforcement active"),
              );
            }
          })
          .catch(() => {
            // Non-fatal: default to moderate if classifier fails
            getState(ctx).taskComplexity = "moderate";
          });
      }

      const h = getEventBusHandlers();

      // Reload-safe: remove old first, then add new
      if (h.context_full) eventBus.off("context_full", h.context_full);
      h.context_full = (event: { usagePercent: number }) => {
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
      eventBus.on("context_full", h.context_full);

      // Reload-safe enforcement_violation → tool_error routing
      if (h.enforcement_violation) eventBus.off("enforcement_violation", h.enforcement_violation);
      h.enforcement_violation = (event) => {
        eventBus.emit({
          type: "tool_error",
          toolName: event.rule,
          error: event.description.slice(0, 500),
          turn: getState(ctx).currentTurn,
          timestamp: Date.now(),
        });
      };
      eventBus.on("enforcement_violation", h.enforcement_violation);

      // Reload-safe heartbeat_tick tracking
      if (h.heartbeat_tick) eventBus.off("heartbeat_tick", h.heartbeat_tick);
      h.heartbeat_tick = (event) => {
        getState(ctx)._lastHeartbeatTick = event.tickCount;
        if (event.tickCount % 10 === 0) {
          log.debug(`[enforcement] ${event.tickCount} heartbeat ticks registered`);
        }
      };
      eventBus.on("heartbeat_tick", h.heartbeat_tick);

      // Reload-safe turn_complete tracking
      if (h.turn_complete) eventBus.off("turn_complete", h.turn_complete);
      h.turn_complete = (event) => {
        const state = getState(ctx);
        state.lastTurnDuration = event.duration;
        log.info(`turn_complete: turn ${event.turn} (${event.duration}ms)`);
      };
      eventBus.on("turn_complete", h.turn_complete);

      // Reload-safe sop_suggestion tracking
      if (h.sop_suggestion) eventBus.off("sop_suggestion", h.sop_suggestion);
      h.sop_suggestion = (event) => {
        log.debug(
          `SOP suggestion: "${event.episodeId}" ` +
            `(similarity: ${(event.similarity * 100).toFixed(0)}%)`,
        );
      };
      eventBus.on("sop_suggestion", h.sop_suggestion);
    },
  );
}
