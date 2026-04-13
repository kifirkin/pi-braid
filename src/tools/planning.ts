/**
 * Planning tools for plan-execute-review cycles
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Planner, StepType } from "../lib/planner.js";

const planCreateSchema = Type.Object({
	description: Type.String({ description: "What the plan will accomplish" }),
	steps: Type.Array(
		Type.Object({
			description: Type.String(),
			type: Type.String({ description: "information, action, decision, or verification" }),
			expectedOutcome: Type.String(),
			dependencies: Type.Optional(Type.Array(Type.String())),
			tools: Type.Optional(Type.Array(Type.String())),
		}),
	),
	estimatedCost: Type.Optional(Type.Number({ description: "Estimated token cost" })),
});

const planStartSchema = Type.Object({
	planId: Type.String(),
});

const planStepCompleteSchema = Type.Object({
	planId: Type.Optional(Type.String()),
	actualOutcome: Type.String(),
});

const planStepFailSchema = Type.Object({
	planId: Type.Optional(Type.String()),
	reason: Type.String(),
});

const planAdaptSchema = Type.Object({
	failedPlanId: Type.String(),
	newSteps: Type.Array(
		Type.Object({
			description: Type.String(),
			type: Type.String(),
			expectedOutcome: Type.String(),
		}),
	),
	reasoning: Type.String(),
});

const planCompleteSchema = Type.Object({
	planId: Type.Optional(Type.String()),
	lessons: Type.Optional(Type.String()),
});

const planListSchema = Type.Object({});

export interface PlanningToolOptions {
	planner: Planner;
}

export function createPlanningTools(options: PlanningToolOptions): Record<string, AgentTool<any>> {
	const { planner } = options;

	const planCreateTool: AgentTool<typeof planCreateSchema> = {
		name: "plan_create",
		label: "Create Plan",
		description: "Create a new execution plan with steps",
		parameters: planCreateSchema,
		execute: async (_toolCallId, params) => {
			const plan = planner.createPlan(
				params.description,
				params.steps.map((s, _i) => ({
					description: s.description,
					type: s.type as StepType,
					expectedOutcome: s.expectedOutcome,
					dependencies: s.dependencies ?? [],
					tools: s.tools,
				})),
				{ estimatedCost: params.estimatedCost },
			);
			return {
				content: [{ type: "text" as const, text: `Created plan ${plan.id} with ${plan.steps.length} steps` }],
				details: { id: plan.id, steps: plan.steps.length },
			};
		},
	};

	const planStartTool: AgentTool<typeof planStartSchema> = {
		name: "plan_start",
		label: "Start Plan",
		description: "Start executing a plan",
		parameters: planStartSchema,
		execute: async (_toolCallId, params) => {
			const plan = planner.startPlan(params.planId);
			if (!plan) {
				throw new Error(`Plan ${params.planId} not found`);
			}
			return {
				content: [{ type: "text" as const, text: `Started plan: ${plan.description}` }],
				details: { id: plan.id },
			};
		},
	};

	const planStepCompleteTool: AgentTool<typeof planStepCompleteSchema> = {
		name: "plan_step_complete",
		label: "Complete Plan Step",
		description: "Mark current step as complete and advance",
		parameters: planStepCompleteSchema,
		execute: async (_toolCallId, params) => {
			const step = planner.completeStep(params.actualOutcome, params.planId);
			if (!step) {
				const active = planner.getActivePlan();
				if (active?.status === "reviewing") {
					return {
						content: [{ type: "text" as const, text: "All steps complete. Use plan_complete to finalize." }],
						details: { status: "complete" },
					};
				}
				throw new Error("No active step to complete");
			}
			return {
				content: [{ type: "text" as const, text: `Completed step: ${step.description}` }],
				details: undefined,
			};
		},
	};

	const planStepFailTool: AgentTool<typeof planStepFailSchema> = {
		name: "plan_step_fail",
		label: "Fail Plan Step",
		description: "Mark current step as failed (triggers adaptation)",
		parameters: planStepFailSchema,
		execute: async (_toolCallId, params) => {
			const result = planner.failStep(params.reason, params.planId);
			if (!result) {
				throw new Error("No active step to fail");
			}
			return {
				content: [
					{ type: "text" as const, text: `Step failed: ${result.step.description}` },
					{ type: "text" as const, text: "Plan status: adapted. Create new steps with plan_adapt." },
				],
				details: { planId: result.plan.id, failedStep: result.step.id },
			};
		},
	};

	const planAdaptTool: AgentTool<typeof planAdaptSchema> = {
		name: "plan_adapt",
		label: "Adapt Plan",
		description: "Create adaptation after step failure",
		parameters: planAdaptSchema,
		execute: async (_toolCallId, params) => {
			const newPlan = planner.adaptPlan(
				params.failedPlanId,
				params.newSteps.map((s) => ({
					description: s.description,
					type: s.type as StepType,
					expectedOutcome: s.expectedOutcome,
					dependencies: [],
				})),
				params.reasoning,
			);
			return {
				content: [{ type: "text" as const, text: `Created adaptation plan: ${newPlan.id}` }],
				details: { newPlanId: newPlan.id },
			};
		},
	};

	const planCompleteTool: AgentTool<typeof planCompleteSchema> = {
		name: "plan_complete",
		label: "Complete Plan",
		description: "Finalize completed plan with lessons learned",
		parameters: planCompleteSchema,
		execute: async (_toolCallId, params) => {
			const plan = planner.reviewPlan(params.lessons, params.planId);
			if (!plan) {
				throw new Error("No completed plan to finalize");
			}
			return {
				content: [{ type: "text" as const, text: `Plan completed: ${plan.description}` }],
				details: { id: plan.id },
			};
		},
	};

	const planListTool: AgentTool<typeof planListSchema> = {
		name: "plan_list",
		label: "List Plans",
		description: "List all plans",
		parameters: planListSchema,
		execute: async () => {
			const plans = planner.list();
			const stats = planner.getStats();
			const lines = plans.map(
				(p) => `[${p.status}] ${p.id}: ${p.description} (${p.currentStepIndex}/${p.steps.length})`,
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
		},
	};

	return {
		plan_create: planCreateTool,
		plan_start: planStartTool,
		plan_step_complete: planStepCompleteTool,
		plan_step_fail: planStepFailTool,
		plan_adapt: planAdaptTool,
		plan_complete: planCompleteTool,
		plan_list: planListTool,
	};
}
