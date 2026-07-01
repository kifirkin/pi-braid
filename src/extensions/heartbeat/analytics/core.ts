/**
 * Analytics - core functions: metrics, sequences, persistence.
 */

import { existsSync, mkdirSync, readFileSync, promises as fs } from "node:fs";
import { METRICS_FILE, METRICS_DIR } from "../../../lib/config/braid-paths.js";
import { createLogger } from "../../../lib/core/logger.js";
const log = createLogger("analytics:core");
import type {
  AnalyticsState,
  AnalyticsSummary,
  ToolMetrics,
  ToolSequence,
  SessionMetrics,
} from "./shared.js";

// ── Metrics ────────────────────────────────────────────────────────────────

export function getOrCreateMetrics(s: AnalyticsState, toolName: string): ToolMetrics {
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

export function recordToolCall(
  s: AnalyticsState,
  toolName: string,
  durationMs: number,
  success: boolean,
): void {
  s.toolCallSequence.push(toolName);
  const metrics = getOrCreateMetrics(s, toolName);
  metrics.totalCalls++;
  if (success) metrics.successfulCalls++;
  else metrics.failedCalls++;
  metrics.totalDurationMs += durationMs;
  metrics.avgDurationMs = Math.round(metrics.totalDurationMs / metrics.totalCalls);
  metrics.minDurationMs = Math.min(metrics.minDurationMs, durationMs);
  metrics.maxDurationMs = Math.max(metrics.maxDurationMs, durationMs);
  metrics.errorRate = metrics.failedCalls / metrics.totalCalls;
  metrics.lastUsed = Date.now();
}

export function getToolSequences(s: AnalyticsState, minLength = 2, minSupport = 2): ToolSequence[] {
  const sequences = new Map<string, { count: number; successCount: number }>();

  for (let i = 0; i < s.toolCallSequence.length - minLength + 1; i++) {
    const pattern = s.toolCallSequence.slice(i, i + minLength).join(" -> ");
    const existing = sequences.get(pattern) || { count: 0, successCount: 0 };
    existing.count++;
    existing.successCount += s.toolMetrics.has(s.toolCallSequence[i]) ? 0.9 : 0.5;
    sequences.set(pattern, existing);
  }

  return Array.from(sequences.entries())
    .filter(([, stats]) => stats.count >= minSupport)
    .map(([pattern, stats]) => ({
      pattern,
      count: stats.count,
      successRate: Math.min(stats.successCount / stats.count, 1),
    }))
    .sort((a, b) => b.count - a.count);
}

export function getSessionMetrics(s: AnalyticsState): SessionMetrics {
  return {
    sessionId: s.sessionId,
    startTime: s.sessionStartTime,
    totalToolCalls: s.toolCallSequence.length,
    uniqueToolsUsed: new Set(s.toolCallSequence).size,
    toolCallSequence: [...s.toolCallSequence],
  };
}

export function computeSessionOutcome(s: AnalyticsState): "success" | "partial" | "failure" {
  const totalCalls = s.toolCallSequence.length;
  if (totalCalls === 0) return "partial";
  const failedCalls = Array.from(s.toolMetrics.values()).reduce((sum, m) => sum + m.failedCalls, 0);
  const errorRate = failedCalls / totalCalls;
  if (s.wasDegraded && errorRate > 0.3) return "failure";
  if (s.wasDegraded || errorRate > 0.15) return "partial";
  return "success";
}

// ── Persistence ────────────────────────────────────────────────────────────

export function flushAnalytics(s: AnalyticsState, taskCompleted = false): void {
  if (!existsSync(METRICS_DIR)) mkdirSync(METRICS_DIR, { recursive: true });

  const metrics = Array.from(s.toolMetrics.values());
  const sequences = getToolSequences(s);

  const entry = {
    timestamp: Date.now(),
    sessionMetrics: getSessionMetrics(s),
    toolMetrics: metrics,
    sequences,
    taskCompleted,
    abVariant: s.abVariant,
    nudgesSent: s.nudgesSent,
    nudgesSuppressed: s.nudgesSuppressed,
    outcome: computeSessionOutcome(s),
  };

  // Async append to avoid blocking the event loop on every analytics write.
  // JSONL format is append-only so there's no read-modify-write race.
  fs.appendFile(s.storagePath, `${JSON.stringify(entry)}\n`).catch((err) =>
    log.warn(`Could not persist session metric: ${err}`),
  );
}

export function loadAnalytics(storagePath?: string): AnalyticsSummary {
  const path = storagePath ?? METRICS_FILE;
  if (!existsSync(path))
    return {
      totalSessions: 0,
      totalToolCalls: 0,
      avgToolsPerSession: 0,
      topTools: [],
      sequences: [],
    };

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
      } catch (err) {
        log.warn(`Could not read toolMetrics for session: ${err}`);
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
          } else sequenceMap.set(seq.pattern, { ...seq });
        }
      } catch (err) {
        log.warn(`Could not read sequenceMetrics: ${err}`);
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
