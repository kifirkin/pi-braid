/**
 * Analytics Extension — self-contained tool usage analytics.
 *
 * Tracks tool call counts, durations, success/failure rates,
 * tool sequences and patterns, session-level metrics, and
 * A/B experiment variant tracking (BR3).
 *
 * State is session-scoped via getExtensionState to prevent
 * cross-session contamination.
 */

import { createLogger } from "../../../lib/logger.js";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/session-start-queue.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { METRICS_FILE, METRICS_DIR } from "../../../lib/braid-paths.js";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState, safeSessionManager } from "../../../lib/extension-state.js";
import { emitSignal } from "../../../lib/belief-policy-engine.js";
import { eventBus } from "../../../lib/event-bus.js";
import { isDegraded, getDegradationReasons } from "../../../lib/degradation-detector.js";
import { sendTrackedMessage } from "../../../lib/injection-tracker.js";
import { areCognitiveNudgesDisabled } from "../../../lib/braid-settings.js";
import { Type } from "typebox";

import {
  getAnalyticsStateInternal,
  updateContextDensity,
  recordNudgeSent,
  recordNudgeSuppressed,
  getAnalyticsState,
} from "./shared.js";
import { recordError, recordToolSuccess } from "../../../lib/degradation-detector.js";
export {
  updateContextDensity,
  recordNudgeSent,
  recordNudgeSuppressed,
  getAnalyticsState,
  getAnalyticsSummary,
} from "./shared.js";

import {
  recordToolCall,
  getToolSequences,
  getSessionMetrics,
  computeSessionOutcome,
  flushAnalytics,
  loadAnalytics,
} from "./core.js";
import { loadAnalyticsByVariant } from "./ab-variant.js";
import { formatCurrentSession, formatAllSessions } from "./format.js";

const log = createLogger("analytics");

