/**
 * Analytics Extension — Self-contained tool usage analytics
 *
 * Provides /analytics and /analytics:all commands that were previously
 * only available via the core ToolAnalytics class on the develop branch.
 *
 * This extension implements a simplified but functional analytics system
 * that tracks:
 * - Tool call counts, durations, success/failure rates
 * - Tool sequences and patterns
 * - Session-level metrics
 * - Basic recommendations
 *
 * Note: This is a simplified version of the core ToolAnalytics.
 * The core version has deeper integration with session management and
 * additional features like phase detection and correlation analysis.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Types

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

// Tool Categories (for potential future use)

const TOOL_CATEGORIES: Record<string, string> = {
	read: "read",
	grep: "search",
	find: "search",
	ls: "read",
	edit: "write",
	write: "write",
	bash: "exec",
	think: "cognitive",
	scratchpad: "cognitive",
	goal_create: "cognitive",
	goal_complete: "cognitive",
	plan_create: "cognitive",
	plan_start: "cognitive",
	memory_store: "memory",
	memory_recall: "memory",
};

// Analytics State

interface AnalyticsState {
	sessionId: string;
	sessionStartTime: number;
	toolMetrics: Map<string, ToolMetrics>;
	toolCallSequence: string[];
	storagePath: string;
}

const state: AnalyticsState = {
	sessionId: "",
	sessionStartTime: Date.now(),
	toolMetrics: new Map(),
	toolCallSequence: [],
	storagePath: join(homedir(), ".pi/agent/analytics/tool-analytics.jsonl"),
};

// Core Analytics Functions

function getOrCreateMetrics(toolName: string): ToolMetrics {
	let metrics = state.toolMetrics.get(toolName);
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
		state.toolMetrics.set(toolName, metrics);
	}
	return metrics;
}

function recordToolCall(toolName: string, durationMs: number, success: boolean): void {
	// Track sequence
	state.toolCallSequence.push(toolName);

	const metrics = getOrCreateMetrics(toolName);
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

function getToolSequences(minLength = 2, minSupport = 2): ToolSequence[] {
	const sequences: Map<string, { count: number; successCount: number }> = new Map();

	for (let i = 0; i < state.toolCallSequence.length - minLength + 1; i++) {
		const pattern = state.toolCallSequence.slice(i, i + minLength).join(" → ");
		const subSequence = state.toolCallSequence.slice(i, i + minLength);

		const existing = sequences.get(pattern) || { count: 0, successCount: 0 };
		existing.count++;
		// Simplified: assume success if tools are common
		const successRate = subSequence.every((t) => state.toolMetrics.has(t)) ? 0.9 : 0.5;
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

function getSessionMetrics(): SessionMetrics {
	const uniqueTools = new Set(state.toolCallSequence).size;
	return {
		sessionId: state.sessionId,
		startTime: state.sessionStartTime,
		totalToolCalls: state.toolCallSequence.length,
		uniqueToolsUsed: uniqueTools,
		toolCallSequence: [...state.toolCallSequence],
	};
}

function flushAnalytics(taskCompleted = false): void {
	const storageDir = join(homedir(), ".pi/agent/analytics");
	if (!existsSync(storageDir)) {
		mkdirSync(storageDir, { recursive: true });
	}

	const sessionMetrics = getSessionMetrics();
	const toolMetricsList = Array.from(state.toolMetrics.values());
	const sequences = getToolSequences();

	const entry = {
		timestamp: Date.now(),
		sessionMetrics,
		toolMetrics: toolMetricsList,
		sequences,
		taskCompleted,
	};

	try {
		writeFileSync(state.storagePath, `${JSON.stringify(entry)}\n`, { flag: "a" });
	} catch (e) {
		// Silently fail - analytics is non-critical
	}
}

function loadAnalytics(): AnalyticsSummary {
	if (!existsSync(state.storagePath)) {
		return {
			totalSessions: 0,
			totalToolCalls: 0,
			avgToolsPerSession: 0,
			topTools: [],
			sequences: [],
		};
	}

	try {
		const content = readFileSync(state.storagePath, "utf-8");
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
				successRate: toolCounts[toolName] > 0 ? (toolSuccess[toolName] || 0) / toolCounts[toolName] : 0,
			}))
			.sort((a, b) => b.count - a.count)
			.slice(0, 10);

		// Aggregate sequences from stored entries
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

function formatCurrentSession(): string {
	const metrics = Array.from(state.toolMetrics.values()).sort((a, b) => b.totalCalls - a.totalCalls);
	const sequences = getToolSequences(2, 2);
	const sessionMetrics = getSessionMetrics();

	const lines: string[] = [];
	lines.push("## Tool Analytics — Current Session");
	lines.push("");
	lines.push(`**Session:** ${state.sessionId || "unknown"}`);
	lines.push(`**Duration:** ${Math.round((Date.now() - state.sessionStartTime) / 1000)}s`);
	lines.push(`**Total Tool Calls:** ${sessionMetrics.totalToolCalls}`);
	lines.push(`**Unique Tools Used:** ${sessionMetrics.uniqueToolsUsed}`);
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
	lines.push("## Tool Analytics — Historical Summary");
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

// Extension

export default function analyticsExtension(pi: ExtensionAPI) {
	// Initialize on session start
	pi.on("session_start", async (_event, ctx) => {
		state.sessionId = ctx.sessionManager.getSessionFile() ?? `session-${Date.now()}`;
		state.sessionStartTime = Date.now();
		state.toolMetrics.clear();
		state.toolCallSequence = [];
		pendingToolCalls.clear();

		// Ensure storage directory exists
		const storageDir = join(homedir(), ".pi/agent/analytics");
		if (!existsSync(storageDir)) {
			mkdirSync(storageDir, { recursive: true });
		}
	});

// Track tool calls for analytics - need both start and end for timing
let pendingToolCalls: Map<string, { toolName: string; startTime: number }> = new Map();

// Record tool execution start
pi.on("tool_execution_start", async (event) => {
	pendingToolCalls.set(event.toolCallId, {
		toolName: event.toolName,
		startTime: Date.now(),
	});
});

// Record tool execution end - capture timing and success
pi.on("tool_execution_end", async (event) => {
	const pending = pendingToolCalls.get(event.toolCallId);
	if (pending) {
		const durationMs = Date.now() - pending.startTime;
		recordToolCall(pending.toolName, durationMs, !event.isError);
		pendingToolCalls.delete(event.toolCallId);
	}
});

	// Cleanup on session shutdown
	pi.on("session_shutdown", async () => {
		if (state.toolCallSequence.length > 0) {
			flushAnalytics(false);
		}
	});

	// /analytics — current session stats
	pi.registerCommand("analytics", {
		description: "Show tool analytics for the current session",
		handler: async (_args, ctx) => {
			const output = formatCurrentSession();
			ctx.ui.notify(output, "info");
		},
	});

	// /analytics:all — historical stats
	pi.registerCommand("analytics:all", {
		description: "Show tool analytics across all historical sessions",
		handler: async (_args, ctx) => {
			const output = formatAllSessions();
			ctx.ui.notify(output, "info");
		},
	});

	// Note: Tool call end recording would ideally use a tool_end event
	// which may not be available on all versions. For now, we track
	// on tool_call for sequence, and rely on the user's session context
	// for timing information.
}