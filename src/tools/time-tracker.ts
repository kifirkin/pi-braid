/**
 * Time Tracking Tool
 *
 * Provides time awareness for the agent:
 * - Track elapsed time since session start
 * - Track time between events
 * - Track tool call durations
 * - Track timeout utilization
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

export interface TimeTrackerState {
	sessionStart: number;
	lastEventTime: number;
	toolCallStarts: Map<string, number>;
	metrics: {
		totalToolCalls: number;
		totalToolTime: number;
		userMessageCount: number;
		assistantMessageCount: number;
	};
}

const timeStatusSchema = Type.Object({
	action: Type.Union([Type.Literal("status"), Type.Literal("mark"), Type.Literal("elapsed_since")], {
		description:
			"Action: 'status' = full time report, 'mark' = mark current time as last event, 'elapsed_since' = time since last mark",
	}),
	label: Type.Optional(
		Type.String({ description: "Optional label for the time mark (e.g., 'started debugging', 'fixed first bug')" }),
	),
});

export function createTimeTracker(): { tool: AgentTool<typeof timeStatusSchema>; state: TimeTrackerState } {
	const state: TimeTrackerState = {
		sessionStart: Date.now(),
		lastEventTime: Date.now(),
		toolCallStarts: new Map(),
		metrics: {
			totalToolCalls: 0,
			totalToolTime: 0,
			userMessageCount: 0,
			assistantMessageCount: 0,
		},
	};

	const tool: AgentTool<typeof timeStatusSchema> = {
		name: "time_status",
		label: "Time Status",
		description:
			"Get current time status: elapsed time, time since last event, session duration. Use to track progress and estimate remaining time.",
		parameters: timeStatusSchema,
		execute: async (_toolCallId: string, params: { action: string; label?: string }) => {
			const now = Date.now();
			const sessionElapsed = now - state.sessionStart;
			const sinceLastEvent = now - state.lastEventTime;

			switch (params.action) {
				case "status": {
					const minutes = Math.floor(sessionElapsed / 60000);
					const seconds = Math.floor((sessionElapsed % 60000) / 1000);
					const avgToolTime =
						state.metrics.totalToolCalls > 0
							? Math.round(state.metrics.totalToolTime / state.metrics.totalToolCalls)
							: 0;

					const text = `Session: ${minutes}m ${seconds}s | Last event: ${Math.round(sinceLastEvent / 1000)}s ago | Tools: ${state.metrics.totalToolCalls} calls (avg ${avgToolTime}ms)`;

					return {
						content: [{ type: "text" as const, text }],
						details: {
							session_elapsed_ms: sessionElapsed,
							session_elapsed_human: `${minutes}m ${seconds}s`,
							time_since_last_event_ms: sinceLastEvent,
							time_since_last_event_human: `${Math.round(sinceLastEvent / 1000)}s`,
							metrics: {
								total_tool_calls: state.metrics.totalToolCalls,
								avg_tool_time_ms: avgToolTime,
								user_messages: state.metrics.userMessageCount,
								assistant_messages: state.metrics.assistantMessageCount,
							},
						},
					};
				}

				case "mark": {
					const previousMark = state.lastEventTime;
					state.lastEventTime = now;
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

	return { tool, state };
}

/**
 * Record a tool call start/end for timing.
 */
export function recordToolStart(state: TimeTrackerState, toolCallId: string): void {
	state.toolCallStarts.set(toolCallId, Date.now());
	state.metrics.totalToolCalls++;
}

export function recordToolEnd(state: TimeTrackerState, toolCallId: string): void {
	const start = state.toolCallStarts.get(toolCallId);
	if (start) {
		state.metrics.totalToolTime += Date.now() - start;
		state.toolCallStarts.delete(toolCallId);
	}
}

/**
 * Record user/assistant message for timing.
 */
export function recordUserMessage(state: TimeTrackerState): void {
	state.metrics.userMessageCount++;
	state.lastEventTime = Date.now();
}

export function recordAssistantMessage(state: TimeTrackerState): void {
	state.metrics.assistantMessageCount++;
	state.lastEventTime = Date.now();
}
