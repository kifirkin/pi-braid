/**
 * Analytics - type definitions
 *
 * Extracted from index.ts for maintainability.
 */

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

export interface AnalyticsState {
  sessionId: string;
  sessionStartTime: number;
  toolMetrics: Map<string, ToolMetrics>;
  toolCallSequence: string[];
  /** Per-turn deduplicated tool names for addiction detection */
  turnToolSequence: string[];
  storagePath: string;
  abVariant: string;
  contextDensity: number;
  lastDensityTurn: number;
  wasDegraded: boolean;
  nudgesSent: number;
  nudgesSuppressed: number;
}
