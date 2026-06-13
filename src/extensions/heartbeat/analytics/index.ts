/**
 * Analytics Extension - self-contained tool usage analytics.
 *
 * Tracks tool call counts, durations, success/failure rates,
 * tool sequences and patterns, session-level metrics, and
 * A/B experiment variant tracking (BR3).
 *
 * State is session-scoped via getExtensionState to prevent
 * cross-session contamination.
 */

import { createLogger } from "../../../lib/core/logger.js";
import { resetCriticStats, getCriticStats } from "../../../lib/ai/critic-stats.js";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/state/session-start-queue.js";
import { existsSync, mkdirSync } from "node:fs";
import { METRICS_FILE, METRICS_DIR } from "../../../lib/config/braid-paths.js";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { safeSessionManager } from "../../../lib/state/extension-state.js";
import { emitSignal } from "../../../lib/reasoning/belief-policy-engine.js";
import { eventBus } from "../../../lib/events/event-bus.js";
import { isDegraded, getDegradationReasons } from "../../../lib/detection/degradation-detector.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { areCognitiveNudgesDisabled } from "../../../lib/config/braid-settings.js";
import { Type } from "typebox";

import { getAnalyticsStateInternal } from "./shared.js";
import { formatABResults } from "./ab-variant.js";
import { getCompactionHealth } from "../../memory/context-manager/handlers/shared.js";
import { recordError, recordToolSuccess } from "../../../lib/detection/degradation-detector.js";
import { getReasoningStateView } from "../../cognitive/reasoning/index.js";
export {
  updateContextDensity,
  recordNudgeSent,
  recordNudgeSuppressed,
  getAnalyticsState,
  getAnalyticsSummary,
} from "./shared.js";

import { recordToolCall, flushAnalytics } from "./core.js";
import { formatCurrentSession, formatAllSessions } from "./format.js";
import { TURN_END, TOOL_EXECUTION_START, TOOL_EXECUTION_END, SESSION_SHUTDOWN } from "../../../lib/core/event-names.js";

const log = createLogger("analytics");

