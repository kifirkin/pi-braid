import { getAnalyticsState } from "../../heartbeat/analytics/index.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BenchmarkResult } from "./types.js";

// Analytics feedback loop helpers
export function getAnalyticsMetrics(ctx?: ExtensionContext) {
  const analytics = getAnalyticsState(ctx);
  const toolList: Array<{ name: string; calls: number; successRate: number }> = [];
  for (const [name, metrics] of analytics.toolMetrics) {
    toolList.push({
      name,
      calls: metrics.totalCalls,
      successRate:
        metrics.totalCalls > 0 ? (metrics.successfulCalls / metrics.totalCalls) * 100 : 0,
    });
  }
  const totalCalls = toolList.reduce((sum, t) => sum + t.calls, 0);
  const topCallCount = toolList.length > 0 ? Math.max(...toolList.map((t) => t.calls)) : 0;
  // R9: Tool addiction detection (>50% of calls = addiction)
  const toolAddictionScore = totalCalls > 10 && topCallCount / totalCalls > 0.5 ? 0.3 : 1.0;
  const abReady = analytics.abVariant !== "control";
  return {
    totalToolCalls: totalCalls,
    toolCount: toolList.length,
    abVariant: analytics.abVariant,
    abReady,
    topTools: toolList.sort((a, b) => b.calls - a.calls).slice(0, 5),
    toolAddictionScore,
    recommendation: getAnalyticsRecommendation(toolList, toolAddictionScore, abReady),
  };
}

export function getAnalyticsRecommendation(
  toolList: Array<{ name: string; calls: number; successRate: number }>,
  toolAddictionScore: number,
  abReady: boolean,
): string | null {
  if (toolAddictionScore < 0.5) {
    const addictiveTool = toolList.sort((a, b) => b.calls - a.calls)[0];
    return `Tool addiction: ${addictiveTool?.name ?? "unknown"} used in >50% of calls. Consider varying approach.`;
  }
  if (!abReady) {
    return "A/B experiment not configured. Run /analytics:setVariant to enable measurement.";
  }
  return null;
}

// State management: the metrics interval is process-scoped (it starts in the
// extension factory, before any session ctx exists), so the handle lives in
// the module default and the shutdown path clears it from the same place.
const METRICS_SAVE_INTERVAL = 30000; // 30 seconds

const _default = { saveTimer: null as ReturnType<typeof setInterval> | null };

export function startMetricsPersistence(): void {
  if (_default.saveTimer) return;
  const timer = setInterval(() => {
    saveMetrics().catch((err: Error) => _log.error("Failed to save metrics:", err));
  }, METRICS_SAVE_INTERVAL);
  // Auxiliary periodic save: it must never be the handle that keeps an idle
  // process's event loop alive (print mode must be able to exit).
  if (typeof timer.unref === "function") timer.unref();
  _default.saveTimer = timer;
}

export function stopMetricsPersistence(): void {
  if (!_default.saveTimer) return;
  clearInterval(_default.saveTimer);
  _default.saveTimer = null;
}

import { createLogger } from "../../../lib/core/logger.js";
import { saveMetrics } from "../../../lib/detection/degradation-detector.js";
const _log = createLogger("evolve");

// Benchmark history
export const BENCHMARK_HISTORY: BenchmarkResult[] = [];
export const MAX_BENCHMARK_HISTORY = 20;
