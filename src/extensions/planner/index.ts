import { createLogger } from "../../lib/logger.js";

const log = createLogger("planner");
/**
 * Planner Extension
 *
 * Unified planning system: tasks, goals, plans, execution control, and coordination tools.
 * Merges what was previously spread across cognitive-systems, standalone tools, and the old
 * enforcement-style plan tool.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { GoalManager } from "../../lib/goal-manager.js";
import { Planner } from "../../lib/planner.js";
import { getExtensionState } from "../../lib/extension-state.js";


// goals.ts and planning.ts - inlined here

import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { GoalStatus } from "../../lib/goal-manager.js";
import type { StepType } from "../../lib/planner.js";

// --- Goal Tool Factory (inlined from goals.ts) ---

const goalSchema = Type.Object({
	action: StringEnum(
		["create", "decompose", "complete", "fail", "block", "list", "current"],
		{ description: "Action to perform" },
	),
	description: Type.Optional(Type.String({ description: "What to accomplish (for create)" })),
	successCriteria: Type.Optional(Type.Array(Type.String(), { description: "How to verify completion (for create)" })),
	priority: Type.Optional(Type.Number({ description: "Priority 0-10, higher=more important (for create)" })),
	dependencies: Type.Optional(Type.Array(Type.String(), { description: "Goal IDs that must complete first (for create)" })),
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
	reason: Type.Optional(Type.String({ description: "Why it failed or was blocked" })),
	status: Type.Optional(
		StringEnum(
			["pending", "active", "blocked", "completed", "failed"],
			{ description: "Filter by status (for list)" },
		),
	),
});

function createGoalTool(options: { manager: GoalManager }): AgentTool<typeof goalSchema> {
	const { manager } = options;
	return {
		name: "goal",
		label: "Goal",
		description:
			"Manage goals with success criteria. Actions: create (with criteria), decompose (into subgoals), complete, fail, block, list (filterable), current (active with progress).",
		parameters: goalSchema,
		execute: async (_toolCallId, params: any) => {
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

// --- Plan Tool Factory (inlined from planning.ts) ---

const planSchema = Type.Object({
	action: StringEnum(
		["create", "step", "adapt", "complete", "list"],
		{ description: "Action to perform" },
	),
	description: Type.Optional(Type.String({ description: "What the plan accomplishes (for create)" })),
	steps: Type.Optional(
		Type.Array(
			Type.Object({
				description: Type.String(),
				type: Type.String({ description: "information, action, decision, or verification" }),
				expectedOutcome: Type.String(),
				dependencies: Type.Optional(Type.Array(Type.String())),
				tools: Type.Optional(Type.Array(Type.String())),
			}),
			{ description: "Plan steps (for create)" },
		),
	),
	estimatedCost: Type.Optional(Type.Number({ description: "Estimated token cost (for create)" })),
	outcome: Type.Optional(Type.String({ description: "What happened (for step complete)" })),
	reason: Type.Optional(Type.String({ description: "Why it failed (for step fail)" })),
	planId: Type.Optional(Type.String({ description: "Plan ID (for step/complete)" })),
	failedPlanId: Type.Optional(Type.String({ description: "Plan to adapt (for adapt)" })),
	newSteps: Type.Optional(
		Type.Array(
			Type.Object({
				description: Type.String(),
				type: Type.String(),
				expectedOutcome: Type.String(),
			}),
		),
	),
	reasoning: Type.Optional(Type.String({ description: "Why adaptation needed (for adapt)" })),
	lessons: Type.Optional(Type.String({ description: "Lessons learned (for complete)" })),
});

function createPlanTool(options: { planner: Planner }): AgentTool<typeof planSchema> {
	const { planner } = options;
	return {
		name: "plan",
		label: "Plan",
		description:
			"Structured plan-execute-review cycles. Actions: create (auto-starts), step (complete/fail), adapt (add steps after failure), complete (finalize), list (show all).",
		parameters: planSchema,
		execute: async (_toolCallId, params: any) => {
			const { action } = params;
			switch (action) {
				case "create": {
					if (!params.description || !params.steps) {
						return {
							content: [{ type: "text" as const, text: "description and steps required for create" }],
							details: { error: "missing_params" },
						};
					}
					const plan = planner.createPlan(
						params.description,
						params.steps.map((s: any) => ({
							description: s.description,
							type: s.type as StepType,
							expectedOutcome: s.expectedOutcome,
							dependencies: s.dependencies ?? [],
							tools: s.tools,
						})),
						{ estimatedCost: params.estimatedCost },
					);
					planner.startPlan(plan.id);
					return {
						content: [
							{
								type: "text" as const,
								text: `Created and started plan ${plan.id}: ${plan.description}\n${plan.steps.length} steps`,
							},
						],
						details: { id: plan.id, steps: plan.steps.length, started: true },
					};
				}
				case "step": {
					const planId = params.planId ?? planner.getActivePlan()?.id;
					if (!planId) {
						return {
							content: [{ type: "text" as const, text: "No active plan" }],
							details: { error: "no_active_plan" },
						};
					}
					if (params.reason) {
						const result = planner.failStep(params.reason, planId);
						if (!result) {
							return {
								content: [{ type: "text" as const, text: "No active step to fail" }],
								details: { error: "no_step" },
							};
						}
						return {
							content: [
								{ type: "text" as const, text: `Step failed: ${result.step.description}\nReason: ${params.reason}` },
								{ type: "text" as const, text: "Use plan(action='adapt', ...) to add replacement steps." },
							],
							details: { planId: result.plan.id, failedStep: result.step.id },
						};
					}
					const step = planner.completeStep(params.outcome ?? "", planId);
					if (!step) {
						const active = planner.getActivePlan();
						if (active?.status === "reviewing") {
							return {
								content: [{ type: "text" as const, text: "All steps complete. Use plan(action='complete') to finalize." }],
								details: { status: "reviewing" },
							};
						}
						return {
							content: [{ type: "text" as const, text: "No active step to complete" }],
							details: { error: "no_step" },
						};
					}
					return {
						content: [{ type: "text" as const, text: `Completed: ${step.description}` }],
						details: { stepId: step.id },
					};
				}
				case "adapt": {
					if (!params.newSteps || params.newSteps.length === 0) {
						return {
							content: [{ type: "text" as const, text: "newSteps required for adapt" }],
							details: { error: "missing_newSteps" },
						};
					}
					const planId = params.failedPlanId ?? planner.getActivePlan()?.id;
					if (!planId) {
						return {
							content: [{ type: "text" as const, text: "No plan to adapt" }],
							details: { error: "no_plan" },
						};
					}
					const newPlan = planner.adaptPlan(
						planId,
						params.newSteps.map((s: any) => ({
							description: s.description,
							type: s.type as StepType,
							expectedOutcome: s.expectedOutcome,
							dependencies: [],
						})),
						params.reasoning ?? "",
					);
					return {
						content: [
							{
								type: "text" as const,
								text: `Added ${params.newSteps.length} adaptation steps to plan ${newPlan.id}`,
							},
						],
						details: { newPlanId: newPlan.id },
					};
				}
				case "complete": {
					const planId = params.planId ?? planner.getActivePlan()?.id;
					const plan = planner.reviewPlan(params.lessons, planId);
					if (!plan) {
						return {
							content: [{ type: "text" as const, text: "No completed plan to finalize" }],
							details: { error: "no_plan" },
						};
					}
					return {
						content: [{ type: "text" as const, text: `Plan completed: ${plan.description}` }],
						details: { id: plan.id },
					};
				}
				case "list": {
					const plans = planner.list();
					const stats = planner.getStats();
					const lines = plans.map(
						(p) => `[${p.status}] ${p.id}: ${p.description} (step ${p.currentStepIndex + 1}/${p.steps.length})`,
					);
					return {
						content: [
							{ type: "text" as const, text: lines.join("\n") || "No plans." },
							{
								type: "text" as const,
								text: `\nStats: ${stats.executing} active, ${stats.completed} completed, ${stats.failed} failed`,
							},
						],
						details: stats,
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

// Session-scoped state factory
interface PlannerState {
	goalManager: GoalManager;
	planner: Planner;
}

function getPlannerState(ctx: ExtensionContext): PlannerState {
	return getExtensionState(ctx, "planner", () => ({
		goalManager: new GoalManager(),
		planner: new Planner(),
	}));
}

export default function plannerExtension(pi: ExtensionAPI) {
	// Goal tool (inlined from goals.ts)
	const goalTool = createGoalTool({ manager: {} as GoalManager }); // placeholder for schema
	pi.registerTool({
		name: goalTool.name,
		label: goalTool.label,
		description: goalTool.description,
		parameters: goalTool.parameters,
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
			const { goalManager } = getPlannerState(ctx);
			const tool = createGoalTool({ manager: goalManager });
			return tool.execute(toolCallId, params);
		},
	});

	// Plan tool (inlined from planning.ts)
	const planTool = createPlanTool({ planner: {} as Planner }); // placeholder for schema
	pi.registerTool({
		name: planTool.name,
		label: planTool.label,
		description: planTool.description,
		parameters: planTool.parameters,
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
			const { planner } = getPlannerState(ctx);
			const tool = createPlanTool({ planner });
			return tool.execute(toolCallId, params);
		},
	});

	// Retry command - abort and trigger new turn
	pi.registerCommand("retry", {
		description: "Retry the last agent turn (abort and retry)",
		handler: async (_args, ctx) => {
			ctx.abort();
			// Trigger a new turn after abort
			pi.sendMessage(
				{
					customType: "retry",
					content: [{ type: "text" as const, text: "" }],
					display: false,
				},
				{ triggerTurn: true },
			);
		},
	});
}
