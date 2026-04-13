/**
 * Sub-Agent Tool
 *
 * Delegates complex tasks to isolated sub-agents with clean context windows.
 * Based on Anthropic's sub-agent architecture pattern.
 *
 * Use cases:
 * - Multi-file bug analysis (explore extensively, return summary)
 * - Code exploration across many files
 * - Research tasks requiring deep investigation
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

const subAgentSchema = Type.Object({
	task: Type.String({
		description: "Task for the sub-agent to perform",
	}),
	files: Type.Optional(
		Type.Array(Type.String(), {
			description: "Specific files to analyze (optional)",
		}),
	),
	maxSteps: Type.Optional(
		Type.Number({
			description: "Maximum steps for sub-agent (default: 10)",
		}),
	),
});

export type SubAgentInput = {
	task: string;
	files?: string[];
	maxSteps?: number;
};

const subAgentDescription = `Delegate a task to an isolated sub-agent.
Use this for:
- Multi-file bug analysis (explore extensively, return summary)
- Code exploration across many files
- Research tasks requiring deep investigation

The sub-agent works in isolation with a clean context window and returns a condensed summary.
This prevents your context from being polluted with exploration details.`;

/**
 * Create the sub-agent tool.
 *
 * Note: This is a lightweight implementation that structures the task
 * for the main agent to execute. A full implementation would spawn
 * a separate agent process.
 */
export function createSubAgentTool(): AgentTool<typeof subAgentSchema> {
	return {
		name: "sub_agent",
		label: "Sub-Agent",
		description: subAgentDescription,
		parameters: subAgentSchema,
		execute: async (_toolCallId: string, params: SubAgentInput) => {
			const { task, files, maxSteps = 10 } = params;

			// Structure the sub-agent task
			const fileList = files ? files.map((f) => `- ${f}`).join("\n") : "(explore to find relevant files)";
			const instructions = `You are a sub-agent with a focused task. Work in isolation and return a condensed summary.

## Task
${task}

## Files to analyze
${fileList}

## Constraints
- Maximum ${maxSteps} steps
- Return a concise summary (max 500 words)
- Include: what you found, key insights, recommended actions
- Do NOT make changes - only analyze and report

## Format your response as:
### Findings
(bullet points of what you discovered)

### Root Cause
(if applicable)

### Recommended Fix
(if applicable)`;

			return {
				content: [
					{
						type: "text" as const,
						text: instructions,
					},
				],
				details: { task, files, maxSteps },
			};
		},
	};
}
