/**
 * Visual Dashboard Extension - Agent state visualization
 *
 * Provides:
 * - Real-time agent state display (turns, phase, confidence)
 * - ASCII metrics charts (tool usage, token budget)
 * - Terminal image rendering support (Kitty/iTerm2)
 * - Phase tracking (explore → plan → implement → verify)
 *
 * Hooks into pi events to track state in real-time.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createStateTracker, updatePhase, recordToolCall, formatPhase, type TrackedState } from "./state-tracker.js";
import {
	renderToolUsageBars,
	renderTokenBudget,
	renderProgress,
	renderMetricBar,
	renderSection,
} from "./chart-renderer.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentMetrics {
	turns: number;
	phase: "idle" | "exploring" | "planning" | "implementing" | "verifying";
	confidence: number;
	memoryPressure: number;
	errors: number;
	warnings: number;
	toolCalls: Map<string, number>;
	totalTokens: number;
	tokenBudget: number;
	contextPercent: number;
}

// ── State ────────────────────────────────────────────────────────────────────

let _state: TrackedState | null = null;
let _sessionManager: any = null;

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Render the full agent state dashboard
 */
function renderDashboard(): string {
	if (!_state) {
		return "Dashboard not initialized";
	}

	const elapsed = Date.now() - _state.sessionStartMs;
	const minutes = Math.floor(elapsed / 60000);
	const seconds = Math.floor((elapsed % 60000) / 1000);

	const lines: string[] = [];
	lines.push("");
	lines.push("┌─────────────────────────────────────────────────────────────────┐");
	lines.push("│  Agent State Dashboard                                           │");
	lines.push("├─────────────────────────────────────────────────────────────────┤");

	// Session info
	lines.push(`│  Session: ${minutes}m ${seconds}s | Turns: ${_state.turns} | Phase: ${formatPhase(_state.phase).padEnd(20)}│`);

	// Confidence
	const confBar = renderProgress(_state.confidence, 100, 20);
	lines.push(`│  Confidence: [${confBar}]                                    │`);

	// Memory pressure
	const memBar = renderProgress(_state.memoryPressure, 100, 20);
	lines.push(`│  Memory:      [${memBar}]                                    │`);

	// Errors/Warnings
	const status = _state.errors > 0 ? `🔴 ${_state.errors} error(s)` : _state.warnings > 0 ? `🟡 ${_state.warnings} warning(s)` : "✅ No issues";
	lines.push(`│  Status: ${status.padEnd(54)}│`);

	lines.push("├─────────────────────────────────────────────────────────────────┤");
	lines.push("│  Tool Usage (this session)                                      │");

	// Tool usage bars
	const toolBars = renderToolUsageBars(_state.toolCounts);
	const toolLines = toolBars.split("\n");
	for (const line of toolLines.slice(0, 6)) {
		lines.push(`${line.padEnd(65)}│`);
	}

	lines.push("├─────────────────────────────────────────────────────────────────┤");
	lines.push("│  Token Budget                                                   │");

	// Token budget
	const tokenBar = renderTokenBudget(_state.totalTokens, _state.tokenBudget || 100000, 40);
	lines.push(`│  ${tokenBar.padEnd(63)}│`);

	// Context usage
	const ctxBar = renderProgress(_state.contextPercent, 100, 20);
	lines.push(`│  Context:    [${ctxBar}] ${_state.contextPercent}%                              │`);

	lines.push("└─────────────────────────────────────────────────────────────────┘");

	return lines.join("\n");
}

/**
 * Render a compact status line
 */
function renderCompactStatus(): string {
	if (!_state) return "";

	const elapsed = Math.floor((Date.now() - _state.sessionStartMs) / 1000);
	const minutes = Math.floor(elapsed / 60);

	return `[${minutes}m | ${_state.turns} turns | ${formatPhase(_state.phase)}]`;
}

/**
 * Render token usage summary
 */
function renderMetrics(): string {
	if (!_state) return "No metrics available";

	const lines: string[] = [];
	lines.push("");
	lines.push("## Session Metrics");
	lines.push("");

	// Tool usage
	lines.push("### Tool Usage");
	lines.push(renderToolUsageBars(_state.toolCounts));
	lines.push("");

	// Token budget
	lines.push("### Token Budget");
	if (_state.tokenBudget > 0) {
		lines.push(renderTokenBudget(_state.totalTokens, _state.tokenBudget));
	} else {
		lines.push("No budget configured");
	}
	lines.push("");

	// Summary stats
	lines.push("### Summary");
	lines.push(`- Turns: ${_state.turns}`);
	lines.push(`- Errors: ${_state.errors}`);
	lines.push(`- Warnings: ${_state.warnings}`);
	lines.push(`- Unique tools: ${_state.toolCounts.size}`);

	return lines.join("\n");
}

