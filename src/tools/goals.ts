/**
 * Goal Tool — Consolidated
 *
 * Single tool for all goal management. Use action parameter to specify operation.
 * Consolidates: goal_create, goal_decompose, goal_complete, goal_fail, goal_block, goal_list, goal_current
 *
 * Workflow:
 * 1. goal(action="create", description, successCriteria) → create goal
 * 2. goal(action="decompose", goalId, subgoals) → break into subgoals
 * 3. goal(action="complete", goalId) → mark done (auto-completes parent when all subgoals done)
 * 4. goal(action="fail", goalId, reason) → mark failed
 * 5. goal(action="block", goalId, reason) → block with reason
 * 6. goal(action="list", status?) → list all or filtered
 * 7. goal(action="current") → show active goal with progress
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { GoalManager, GoalStatus } from "../lib/goal-manager.js";

const goalSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("create", { description: "Create a new goal" }),
			Type.Literal("decompose", { description: "Break a goal into subgoals" }),
			Type.Literal("complete", { description: "Mark a goal as completed" }),
			Type.Literal("fail", { description: "Mark a goal as failed" }),
			Type.Literal("block", { description: "Mark a goal as blocked" }),
			Type.Literal("list", { description: "List all goals or filter by status" }),
			Type.Literal("current", { description: "Show active goal with progress" }),
		],
		{ description: "Action to perform" },
	),

	// create
	description: Type.Optional(
		Type.String({ description: "What to accomplish (for create)" }),
	),
	successCriteria: Type.Optional(
		Type.Array(Type.String(), { description: "How to verify completion (for create)" }),
	),
	priority: Type.Optional(
		Type.Number({ description: "Priority 0-10, higher=more important (for create)" }),
	),
	dependencies: Type.Optional(
		Type.Array(Type.String(), { description: "Goal IDs that must complete first (for create)" }),
	),

	// decompose
	goalId: Type.Optional(Type.String({ description: "Goal ID (for decompose/complete/fail/block)" })),
	subgoals: Type.Optional(
		Type.Array(
			Type.Object({
				description: Type.String(),
				successCriteria: Type.Array(Type.String()),
				priority: Type.Optional(Type.Number()),
			}),
			{ description: "Subgoals to create (for decompose)" },
		),
	),

	// fail/block
	reason: Type.Optional(Type.String({ description: "Why it failed or was blocked" })),

	// list
	status: Type.Optional(
		Type.Union(
			[
				Type.Literal("pending"),
				Type.Literal("active"),
				Type.Literal("blocked"),
				Type.Literal("completed"),
				Type.Literal("failed"),
			],
			{ description: "Filter by status (for list)" },
		),
	),
});

export type GoalToolInput = {
	action: "create" | "decompose" | "complete" | "fail" | "block" | "list" | "current";
	description?: string;
	successCriteria?: string[];
	priority?: number;
	dependencies?: string[];
	goalId?: string;
	subgoals?: Array<{ description: string; successCriteria: string[]; priority?: number }>;
	reason?: string;
	status?: GoalStatus;
};

export interface GoalToolOptions {
	manager: GoalManager;
}

export function createGoalTool(options: GoalToolOptions): AgentTool<typeof goalSchema> {
	const { manager } = options;

	return {
		name: "goal",
		label: "Goal",
		description:
			"Manage goals with success criteria. Actions: create (with criteria), decompose (into subgoals), complete, fail, block, list (filterable), current (active with progress).",
		parameters: goalSchema,
		execute: async (_toolCallId, params: GoalToolInput) => {
			const { action } = params;

			switch (action) {
				case "create": {
					if (!params.description) {
						return {
							content: [{ type: "text" as const, text: "description required for create" }],
							details: { error: "missing_description" },
						};
					}
					const goal = manager.addGoal(params.description, params.successCriteria ?? [], {
						priority: params.priority,
						dependencies: params.dependencies,
					});
					// Auto-activate the newly created goal
					manager.activateGoal(goal.id);
					return {
						content: [
							{
								type: "text" as const,
								text: `Created goal ${goal.id}: ${goal.description}${goal.successCriteria.length > 0 ? `\nSuccess criteria: ${goal.successCriteria.join(", ")}` : ""}`,
							},
						],
						details: { id: goal.id, activated: true },
					};
				}

				case "decompose": {
					if (!params.goalId || !params.subgoals) {
						return {
							content: [{ type: "text" as const, text: "goalId and subgoals required for decompose" }],
							details: { error: "missing_params" },
						};
					}
					manager.decompose(params.goalId, params.subgoals);
					return {
						content: [
							{
								type: "text" as const,
								text: `Decomposed ${params.goalId} into ${params.subgoals.length} subgoals`,
							},
						],
						details: { goalId: params.goalId, subgoalsCreated: params.subgoals.length },
					};
				}

				case "complete": {
					if (!params.goalId) {
						return {
							content: [{ type: "text" as const, text: "goalId required for complete" }],
							details: { error: "missing_goalId" },
						};
					}
					const goal = manager.markCompleted(params.goalId);
					if (!goal) {
						return {
							content: [{ type: "text" as const, text: `Goal ${params.goalId} not found` }],
							details: { error: "not_found" },
						};
					}
					return {
						content: [{ type: "text" as const, text: `Completed ${params.goalId}${goal.parentId ? " (parent auto-completed)" : ""}` }],
						details: { id: params.goalId, parentAutoCompleted: !!goal.parentId },
					};
				}

				case "fail": {
					if (!params.goalId) {
						return {
							content: [{ type: "text" as const, text: "goalId required for fail" }],
							details: { error: "missing_goalId" },
						};
					}
					const goal = manager.markFailed(params.goalId, params.reason);
					if (!goal) {
						return {
							content: [{ type: "text" as const, text: `Goal ${params.goalId} not found` }],
							details: { error: "not_found" },
						};
					}
					return {
						content: [{ type: "text" as const, text: `Failed ${params.goalId}${params.reason ? `: ${params.reason}` : ""}` }],
						details: { id: params.goalId },
					};
				}

				case "block": {
					if (!params.goalId || !params.reason) {
						return {
							content: [{ type: "text" as const, text: "goalId and reason required for block" }],
							details: { error: "missing_params" },
						};
					}
					const goal = manager.markBlocked(params.goalId, params.reason);
					if (!goal) {
						return {
							content: [{ type: "text" as const, text: `Goal ${params.goalId} not found` }],
							details: { error: "not_found" },
						};
					}
					return {
						content: [{ type: "text" as const, text: `Blocked ${params.goalId}: ${params.reason}` }],
						details: { id: params.goalId },
					};
				}

				case "list": {
					const stats = manager.getStats();
					let text = `Goals: ${stats.active} active, ${stats.pending} pending, ${stats.completed} completed, ${stats.failed} failed`;
					if (params.status) {
						const filtered = manager.list(params.status);
						text += `\n\nFiltered (${params.status}): ${filtered.length} goals`;
						for (const g of filtered.slice(0, 20)) {
							text += `\n[${g.status}] ${g.id}: ${g.description}`;
						}
					} else {
						text += "\n\n" + manager.formatGoalTree();
					}
					return {
						content: [{ type: "text" as const, text }],
						details: stats,
					};
				}

				case "current": {
					const stats = manager.getStats();
					if (stats.active === 0) {
						return {
							content: [{ type: "text" as const, text: "No active goals." }],
							details: { active: 0 },
						};
					}
					const activeGoals = manager.list("active");
					let text = `Active goals (${activeGoals.length}):\n`;
					for (const g of activeGoals) {
						text += `\n${g.id}: ${g.description}`;
						if (g.successCriteria.length > 0) {
							text += `\n  Criteria: ${g.successCriteria.join(", ")}`;
						}
						if (g.subgoals.length > 0) {
							text += `\n  Subgoals: ${g.subgoals.length}`;
						}
					}
					return {
						content: [{ type: "text" as const, text }],
						details: { activeGoals },
					};
				}

				default:
					return {
						content: [{ type: "text" as const, text: `Unknown action: ${action}` }],
						details: { error: "unknown_action" },
					};
			}
		},
	};
}

/**
 * @deprecated Use createGoalTool() instead. Kept for compatibility.
 */
export function createGoalTools(options: GoalToolOptions): Record<string, AgentTool<any>> {
	const tool = createGoalTool(options);
	return {
		goal: tool,
		goal_create: tool, // alias
	};
}
