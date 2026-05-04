/**
 * Analytics — shared types, state, and exported helpers.
 */

import { getExtensionState } from "../../../lib/extension-state.js";
import { eventBus } from "../../../lib/event-bus.js";
import { createLogger } from "../../../lib/logger.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

const log = createLogger("analytics:shared");

// ── Types ──────────────────────────────────────────────────────────────────

export interface ToolMetrics {
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

export interface ToolSequence {
  pattern: string;
  count: number;
  successRate: number;
}

export interface SessionMetrics {
  sessionId: string;
  startTime: number;
  totalToolCalls: number;
  uniqueToolsUsed: number;
  toolCallSequence: string[];
}

export interface AnalyticsSummary {
  totalSessions: number;
  totalToolCalls: number;
  avgToolsPerSession: number;
  topTools: { toolName: string; count: number; successRate: number }[];
  sequences: ToolSequence[];
}

// ── Session-scoped State ───────────────────────────────────────────────────

export interface AnalyticsState {
  sessionId: string;
  sessionStartTime: number;
  toolMetrics: Map<string, ToolMetrics>;
  toolCallSequence: string[];
  storagePath: string;
  abVariant: string;
  contextDensity: number;
  lastDensityTurn: number;
  wasDegraded: boolean;
  nudgesSent: number;
  nudgesSuppressed: number;
}

export function createAnalyticsState(): AnalyticsState {
  return {
    sessionId: "",
    sessionStartTime: Date.now(),
    toolMetrics: new Map(),
    toolCallSequence: [],
    storagePath: "",
    abVariant: "control",
    contextDensity: 0,
    lastDensityTurn: 0,
    wasDegraded: false,
    nudgesSent: 0,
    nudgesSuppressed: 0,
  };
}

let _lastState: AnalyticsState | null = null;

export function getAnalyticsStateInternal(ctx: ExtensionContext): AnalyticsState {
  const s = getExtensionState(ctx, "analytics", createAnalyticsState);
  _lastState = s;
  return s;
}

// ── Exported helpers (for evolve/enforcement extensions) ───────────────────

export function updateContextDensity(ctx: ExtensionContext, density: number) {
  const state = getAnalyticsStateInternal(ctx);
  state.contextDensity = Math.round(density * 1000) / 10;
  state.lastDensityTurn = (ctx as any).turnCount ?? 0;
  log.debug(`analytics: context_density=${state.contextDensity.toFixed(1)}%`);

  if (state.contextDensity > 70) {
    try {
      eventBus.emit({
        type: "context_full",
        usagePercent: state.contextDensity,
        tokensUsed: 0,
        tokensLimit: 0,
      });
    } catch {}
  }
}

export function recordNudgeSent(ctx: ExtensionContext) {
  getAnalyticsStateInternal(ctx).nudgesSent++;
}

export function recordNudgeSuppressed(ctx: ExtensionContext) {
  getAnalyticsStateInternal(ctx).nudgesSuppressed++;
}

export function getAnalyticsState(ctx?: ExtensionContext) {
  if (ctx) return getAnalyticsStateInternal(ctx);
  if (_lastState) return _lastState;
  return createAnalyticsState();
}

export function getAnalyticsSummary(): any {
  return { sessions: {} }; // backwards compat
}
