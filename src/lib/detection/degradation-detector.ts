/**
 * Degradation Detector - Track performance metrics and detect degradation
 *
 * Session-scoped via ExtensionContext (in-memory). Global fallback for legacy callers.
 * File persistence is process-global (separate concern).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "../state/extension-state.js";
import { saveStateImmediate } from "../state/async-storage.js";
import { createLogger } from "../core/logger.js";

import { DEGRADATION_FILE } from "../config/braid-paths.js";

const _log = createLogger("degradation-detector");

export interface PerformanceMetrics {
  timestamp: number;
  turnNumber: number;
  healthcheckScore: number;
  errorRate: number;
  avgTurnDurationMs: number;
  toolSuccessRate: number;
  memoryUsagePercent: number;
  consecutiveErrors: number;
  toolCalls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  tokenUsage: { input: number; output: number };
}

export interface DegradationConfig {
  healthcheckMinScore: number;
  errorRateMax: number;
  toolSuccessMin: number;
  checkIntervalMs: number;
  maxConsecutiveErrors: number;
}

export interface DegradationState {
  metrics: PerformanceMetrics[];
  config: DegradationConfig;
  isDegraded: boolean;
  lastHealthcheck: { score: number; timestamp: number } | null;
}

const DEFAULT_CONFIG: DegradationConfig = {
  healthcheckMinScore: 80,
  errorRateMax: 0.1,
  toolSuccessMin: 70,
  checkIntervalMs: 60000,
  maxConsecutiveErrors: 3,
};

const METRICS_FILE = DEGRADATION_FILE;

// Global fallback (legacy — for tool handlers without ctx)
let _global: DegradationState = {
  metrics: [],
  config: { ...DEFAULT_CONFIG },
  isDegraded: false,
  lastHealthcheck: null,
};

function getStateFrom(ctx?: ExtensionContext): DegradationState {
  if (ctx) return getExtensionState(ctx, "degradation-detector", () => ({ ..._global }));
  // Global fallback: no ExtensionContext available, state is shared across sessions
  return _global;
}

/** Runtime type guard: is this an ExtensionContext? */
function isCtx(val: unknown): val is ExtensionContext {
  return typeof val === "object" && val !== null && "settingsManager" in val;
}

function updateDegradationStatusFrom(state: DegradationState): void {
  const recent = state.metrics.slice(-5);
  if (recent.length === 0) {
    state.isDegraded = false;
    return;
  }
  const hasConsecutiveErrors = recent.some(
    (m) => m.consecutiveErrors >= state.config.maxConsecutiveErrors,
  );
  if (hasConsecutiveErrors) {
    state.isDegraded = true;
    return;
  }
  const avgErrorRate = recent.reduce((s, m) => s + m.errorRate, 0) / recent.length;
  if (avgErrorRate > state.config.errorRateMax) {
    state.isDegraded = true;
    return;
  }
  const avgToolSuccess = recent.reduce((s, m) => s + m.toolSuccessRate, 0) / recent.length;
  if (avgToolSuccess < state.config.toolSuccessMin) {
    state.isDegraded = true;
    return;
  }
  if (state.lastHealthcheck && state.lastHealthcheck.score < state.config.healthcheckMinScore) {
    state.isDegraded = true;
    return;
  }
  state.isDegraded = false;
}

// ── Public API (ctx-aware) ───────────────────────────────────────────────────────

export function getConfig(ctx?: ExtensionContext): DegradationConfig {
  return { ...getStateFrom(ctx).config };
}

// Overload: legacy call (no ctx) or ctx-scoped call
export function updateConfig(partial: Partial<DegradationConfig>): void;
export function updateConfig(ctx: ExtensionContext, partial: Partial<DegradationConfig>): void;
export function updateConfig(
  ctxOrPartial: ExtensionContext | Partial<DegradationConfig>,
  partial?: Partial<DegradationConfig>,
): void {
  const ctx =
    typeof ctxOrPartial === "object" && !("healthcheckMinScore" in ctxOrPartial)
      ? (ctxOrPartial as ExtensionContext)
      : undefined;
  const config = ctx ? partial! : (ctxOrPartial as Partial<DegradationConfig>);
  getStateFrom(ctx).config = { ...getStateFrom(ctx).config, ...config };
}

export function resetConfig(ctx?: ExtensionContext): void {
  getStateFrom(ctx).config = { ...DEFAULT_CONFIG };
}