// ── Event Handlers ───────────────────────────────────────────────────────────

function handleTurnStart(): void {
	if (!_state) return;
	_state.turns++;
	_state.turnStartMs = Date.now();
	updatePhase(_state);
}

function handleToolCall(toolName: string): void {
	if (!_state) return;
	recordToolCall(_state, toolName);
	updatePhase(_state);
}

function handleToolResult(toolName: string, success: boolean): void {
	if (!_state) return;
	if (!success) {
		_state.errors++;
	}
}

function handleMessage(tokenCount: number): void {
	if (!_state) return;
	_state.totalTokens += tokenCount;
}

function handleConfidenceUpdate(confidence: number): void {
	if (!_state) return;
	_state.confidence = confidence;
}

function handleMemoryUpdate(pressure: number): void {
	if (!_state) return;
	_state.memoryPressure = pressure;
}

function handleContextUpdate(percent: number): void {
	if (!_state) return;
	_state.contextPercent = percent;
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function visualDashboardExtension(pi: ExtensionAPI): void {
	_state = createStateTracker();

	// ── Session Events ──────────────────────────────────────────────────────

	pi.on("session_start", () => {
		_state = createStateTracker();
	});

	// ── Turn Events ────────────────────────────────────────────────────────

	pi.on("turn_start", () => {
		handleTurnStart();
	});

	// ── Tool Events ─────────────────────────────────────────────────────────

	pi.on("tool_call", (event: any) => {
		const toolName = event?.tool?.name || event?.name || "unknown";
		handleToolCall(toolName);
	});

	pi.on("tool_result", (event: any) => {
		const toolName = event?.toolName || event?.name || "unknown";
		const success = event?.error === undefined || event?.error === null;
		handleToolResult(toolName, success);
	});

	// ── Message Events ──────────────────────────────────────────────────────

	pi.on("message_end", (event: any) => {
		if (event?.message?.usage) {
			const tokens = event.message.usage.input_tokens + (event.message.usage.output_tokens || 0);
			handleMessage(tokens);
		}
	});

	// ── Status Widget ──────────────────────────────────────────────────────

	pi.on("turn_end", () => {
		// Status is available via /status command
		// Compact info: [${minutes}m | ${turns} turns | ${phase}]
	});

	// ── Commands ───────────────────────────────────────────────────────────

	pi.registerCommand("dashboard", {
		description: "Show visual dashboard",
		handler: async (_args: string, ctx: any) => {
			const output = renderDashboard();
			ctx.ui.notify(output, "info");
		},
	});

	pi.registerCommand("metrics", {
		description: "Show metrics summary",
		handler: async (_args: string, ctx: any) => {
			const output = renderMetrics();
			ctx.ui.notify(output, "info");
		},
	});

	pi.registerCommand("status", {
		description: "Show compact status",
		handler: async (_args: string, ctx: any) => {
			ctx.ui.notify(renderCompactStatus(), "info");
		},
	});
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get current agent metrics (for other extensions to read)
 */
export function getAgentMetrics(): AgentMetrics | null {
	if (!_state) return null;
	return {
		turns: _state.turns,
		phase: _state.phase,
		confidence: _state.confidence,
		memoryPressure: _state.memoryPressure,
		errors: _state.errors,
		warnings: _state.warnings,
		toolCalls: _state.toolCounts,
		totalTokens: _state.totalTokens,
		tokenBudget: _state.tokenBudget,
		contextPercent: _state.contextPercent,
	};
}

/**
 * Update confidence score (for metacognition integration)
 */
export function updateConfidence(confidence: number): void {
	handleConfidenceUpdate(confidence);
}

/**
 * Update memory pressure (for context-manager integration)
 */
export function updateMemoryPressure(pressure: number): void {
	handleMemoryUpdate(pressure);
}

/**
 * Update context percent (for context-manager integration)
 */
export function updateContextPercent(percent: number): void {
	handleContextUpdate(percent);
}

/**
 * Set token budget (for analytics integration)
 */
export function setTokenBudget(budget: number): void {
	if (_state) {
		_state.tokenBudget = budget;
	}
}
