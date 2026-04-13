/**
 * Think Tool
 *
 * Records structured thinking: observation, decision, reason.
 * The agent calls this to explain what it's doing and why.
 *
 * v2 additions (backward compatible):
 * - thought_id: unique identifier for referencing and threading
 * - parent_id: link to parent thought for conversation threads
 * - type: categorize thoughts (insight/question/assumption/conclusion/hypothesis)
 * - confidence: certainty level 0-1 (optional)
 * - tags: array of tags for organization
 */

import { randomUUID } from "node:crypto";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

const thinkSchema = Type.Object({
	observation: Type.String({
		description: "What you observed or discovered",
	}),
	decision: Type.String({
		description: "What you decided to do",
	}),
	reason: Type.String({
		description: "Why this decision",
	}),
	// v2 additions (all optional for backward compatibility)
	thought_id: Type.Optional(
		Type.String({
			description: "Unique identifier for this thought (auto-generated if not provided)",
		}),
	),
	parent_id: Type.Optional(
		Type.String({
			description: "ID of parent thought to create threaded reasoning chains",
		}),
	),
	type: Type.Optional(
		Type.Union(
			[
				Type.Literal("insight", { description: "Key learning or realization" }),
				Type.Literal("question", { description: "Something to investigate" }),
				Type.Literal("assumption", { description: "Assumed fact or constraint" }),
				Type.Literal("conclusion", { description: "Final determination" }),
				Type.Literal("hypothesis", { description: "Proposed explanation to test" }),
			],
			{
				description: "Categorize the thought type",
				default: "insight",
			},
		),
	),
	confidence: Type.Optional(
		Type.Number({
			minimum: 0,
			maximum: 1,
			description: "Confidence level 0-1 (optional)",
		}),
	),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization and search" })),
});

export type ThinkToolInput = {
	observation: string;
	decision: string;
	reason: string;
	// v2 fields
	thought_id?: string;
	parent_id?: string;
	type?: "insight" | "question" | "assumption" | "conclusion" | "hypothesis";
	confidence?: number;
	tags?: string[];
};

const thinkDescription = "Record structured thinking: observation, decision, reason.";

/**
 * The think tool instance (for allTools registry).
 */
export const thinkTool: AgentTool<typeof thinkSchema> = {
	name: "think",
	label: "Think",
	description: thinkDescription,
	parameters: thinkSchema,
	execute: async (_toolCallId: string, params: ThinkToolInput) => {
		const { observation, decision, reason } = params;
		// Generate thought_id if not provided
		const thoughtId = params.thought_id ?? randomUUID();

		const result: {
			thought_id: string;
			parent_id?: string;
			type?: string;
			confidence?: number;
			tags?: string[];
		} = {
			thought_id: thoughtId,
		};

		if (params.parent_id) result.parent_id = params.parent_id;
		if (params.type) result.type = params.type;
		if (params.confidence !== undefined) result.confidence = params.confidence;
		if (params.tags) result.tags = params.tags;

		return {
			content: [
				{
					type: "text" as const,
					text: `Thinking recorded (${params.type ?? "insight"}):\n- Observed: ${observation}\n- Decided: ${decision}\n- Reason: ${reason}\n- ID: ${thoughtId}${params.parent_id ? `\n- Parent: ${params.parent_id}` : ""}`,
				},
			],
			details: {
				observation,
				decision,
				reason,
				...result,
			} as const,
		};
	},
};

/**
 * Create the think tool.
 */
export function createThinkTool(): AgentTool<typeof thinkSchema> {
	return {
		name: "think",
		label: "Think",
		description: thinkDescription,
		parameters: thinkSchema,
		execute: async (_toolCallId: string, params: ThinkToolInput) => {
			const { observation, decision, reason } = params;
			// Generate thought_id if not provided
			const thoughtId = params.thought_id ?? randomUUID();

			const result: {
				thought_id: string;
				parent_id?: string;
				type?: string;
				confidence?: number;
				tags?: string[];
			} = {
				thought_id: thoughtId,
			};

			if (params.parent_id) result.parent_id = params.parent_id;
			if (params.type) result.type = params.type;
			if (params.confidence !== undefined) result.confidence = params.confidence;
			if (params.tags) result.tags = params.tags;

			return {
				content: [
					{
						type: "text" as const,
						text: `Thinking recorded (${params.type ?? "insight"}):\n- Observed: ${observation}\n- Decided: ${decision}\n- Reason: ${reason}\n- ID: ${thoughtId}${params.parent_id ? `\n- Parent: ${params.parent_id}` : ""}`,
					},
				],
				details: {
					observation,
					decision,
					reason,
					...result,
				} as const,
			};
		},
	};
}