// Overload: legacy call (no ctx) or ctx-scoped call
export function recordHealthcheckScore(score: number): void;
export function recordHealthcheckScore(ctx: ExtensionContext, score: number): void;
export function recordHealthcheckScore(
  ctxOrScore: ExtensionContext | number,
  score?: number,
): void {
  const ctx = typeof ctxOrScore === "number" ? undefined : ctxOrScore;
  const actualScore = typeof ctxOrScore === "number" ? ctxOrScore : score!;
  const s = getStateFrom(ctx);
  s.lastHealthcheck = { score: actualScore, timestamp: Date.now() };
  s.isDegraded = actualScore < s.config.healthcheckMinScore;
}

export function recordTurnMetrics(
  metrics: Omit<PerformanceMetrics, "timestamp" | "healthcheckScore">,
): void;
export function recordTurnMetrics(
  ctx: ExtensionContext,
  metrics: Omit<PerformanceMetrics, "timestamp" | "healthcheckScore">,
): void;
export function recordTurnMetrics(
  ctxOrMetrics: ExtensionContext | Omit<PerformanceMetrics, "timestamp" | "healthcheckScore">,
  metrics?: Omit<PerformanceMetrics, "timestamp" | "healthcheckScore">,
): void {
  const ctx = isCtx(ctxOrMetrics) ? ctxOrMetrics : undefined;
  const actualMetrics = isCtx(ctxOrMetrics)
    ? metrics!
    : (ctxOrMetrics as Omit<PerformanceMetrics, "timestamp" | "healthcheckScore">);
  const s = getStateFrom(ctx);

  // Calculate derived fields if not provided
  const toolCalls = actualMetrics.toolCalls || 0;
  const errors = actualMetrics.errors || 0;
  const errorRate = actualMetrics.errorRate ?? (toolCalls > 0 ? errors / toolCalls : 0);
  const toolSuccessRate =
    actualMetrics.toolSuccessRate ??
    (toolCalls > 0 ? ((toolCalls - errors) / toolCalls) * 100 : 100);

  const entry: PerformanceMetrics = {
    ...actualMetrics,
    errorRate,
    toolSuccessRate,
    memoryUsagePercent:
      actualMetrics.memoryUsagePercent ?? captureSystemMetrics().memoryUsagePercent,
    consecutiveErrors: actualMetrics.consecutiveErrors ?? (errors > 0 ? errors : 0),
    timestamp: Date.now(),
    healthcheckScore: s.lastHealthcheck?.score ?? 100,
  };
  s.metrics.push(entry);
  if (s.metrics.length > 100) s.metrics = s.metrics.slice(-100);
  updateDegradationStatusFrom(s);
}

export function recordError(ctx?: ExtensionContext): void {
  const s = getStateFrom(ctx);
  const last = s.metrics[s.metrics.length - 1];
  if (last) {
    last.consecutiveErrors++;
    last.errorRate = Math.min(1, last.errorRate + 0.1);
  }
}

export function recordToolSuccess(ctx?: ExtensionContext): void {
  const s = getStateFrom(ctx);
  const last = s.metrics[s.metrics.length - 1];
  if (last) {
    last.consecutiveErrors = 0;
  }
}

export function isDegraded(ctx?: ExtensionContext): boolean {
  return getStateFrom(ctx).isDegraded;
}

export function getDegradationReasons(ctx?: ExtensionContext): string[] {
  const reasons: string[] = [];
  const s = getStateFrom(ctx);
  const recent = s.metrics.slice(-5);

  // Check metrics-based conditions only if we have metrics
  if (recent.length > 0) {
    const maxConsecutive = Math.max(...recent.map((m) => m.consecutiveErrors));
    if (maxConsecutive >= s.config.maxConsecutiveErrors)
      reasons.push(`High consecutive errors (max: ${maxConsecutive})`);
    const avgErrorRate = recent.reduce((a, m) => a + m.errorRate, 0) / recent.length;
    if (avgErrorRate > s.config.errorRateMax)
      reasons.push(`High error rate: ${(avgErrorRate * 100).toFixed(1)}%`);
    const avgToolSuccess = recent.reduce((a, m) => a + m.toolSuccessRate, 0) / recent.length;
    if (avgToolSuccess < s.config.toolSuccessMin)
      reasons.push(`Low tool success: ${avgToolSuccess.toFixed(1)}%`);
  }

  // Always check healthcheck score (doesn't depend on having metrics)
  if (s.lastHealthcheck && s.lastHealthcheck.score < s.config.healthcheckMinScore)
    reasons.push(`Low healthcheck: ${s.lastHealthcheck.score}%`);

  return reasons;
}

