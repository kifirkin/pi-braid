import { createLogger } from "../../../lib/logger.js";
import { eventBus } from "../../../lib/event-bus.js";

const log = createLogger("analytics");

/**
 * Analytics Extension - Self-contained tool usage analytics
 *
 * Tracks tool call counts, durations, success/failure rates,
 * tool sequences and patterns, session-level metrics, and
 * basic recommendations with A/B experiment variant tracking (R9).
 *
 * State is session-scoped via getExtensionState to prevent
 * cross-session contamination in multi-session processes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "../../../lib/extension-state.js";
import { emitSignal, getNextRecommendation } from "../../../lib/belief-policy-engine.js";
import { isDegraded, getDegradationReasons } from "../../../lib/degradation-detector.js";
import { sendTrackedMessage } from "../../../lib/injection-tracker.js";
import { Type } from "typebox";

// ── Types ──────────────────────────────────────────────────────────────────

interface ToolMetrics {
  toolName: string;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  totalDurationMs: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  errorRate: number;
  lastUsed: number;
  lastError?: string;
}

interface ToolSequence {
  pattern: string;
  count: number;
  successRate: number;
}

interface SessionMetrics {
  sessionId: string;
  startTime: number;
  totalToolCalls: number;
  uniqueToolsUsed: number;
  toolCallSequence: string[];
}

interface AnalyticsSummary {
  totalSessions: number;
  totalToolCalls: number;
  avgToolsPerSession: number;
  topTools: { toolName: string; count: number; successRate: number }[];
  sequences: ToolSequence[];
}

// ── Session-scoped State ───────────────────────────────────────────────────

interface AnalyticsState {
  sessionId: string;
  sessionStartTime: number;
  toolMetrics: Map<string, ToolMetrics>;
  toolCallSequence: string[];
  storagePath: string;
  abVariant: string;
  contextDensity: number;
  lastDensityTurn: number;
  wasDegraded: boolean; // Tracks degradation state transitions for one-shot alerts
  nudgesSent: number; // BR3: Count of nudges actually sent to agent
  nudgesSuppressed: number; // BR3: Count of nudges suppressed by A/B variant
}

function createAnalyticsState(): AnalyticsState {
  return {
    sessionId: "",
    sessionStartTime: Date.now(),
    toolMetrics: new Map(),
    toolCallSequence: [],
    storagePath: join(homedir(), ".pi/logs/braid-metrics.jsonl"),
    abVariant: "control",
    contextDensity: 0,
    lastDensityTurn: 0,
    wasDegraded: false,
    nudgesSent: 0,
    nudgesSuppressed: 0,
  };
}

let _lastState: AnalyticsState | null = null;

function getAnalyticsStateInternal(ctx: ExtensionContext): AnalyticsState {
  const s = getExtensionState(ctx, "analytics", createAnalyticsState);
  _lastState = s;
  return s;
}

// ── Exported helpers (for evolve/enforcement extensions) ───────────────────

/**
 * Update context density metric for heartbeat reporting.
 */
export function updateContextDensity(ctx: ExtensionContext, density: number) {
  const state = getAnalyticsStateInternal(ctx);
  state.contextDensity = Math.round(density * 1000) / 10;
  state.lastDensityTurn = (ctx as any).turnCount ?? 0;
  log.debug(`analytics: context_density=${state.contextDensity.toFixed(1)}%`);

  // Emit context_full event when density exceeds 70%
  if (state.contextDensity > 70) {
    try {
      eventBus.emit({
        type: "context_full",
        usagePercent: state.contextDensity,
        tokensUsed: 0,
        tokensLimit: 0,
      });
    } catch {} // non-fatal
  }
}

/**
 * Record that a nudge was sent to the agent (BR3 tracking).
 */
export function recordNudgeSent(ctx: ExtensionContext) {
  const state = getAnalyticsStateInternal(ctx);
  state.nudgesSent++;
}

/**
 * Record that a nudge was suppressed by A/B variant (BR3 tracking).
 */
export function recordNudgeSuppressed(ctx: ExtensionContext) {
  const state = getAnalyticsStateInternal(ctx);
  state.nudgesSuppressed++;
}

