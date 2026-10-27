/**
 * Pi Watchdog Extension — liveness/stall state machine.
 *
 * Two layers, same extension:
 *   1. Passive session monitor (legacy): tracks per-session uptime / idle /
 *      message count, surfaces via the `watchdog-status` TUI command.
 *   2. Active watchdog engine: monitors
 *      turn progress + keyring LLM feedback + tunnel liveness, detects the
 *      stall/quota/tunnel matrix (zero LLM), and escalates via a waking
 *      `[braid-whisper - watchdog]` whisper + optional 1-line tg signal.
 *
 * Default-ON; the
 * whole engine is code-constant defaulted and overridable via
 * `broker.watchdog` in settings.json (see config.ts) — no env vars.
 *
 * Ownership boundary: watchdog owns liveness/stall/escalation.
 * The heartbeat-scheduler owns cognitive interventions (silence/context/
 * error-accumulation triggers, meta-learning tick, whisper-batcher) — this
 * extension does NOT re-emit those events.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { statSync as fsStatSync } from "node:fs";
import {
  safeSessionManagerTyped,
  getExtensionState,
  hasExtensionState,
} from "../../../lib/state/extension-state.js";
import { createLogger } from "../../../lib/core/logger.js";
import {
  registerSessionStartHandler,
  SessionPhase,
} from "../../../lib/state/session-start-queue.js";
import { eventBus } from "../../../lib/events/event-bus.js";
import {
  MESSAGE_END,
  TOOL_CALL,
  TOOL_EXECUTION_END,
  SESSION_SHUTDOWN,
  AGENT_END,
} from "../../../lib/core/event-names.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import {
  getKeyRingFeedbackHandler,
  setKeyRingFeedbackHandler,
  subscribeWatchdogTunnel,
  getWatchdogTunnelStatus,
  getWatchdogTunnelHub,
  getWatchdogTgSignalSender,
  setWatchdogWakeDeliveryFeed,
  getWatchdogWakeDeliveryFeed,
  getWatchdogWakeDueProvider,
  type WatchdogWakeDeliveryFeed,
  type KeyRingFeedbackHandler,
} from "../../../lib/state/global-state.js";
import { loadWatchdogConfig } from "./config.js";
import { createWatchdogEngine, type WatchdogEngine } from "./engine.js";
import { appendContextHeartbeatLine } from "../../../lib/telemetry/context-heartbeat.js";
import { getSessionHealth, isRouteLatchOpen } from "../../enforcement/session-health.js";

const log = createLogger("watchdog");

/** Extension-state bucket key for the per-session watchdog engine. */
const WATCHDOG_ENGINE_KEY = "watchdog-engine";

/** Marks our keyring wrapper so a reload never double-wraps a live session. */
const WATCHDOG_WRAP_FLAG = "__braidWatchdogWrapped";

interface SessionState {
  startTime: number;
  lastProgressTime: number;
  messageCount: number;
  isStreaming: boolean;
}

interface WatchdogSessionState {
  engine: WatchdogEngine | null;
  restoreKeyRing: () => void;
  /** The wake-delivery feed this session published (identity-checked at
   *  shutdown so a newer session's feed is never unpublished). */
  publishedFeed: WatchdogWakeDeliveryFeed | null;
}

const sessions = new Map<string, SessionState>();

/**
 * Live per-session engine states, keyed by session path. The ctx-scoped
 * bucket is not a reliable shutdown handle: polyfill's `session_shutdown`
 * cleanup deletes all session state before later handlers run, so a handler
 * that re-derives the engine from the bucket finds nothing. Capturing the
 * state at creation keeps stop() reachable regardless of handler order.
 */
const liveWatchdogSessions = new Map<string, WatchdogSessionState>();

function formatTime(ms: number): string {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
  return `${Math.floor(ms / 3600000)}h`;
}

/** Session path fallback (same convention as the passive monitor). */
function sessionPathOf(ctx: ExtensionContext): string {
  const sm = safeSessionManagerTyped(ctx);
  return sm?.getSessionFile?.() ?? ctx.cwd ?? "unknown";
}