export function getCurrentMetrics(ctx?: ExtensionContext): PerformanceMetrics | null {
  const s = getStateFrom(ctx);
  return s.metrics[s.metrics.length - 1] ?? null;
}

export function getRecentMetrics(count?: number): PerformanceMetrics[];
export function getRecentMetrics(ctx: ExtensionContext, count?: number): PerformanceMetrics[];
export function getRecentMetrics(
  ctxOrCount?: ExtensionContext | number,
  count?: number,
): PerformanceMetrics[] {
  const ctx = isCtx(ctxOrCount) ? ctxOrCount : undefined;
  const actualCount = typeof ctxOrCount === "number" ? ctxOrCount : count;
  return getStateFrom(ctx).metrics.slice(actualCount ? -actualCount : undefined);
}

export function getAllMetrics(ctx?: ExtensionContext): PerformanceMetrics[] {
  return [...getStateFrom(ctx).metrics];
}

export function getMetricsSummary(): {
  totalTurns: number;
  avgHealthcheck: number;
  avgErrorRate: number;
  avgToolSuccess: number;
  degraded: boolean;
  reasons: string[];
};
export function getMetricsSummary(ctx: ExtensionContext): {
  totalTurns: number;
  avgHealthcheck: number;
  avgErrorRate: number;
  avgToolSuccess: number;
  degraded: boolean;
  reasons: string[];
};
export function getMetricsSummary(ctx?: ExtensionContext) {
  const s = getStateFrom(ctx);
  const recent = s.metrics;
  if (recent.length === 0)
    return {
      totalTurns: 0,
      avgHealthcheck: 100,
      avgErrorRate: 0,
      avgToolSuccess: 100,
      degraded: false,
      reasons: [],
    };
  return {
    totalTurns: recent.length,
    avgHealthcheck: recent.reduce((a, m) => a + m.healthcheckScore, 0) / recent.length,
    avgErrorRate: recent.reduce((a, m) => a + m.errorRate, 0) / recent.length,
    avgToolSuccess: recent.reduce((a, m) => a + m.toolSuccessRate, 0) / recent.length,
    degraded: isDegraded(ctx),
    reasons: getDegradationReasons(ctx),
  };
}

export async function saveMetrics(): Promise<void> {
  try {
    const dir = path.dirname(METRICS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await saveStateImmediate(METRICS_FILE, _global);
  } catch (error) {
    _log.error("Failed to save degradation metrics:", error);
  }
}

export async function loadMetrics(): Promise<void> {
  try {
    if (fs.existsSync(METRICS_FILE)) {
      const data = fs.readFileSync(METRICS_FILE, "utf-8");
      const loaded = JSON.parse(data) as DegradationState;
      _global = { ..._global, ...loaded, config: { ...DEFAULT_CONFIG, ...loaded.config } };
    }
  } catch (error) {
    _log.error("Failed to load degradation metrics:", error);
  }
}

export function resetMetrics(ctx?: ExtensionContext): void {
  const s = getStateFrom(ctx);
  s.metrics = [];
  s.isDegraded = false;
  s.lastHealthcheck = null;
}

export function captureSystemMetrics(): Pick<PerformanceMetrics, "memoryUsagePercent"> {
  const freeMem = os.freemem();
  const totalMem = os.totalmem();
  return { memoryUsagePercent: ((totalMem - freeMem) / totalMem) * 100 };
}

export function createTurnMetrics(
  turnNumber: number,
  durationMs: number,
  inputTokens: number,
  outputTokens: number,
  toolCalls: number,
  errors: number,
): Omit<PerformanceMetrics, "timestamp" | "healthcheckScore"> {
  const system = captureSystemMetrics();
  return {
    turnNumber,
    avgTurnDurationMs: durationMs,
    inputTokens,
    outputTokens,
    toolCalls,
    errors,
    errorRate: toolCalls > 0 ? errors / toolCalls : 0,
    toolSuccessRate: toolCalls > 0 ? ((toolCalls - errors) / toolCalls) * 100 : 100,
    memoryUsagePercent: system.memoryUsagePercent,
    consecutiveErrors: errors > 0 ? errors : 0,
    tokenUsage: { input: inputTokens, output: outputTokens },
  };
}