/**
 * Get analytics state for feedback loop (used by evolve extension).
 * Accepts optional ctx — falls back to last session's state.
 */
export function getAnalyticsState(ctx?: ExtensionContext) {
  if (ctx) return getAnalyticsStateInternal(ctx);
  if (_lastState) return _lastState;
  return createAnalyticsState();
}

/**
 * Get historical analytics summary (used by enforcement for tool suggestions).
 */
export function getAnalyticsSummary(): any {
  return loadAnalytics();
}

// ── Core Analytics Functions ───────────────────────────────────────────────

function getOrCreateMetrics(s: AnalyticsState, toolName: string): ToolMetrics {
  let metrics = s.toolMetrics.get(toolName);
  if (!metrics) {
    metrics = {
      toolName,
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      minDurationMs: Number.MAX_SAFE_INTEGER,
      maxDurationMs: 0,
      errorRate: 0,
      lastUsed: Date.now(),
    };
    s.toolMetrics.set(toolName, metrics);
  }
  return metrics;
}

function recordToolCall(
  s: AnalyticsState,
  toolName: string,
  durationMs: number,
  success: boolean,
): void {
  s.toolCallSequence.push(toolName);

  const metrics = getOrCreateMetrics(s, toolName);
  metrics.totalCalls++;
  if (success) {
    metrics.successfulCalls++;
  } else {
    metrics.failedCalls++;
  }
  metrics.totalDurationMs += durationMs;
  metrics.avgDurationMs = Math.round(metrics.totalDurationMs / metrics.totalCalls);
  metrics.minDurationMs = Math.min(metrics.minDurationMs, durationMs);
  metrics.maxDurationMs = Math.max(metrics.maxDurationMs, durationMs);
  metrics.errorRate = metrics.failedCalls / metrics.totalCalls;
  metrics.lastUsed = Date.now();
}

function getToolSequences(s: AnalyticsState, minLength = 2, minSupport = 2): ToolSequence[] {
  const sequences: Map<string, { count: number; successCount: number }> = new Map();

  for (let i = 0; i < s.toolCallSequence.length - minLength + 1; i++) {
    const pattern = s.toolCallSequence.slice(i, i + minLength).join(" → ");
    const subSequence = s.toolCallSequence.slice(i, i + minLength);

    const existing = sequences.get(pattern) || { count: 0, successCount: 0 };
    existing.count++;
    const successRate = subSequence.every((t) => s.toolMetrics.has(t)) ? 0.9 : 0.5;
    existing.successCount += successRate;
    sequences.set(pattern, existing);
  }

  const result: ToolSequence[] = [];
  for (const [pattern, stats] of sequences) {
    if (stats.count >= minSupport) {
      result.push({
        pattern,
        count: stats.count,
        successRate: Math.min(stats.successCount / stats.count, 1),
      });
    }
  }

  return result.sort((a, b) => b.count - a.count);
}

function getSessionMetrics(s: AnalyticsState): SessionMetrics {
  const uniqueTools = new Set(s.toolCallSequence).size;
  return {
    sessionId: s.sessionId,
    startTime: s.sessionStartTime,
    totalToolCalls: s.toolCallSequence.length,
    uniqueToolsUsed: uniqueTools,
    toolCallSequence: [...s.toolCallSequence],
  };
}

function computeSessionOutcome(s: AnalyticsState): "success" | "partial" | "failure" {
  const totalCalls = s.toolCallSequence.length;
  if (totalCalls === 0) return "partial";
  const failedCalls = Array.from(s.toolMetrics.values()).reduce((sum, m) => sum + m.failedCalls, 0);
  const errorRate = failedCalls / totalCalls;
  if (s.wasDegraded && errorRate > 0.3) return "failure";
  if (s.wasDegraded || errorRate > 0.15) return "partial";
  return "success";
}