/** Resolve the per-session watchdog engine if a session set one up. */
function engineFor(ctx: ExtensionContext): WatchdogEngine | null {
  if (!hasExtensionState(ctx, WATCHDOG_ENGINE_KEY)) return null;
  const st = getExtensionState<WatchdogSessionState>(ctx, WATCHDOG_ENGINE_KEY, () => ({
    engine: null,
    restoreKeyRing: () => {},
    publishedFeed: null,
  }));
  return st.engine;
}

/** Bounded tail of the assistant text seen on the wire (resume-marker payload). */
function partialTextOf(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return undefined;
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i] as { type?: string; text?: string } | undefined;
    if ((part?.type === "text" || part?.type === "thinking") && typeof part.text === "string") {
      return part.text;
    }
  }
  return undefined;
}

/** Args preview for the resume marker; JSON can throw on exotic inputs. */
function argsPreviewOf(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  try {
    return JSON.stringify(input);
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  const config = loadWatchdogConfig();

  // Whisper + tg delivery (the escalation actions)
  // Waking whisper: triggerTurn wakes an idle agent; bypassFloodCap because a
  // watchdog escalation is correctness-critical (the agent may be stuck) —
  // mirrors the timer-fire wake path. Source starts with "watchdog" so the
  // universal envelope renders as [braid-whisper - watchdog].
  function wakeWhisper(text: string): void {
    try {
      sendTrackedMessage(
        pi,
        {
          customType: "watchdog-alert",
          content: [{ type: "text" as const, text }],
          display: true,
        },
        { triggerTurn: true },
        { type: "heartbeat", source: "watchdog/escalation" },
        { bypassFloodCap: true },
      );
    } catch (err) {
      log.warn(`[watchdog] wake whisper delivery failed: ${(err as Error).message}`);
    }
  }

  // Non-waking recovery whisper (tunnel-up), delivered on the next turn.
  function quietWhisper(text: string): void {
    try {
      sendTrackedMessage(
        pi,
        {
          customType: "watchdog-recovery",
          content: [{ type: "text" as const, text }],
          display: true,
        },
        { deliverAs: "nextTurn" },
        { type: "heartbeat", source: "watchdog/recovery" },
      );
    } catch (err) {
      log.warn(`[watchdog] recovery whisper delivery failed: ${(err as Error).message}`);
    }
  }

  // Non-waking terminal-stop emission: an alert, but it must not spend a
  // provider call (that is the very thing the breaker suppresses). Mirrors
  // quietWhisper's delivery shape; distinct customType so it is not read as a
  // recovery notice.
  function terminalStopWhisper(text: string): void {
    try {
      sendTrackedMessage(
        pi,
        {
          customType: "watchdog-alert",
          content: [{ type: "text" as const, text }],
          display: true,
        },
        { deliverAs: "nextTurn" },
        { type: "heartbeat", source: "watchdog/terminal-stop" },
        { bypassFloodCap: true },
      );
    } catch (err) {
      log.warn(`[watchdog] terminal-stop whisper delivery failed: ${(err as Error).message}`);
    }
  }

  // Optional 1-line tg signal (telegram publishes the sender; absent = skip).
  function tgSignal(text: string): void {
    const sender = getWatchdogTgSignalSender();
    if (!sender) return;
    Promise.resolve(sender(text)).catch(() => {
      // optional — never fatal
    });
  }

  /** Stop one session's engine and release what it published. Idempotent. */
  function disposeWatchdogSession(st: WatchdogSessionState): void {
    st.engine?.stop();
    st.restoreKeyRing();
    if (st.publishedFeed && getWatchdogWakeDeliveryFeed() === st.publishedFeed) {
      setWatchdogWakeDeliveryFeed(null);
    }
    log.info("[watchdog] engine disposed");
  }

  /** Build + start a per-session watchdog engine and its keyring probe. */
  function buildWatchdogSession(ctx: ExtensionContext): WatchdogSessionState {
    const base: WatchdogSessionState = {
      engine: null,
      restoreKeyRing: () => {},
      publishedFeed: null,
    };
    try {
      const engine = createWatchdogEngine(config, {
        now: Date.now,
        schedule: (cb, ms) => {
          const id = setTimeout(cb, ms);
          // The monitor cadence is auxiliary: unref'd so an idle process can
          // exit even when shutdown never reaches stop() (print mode).
          if (typeof id.unref === "function") id.unref();
          return () => clearTimeout(id);
        },
        wakeWhisper,
        quietWhisper,
        terminalStopWhisper,
        tgSignal,
        subscribeTunnel: (fn) => subscribeWatchdogTunnel(fn),
        getTunnelStatus: () => ({
          status: getWatchdogTunnelStatus(),
          failures: getWatchdogTunnelHub().failures,
        }),
        // Hook 2: one cheap context-heartbeat line per detect pass so
        // idle processes stay covered on the wall-clock cadence. The engine
        // builds the scalar line; this wiring enriches it with the session
        // identity + size + health mode (the engine has no ctx). Sink
        // failures are non-fatal inside appendContextHeartbeatLine.
        telemetryEmit: (entry) => {
          try {
            const sm = safeSessionManagerTyped(ctx);
            const sessionFile = sm?.getSessionFile?.();
            let sessionFileSizeBytes: number | null = null;
            if (sessionFile) {
              const st = fsStatSync(sessionFile, { throwIfNoEntry: false });
              if (st) sessionFileSizeBytes = st.size;
            }
            const sessionId =
              (
                sm as unknown as { getSessionId?: () => string | undefined } | undefined
              )?.getSessionId?.() ?? "?";
            appendContextHeartbeatLine({
              ...entry,
              sessionId,
              sessionFileSizeBytes,
              healthMode: getSessionHealth(ctx).mode,
            });
          } catch {
            // telemetry never fatal
          }
        },
        // Bounded stall ladder: the resume marker goes to the session's own
        // durable seat (appendEntry → session file, replayed by a resume)
        // before any abort; the abort reuses the compaction cancel path. A
        // missing seat degrades to the engine's unready hand-back, never
        // kill-and-forget.
        persistResumeMarker: (_key, marker) => {
          try {
            pi.appendEntry("watchdog-stall-marker", {
              ...marker,
              pendingMessages: ctx.hasPendingMessages(),
            });
            return true;
          } catch (err) {
            log.warn(`[watchdog] resume marker persist failed: ${(err as Error).message}`);
            return false;
          }
        },
        abortTurn: () => {
          try {
            ctx.abort();
          } catch (err) {
            // The runner context asserts liveness before dispatching abort; a
            // watchdog firing into a dying session must never crash the process.
            log.warn(`[watchdog] stall abort failed: ${(err as Error).message}`);
          }
        },
        isWakeDue: () => {
          try {
            return getWatchdogWakeDueProvider()?.() === true;
          } catch {
            return false;
          }
        },
        // Route-failure latch: the engine asks the health layer, once per
        // escalation, whether a self-started turn would park. While it is
        // open the bark rides the quiet channel and the tg line below still
        // fires (see fireEscalation). Read-only, fail-open: a broken reader
        // must never silence an escalation.
        isTurnStartBlocked: () => {
          try {
            return isRouteLatchOpen(ctx);
          } catch {
            return false;
          }
        },
        log: (level, message, ...rest) => {
          switch (level) {
            case "debug":
              log.debug(message, rest[0]);
              break;
            case "info":
              log.info(message, rest[0]);
              break;
            case "warn":
              log.warn(message, rest[0]);
              break;
            default:
              log.error(message, rest[0]);
          }
        },
      });
      engine.start();
      base.engine = engine;

      // Wake-delivery feed (scheduling/timer → this engine): the retry queue
      // detects dead wake delivery; this engine owns the episode latch and
      // the escalation path. Published so timer/index.ts can forward facts
      // without importing this module (sibling-extension layering).
      const feed: WatchdogWakeDeliveryFeed = {
        recordWakeOutcomeTimeout: engine.recordWakeOutcomeTimeout,
        recordWakeUndelivered: engine.recordWakeUndelivered,
        recordWakeDelivered: engine.recordWakeDelivered,
      };
      setWatchdogWakeDeliveryFeed(feed);
      base.publishedFeed = feed;

      // Keyring probe: wrap the published handler so ring
      // rotation keeps working while the watchdog counts quota/403/rotation
      // failures and successes. Guard against double-wrapping on reload.
      const original = getKeyRingFeedbackHandler();
      if (original && !(original as unknown as Record<string, unknown>)[WATCHDOG_WRAP_FLAG]) {
        // Core asks the slot's occupant `routeUsable` by structural lookup
        // (llm-call.ts isModelRouteUsable) and fails OPEN when the method is
        // absent, so a wrapper carrying only the two report methods makes
        // every route answer "usable" for as long as it holds the slot: the
        // auxiliary skip is dead and a spent ring still gets the request.
        const forwardRouteUsable = (
          original as unknown as {
            routeUsable?: (modelId: string, providerId: string | undefined) => boolean;
          }
        ).routeUsable;
        const wrapped = {
          [WATCHDOG_WRAP_FLAG]: true,
          // Bound to the handler it came from: core calls it with `this` set to
          // the wrapper, which is not the object the query was written for.
          routeUsable: forwardRouteUsable?.bind(original),
          reportFailure: (modelId: string, providerId: string | undefined, errText: string) => {
            try {
              engine.recordLlmFailure(String(errText ?? ""), {
                provider: providerId,
                model: modelId,
              });
            } catch {
              // the counter must never break key-ring rotation
            }
            original.reportFailure(modelId, providerId, errText);
          },
          reportSuccess: (modelId: string, providerId: string | undefined) => {
            try {
              engine.recordLlmSuccess();
            } catch {
              // The counter must never break key-ring success reporting
              // (mirror of the reportFailure guard above).
            }
            original.reportSuccess(modelId, providerId);
          },
        };
        setKeyRingFeedbackHandler(wrapped as unknown as KeyRingFeedbackHandler);
        base.restoreKeyRing = () => {
          // Restore only our own wrapper (a provider reload may have
          // published a fresh handler mid-session — leave it alone).
          if (getKeyRingFeedbackHandler() === (wrapped as unknown)) {
            setKeyRingFeedbackHandler(original);
          }
        };
      }
    } catch (err) {
      // The engine must never take the extension down.
      log.error(`[watchdog] engine setup failed: ${(err as Error).message}`);
    }
    liveWatchdogSessions.set(sessionPathOf(ctx), base);
    return base;
  }

  // Session lifecycle

  registerSessionStartHandler(pi, SessionPhase.Background, async (_event, ctx) => {
    const path = sessionPathOf(ctx);
    // The sessions map was never pruned — one small entry per
    // session path for the process lifetime. Cap at 8 (evict-oldest); only
    // the active session's entry is read on hot paths.
    if (sessions.size >= 8 && !sessions.has(path)) {
      const oldestPath = sessions.keys().next();
      if (!oldestPath.done) sessions.delete(oldestPath.value);
    }
    sessions.set(path, {
      startTime: Date.now(),
      lastProgressTime: Date.now(),
      messageCount: 0,
      isStreaming: false,
    });
    ctx.ui.setStatus("watchdog", "active");

    // Active engine: build once per session, register the session for stall
    // tracking, start the monitor loop.
    const st = getExtensionState<WatchdogSessionState>(ctx, WATCHDOG_ENGINE_KEY, () =>
      buildWatchdogSession(ctx),
    );
    st.engine?.observeSessionStart(path);
    log.info(
      `[watchdog] engine ${config.mode} (base ${config.baseMs}ms, hot ${config.hotMs}ms, ` +
        `stall ${config.stallMult}×, quota ${config.quotaErrors}, tunnel ${config.tunnelFailures})`,
    );
  });

  pi.on(SESSION_SHUTDOWN, (_event, ctx) => {
    // The live registry is the reliable path (see liveWatchdogSessions); the
    // bucket lookup below is the fallback for states built before this file
    // tracked them. Path resolution is guarded: a stale ctx throws on both
    // `sessionManager` and `cwd` getters, and that must not lose the fallback.
    let path: string | undefined;
    try {
      path = sessionPathOf(ctx);
    } catch {
      path = undefined;
    }
    if (path !== undefined) {
      const live = liveWatchdogSessions.get(path);
      if (live) {
        liveWatchdogSessions.delete(path);
        disposeWatchdogSession(live);
        return;
      }
    }
    if (!hasExtensionState(ctx, WATCHDOG_ENGINE_KEY)) return;
    const st = getExtensionState<WatchdogSessionState>(ctx, WATCHDOG_ENGINE_KEY, () => ({
      engine: null,
      restoreKeyRing: () => {},
      publishedFeed: null,
    }));
    disposeWatchdogSession(st);
  });

  eventBus.on("analytics_alert", (event) => {
    if (event.severity === "critical") {
      log.warn(`[watchdog] Critical analytics alert: ${event.message}`);
    } else if (event.severity === "warn") {
      log.info(`[watchdog] Analytics warning: ${event.message}`);
    }
  });

  // Turn progress feeds the stall detector

  pi.on(MESSAGE_END, async (event, ctx) => {
    const path = sessionPathOf(ctx);
    const sessionState = sessions.get(path);
    if (sessionState) {
      sessionState.lastProgressTime = Date.now();
      sessionState.messageCount++;
    }
    engineFor(ctx)?.observeProgress(
      path,
      event.message?.role === "assistant" ? "assistant" : "other",
    );
    // A provider error message with no continuation is the terminal
    // transcript shape the stall classifier needs.
    const message = event.message;
    if (message?.role === "assistant" && message.stopReason === "error") {
      engineFor(ctx)?.observeTranscriptError(path);
    }
  });

  pi.on(TOOL_CALL, async (event, ctx) => {
    const path = sessionPathOf(ctx);
    const sessionState = sessions.get(path);
    if (sessionState) {
      // A tool call is progress even without a completed turn — the stall
      // check keys on last tool-call, not wall clock.
      sessionState.lastProgressTime = Date.now();
      sessionState.isStreaming = true;
    }
    engineFor(ctx)?.observeToolCall(path, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      argsPreview: argsPreviewOf(event.input),
    });
  });

  // Wire liveness: token-by-token assistant updates are the provider
  // heartbeat the stall classifier keys on (separate from tool-call silence).
  pi.on("message_update", (_event, ctx) => {
    const path = sessionPathOf(ctx);
    engineFor(ctx)?.observeStreamActivity(path, partialTextOf(_event.message));
  });

  // A tool result is progress, and it leaves the transcript's last event
  // awaiting a continuation — the shape a dead provider call strands.
  pi.on(TOOL_EXECUTION_END, (event, ctx) => {
    const path = sessionPathOf(ctx);
    engineFor(ctx)?.observeToolResult(path, event.toolCallId);
  });

  pi.on("agent_start", async (_event, ctx) => {
    const path = sessionPathOf(ctx);
    const sessionState = sessions.get(path);
    if (sessionState) sessionState.isStreaming = true;
    engineFor(ctx)?.observeTurnStart(path);
  });

  pi.on(AGENT_END, async (_event, ctx) => {
    const path = sessionPathOf(ctx);
    const sessionState = sessions.get(path);
    if (sessionState) {
      sessionState.isStreaming = false;
      sessionState.lastProgressTime = Date.now();
    }
    engineFor(ctx)?.observeTurnComplete(path);
  });

  pi.registerCommand("watchdog-status", {
    description: "Show watchdog status",
    handler: async (_args, ctx) => {
      const path = sessionPathOf(ctx);
      const sessionState = sessions.get(path);
      const eng = engineFor(ctx);
      const parts = ["Watchdog:"];
      if (sessionState) {
        parts.push(
          `${formatTime(Date.now() - sessionState.startTime)} uptime`,
          `${formatTime(Date.now() - sessionState.lastProgressTime)} idle`,
          `${sessionState.messageCount} msgs`,
        );
      } else {
        parts.push("no active session");
      }
      if (eng) {
        const snap = eng.getSnapshot();
        parts.push(
          `engine ${snap.enabled ? "on" : "off"}`,
          `${snap.cadence} cadence`,
          `open: ${snap.openConditions.join(",") || "none"}`,
        );
        // Compact unclassified-failure line: provider + HTTP code + bounded
        // text, so the status command alone can root-cause an outage that
        // the classifier could not name.
        const unknown = snap.unknownFailures ?? [];
        if (unknown.length > 0) {
          const last = unknown[unknown.length - 1];
          parts.push(
            `unknown: ${unknown.length}`,
            `last: ${last.provider ?? "?"}${
              last.statusCode != null ? ` HTTP ${last.statusCode}` : ""
            }: ${last.text.slice(0, 80)}`,
          );
        }
      }
      ctx.ui?.notify?.(parts.join(" | "), "info");
    },
  });
}
