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
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "../../../lib/extension-state.js";
import { emitSignal, getNextRecommendation } from "../../../lib/belief-policy-engine.js";
import { isDegraded, getDegradationReasons } from "../../../lib/degradation-detector.js";
import { sendTrackedMessage } from "../../../lib/injection-tracker.js";
import { Type } from "typebox";

import { getAnalyticsStateInternal, updateContextDensity, recordNudgeSent, recordNudgeSuppressed, getAnalyticsState } from "./shared.js";
import { recordError, recordToolSuccess } from "../../../lib/degradation-detector.js";
export { updateContextDensity, recordNudgeSent, recordNudgeSuppressed, getAnalyticsState, getAnalyticsSummary } from "./shared.js";

import { recordToolCall, getToolSequences, getSessionMetrics, computeSessionOutcome, flushAnalytics, loadAnalytics } from "./core.js";
import { loadAnalyticsByVariant } from "./ab-variant.js";
import { formatCurrentSession, formatAllSessions } from "./format.js";

const log = createLogger("analytics");

export default function analyticsExtension(pi: ExtensionAPI) {
  const pendingToolCalls = new Map<string, { toolName: string; startTime: number }>();
  /** Tracks unique tool types used in the current turn (deduplicated for addiction detection).
   *  Set is flushed to state.turnToolSequence on each turn_end, then cleared. */
  const turnToolTypes = new Set<string>();

  // ── session_start ──────────────────────────────────────────────────
  registerSessionStartHandler(pi, SessionPhase.MemoryState, async (_event, ctx) => {
    const state = getAnalyticsStateInternal(ctx);
    state.sessionId = ctx.sessionManager.getSessionFile() ?? `session-${Date.now()}`;
    state.sessionStartTime = Date.now();
    state.toolMetrics.clear();
    state.toolCallSequence = [];
    state.turnToolSequence = [];
    state.wasDegraded = false;
    state.nudgesSent = 0;
    state.nudgesSuppressed = 0;
    state.storagePath = join(homedir(), ".pi/logs/braid-metrics.jsonl");
    pendingToolCalls.clear();
    turnToolTypes.clear();
    lastAddictionCheck = 0;

    const logsDir = join(homedir(), ".pi/logs");
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
  });

  // ── tool_execution_start ───────────────────────────────────────────
  pi.on("tool_execution_start", async (event) => {
    pendingToolCalls.set(event.toolCallId, { toolName: event.toolName, startTime: Date.now() });
  });

  // ── tool_execution_end ─────────────────────────────────────────────
  pi.on("tool_execution_end", async (event, ctx) => {
    try {
    const pending = pendingToolCalls.get(event.toolCallId);
    if (pending) {
      const state = getAnalyticsStateInternal(ctx);
      const success = !event.isError;
      recordToolCall(state, pending.toolName, Date.now() - pending.startTime, success);
      // Feed degradation detector
      if (success) {
        recordToolSuccess(ctx);
      } else {
        recordError(ctx);
      }
      // Track tool type for per-turn deduplication in addiction detection
      turnToolTypes.add(pending.toolName);
      pendingToolCalls.delete(event.toolCallId);
    }
    } catch (err) {
      log.error("[analytics-tool-exec-end] error:", err);
    }
  });

  // ── turn_end: addiction detection + degradation ─────────────────────
  let lastAddictionCheck = 0;
  pi.on("turn_end", async (_event: any, ctx: any) => {
    try {
    const state = getAnalyticsStateInternal(ctx);

    // Flush per-turn deduplicated tool types into turnToolSequence
    for (const tool of turnToolTypes) {
      state.turnToolSequence.push(tool);
    }
    turnToolTypes.clear();

    // Addiction check using per-turn deduplicated sequence (turnToolSequence)
    // This prevents multi-call turns (e.g., 3 bash + 1 read) from skewing ratios.
    const turnCalls = state.turnToolSequence.length;
    if (turnCalls >= 10 && turnCalls - lastAddictionCheck >= 10) {
      lastAddictionCheck = turnCalls;
      const window = state.turnToolSequence.slice(-50);
      const counts = new Map<string, number>();
      for (const t of window) counts.set(t, (counts.get(t) ?? 0) + 1);
      const total = window.length;
      const warnings: string[] = [];
      for (const [tool, count] of counts) {
        const ratio = count / total;
        const toolN = counts.size;
        if (tool === "read") continue;
        if ((ratio > 0.8 && toolN <= 2) || (toolN > 1 && count > (total / Math.max(toolN, 1)) * 4)) {
          warnings.push(`${tool} (${count}/${total} turns, ${(ratio * 100).toFixed(0)}%)`);
        }
      }
      if (warnings.length > 0) {
        emitSignal(ctx, "tool-use", "overuse", "warn", false, { tools: warnings, windowSize: total });
        const bpeRec = getNextRecommendation(ctx);
        if (bpeRec) {
          sendTrackedMessage(pi, { customType: "context", display: true, content: [{ type: "text", text: bpeRec.message }] }, undefined, { type: "heartbeat", source: "heartbeat/analytics/policy" });
        }
        sendTrackedMessage(pi, { customType: "memory", display: true, content: [{ type: "text", text: `[analytics] Tool addiction pattern detected: ${warnings.join("; ")}` }] }, undefined, { type: "heartbeat", source: "heartbeat/analytics" });
      }
    }

    // Degradation detection
    const degraded = isDegraded(ctx);
    if (degraded && !state.wasDegraded) {
      state.wasDegraded = true;
      const reasons = getDegradationReasons(ctx);
      emitSignal(ctx, "stability", "decline", "critical", false, { reason: reasons[0] ?? "degraded", consecutiveErrors: 3 });
      sendTrackedMessage(pi, { customType: "context", display: true, content: [{ type: "text", text: `[health] Degradation detected: ${reasons.join("; ")}` }] }, undefined, { type: "heartbeat", source: "heartbeat/analytics/degrade" });
    } else if (!degraded && state.wasDegraded) {
      state.wasDegraded = false;
      sendTrackedMessage(pi, { customType: "context", display: true, content: [{ type: "text", text: "[health] Performance recovered to healthy." }] }, undefined, { type: "heartbeat", source: "heartbeat/analytics/recover" });
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
    handler: async (_args, ctx) => { ctx.ui.notify(formatCurrentSession(getAnalyticsStateInternal(ctx)), "info"); },
  });
  pi.registerCommand("analytics:all", {
    description: "Show tool analytics across all historical sessions",
    handler: async (_args, _ctx) => { _ctx.ui.notify(formatAllSessions(), "info"); },
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
    handler: async (_args, ctx) => { ctx.ui.notify((await import("./ab-variant.js")).formatABResults(), "info"); },
  });

  // ── Tools ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "get-session-metrics", label: "Get Session Metrics",
    description: "Get structured current session analytics.",
    parameters: Type.Object({}),
    execute: async (_id: any, _params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext): Promise<any> => {
      const state = getAnalyticsStateInternal(ctx);
      const metrics = Array.from(state.toolMetrics.values()).sort((a, b) => b.totalCalls - a.totalCalls);
      const sm = getSessionMetrics(state);
      const duration = Math.round((Date.now() - state.sessionStartTime) / 1000);
      return {
        content: [{ type: "text" as const, text: `Session: ${state.sessionId || "unknown"}, ${sm.totalToolCalls} tool calls, ${duration}s, outcome: ${computeSessionOutcome(state)}.` }],
        details: {
          sessionId: state.sessionId || "unknown", durationSeconds: duration,
          totalToolCalls: sm.totalToolCalls, uniqueToolsUsed: sm.uniqueToolsUsed,
          abVariant: state.abVariant, outcome: computeSessionOutcome(state),
          toolCounts: Object.fromEntries(metrics.map((m) => [m.toolName, m.totalCalls])),
          topTools: metrics.slice(0, 10).map((m) => ({ tool: m.toolName, calls: m.totalCalls, successRate: m.totalCalls > 0 ? m.successfulCalls / m.totalCalls : 0, avgDurationMs: m.totalCalls > 0 ? m.totalDurationMs / m.totalCalls : 0 })),
          sequences: getToolSequences(state, 2, 3).slice(0, 10).map((s) => ({ pattern: s.pattern, count: s.count })),
        },
      };
    },
  } as any);

  pi.registerTool({
    name: "get-tool-reliability", label: "Get Tool Reliability",
    description: "Get tool success rates from historical analytics data.",
    parameters: Type.Object({ topN: Type.Optional(Type.Number({ description: "Max results. Default: 10" })) }),
    execute: async (_id: any, params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext): Promise<any> => {
      const state = getAnalyticsStateInternal(ctx);
      const summary = loadAnalytics(state.storagePath);
      const reliability = summary.topTools.slice(0, params?.topN ?? 10).map((t: any) => ({ tool: t.toolName, totalCalls: t.totalCalls }));
      return { content: [{ type: "text" as const, text: `${reliability.length} tools tracked.` }], details: { totalSessions: summary.totalSessions, totalToolCalls: summary.totalToolCalls, tools: reliability } };
    },
  } as any);

  pi.registerTool({
    name: "get-ab-results", label: "Get A/B Results",
    description: "Get A/B experiment results across variants.",
    parameters: Type.Object({}),
    execute: async (_id: any, _params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext): Promise<any> => {
      const state = getAnalyticsStateInternal(ctx);
      const variants = loadAnalyticsByVariant(state.storagePath);
      const rows = Array.from(variants.values()).map((v) => ({ variant: v.variant, sessions: v.sessions, successRate: v.sessions > 0 ? v.successCount / v.sessions : 0, partialRate: v.sessions > 0 ? v.partialCount / v.sessions : 0, failureRate: v.sessions > 0 ? v.failureCount / v.sessions : 0, avgTools: v.avgToolsPerSession, avgErrorRate: v.avgErrorRate }));
      return { content: [{ type: "text" as const, text: rows.length === 0 ? "No A/B data yet." : `${rows.length} variant(s) tracked. Top: ${rows[0].variant} (${rows[0].sessions} sessions).` }], details: { variants: rows } };
    },
  } as any);

  pi.registerTool({
    name: "get-tool-addiction", label: "Get Tool Addiction",
    description: "Detect tool addiction patterns.",
    parameters: Type.Object({ sessionOnly: Type.Optional(Type.Boolean({ default: false })) }),
    execute: async (_id: any, params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext): Promise<any> => {
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
        const addictionScore = Math.min((Math.min(frequency / 5, 1)) * 0.5 + burstRatio * 0.3, 1);
        const reasons: string[] = [];
        if (frequency > 3) reasons.push(`high frequency (${count}x vs ${avgPerTool.toFixed(1)}x avg)`);
        if (burstRatio > 0.4) reasons.push(`bursty (${clusters} consecutive repeats)`);
        results.push({ tool, frequency: parseFloat(frequency.toFixed(2)), burstRatio: parseFloat(burstRatio.toFixed(2)), addictionScore: parseFloat(addictionScore.toFixed(3)), note: reasons.length > 0 ? reasons.join("; ") : undefined });
      }
      results.sort((a: any, b: any) => b.addictionScore - a.addictionScore);
      return { content: [{ type: "text" as const, text: `Tool addiction analysis: ${results.length} tools tracked.` }], details: { totalCalls, tools: results } };
    },
  } as any);

  pi.registerTool({
    name: "hidden-messages", label: "Get Hidden Messages",
    description: "Show all display:false injections this session.",
    parameters: Type.Object({}),
    execute: async (_id: any, _params: any, _signal: any, _onUpdate: any, _ctx: ExtensionContext): Promise<any> => {
      const { getInjections } = await import("../../../lib/injection-tracker.js");
      const hidden = getInjections().filter((i: any) => !i.display);
      if (hidden.length === 0) return { content: [{ type: "text" as const, text: "No hidden messages this session." }], details: { count: 0, injections: [] } };
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
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { count: hidden.length, byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length])) } };
    },
  } as any);
}
