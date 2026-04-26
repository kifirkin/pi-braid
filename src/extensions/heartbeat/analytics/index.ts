import { createLogger } from "../../../lib/logger.js";

const log = createLogger("analytics");
/**
 * Analytics Extension - Self-contained tool usage analytics
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
 * - A/B experiment variant tracking (R9)
 *
 * Note: This is a simplified version of the core ToolAnalytics.
 * The core version has deeper integration with session management and
 * additional features like phase detection and correlation analysis.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";


import { Type } from "typebox";

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
	abVariant: string; // R9: A/B experiment variant tracking
}

const state: AnalyticsState = {
	sessionId: "",
	sessionStartTime: Date.now(),
	toolMetrics: new Map(),
	toolCallSequence: [],
	// R9: Export to ~/.pi/logs/braid-metrics.jsonl
	storagePath: join(homedir(), ".pi/logs/braid-metrics.jsonl"),
	abVariant: "control",
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
	// R9: Ensure logs directory exists for metrics export
	const logsDir = join(homedir(), ".pi/logs");
	if (!existsSync(logsDir)) {
		mkdirSync(logsDir, { recursive: true });
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
		// R9: Include A/B variant in exported data
		abVariant: state.abVariant,
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
	lines.push("## Tool Analytics - Current Session");
	lines.push("");
	lines.push(`**Session:** ${state.sessionId || "unknown"}`);
	lines.push(`**Duration:** ${Math.round((Date.now() - state.sessionStartTime) / 1000)}s`);
	lines.push(`**Total Tool Calls:** ${sessionMetrics.totalToolCalls}`);
	lines.push(`**Unique Tools Used:** ${sessionMetrics.uniqueToolsUsed}`);
	lines.push(`**A/B Variant:** ${state.abVariant}`);
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

// R9: Export analytics state for feedback loop (used by evolve extension)
export function getAnalyticsState() {
	return {
		toolMetrics: state.toolMetrics,
		toolCallSequence: state.toolCallSequence,
		abVariant: state.abVariant,
	};
}

// R9: Export histrical analytics summary for feedback loop
// Used by enforcement extension for data-driven tool suggestions
export function getAnalyticsSummary(): any {
	return loadAnalytics();
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

		// R9: Ensure logs directory exists for metrics export
		const logsDir = join(homedir(), ".pi/logs");
		if (!existsSync(logsDir)) {
			mkdirSync(logsDir, { recursive: true });
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

	// Auto-trigger addiction analysis every ~10 turns
	// Auto-trigger addiction analysis — rolling window, fires every 10+ calls
	let lastAddictionCheck = 0;
	pi.on("turn_end", async (_event: any, ctx: any) => {
		const calls = state.toolCallSequence.length;
		if (calls >= 10 && calls - lastAddictionCheck >= 10) {
			lastAddictionCheck = calls;
			// Analyze last 50 calls (rolling window)
			const window = state.toolCallSequence.slice(-50);
			const toolCounts = new Map<string, number>();
			for (const t of window) {
				toolCounts.set(t, (toolCounts.get(t) ?? 0) + 1);
			}
			const total = window.length;
			const warnings: string[] = [];
			for (const [tool, count] of toolCounts) {
				const ratio = count / total;
				// Flag if single tool >60% of window, or >3x fair share
				const fairShare = total / Math.max(toolCounts.size, 1);
				if (ratio > 0.6 || (toolCounts.size > 1 && count > fairShare * 3)) {
					warnings.push(`${tool} (${count}/${total}, ${(ratio * 100).toFixed(0)}%)`);
				}
			}
			if (warnings.length > 0) {
				pi.sendMessage({
					customType: "memory",
					display: true,
					content: [{ type: "text", text: `[analytics] Tool addiction pattern detected: ${warnings.join("; ")}` }],
				});
			}
		}
	});

	// Cleanup on session shutdown
	pi.on("session_shutdown", async () => {
		if (state.toolCallSequence.length > 0) {
			flushAnalytics(false);
		}
	});

	// /analytics - current session stats
	pi.registerCommand("analytics", {
		description: "Show tool analytics for the current session",
		handler: async (_args, ctx) => {
			const output = formatCurrentSession();
			ctx.ui.notify(output, "info");
		},
	});

	// /analytics:all - historical stats
	pi.registerCommand("analytics:all", {
		description: "Show tool analytics across all historical sessions",
		handler: async (_args, ctx) => {
			const output = formatAllSessions();
			ctx.ui.notify(output, "info");
		},
	});

	// R9: A/B experiment variant tracking
	pi.registerCommand("analytics:setVariant", {
		description: "Set A/B experiment variant for this session",
		handler: async (args, _ctx) => {
			const parsed = typeof args === "string" ? JSON.parse(args) : args;
			state.abVariant = parsed.variant;
		},
	});

	// TIER 1: Programmatic analytics tools — structured JSON instead of formatted text
	pi.registerTool({
		name: "get-session-metrics",
		label: "Get Session Metrics",
		description: "Get structured current session analytics: tool counts, timing, sequences, success rates.",
		parameters: Type.Object({}),
		execute: async (): Promise<any> => {
			const metrics = Array.from(state.toolMetrics.values()).sort((a, b) => b.totalCalls - a.totalCalls);
			const sessionMetrics = getSessionMetrics();
			const sequences = getToolSequences(2, 3).slice(0, 10);
			const duration = Math.round((Date.now() - state.sessionStartTime) / 1000);
			const text = `Session: ${state.sessionId || "unknown"}, ${sessionMetrics.totalToolCalls} tool calls, ${duration}s.`;
			return {
				content: [{ type: "text" as const, text }],
				details: {
					sessionId: state.sessionId || "unknown",
					durationSeconds: duration,
					totalToolCalls: sessionMetrics.totalToolCalls,
					uniqueToolsUsed: sessionMetrics.uniqueToolsUsed,
					abVariant: state.abVariant,
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
		execute: async (_id: string, params: any): Promise<any> => {
			const topN = params?.topN ?? 10;
			const summary = loadAnalytics();
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

	// BR2: Tool addiction measurement — detects tools that are overused
	// relative to task complexity, appearing in bursts or persistently
	// across sessions ("addictive" patterns like think-spam, read-binging)
	pi.registerTool({
		name: "get-tool-addiction",
		label: "Get Tool Addiction",
		description: "Detect tool addiction patterns: overuse relative to task complexity, burst repetition, cross-session persistence.",
		parameters: Type.Object({
			sessionOnly: Type.Optional(Type.Boolean({ description: "Only analyze current session (default: false)" })),
		}),
		execute: async (_id: string, params: any): Promise<any> => {
			const sessionOnly = params?.sessionOnly ?? false;
			const now = Date.now();
			const startTime = state.sessionStartTime ?? now;
			const sessionAge = (now - startTime) / 1000;

			// ── Compute session-level stats ──────────────────────────
			const sessionToolNames = state.toolCallSequence;
			const toolCounts = new Map<string, { count: number; clusters: number }>();
			for (let i = 0; i < sessionToolNames.length; i++) {
				const tool = sessionToolNames[i];
				const entry = toolCounts.get(tool) ?? { count: 0, clusters: 0 };
				entry.count++;
				// Detect clusters: same tool repeated consecutively
				if (i > 0 && sessionToolNames[i - 1] === tool) {
					entry.clusters++;
				}
				toolCounts.set(tool, entry);
			}

			// ── Load historical data ─────────────────────────────────
			const summary = sessionOnly ? null : loadAnalytics();
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

			// ── Compute addiction scores ─────────────────────────────
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
				// Frequency: how many std deviations above average
				const frequency = totalSessionCalls > 0 ? count / Math.max(avgCallsPerTool, 1) : 0;

				// Burst ratio: cluster-to-count ratio (0-1)
				const burstRatio = count > 1 ? clusters / (count - 1) : 0;

				// Persistence: tool appears across sessions (0-1)
				const histCount = histToolTotals.get(tool) ?? 0;
				const histSessions = histSessionCount.get(tool) ?? 0;
				const persistence =
					totalHistSessions > 0 && histCount > 0
						? Math.min(histSessions / Math.max(totalHistSessions, 1), 1)
						: 0;

				// Composite addiction score (0-1)
				// Weights: frequency 0.5, burst 0.3, persistence 0.2
				const freqScore = Math.min(frequency / 5, 1); // normalize: 5x avg = 1.0
				const addictionScore = Math.min(
					freqScore * 0.5 + burstRatio * 0.3 + persistence * 0.2,
					1,
				);

				// Generate note for high-addiction tools
				let note: string | undefined;
				const reasons: string[] = [];
				if (freqScore > 0.6) reasons.push(`high frequency (${count}x vs ${avgCallsPerTool.toFixed(1)}x avg)`);
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

			// Sort by addiction score descending
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

	// Note: Tool call end recording would ideally use a tool_end event
	// which may not be available on all versions. For now, we track
	// on tool_call for sequence, and rely on the user's session context
	// for timing information.
}