function flushAnalytics(s: AnalyticsState, taskCompleted = false): void {
  const logsDir = join(homedir(), ".pi/logs");
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }

  const sessionMetrics = getSessionMetrics(s);
  const toolMetricsList = Array.from(s.toolMetrics.values());
  const sequences = getToolSequences(s);
  const outcome = computeSessionOutcome(s);

  const entry = {
    timestamp: Date.now(),
    sessionMetrics,
    toolMetrics: toolMetricsList,
    sequences,
    taskCompleted,
    abVariant: s.abVariant,
    nudgesSent: s.nudgesSent,
    nudgesSuppressed: s.nudgesSuppressed,
    outcome,
  };

  try {
    writeFileSync(s.storagePath, `${JSON.stringify(entry)}\n`, { flag: "a" });
  } catch (e) {
    // Silently fail - analytics is non-critical
  }
}

function loadAnalytics(storagePath?: string): AnalyticsSummary {
  const path = storagePath ?? join(homedir(), ".pi/logs/braid-metrics.jsonl");
  if (!existsSync(path)) {
    return {
      totalSessions: 0,
      totalToolCalls: 0,
      avgToolsPerSession: 0,
      topTools: [],
      sequences: [],
    };
  }

  try {
    const content = readFileSync(path, "utf-8");
    const lines = content.trim().split("\n");

    const toolCounts: Record<string, number> = {};
    const toolSuccess: Record<string, number> = {};
    let totalSessions = 0;
    let totalToolCalls = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        totalSessions++;
        const sm = entry.sessionMetrics;
        totalToolCalls += sm.totalToolCalls;

        for (const tool of sm.toolCallSequence) {
          toolCounts[tool] = (toolCounts[tool] || 0) + 1;
        }

        for (const tm of entry.toolMetrics || []) {
          toolSuccess[tm.toolName] = (toolSuccess[tm.toolName] || 0) + tm.successfulCalls;
        }
      } catch {
        // Skip malformed lines
      }
    }

    const topTools = Object.entries(toolCounts)
      .map(([toolName, count]) => ({
        toolName,
        count,
        successRate:
          toolCounts[toolName] > 0 ? (toolSuccess[toolName] || 0) / toolCounts[toolName] : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const sequenceMap = new Map<string, ToolSequence>();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        for (const seq of entry.sequences || []) {
          const existing = sequenceMap.get(seq.pattern);
          if (existing) {
            existing.count += seq.count;
            existing.successRate = (existing.successRate + seq.successRate) / 2;
          } else {
            sequenceMap.set(seq.pattern, { ...seq });
          }
        }
      } catch {
        // Skip
      }
    }

    return {
      totalSessions,
      totalToolCalls,
      avgToolsPerSession: totalSessions > 0 ? totalToolCalls / totalSessions : 0,
      topTools,
      sequences: Array.from(sequenceMap.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
    };
  } catch {
    return {
      totalSessions: 0,
      totalToolCalls: 0,
      avgToolsPerSession: 0,
      topTools: [],
      sequences: [],
    };
  }
}

// ── A/B Variant Measurement (BR3) ──────────────────────────────────────────

interface VariantStats {
  variant: string;
  sessions: number;
  totalToolCalls: number;
  successCount: number;
  partialCount: number;
  failureCount: number;
  avgToolsPerSession: number;
  avgErrorRate: number;
  nudgesSent: number;
  nudgesSuppressed: number;
}

function loadAnalyticsByVariant(storagePath?: string): Map<string, VariantStats> {
  const path = storagePath ?? join(homedir(), ".pi/logs/braid-metrics.jsonl");
  const variants = new Map<string, VariantStats>();

  if (!existsSync(path)) return variants;

  try {
    const content = readFileSync(path, "utf-8");
    const lines = content.trim().split("\n");

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const variant = entry.abVariant || "control";
        const sm = entry.sessionMetrics || {};
        const tms = entry.toolMetrics || [];

        let existing = variants.get(variant);
        if (!existing) {
          existing = {
            variant,
            sessions: 0,
            totalToolCalls: 0,
            successCount: 0,
            partialCount: 0,
            failureCount: 0,
            avgToolsPerSession: 0,
            avgErrorRate: 0,
            nudgesSent: 0,
            nudgesSuppressed: 0,
          };
          variants.set(variant, existing);
        }

        existing.sessions++;
        existing.totalToolCalls += sm.totalToolCalls || 0;

        const outcome = entry.outcome || "partial";
        if (outcome === "success") existing.successCount++;
        else if (outcome === "failure") existing.failureCount++;
        else existing.partialCount++;

        // Rolling average for tools per session
        existing.avgToolsPerSession =
          (existing.avgToolsPerSession * (existing.sessions - 1) + (sm.totalToolCalls || 0)) /
          existing.sessions;

        // Accumulate nudge counts
        existing.nudgesSent += entry.nudgesSent || 0;
        existing.nudgesSuppressed += entry.nudgesSuppressed || 0;

        // Compute session error rate
        const totalCalls = sm.totalToolCalls || 0;
        const failedCalls = tms.reduce((sum: number, m: any) => sum + (m.failedCalls || 0), 0);
        const errorRate = totalCalls > 0 ? failedCalls / totalCalls : 0;
        existing.avgErrorRate =
          (existing.avgErrorRate * (existing.sessions - 1) + errorRate) / existing.sessions;
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // Ignore read errors
  }

  return variants;
}

