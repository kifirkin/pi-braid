/**
 * Analytics - shared types, state, and exported helpers.
 */

import { getExtensionState } from "../../../lib/state/extension-state.js";
import { eventBus } from "../../../lib/events/event-bus.js";
import { createLogger } from "../../../lib/core/logger.js";
import { ANALYTICS_DENSITY_FULL_EVENT } from "../../../lib/detection/context-thresholds.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
  /** Per-turn deduplicated tool names: each turn contributes at most 1 entry per tool type.
   *  Used for addiction detection to avoid over-weighting multi-call turns. */
  turnToolSequence: string[];
  /** Session-scoped counter for addiction check throttling (prevents leak between sessions). */
  lastAddictionCheck: number;
  /** Set of last-emitted warning signatures to suppress duplicate identical reports. */
  lastAddictionSignatures: string[];
  /** Pending tool calls awaiting execution_end (toolCallId → {toolName, startTime}).
   *  Session-scoped to prevent cross-session contamination if session_start timing varies. */
  pendingToolCalls: Map<string, { toolName: string; startTime: number }>;
  /** Unique tool types used in the current turn (per-turn deduplication for addiction).
   *  Flushed to turnToolSequence on each turn_end, then cleared.
   *  Session-scoped to prevent cross-session contamination. */
  currentTurnTypes: Set<string>;
  storagePath: string;
  abVariant: string;
  contextDensity: number;
  lastDensityTurn: number;
  wasDegraded: boolean;
  nudgesSent: number;
  nudgesSuppressed: number;
  /** Local turn counter (incremented each turn_end) - ExtensionContext has no turnCount */
  localTurnCount: number;
}

export function createAnalyticsState(): AnalyticsState {
  return {
    sessionId: "",
    sessionStartTime: Date.now(),
    toolMetrics: new Map(),
    toolCallSequence: [],
    turnToolSequence: [],
    lastAddictionCheck: 0,
    lastAddictionSignatures: [],
    pendingToolCalls: new Map(),
    currentTurnTypes: new Set(),
    storagePath: "",
    abVariant: "control",
    contextDensity: 0,
    lastDensityTurn: 0,
    wasDegraded: false,
    nudgesSent: 0,
    nudgesSuppressed: 0,
    localTurnCount: 0,
  };
}

// Memoized reference to the most recent session's analytics state.
// Mirrors the getAnalyticsStateInternal return value. Used by the ctx-less
// getAnalyticsState() fallback. In pi-core's single-session-per-process
// model this is equivalent to per-session.
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
  state.lastDensityTurn = state.localTurnCount;
  log.debug(`analytics: context_density=${state.contextDensity.toFixed(1)}%`);

  if (state.contextDensity > ANALYTICS_DENSITY_FULL_EVENT) {
    try {
      eventBus.emit({
        type: "context_full",
        usagePercent: state.contextDensity,
        tokensUsed: 0,
        tokensLimit: 0,
      });
    } catch (err) {
      log.warn(`[analytics:shared] Event bus emit failed: ${err}`);
    }
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
