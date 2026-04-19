/**
 * Agent Environment Extension - L1 Environmental Awareness
 *
 * Provides the agent with awareness of its runtime environment and session state.
 * This is the L1 (Internal) layer - context state surfaced to the agent via:
 *   1. `time_status` tool - explicit time queries
 *   2. L1 system prompt injection - automatic context awareness
 *
 * L1 data: session time, turn count, last event, tool call metrics, machine info.
 * These are surfaced in the system prompt so the agent is always context-aware
 * without having to explicitly call tools.
 */

import * as os from "node:os";
import * as process from "node:process";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// =============================================================================
// L1 State - shared with prompt-builder for system prompt injection
// =============================================================================

export interface AgentEnvironmentState {
	sessionStart: number;
	lastEventTime: number;
	turnCount: number;
	toolCallStarts: Map<string, number>;
	metrics: {
		totalToolCalls: number;
		totalToolTime: number;
		userMessageCount: number;
		assistantMessageCount: number;
	};
}

const _state: AgentEnvironmentState = {
	sessionStart: Date.now(),
	lastEventTime: Date.now(),
	turnCount: 0,
	toolCallStarts: new Map(),
	metrics: {
		totalToolCalls: 0,
		totalToolTime: 0,
		userMessageCount: 0,
		assistantMessageCount: 0,
	},
};

// =============================================================================
// L1 State gathering - consumed by prompt-builder
// =============================================================================

export interface L1EnvironmentData {
	pid: number;
	sessionElapsedMs: number;
	turnCount: number;
	sinceLastEventMs: number;
	avgToolTimeMs: number;
	machine: {
		platform: string;
		type: string;
		hostname: string;
	};
}

export function gatherL1Environment(_pi: ExtensionAPI, _ctx: ExtensionContext | undefined): L1EnvironmentData {
	const now = Date.now();
	const sessionElapsed = now - _state.sessionStart;
	const sinceLastEvent = now - _state.lastEventTime;
	const avgToolTime =
		_state.metrics.totalToolCalls > 0
			? Math.round(_state.metrics.totalToolTime / _state.metrics.totalToolCalls)
			: 0;

	// OS detection - normalize platform names for clarity
	const rawPlatform = os.platform();
	const platformDisplay = rawPlatform === "win32" ? "Windows" : rawPlatform === "darwin" ? "macOS" : rawPlatform === "linux" ? "Linux" : rawPlatform;

	return {
		pid: process.pid,
		sessionElapsedMs: sessionElapsed,
		turnCount: _state.turnCount,
		sinceLastEventMs: sinceLastEvent,
		avgToolTimeMs: avgToolTime,
		machine: {
			platform: platformDisplay,
			type: os.type(),
			hostname: os.hostname(),
		},
	};
}

export function formatL1EnvironmentSection(data: L1EnvironmentData): string {
	const minutes = Math.floor(data.sessionElapsedMs / 60000);
	const seconds = Math.floor((data.sessionElapsedMs % 60000) / 1000);
	const sinceLast = Math.round(data.sinceLastEventMs / 1000);

	const lines: string[] = [];
	lines.push("");

	// Machine info
	lines.push("## System State");
	lines.push(`- PID: ${data.pid} (${data.machine.platform})`);
	lines.push(`- Machine: ${data.machine.platform} (${data.machine.hostname})`);
	lines.push(`- Session: ${minutes}m ${seconds}s`);
	lines.push(`- Last event: ${sinceLast}s ago`);
	lines.push(`- Turns: ${data.turnCount}`);
	if (data.avgToolTimeMs > 0) {
		lines.push(`- Tool avg: ${data.avgToolTimeMs}ms`);
	}

	return lines.join("\n");
}

// =============================================================================
// time_status tool
// =============================================================================

const timeStatusSchema = Type.Object({
	action: StringEnum(
		["status", "mark", "elapsed_since"],
		{ description: "Action: 'status' = full time report, 'mark' = mark current time as last event, 'elapsed_since' = time since last mark" },
	),
	label: Type.Optional(Type.String({ description: "Optional label for the time mark (e.g., 'started debugging', 'fixed first bug')" })),
});

