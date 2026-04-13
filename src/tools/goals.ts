/**
 * Goal management tools for autonomous agent operation
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { GoalManager } from "../lib/goal-manager.js";

const goalCreateSchema = Type.Object({
	description: Type.String({ description: "What the agent should accomplish" }),
	successCriteria: Type.Array(Type.String(), { description: "How to verify completion" }),
	priority: Type.Optional(Type.Number({ default: 5, description: "Higher = more important (0-10)" })),
	dependencies: Type.Optional(Type.Array(Type.String(), { description: "Goal IDs that must complete first" })),
});

const goalDecomposeSchema = Type.Object({
	goalId: Type.String({ description: "Parent goal ID" }),
	subgoals: Type.Array(
		Type.Object({
			description: Type.String(),
			successCriteria: Type.Array(Type.String()),
			priority: Type.Optional(Type.Number()),
		}),
		{ description: "Subgoals to create" },
	),
});

const goalCompleteSchema = Type.Object({
	goalId: Type.String({ description: "Goal ID to mark complete" }),
});

const goalFailSchema = Type.Object({
	goalId: Type.String({ description: "Goal ID that failed" }),
	reason: Type.Optional(Type.String({ description: "Why it failed" })),
});

const goalBlockSchema = Type.Object({
	goalId: Type.String({ description: "Goal ID to block" }),
	reason: Type.String({ description: "Why it's blocked" }),
});

const goalListSchema = Type.Object({
	status: Type.Optional(Type.String({ description: "Filter: pending, active, blocked, completed, failed" })),
});

export interface GoalToolOptions {
	manager: GoalManager;
}

export function createGoalTools(options: GoalToolOptions): Record<string, AgentTool<any>> {
	const { manager } = options;

	const goalCreateTool: AgentTool<typeof goalCreateSchema> = {
		name: "goal_create",
		label: "Create Goal",
		description: "Create a new top-level goal with success criteria",
		parameters: goalCreateSchema,
		execute: async (_toolCallId, params) => {
			const goal = manager.addGoal(params.description, params.successCriteria, {
				priority: params.priority,
				dependencies: params.dependencies,
			});
			return {
				content: [{ type: "text" as const, text: `Created goal ${goal.id}: ${goal.description}` }],
				details: { id: goal.id },
			};
		},
	};

	const goalDecomposeTool: AgentTool<typeof goalDecomposeSchema> = {
		name: "goal_decompose",
		label: "Decompose Goal",
		description: "Break a goal into subgoals",
		parameters: goalDecomposeSchema,
		execute: async (_toolCallId, params) => {
			manager.decompose(params.goalId, params.subgoals);
			return {
				content: [
					{ type: "text" as const, text: `Decomposed ${params.goalId} into ${params.subgoals.length} subgoals` },
				],
				details: undefined,
			};
		},
	};

	const goalCompleteTool: AgentTool<typeof goalCompleteSchema> = {
		name: "goal_complete",
		label: "Complete Goal",
		description: "Mark a goal as completed. Parent goals auto-complete when all subgoals done.",
		parameters: goalCompleteSchema,
		execute: async (_toolCallId, params) => {
			const goal = manager.markCompleted(params.goalId);
			if (!goal) {
				throw new Error(`Goal ${params.goalId} not found`);
			}
			return {
				content: [{ type: "text" as const, text: `Completed ${params.goalId}` }],
				details: undefined,
			};
		},
	};

	const goalFailTool: AgentTool<typeof goalFailSchema> = {
		name: "goal_fail",
		label: "Fail Goal",
		description: "Mark a goal as failed",
		parameters: goalFailSchema,
		execute: async (_toolCallId, params) => {
			const goal = manager.markFailed(params.goalId, params.reason);
			if (!goal) {
				throw new Error(`Goal ${params.goalId} not found`);
			}
			return {
				content: [{ type: "text" as const, text: `Marked ${params.goalId} as failed: ${params.reason ?? ""}` }],
				details: undefined,
			};
		},
	};

	const goalBlockTool: AgentTool<typeof goalBlockSchema> = {
		name: "goal_block",
		label: "Block Goal",
		description: "Mark a goal as blocked with a reason",
		parameters: goalBlockSchema,
		execute: async (_toolCallId, params) => {
			const goal = manager.markBlocked(params.goalId, params.reason);
			if (!goal) {
				throw new Error(`Goal ${params.goalId} not found`);
			}
			return {
				content: [{ type: "text" as const, text: `Blocked ${params.goalId}: ${params.reason}` }],
				details: undefined,
			};
		},
	};

	const goalListTool: AgentTool<typeof goalListSchema> = {
		name: "goal_list",
		label: "List Goals",
		description: "List all goals and their status",
		parameters: goalListSchema,
		execute: async (_toolCallId, params) => {
			// Use status filter if provided
			const filteredGoals = params.status
				? manager.list(params.status as import("../lib/goal-manager.js").GoalStatus)
				: [];
			const tree = manager.formatGoalTree();
			const stats = manager.getStats();
			const lines: string[] = [tree];
			if (params.status) {
				lines.push(`\nFiltered (${params.status}): ${filteredGoals.length} goals`);
			}
			lines.push(`\nStats: ${stats.pending} pending, ${stats.active} active, ${stats.completed} completed`);
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { stats, filtered: filteredGoals.length },
			};
		},
	};

	return {
		goal_create: goalCreateTool,
		goal_decompose: goalDecomposeTool,
		goal_complete: goalCompleteTool,
		goal_fail: goalFailTool,
		goal_block: goalBlockTool,
		goal_list: goalListTool,
	};
}
