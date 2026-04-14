/**
 * Plan Tool — Consolidated
 *
 * Single tool for structured plan-execute-review cycles.
 * Consolidates: plan_create, plan_start, plan_step_complete, plan_step_fail, plan_adapt, plan_complete, plan_list
 *
 * Actions:
 * - create: create plan with steps (auto-starts)
 * - step: advance current step (complete/fail with outcome/reason)
 * - adapt: add new steps after failure
 * - complete: finalize with lessons
 * - list: show all plans
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Planner, StepType } from "../lib/planner.js";

const planSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("create", { description: "Create a plan with steps (auto-starts)" }),
			Type.Literal("step", { description: "Advance current step (complete/fail)" }),
			Type.Literal("adapt", { description: "Add new steps after failure" }),
			Type.Literal("complete", { description: "Finalize plan with lessons" }),
			Type.Literal("list", { description: "List all plans" }),
		],
		{ description: "Action to perform" },
	),

	// create
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

	// step
	outcome: Type.Optional(Type.String({ description: "What happened (for step complete)" })),
	reason: Type.Optional(Type.String({ description: "Why it failed (for step fail)" })),
	planId: Type.Optional(Type.String({ description: "Plan ID (for step/complete)" })),

	// adapt
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

	// complete
	lessons: Type.Optional(Type.String({ description: "Lessons learned (for complete)" })),
});

export type PlanToolInput = {
	action: "create" | "step" | "adapt" | "complete" | "list";
	description?: string;
	steps?: Array<{
		description: string;
		type: string;
		expectedOutcome: string;
		dependencies?: string[];
		tools?: string[];
	}>;
	estimatedCost?: number;
	outcome?: string;
	reason?: string;
	planId?: string;
	failedPlanId?: string;
	newSteps?: Array<{ description: string; type: string; expectedOutcome: string }>;
	reasoning?: string;
	lessons?: string;
};

export interface PlanningToolOptions {
	planner: Planner;
}

export function createPlanTool(options: PlanningToolOptions): AgentTool<typeof planSchema> {
	const { planner } = options;

	return {
		name: "plan",
		label: "Plan",
		description:
			"Structured plan-execute-review cycles. Actions: create (auto-starts), step (complete/fail), adapt (add steps after failure), complete (finalize), list (show all).",
		parameters: planSchema,
		execute: async (_toolCallId, params: PlanToolInput) => {
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
						params.steps.map((s) => ({
							description: s.description,
							type: s.type as StepType,
							expectedOutcome: s.expectedOutcome,
							dependencies: s.dependencies ?? [],
							tools: s.tools,
						})),
						{ estimatedCost: params.estimatedCost },
					);
					// Auto-start
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

					// If reason provided, fail; otherwise complete
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

					// Complete step
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
						params.newSteps.map((s) => ({
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

/**
 * @deprecated Use createPlanTool() instead. Kept for compatibility.
 */
export function createPlanningTools(options: PlanningToolOptions): Record<string, AgentTool<any>> {
	const tool = createPlanTool(options);
	return {
		plan: tool,
		plan_create: tool,
	};
}