export default function analyticsExtension(pi: ExtensionAPI) {
  // ── session_start ──────────────────────────────────────────────────
  registerSessionStartHandler(pi, SessionPhase.MemoryState, async (_event, ctx) => {
    const state = getAnalyticsStateInternal(ctx);
    const sm = safeSessionManager(ctx);
    state.sessionId = sm
      ? ((sm as any).getSessionFile?.() ?? `session-${Date.now()}`)
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
  pi.on("tool_execution_start", async (event, ctx) => {
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
  pi.on("tool_execution_end", async (event, ctx) => {
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
  pi.on("turn_end", async (_event: any, ctx: any) => {
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
                      text: `[analytics] Tool addiction pattern detected: ${warnings.join("; ")}. Assess intent — heavy single-tool use may be valid if the task demands it.`,
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
  pi.on("session_shutdown", async (_event, ctx) => {
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
  pi.registerCommand("analytics:setVariant", {
    description: "Set A/B experiment variant for this session",
    handler: async (args, ctx) => {
      const parsed = typeof args === "string" ? JSON.parse(args) : args;
      getAnalyticsStateInternal(ctx).abVariant = parsed.variant;
    },
  });
  pi.registerCommand("analytics:ab", {
    description: "Show A/B experiment results across variants",
    handler: async (_args, ctx) => {
      ctx.ui.notify((await import("./ab-variant.js")).formatABResults(), "info");
    },
  });

  // ── Tools ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "get-session-metrics",
    label: "Get Session Metrics",
    promptSnippet: "Get structured current session analytics",
    description:
      "Get structured current session analytics — use for performance monitoring and debugging session behavior.",
    parameters: Type.Object({}),
    execute: async (
      _id: any,
      _params: any,
      _signal: any,
      _onUpdate: any,
      ctx: ExtensionContext,
    ): Promise<any> => {
      const state = getAnalyticsStateInternal(ctx);
      const metrics = Array.from(state.toolMetrics.values()).sort(
        (a, b) => b.totalCalls - a.totalCalls,
      );
      const sm = getSessionMetrics(state);
      const duration = Math.round((Date.now() - state.sessionStartTime) / 1000);
      return {
        content: [
          {
            type: "text" as const,
            text: `Session: ${state.sessionId || "unknown"}, ${sm.totalToolCalls} tool calls, ${duration}s, outcome: ${computeSessionOutcome(state)}.`,
          },
        ],
        details: {
          sessionId: state.sessionId || "unknown",
          durationSeconds: duration,
          totalToolCalls: sm.totalToolCalls,
          uniqueToolsUsed: sm.uniqueToolsUsed,
          abVariant: state.abVariant,
          outcome: computeSessionOutcome(state),
          toolCounts: Object.fromEntries(metrics.map((m) => [m.toolName, m.totalCalls])),
          topTools: metrics.slice(0, 10).map((m) => ({
            tool: m.toolName,
            calls: m.totalCalls,
            successRate: m.totalCalls > 0 ? m.successfulCalls / m.totalCalls : 0,
            avgDurationMs: m.totalCalls > 0 ? m.totalDurationMs / m.totalCalls : 0,
          })),
          sequences: getToolSequences(state, 2, 3)
            .slice(0, 10)
            .map((s) => ({ pattern: s.pattern, count: s.count })),
        },
      };
    },
  } as any);

  pi.registerTool({
    name: "get-tool-reliability",
    label: "Get Tool Reliability",
    promptSnippet: "Get tool success rates from historical data",
    description:
      "Get tool success rates from historical data — use to find which tools work best for each task type.",
    parameters: Type.Object({
      topN: Type.Optional(Type.Number({ description: "Max results. Default: 10" })),
    }),
    execute: async (
      _id: any,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: ExtensionContext,
    ): Promise<any> => {
      const state = getAnalyticsStateInternal(ctx);
      const summary = loadAnalytics(state.storagePath);
      const reliability = summary.topTools
        .slice(0, params?.topN ?? 10)
        .map((t: any) => ({ tool: t.toolName, totalCalls: t.totalCalls }));
      return {
        content: [{ type: "text" as const, text: `${reliability.length} tools tracked.` }],
        details: {
          totalSessions: summary.totalSessions,
          totalToolCalls: summary.totalToolCalls,
          tools: reliability,
        },
      };
    },
  } as any);

  pi.registerTool({
    name: "get-ab-results",
    label: "Get A/B Results",
    promptSnippet: "Get A/B experiment results across variants",
    description:
      "Get A/B experiment results across variants — use to compare different configurations and agent behaviors.",
    parameters: Type.Object({}),
    execute: async (
      _id: any,
      _params: any,
      _signal: any,
      _onUpdate: any,
      ctx: ExtensionContext,
    ): Promise<any> => {
      const state = getAnalyticsStateInternal(ctx);
      const variants = loadAnalyticsByVariant(state.storagePath);
      const rows = Array.from(variants.values()).map((v) => ({
        variant: v.variant,
        sessions: v.sessions,
        successRate: v.sessions > 0 ? v.successCount / v.sessions : 0,
        partialRate: v.sessions > 0 ? v.partialCount / v.sessions : 0,
        failureRate: v.sessions > 0 ? v.failureCount / v.sessions : 0,
        avgTools: v.avgToolsPerSession,
        avgErrorRate: v.avgErrorRate,
      }));
      return {
        content: [
          {
            type: "text" as const,
            text:
              rows.length === 0
                ? "No A/B data yet."
                : `${rows.length} variant(s) tracked. Top: ${rows[0].variant} (${rows[0].sessions} sessions).`,
          },
        ],
        details: { variants: rows },
      };
    },
  } as any);

  pi.registerTool({
    name: "get-tool-addiction",
    label: "Get Tool Addiction",
    promptSnippet: "Detect tool addiction patterns",
    description:
      "Detect tool addiction patterns — use to identify over-reliance on a single tool across sessions.",
    parameters: Type.Object({ sessionOnly: Type.Optional(Type.Boolean({ default: false })) }),
    execute: async (
      _id: any,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: ExtensionContext,
    ): Promise<any> => {
      const state = getAnalyticsStateInternal(ctx);
      const sessionToolNames = state.toolCallSequence;
      const toolCounts = new Map<string, { count: number; clusters: number }>();
      for (let i = 0; i < sessionToolNames.length; i++) {
        const entry = toolCounts.get(sessionToolNames[i]) ?? { count: 0, clusters: 0 };
        entry.count++;
        if (i > 0 && sessionToolNames[i - 1] === sessionToolNames[i]) entry.clusters++;
        toolCounts.set(sessionToolNames[i], entry);
      }
      const totalCalls = sessionToolNames.length;
      const avgPerTool = totalCalls / Math.max(toolCounts.size, 1);
      const results: any[] = [];
      for (const [tool, { count, clusters }] of toolCounts) {
        const frequency = totalCalls > 0 ? count / Math.max(avgPerTool, 1) : 0;
        const burstRatio = count > 1 ? clusters / (count - 1) : 0;
        const addictionScore = Math.min(Math.min(frequency / 5, 1) * 0.5 + burstRatio * 0.3, 1);
        const reasons: string[] = [];
        if (frequency > 3)
          reasons.push(`high frequency (${count}x vs ${avgPerTool.toFixed(1)}x avg)`);
        if (burstRatio > 0.4) reasons.push(`bursty (${clusters} consecutive repeats)`);
        results.push({
          tool,
          frequency: parseFloat(frequency.toFixed(2)),
          burstRatio: parseFloat(burstRatio.toFixed(2)),
          addictionScore: parseFloat(addictionScore.toFixed(3)),
          note: reasons.length > 0 ? reasons.join("; ") : undefined,
        });
      }
      results.sort((a: any, b: any) => b.addictionScore - a.addictionScore);
      return {
        content: [
          {
            type: "text" as const,
            text: `Tool addiction analysis: ${results.length} tools tracked.`,
          },
        ],
        details: { totalCalls, tools: results },
      };
    },
  } as any);

  pi.registerTool({
    name: "hidden-messages",
    label: "Get Hidden Messages",
    promptSnippet: "Show all display:false injections in this session",
    description:
      "Show all display:false injections from this session — use to debug hidden system messages and nudges affecting context.",
    parameters: Type.Object({}),
    execute: async (
      _id: any,
      _params: any,
      _signal: any,
      _onUpdate: any,
      _ctx: ExtensionContext,
    ): Promise<any> => {
      const { getInjections } = await import("../../../lib/injection-tracker.js");
      const hidden = getInjections().filter((i: any) => !i.display);
      if (hidden.length === 0)
        return {
          content: [{ type: "text" as const, text: "No hidden messages this session." }],
          details: { count: 0, injections: [] },
        };
      const byType: Record<string, string[]> = {};
      for (const inj of hidden) {
        if (!byType[inj.type]) byType[inj.type] = [];
        byType[inj.type].push(`[${inj.source}] ${inj.content}`);
      }
      const lines = [`## Hidden Messages (${hidden.length} total)`, ""];
      for (const [type, items] of Object.entries(byType)) {
        lines.push(`### ${type} (${items.length})`);
        for (const item of items) lines.push(`- ${item}`);
        lines.push("");
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          count: hidden.length,
          byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length])),
        },
      };
    },
  } as any);
}