function createTimeStatusTool() {
	return {
		name: "time_status",
		label: "Time Status",
		description:
			"Get current time status: elapsed time, time since last event, session duration. Use to track progress and estimate remaining time.",
		parameters: timeStatusSchema,
		execute: async (_toolCallId: string, params: { action: string; label?: string }): Promise<any> => {
			const now = Date.now();
			const sessionElapsed = now - _state.sessionStart;
			const sinceLastEvent = now - _state.lastEventTime;

			// OS detection for status output
			const rawPlatform = os.platform();
			const platformDisplay = rawPlatform === "win32" ? "Windows" : rawPlatform === "darwin" ? "macOS" : rawPlatform === "linux" ? "Linux" : rawPlatform;

			switch (params.action) {
				case "status": {
					const minutes = Math.floor(sessionElapsed / 60000);
					const seconds = Math.floor((sessionElapsed % 60000) / 1000);
					const avgToolTime =
						_state.metrics.totalToolCalls > 0
							? Math.round(_state.metrics.totalToolTime / _state.metrics.totalToolCalls)
							: 0;

					const text = `${platformDisplay} | Session: ${minutes}m ${seconds}s | Last event: ${Math.round(sinceLastEvent / 1000)}s ago | Tools: ${_state.metrics.totalToolCalls} calls (avg ${avgToolTime}ms) | Turns: ${_state.turnCount}`;

					return {
						content: [{ type: "text" as const, text }],
						details: {
							machine: {
								platform: platformDisplay,
								hostname: os.hostname(),
								arch: os.arch(),
							},
							session_elapsed_ms: sessionElapsed,
							session_elapsed_human: `${minutes}m ${seconds}s`,
							time_since_last_event_ms: sinceLastEvent,
							time_since_last_event_human: `${Math.round(sinceLastEvent / 1000)}s`,
							turn_count: _state.turnCount,
							metrics: {
								total_tool_calls: _state.metrics.totalToolCalls,
								avg_tool_time_ms: avgToolTime,
								user_messages: _state.metrics.userMessageCount,
								assistant_messages: _state.metrics.assistantMessageCount,
							},
						},
					};
				}

				case "mark": {
					const previousMark = _state.lastEventTime;
					_state.lastEventTime = now;
					const delta = now - previousMark;
					const text = `Marked '${params.label || "unlabeled"}' at ${new Date(now).toISOString()} (${Math.round(delta / 1000)}s since previous)`;

					return {
						content: [{ type: "text" as const, text }],
						details: {
							marked_at: new Date(now).toISOString(),
							label: params.label || "unlabeled",
							time_since_previous_mark_ms: delta,
							time_since_previous_mark_human: `${Math.round(delta / 1000)}s`,
						},
					};
				}

				case "elapsed_since": {
					return {
						content: [{ type: "text" as const, text: `${Math.round(sinceLastEvent / 1000)}s since last event` }],
						details: {
							elapsed_ms: sinceLastEvent,
							elapsed_human: `${Math.round(sinceLastEvent / 1000)}s`,
						},
					};
				}

				default:
					return {
						content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
						details: { error: `Unknown action: ${params.action}` },
					};
			}
		},
	};
}

// =============================================================================
// Extension registration
// =============================================================================

export default function agentEnvironmentExtension(pi: ExtensionAPI) {
	// Track turns
	pi.on("session_start", () => {
		_state.sessionStart = Date.now();
		_state.lastEventTime = Date.now();
		_state.turnCount = 0;
		_state.metrics.totalToolCalls = 0;
		_state.metrics.totalToolTime = 0;
		_state.metrics.userMessageCount = 0;
		_state.metrics.assistantMessageCount = 0;
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") {
			_state.turnCount++;
		}
		if (event.message.role === "user") {
			_state.lastEventTime = Date.now();
		}
	});

	// Register time_status tool
	const tool = createTimeStatusTool();
	pi.registerTool({
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		execute: tool.execute,
	});
}
