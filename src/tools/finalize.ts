/**
 * Finalize Tool - Agent-controlled loop termination
 *
 * Inspired by agent-zero's approach:
 * - Agent explicitly calls this tool to signal completion
 * - Provides final summary/response
 * - Stops the loop cleanly
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

export function createFinalizeTool(): AgentTool {
	return {
		name: "finalize",
		label: "Finalize",
		description:
			"Call this to stop the loop and provide your final response. Use when you've completed the task and want to deliver the result to the user.",
		parameters: Type.Object({
			summary: Type.String({
				description: "Your final response/summary to the user. This will be shown as the agent's final message.",
			}),
			success: Type.Optional(
				Type.Boolean({
					description: "Whether the task was completed successfully (default: true)",
				}),
			),
		}),
		execute: async (_toolCallId: string, params: unknown) => {
			const { summary, success = true } = params as { summary: string; success?: boolean };

			return {
				content: [
					{
						type: "text" as const,
						text: success
							? `✅ Task completed successfully.\n\n${summary}`
							: `⚠️ Task completed with issues.\n\n${summary}`,
					},
				],
				details: { complete: true, finalized: true, success, summary },
			};
		},
	};
}