function formatABResults(): string {
  const variants = loadAnalyticsByVariant();
  if (variants.size === 0) {
    return "## A/B Results\n\n*No historical data yet. Run `/analytics:setVariant` to configure variants and accumulate sessions.*";
  }

  const lines: string[] = [];
  lines.push("## A/B Experiment Results");
  lines.push("");
  lines.push("| Variant | Sessions | Success | Partial | Failure | Avg Tools | Nudges Sent | Suppressed | Avg Error Rate |");
  lines.push("|---------|----------|---------|---------|---------|-----------|-------------|------------|----------------|");

  for (const v of variants.values()) {
    const successRate = v.sessions > 0 ? ((v.successCount / v.sessions) * 100).toFixed(0) : "0";
    const partialRate = v.sessions > 0 ? ((v.partialCount / v.sessions) * 100).toFixed(0) : "0";
    const failureRate = v.sessions > 0 ? ((v.failureCount / v.sessions) * 100).toFixed(0) : "0";
    lines.push(
      `| ${v.variant} | ${v.sessions} | ${successRate}% | ${partialRate}% | ${failureRate}% | ${v.avgToolsPerSession.toFixed(1)} | ${v.nudgesSent} | ${v.nudgesSuppressed} | ${(v.avgErrorRate * 100).toFixed(0)}% |`,
    );
  }

  lines.push("");

  // Compute significance: if control and no_nudges both have >= 3 sessions, show delta
  const control = variants.get("control");
  const noNudges = variants.get("no_nudges");
  if (control && noNudges && control.sessions >= 3 && noNudges.sessions >= 3) {
    const controlSuccess = control.sessions > 0 ? control.successCount / control.sessions : 0;
    const noNudgesSuccess = noNudges.sessions > 0 ? noNudges.successCount / noNudges.sessions : 0;
    const delta = ((noNudgesSuccess - controlSuccess) * 100).toFixed(1);
    const direction = parseFloat(delta) > 0 ? "improvement" : "regression";
    lines.push(`**Delta (no_nudges vs control): ${delta}% ${direction}**`);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Formatting (for /analytics commands) ───────────────────────────────────

function formatCurrentSession(s: AnalyticsState): string {
  const metrics = Array.from(s.toolMetrics.values()).sort((a, b) => b.totalCalls - a.totalCalls);
  const sequences = getToolSequences(s, 2, 2);
  const sessionMetrics = getSessionMetrics(s);

  const lines: string[] = [];
  lines.push("## Tool Analytics - Current Session");
  lines.push("");
  lines.push(`**Session:** ${s.sessionId || "unknown"}`);
  lines.push(`**Duration:** ${Math.round((Date.now() - s.sessionStartTime) / 1000)}s`);
  lines.push(`**Total Tool Calls:** ${sessionMetrics.totalToolCalls}`);
  lines.push(`**Context Density:** ${s.contextDensity.toFixed(1)}%`);
  lines.push(`**Unique Tools Used:** ${sessionMetrics.uniqueToolsUsed}`);
  lines.push(`**A/B Variant:** ${s.abVariant}`);
  lines.push(`**Nudges Sent:** ${s.nudgesSent} | **Suppressed:** ${s.nudgesSuppressed}`);
  lines.push("");

  if (metrics.length > 0) {
    lines.push("### Tool Usage");
    lines.push("| Tool | Calls | Success | Avg Duration |");
    lines.push("|------|-------|---------|--------------|");
    for (const m of metrics.slice(0, 15)) {
      const successRate = ((1 - m.errorRate) * 100).toFixed(0);
      lines.push(`| ${m.toolName} | ${m.totalCalls} | ${successRate}% | ${m.avgDurationMs}ms |`);
    }
    lines.push("");
  }

  if (sequences.length > 0) {
    lines.push("### Common Sequences");
    lines.push("| Pattern | Count | Success Rate |");
    lines.push("|---------|-------|--------------|");
    for (const seq of sequences.slice(0, 10)) {
      lines.push(`| ${seq.pattern} | ${seq.count} | ${(seq.successRate * 100).toFixed(0)}% |`);
    }
    lines.push("");
  }

  if (metrics.length === 0) {
    lines.push("*No tool calls recorded yet in this session.*");
  }

  return lines.join("\n");
}

function formatAllSessions(): string {
  const summary = loadAnalytics();

  const lines: string[] = [];
  lines.push("## Tool Analytics - Historical Summary");
  lines.push("");
  lines.push(`**Total Sessions:** ${summary.totalSessions}`);
  lines.push(`**Total Tool Calls:** ${summary.totalToolCalls}`);
  lines.push(`**Avg Tools per Session:** ${summary.avgToolsPerSession.toFixed(1)}`);
  lines.push("");

  if (summary.topTools.length > 0) {
    lines.push("### Top Tools (All Time)");
    lines.push("| Tool | Total Calls | Success Rate |");
    lines.push("|------|-------------|--------------|");
    for (const tool of summary.topTools) {
      lines.push(`| ${tool.toolName} | ${tool.count} | ${(tool.successRate * 100).toFixed(0)}% |`);
    }
    lines.push("");
  }

  if (summary.sequences.length > 0) {
    lines.push("### Common Sequences (All Time)");
    lines.push("| Pattern | Count | Success Rate |");
    lines.push("|---------|-------|--------------|");
    for (const seq of summary.sequences.slice(0, 10)) {
      lines.push(`| ${seq.pattern} | ${seq.count} | ${(seq.successRate * 100).toFixed(0)}% |`);
    }
    lines.push("");
  }

  if (summary.totalSessions === 0) {
    lines.push("*No historical data yet. Analytics will accumulate over sessions.*");
  }

  return lines.join("\n");
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function analyticsExtension(pi: ExtensionAPI) {
  // Pending tool calls — timing tracker (closure-scoped, not stateful)
  const pendingToolCalls: Map<string, { toolName: string; startTime: number }> = new Map();

  // Initialize on session start
  pi.on("session_start", async (_event, ctx) => {
    const state = getAnalyticsStateInternal(ctx);
    state.sessionId = ctx.sessionManager.getSessionFile() ?? `session-${Date.now()}`;
    state.sessionStartTime = Date.now();
    state.toolMetrics.clear();
    state.toolCallSequence = [];
    state.wasDegraded = false;
    state.nudgesSent = 0;
    state.nudgesSuppressed = 0;
    pendingToolCalls.clear();

    const logsDir = join(homedir(), ".pi/logs");
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }
  });

  // Record tool execution start
  pi.on("tool_execution_start", async (event) => {
    pendingToolCalls.set(event.toolCallId, {
      toolName: event.toolName,
      startTime: Date.now(),
    });
  });

  // Record tool execution end
  pi.on("tool_execution_end", async (event, ctx) => {
    const pending = pendingToolCalls.get(event.toolCallId);
    if (pending) {
      const durationMs = Date.now() - pending.startTime;
      const state = getAnalyticsStateInternal(ctx);
      recordToolCall(state, pending.toolName, durationMs, !event.isError);
      pendingToolCalls.delete(event.toolCallId);
    }
  });

  // Auto-trigger addiction analysis — rolling window, fires every 10+ calls
  let lastAddictionCheck = 0;
  pi.on("turn_end", async (_event: any, ctx: any) => {
    const state = getAnalyticsStateInternal(ctx);
    const calls = state.toolCallSequence.length;
    if (calls >= 10 && calls - lastAddictionCheck >= 10) {
      lastAddictionCheck = calls;
      const window = state.toolCallSequence.slice(-50);
      const toolCounts = new Map<string, number>();
      for (const t of window) {
        toolCounts.set(t, (toolCounts.get(t) ?? 0) + 1);
      }
      const total = window.length;
      const warnings: string[] = [];
      for (const [tool, count] of toolCounts) {
        const ratio = count / total;
        const toolCount = toolCounts.size;
        const fairShare = total / Math.max(toolCount, 1);
        if (tool === "read") continue;
        if ((ratio > 0.8 && toolCount <= 2) || (toolCount > 1 && count > fairShare * 4)) {
          warnings.push(`${tool} (${count}/${total}, ${(ratio * 100).toFixed(0)}%)`);
        }
      }
      if (warnings.length > 0) {
        // D0: Emit tool-use signal for belief-policy-engine
        emitSignal(ctx, "tool-use", "overuse", "warn", false, {
          tools: warnings,
          windowSize: total,
        });

        // R9: Proactively surface policy recommendations right after emitting signal
        const bpeRec = getNextRecommendation(ctx);
        if (bpeRec) {
          sendTrackedMessage(
            pi,
            {
              customType: "context",
              display: true,
              content: [{ type: "text", text: bpeRec.message }],
            },
            undefined,
            { type: "heartbeat", source: "heartbeat/analytics/policy" },
          );
        }

        sendTrackedMessage(
          pi,
          {
            customType: "memory",
            display: true,
            content: [
              {
                type: "text",
                text: `[analytics] Tool addiction pattern detected: ${warnings.join("; ")}`,
              },
            ],
          },
          undefined,
          { type: "heartbeat", source: "heartbeat/analytics" },
        );
      }
    }

    // P2.1: Auto-trigger degrade detection — fires once on first detection,
    // recovers when agent improves. Uses wasDegraded flag for one-shot alerting.
    const degraded = isDegraded(ctx);
    if (degraded && !state.wasDegraded) {
      state.wasDegraded = true;
      const reasons = getDegradationReasons(ctx);
      emitSignal(ctx, "stability", "decline", "critical", false, {
        reason: reasons[0] ?? "degraded",
        consecutiveErrors: 3, // conservative default
      });
      sendTrackedMessage(
        pi,
        {
          customType: "context",
          display: true,
          content: [{ type: "text", text: `[health] Degradation detected: ${reasons.join("; ")}` }],
        },
        undefined,
        { type: "heartbeat", source: "heartbeat/analytics/degrade" },
      );
    } else if (!degraded && state.wasDegraded) {
      // Recovery — agent improved
      state.wasDegraded = false;
      sendTrackedMessage(
        pi,
        {
          customType: "context",
          display: true,
          content: [{ type: "text", text: "[health] Performance recovered to healthy." }],
        },
        undefined,
        { type: "heartbeat", source: "heartbeat/analytics/recover" },
      );
    }
  });

  // Cleanup on session shutdown
  pi.on("session_shutdown", async (_event, ctx) => {
    const state = getAnalyticsStateInternal(ctx);
    if (state.toolCallSequence.length > 0) {
      flushAnalytics(state, false);
    }
  });

  // ── Commands ────────────────────────────────────────────────────────

  pi.registerCommand("analytics", {
    description: "Show tool analytics for the current session",
    handler: async (_args, ctx) => {
      const state = getAnalyticsStateInternal(ctx);
      const output = formatCurrentSession(state);
      ctx.ui.notify(output, "info");
    },
  });

  pi.registerCommand("analytics:all", {
    description: "Show tool analytics across all historical sessions",
    handler: async (_args, _ctx) => {
      const output = formatAllSessions();
      _ctx.ui.notify(output, "info");
    },
  });

  pi.registerCommand("analytics:setVariant", {
    description: "Set A/B experiment variant for this session",
    handler: async (args, ctx) => {
      const parsed = typeof args === "string" ? JSON.parse(args) : args;
      const state = getAnalyticsStateInternal(ctx);
      state.abVariant = parsed.variant;
    },
  });

  pi.registerCommand("analytics:ab", {
    description: "Show A/B experiment results across variants",
    handler: async (_args, ctx) => {
      const output = formatABResults();
      ctx.ui.notify(output, "info");
    },
  });

  // ── Programmatic Tools ──────────────────────────────────────────────

  pi.registerTool({
    name: "get-session-metrics",
    label: "Get Session Metrics",
    description:
      "Get structured current session analytics: tool counts, timing, sequences, success rates.",
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
      const sessionMetrics = getSessionMetrics(state);
      const sequences = getToolSequences(state, 2, 3).slice(0, 10);
      const duration = Math.round((Date.now() - state.sessionStartTime) / 1000);
      const outcome = computeSessionOutcome(state);
      const text = `Session: ${state.sessionId || "unknown"}, ${sessionMetrics.totalToolCalls} tool calls, ${duration}s, outcome: ${outcome}.`;
      return {
        content: [{ type: "text" as const, text }],
        details: {
          sessionId: state.sessionId || "unknown",
          durationSeconds: duration,
          totalToolCalls: sessionMetrics.totalToolCalls,
          uniqueToolsUsed: sessionMetrics.uniqueToolsUsed,
          abVariant: state.abVariant,
          outcome,
          toolCounts: Object.fromEntries(metrics.map((m) => [m.toolName, m.totalCalls])),
          topTools: metrics.slice(0, 10).map((m) => ({
            tool: m.toolName,
            calls: m.totalCalls,
            successRate: m.totalCalls > 0 ? m.successfulCalls / m.totalCalls : 0,
            avgDurationMs: m.totalCalls > 0 ? m.totalDurationMs / m.totalCalls : 0,
          })),
          sequences: sequences.map((s) => ({ pattern: s.pattern, count: s.count })),
        },
      };
    },
  } as any);

  pi.registerTool({
    name: "get-tool-reliability",
    label: "Get Tool Reliability",
    description: "Get tool success rates from historical analytics data.",
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
      const topN = params?.topN ?? 10;
      const summary = loadAnalytics(state.storagePath);
      const reliability = summary.topTools.slice(0, topN).map((t: any) => ({
        tool: t.toolName,
        totalCalls: t.totalCalls,
        recentSessions: t.recentSessions,
      }));
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
    description: "Get A/B experiment results across variants.",
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
      const text =
        rows.length === 0
          ? "No A/B data yet."
          : `${rows.length} variant(s) tracked. Top: ${rows[0].variant} (${rows[0].sessions} sessions).`;
      return {
        content: [{ type: "text" as const, text }],
        details: {
          variants: rows,
        },
      };
    },
  } as any);

  // Tool addiction measurement
  pi.registerTool({
    name: "get-tool-addiction",
    label: "Get Tool Addiction",
    description:
      "Detect tool addiction patterns: overuse relative to task complexity, burst repetition, cross-session persistence.",
    parameters: Type.Object({
      sessionOnly: Type.Optional(
        Type.Boolean({ description: "Only analyze current session (default: false)" }),
      ),
    }),
    execute: async (
      _id: any,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: ExtensionContext,
    ): Promise<any> => {
      const state = getAnalyticsStateInternal(ctx);
      const sessionOnly = params?.sessionOnly ?? false;
      const now = Date.now();
      const startTime = state.sessionStartTime ?? now;
      const sessionAge = (now - startTime) / 1000;

      const sessionToolNames = state.toolCallSequence;
      const toolCounts = new Map<string, { count: number; clusters: number }>();
      for (let i = 0; i < sessionToolNames.length; i++) {
        const tool = sessionToolNames[i];
        const entry = toolCounts.get(tool) ?? { count: 0, clusters: 0 };
        entry.count++;
        if (i > 0 && sessionToolNames[i - 1] === tool) {
          entry.clusters++;
        }
        toolCounts.set(tool, entry);
      }

      const summary = sessionOnly ? null : loadAnalytics(state.storagePath);
      const histToolTotals = new Map<string, number>();
      const histSessionCount = new Map<string, number>();
      let totalHistSessions = 0;

      if (summary && Array.isArray(summary.topTools)) {
        for (const t of summary.topTools) {
          if (t.toolName && t.count) {
            histToolTotals.set(t.toolName, t.count);
            histSessionCount.set(t.toolName, 1);
          }
        }
        totalHistSessions = summary.totalSessions ?? 0;
      }

      interface AddictionEntry {
        tool: string;
        frequency: number;
        burstRatio: number;
        persistence: number;
        addictionScore: number;
        note?: string;
      }

      const results: AddictionEntry[] = [];
      const totalSessionCalls = sessionToolNames.length;
      const avgCallsPerTool = totalSessionCalls / Math.max(toolCounts.size, 1);

      for (const [tool, { count, clusters }] of toolCounts) {
        const frequency = totalSessionCalls > 0 ? count / Math.max(avgCallsPerTool, 1) : 0;
        const burstRatio = count > 1 ? clusters / (count - 1) : 0;
        const histSessions = histSessionCount.get(tool) ?? 0;
        const persistence =
          totalHistSessions > 0 && (histToolTotals.get(tool) ?? 0) > 0
            ? Math.min(histSessions / Math.max(totalHistSessions, 1), 1)
            : 0;

        const freqScore = Math.min(frequency / 5, 1);
        const addictionScore = Math.min(freqScore * 0.5 + burstRatio * 0.3 + persistence * 0.2, 1);

        let note: string | undefined;
        const reasons: string[] = [];
        if (freqScore > 0.6)
          reasons.push(`high frequency (${count}x vs ${avgCallsPerTool.toFixed(1)}x avg)`);
        if (burstRatio > 0.4) reasons.push(`bursty (${clusters} consecutive repeats)`);
        if (persistence > 0.5) reasons.push(`persistent across ${histSessions} sessions`);
        if (reasons.length > 0) note = reasons.join("; ");

        results.push({
          tool,
          frequency: parseFloat(frequency.toFixed(2)),
          burstRatio: parseFloat(burstRatio.toFixed(2)),
          persistence: parseFloat(persistence.toFixed(2)),
          addictionScore: parseFloat(addictionScore.toFixed(3)),
          note,
        });
      }

      results.sort((a, b) => b.addictionScore - a.addictionScore);

      return {
        content: [
          {
            type: "text" as const,
            text: `Tool addiction analysis: ${results.length} tools tracked. Top addiction: ${results.length > 0 ? results[0].tool : "n/a"} (score: ${results.length > 0 ? results[0].addictionScore : 0})`,
          },
        ],
        details: {
          sessionAge: parseFloat(sessionAge.toFixed(0)),
          totalCalls: totalSessionCalls,
          tools: results,
        },
      };
    },
  } as any);

  // ── hidden_messages tool ───────────────────────────────────────────────────
  // D3: Show all display:false injections this session (tracked by injection-tracker)
  pi.registerTool({
    name: "hidden-messages",
    label: "Get Hidden Messages",
    description:
      "Show all messages sent to the model that are hidden from view (display:false). Use this to audit what the agent sees in context beyond visible conversation.",
    parameters: Type.Object({}),
    execute: async (
      _id: any,
      _params: any,
      _signal: any,
      _onUpdate: any,
      _ctx: ExtensionContext,
    ): Promise<any> => {
      const { getInjections } = await import("../../../lib/injection-tracker.js");
      const injections = getInjections();
      const hidden = injections.filter((i) => !i.display);

      if (hidden.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No hidden messages this session." }],
          details: { count: 0, injections: [] },
        };
      }

      // Group by type
      const byType: Record<string, string[]> = {};
      for (const inj of hidden) {
        if (!byType[inj.type]) byType[inj.type] = [];
        byType[inj.type].push(`[${inj.source}] ${inj.content}`);
      }

      const lines = [
        `## Hidden Messages (${hidden.length} total, ${injections.length} total injections)`,
      ];
      lines.push("_" + `(display:false — model sees these but you don't)` + "_");
      lines.push("");
      for (const [type, items] of Object.entries(byType)) {
        lines.push(`### ${type} (${items.length})`);
        for (const item of items) lines.push(`- ${item}`);
        lines.push("");
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          count: hidden.length,
          totalInjections: injections.length,
          byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length])),
          injections: hidden.map((i) => ({
            id: i.id,
            type: i.type,
            source: i.source,
            content: i.content,
          })),
        },
      };
    },
  } as any);
}