export default function analyticsExtension(pi: ExtensionAPI) {
  // ── session_start ──────────────────────────────────────────────────
  registerSessionStartHandler(pi, SessionPhase.MemoryState, async (_event, ctx) => {
    resetCriticStats();
    const state = getAnalyticsStateInternal(ctx);
    const sm = safeSessionManager(ctx) as { getSessionFile?(): string } | undefined;
    state.sessionId = sm
      ? (sm.getSessionFile?.() ?? `session-${Date.now()}`)
      : `session-${Date.now()}`;
    state.sessionStartTime = Date.now();
    state.toolMetrics.clear();
    state.toolCallSequence = [];
    state.turnToolSequence = [];
    state.wasDegraded = false;
    state.nudgesSent = 0;
    state.nudgesSuppressed = 0;
    state.storagePath = METRICS_FILE;

    if (!existsSync(METRICS_DIR)) mkdirSync(METRICS_DIR, { recursive: true });
  });

  // ── tool_execution_start ───────────────────────────────────────────
  pi.on(TOOL_EXECUTION_START, async (event, ctx) => {
    try {
      const state = getAnalyticsStateInternal(ctx);
      state.pendingToolCalls.set(event.toolCallId, {
        toolName: event.toolName,
        startTime: Date.now(),
      });
    } catch (err) {
      log.warn(`[analytics] Could not track tool start: ${err}`);
    }
  });

  // ── tool_execution_end ─────────────────────────────────────────────
  pi.on(TOOL_EXECUTION_END, async (event, ctx) => {
    try {
      const state = getAnalyticsStateInternal(ctx);
      const pending = state.pendingToolCalls.get(event.toolCallId);
      if (pending) {
        const success = !event.isError;
        recordToolCall(state, pending.toolName, Date.now() - pending.startTime, success);
        // Feed degradation detector
        if (success) {
          recordToolSuccess(ctx);
        } else {
          recordError(ctx);
        }
        // Track tool type for per-turn deduplication in addiction detection
        state.currentTurnTypes.add(pending.toolName);
        state.pendingToolCalls.delete(event.toolCallId);
      }
    } catch (err) {
      log.error("[analytics-tool-exec-end] error:", err);
    }
  });

  // ── turn_end: addiction detection + degradation ─────────────────────
  pi.on(TURN_END, async (_event: any, ctx: any) => {
    try {
      const state = getAnalyticsStateInternal(ctx);
      state.localTurnCount++;

      // Flush per-turn deduplicated tool types into turnToolSequence
      // Defensive: currentTurnTypes may be missing if getExtensionState
      // returns a state from a stale-ctx WeakMap bucket that wasn't
      // initialized through createAnalyticsState.
      if (state.currentTurnTypes) {
        for (const tool of state.currentTurnTypes) {
          state.turnToolSequence.push(tool);
        }
      }
      state.currentTurnTypes.clear();

      // Addiction check using per-turn deduplicated sequence (turnToolSequence)
      // This prevents multi-call turns (e.g., 3 bash + 1 read) from skewing ratios.
      const turnCalls = state?.turnToolSequence?.length ?? 0;
      if (turnCalls >= 10 && turnCalls - state.lastAddictionCheck >= 10) {
        state.lastAddictionCheck = turnCalls;
        const window = state.turnToolSequence.slice(-50);
        const counts = new Map<string, number>();
        for (const t of window) counts.set(t, (counts.get(t) ?? 0) + 1);
        const total = window.length;
        const warnings: string[] = [];
        for (const [tool, count] of counts) {
          const ratio = count / total;
          const toolN = counts.size;
          if (tool === "read") continue;
          if (
            (ratio > 0.8 && toolN <= 2) ||
            (toolN > 1 && count > (total / Math.max(toolN, 1)) * 4)
          ) {
            warnings.push(`${tool} (${count}/${total} tool-turns, ${(ratio * 100).toFixed(0)}%)`);
          }
        }
        if (warnings.length > 0) {
          // Deduplicate: skip if the exact same warnings were already emitted
          const signature = warnings.sort().join("|");
          if (state.lastAddictionSignatures.includes(signature)) {
            log.debug("[analytics] Skipping duplicate addiction warning:", signature);
          } else {
            state.lastAddictionSignatures.push(signature);
            // Keep last 3 signatures to bound memory (stale = 1 full window refresh)
            if (state.lastAddictionSignatures.length > 3) state.lastAddictionSignatures.shift();

            emitSignal(ctx, "tool-use", "overuse", "warn", false, {
              tools: warnings,
              windowSize: total,
            });
            // BPE recommendation handled by enforcement - no duplicate here
            // Skip whisper if cognitive nudges are disabled
            if (areCognitiveNudgesDisabled()) {
              log.debug("[analytics] Addiction alert suppressed via braid.suppressNudges=true");
            } else {
              sendTrackedMessage(
                pi,
                {
                  customType: "heartbeat",
                  content: [
                    {
                      type: "text",
                      text: `[analytics] Tool addiction pattern detected: ${warnings.join("; ")}. Assess intent - heavy single-tool use may be valid if the task demands it.`,
                    },
                  ],
                  display: true,
                },
                { deliverAs: "steer", triggerTurn: false },
                { type: "heartbeat", source: "heartbeat/analytics" },
              );
            }
            try {
              eventBus.emit({
                type: "analytics_alert",
                alertType: "addiction",
                severity: "warn",
                message: `Tool addiction pattern detected: ${warnings.join("; ")}`,
                data: { tools: warnings, windowSize: total },
                turn: state.localTurnCount,
                timestamp: Date.now(),
              });
            } catch (err) {
              log.warn(`[analytics] Could not emit addiction signal: ${err}`);
            }
          }
        }
      }

      // Degradation detection - CRITICAL: stability decline, use triggerTurn
      const degraded = isDegraded(ctx);
      if (degraded && !state.wasDegraded) {
        state.wasDegraded = true;
        const reasons = getDegradationReasons(ctx);
        emitSignal(ctx, "stability", "decline", "critical", false, {
          reason: reasons[0] ?? "degraded",
          consecutiveErrors: 3,
        });
        if (areCognitiveNudgesDisabled()) {
          log.debug("[analytics] Degradation alert suppressed via braid.suppressNudges=true");
        } else {
          sendTrackedMessage(
            pi,
            {
              customType: "context",
              content: [
                { type: "text", text: `[health] Degradation detected: ${reasons.join("; ")}` },
              ],
              display: true,
            },
            { deliverAs: "steer", triggerTurn: true },
            { type: "heartbeat", source: "heartbeat/analytics/degrade" },
          );
        }
        try {
          eventBus.emit({
            type: "analytics_alert",
            alertType: "degradation",
            severity: "critical",
            message: `Degradation detected: ${reasons.join("; ")}`,
            data: { reasons, consecutiveErrors: 3 },
            turn: state.localTurnCount,
            timestamp: Date.now(),
          });
        } catch (err) {
          log.warn(`[analytics] Could not emit degradation alert: ${err}`);
        }
      } else if (!degraded && state.wasDegraded) {
        state.wasDegraded = false;
        if (areCognitiveNudgesDisabled()) {
          log.debug("[analytics] Recovery notification suppressed via braid.suppressNudges=true");
        } else {
          // Recovery notification - informational, use hint
          sendTrackedMessage(
            pi,
            {
              customType: "context",
              content: [{ type: "text", text: "[health] Performance recovered to healthy." }],
              display: true,
            },
            { deliverAs: "steer", triggerTurn: false },
            { type: "heartbeat", source: "heartbeat/analytics/recover" },
          );
        }
        try {
          eventBus.emit({
            type: "analytics_alert",
            alertType: "recovery",
            severity: "info",
            message: "Performance recovered to healthy.",
            turn: state.localTurnCount,
            timestamp: Date.now(),
          });
        } catch (err) {
          log.warn(`[analytics] Could not emit recovery signal: ${err}`);
        }
      }
    } catch (err) {
      log.error("[analytics-turn-end] error:", err);
    }
  });

  // ── session_shutdown ───────────────────────────────────────────────
  pi.on(SESSION_SHUTDOWN, async (_event, ctx) => {
    const state = getAnalyticsStateInternal(ctx);
    if (state.toolCallSequence.length > 0) flushAnalytics(state, false);
  });

  // ── Commands ───────────────────────────────────────────────────────
  pi.registerCommand("analytics", {
    description: "Show tool analytics for the current session",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatCurrentSession(getAnalyticsStateInternal(ctx)), "info");
    },
  });
  pi.registerCommand("analytics:all", {
    description: "Show tool analytics across all historical sessions",
    handler: async (_args, _ctx) => {
      _ctx.ui.notify(formatAllSessions(), "info");
    },
  });
  // Removed `analytics:setVariant` slash command - promoted to a tool below
  // so the agent can set its own A/B variant without a human-typed slash command.
  pi.registerCommand("analytics:ab", {
    description: "Show A/B experiment results across variants",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatABResults(), "info");
    },
  });

  // ── Tools (agent-callable) ────────────────────────────────────────
  // Note: get_session_metrics and get_tool_reliability tools removed
  // in the 2026-06 tool-inventory audit (see docs/CUT-CANDIDATES-DEEP-DIVE.md).
  // These were passive observability tools: the agent rarely needs to know
  // its own session metrics or per-tool reliability, and no internal caller
  // used them. Background tracking (toolMetrics, sessionStartTime) is still
  // active and consumed by event-bus alerts and the analytics:all slash
  // command. The A/B variant can still be set programmatically via
  // getAnalyticsStateInternal(ctx).abVariant.

  // (deleted tool: get_session_metrics - see audit)
  // (deleted tool: get_tool_reliability - see audit)
}
