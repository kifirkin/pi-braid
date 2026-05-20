/**
 * Planning System - Plan-Execute-Review Cycle
 *
 * Based on: docs/analysis/SUPER_AGENT_GAP_ANALYSIS.md
 * Provides strategic planning before execution with adaptive replanning.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PlanStatus =
  | "planning"
  | "executing"
  | "reviewing"
  | "completed"
  | "adapted"
  | "failed";
export type StepType = "information" | "action" | "decision" | "verification";
export type StepStatus = "pending" | "in_progress" | "completed" | "failed";

export interface PlanStep {
  id: string;
  description: string;
  type: StepType;
  dependencies: string[]; // Step IDs that must complete first
  expectedOutcome: string;
  actualOutcome?: string;
  status: StepStatus;
  tools?: string[]; // Expected tools to use
  startedAt?: number;
  completedAt?: number;
}

export interface Plan {
  id: string;
  description: string;
  steps: PlanStep[];
  currentStepIndex: number;
  status: PlanStatus;
  createdAt: number;
  completedAt?: number;
  estimatedCost: number; // Token estimate
  actualCost: number;
  parentPlanId?: string; // For adapted plans
  reasoning?: string; // Why this plan was created
  lessonsLearned?: string; // Lessons from execution
}

export interface PlannerState {
  plans: Plan[];
  activePlanId?: string;
  version: number;
}

export class Planner {
  private plans = new Map<string, Plan>();
  private activePlanId: string | undefined;
  private storagePath: string | null = null;

  /**
   * Initialize planner with optional persistence
   */
  initialize(storageDir?: string): void {
    if (storageDir) {
      this.storagePath = join(storageDir, "planner.json");
      this.load();
    }
  }

  /**
   * Create a new plan from steps
   */
  createPlan(
    description: string,
    steps: Omit<PlanStep, "id" | "status">[],
    options?: {
      estimatedCost?: number;
      reasoning?: string;
      parentPlanId?: string;
    },
  ): Plan {
    const id = this.generatePlanId();

    const planSteps: PlanStep[] = steps.map((s, index) => ({
      ...s,
      id: `step-${index + 1}`,
      status: "pending",
    }));

    const plan: Plan = {
      id,
      description,
      steps: planSteps,
      currentStepIndex: 0,
      status: "planning",
      createdAt: Date.now(),
      estimatedCost: options?.estimatedCost ?? 0,
      actualCost: 0,
      reasoning: options?.reasoning,
      parentPlanId: options?.parentPlanId,
    };

    this.plans.set(id, plan);
    this.save();
    return plan;
  }

  /**
   * Start executing a plan
   */
  startPlan(id: string): Plan | null {
    const plan = this.plans.get(id);
    if (!plan) return null;

    plan.status = "executing";
    plan.currentStepIndex = 0;
    this.activePlanId = id;
    this.save();
    return plan;
  }

  /**
   * Get current step to execute
   */
  getCurrentStep(planId?: string): PlanStep | undefined {
    const id = planId ?? this.activePlanId;
    if (!id) return undefined;

    const plan = this.plans.get(id);
    if (!plan || plan.status !== "executing") return undefined;

    // Find next ready step (dependencies satisfied)
    const completedIds = new Set(
      plan.steps.filter((s) => s.status === "completed").map((s) => s.id),
    );

    // Try to find a ready step from current index onwards
    for (let i = plan.currentStepIndex; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (step.status === "pending" && step.dependencies.every((d) => completedIds.has(d))) {
        plan.currentStepIndex = i;
        return step;
      }
    }

    return undefined;
  }

  /**
   * Mark current step as in progress
   */
  markStepStarted(planId?: string): PlanStep | undefined {
    const id = planId ?? this.activePlanId;
    if (!id) return undefined;

    const plan = this.plans.get(id);
    if (!plan) return undefined;

    const step = plan.steps[plan.currentStepIndex];
    if (!step) return undefined;

    step.status = "in_progress";
    step.startedAt = Date.now();
    this.save();
    return step;
  }

  /**
   * Complete current step and advance
   */
  completeStep(actualOutcome: string, planId?: string): PlanStep | undefined {
    const id = planId ?? this.activePlanId;
    if (!id) return undefined;

    const plan = this.plans.get(id);
    if (!plan) return undefined;

    const step = plan.steps[plan.currentStepIndex];
    if (!step) return undefined;

    step.status = "completed";
    step.actualOutcome = actualOutcome;
    step.completedAt = Date.now();

    // Advance to next step
    plan.currentStepIndex++;

    // Check if plan complete
    if (plan.currentStepIndex >= plan.steps.length) {
      plan.status = "reviewing";
    }

    this.save();
    return step;
  }

  /**
   * Fail current step and trigger adaptation
   */
  failStep(reason: string, planId?: string): { step: PlanStep; plan: Plan } | undefined {
    const id = planId ?? this.activePlanId;
    if (!id) return undefined;

    const plan = this.plans.get(id);
    if (!plan) return undefined;

    const step = plan.steps[plan.currentStepIndex];
    if (!step) return undefined;

    step.status = "failed";
    step.actualOutcome = `Failed: ${reason}`;
    plan.status = "adapted";

    this.save();
    return { step, plan };
  }

  /**
   * Create an adaptation plan after step failure
   */
  adaptPlan(
    failedPlanId: string,
    newSteps: Omit<PlanStep, "id" | "status">[],
    reasoning: string,
  ): Plan {
    const failedPlan = this.plans.get(failedPlanId);
    if (!failedPlan) {
      throw new Error(`Plan ${failedPlanId} not found`);
    }

    // Mark original as failed
    failedPlan.status = "failed";

    // Create adaptation
    const adaptedPlan = this.createPlan(`Adapted: ${failedPlan.description}`, newSteps, {
      reasoning,
      parentPlanId: failedPlanId,
    });

    // Activate the adapted plan
    this.startPlan(adaptedPlan.id);

    return adaptedPlan;
  }

  /**
   * Review and finalize completed plan
   */
  reviewPlan(lessons?: string, planId?: string): Plan | null {
    const id = planId ?? this.activePlanId;
    if (!id) return null;

    const plan = this.plans.get(id);
    if (!plan || plan.status !== "reviewing") return null;

    plan.status = "completed";
    plan.completedAt = Date.now();
    if (lessons) {
      plan.lessonsLearned = lessons;
    }

    this.activePlanId = undefined;
    this.save();
    return plan;
  }

  /**
   * Get active plan
   */
  getActivePlan(): Plan | undefined {
    if (!this.activePlanId) return undefined;
    return this.plans.get(this.activePlanId);
  }

  /**
   * Get plan by ID
   */
  get(id: string): Plan | undefined {
    return this.plans.get(id);
  }

  /**
   * List all plans
   */
  list(): Plan[] {
    return Array.from(this.plans.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Get statistics
   */
  getStats(): {
    total: number;
    planning: number;
    executing: number;
    completed: number;
    failed: number;
    adapted: number;
  } {
    const plans = Array.from(this.plans.values());
    return {
      total: plans.length,
      planning: plans.filter((p) => p.status === "planning").length,
      executing: plans.filter((p) => p.status === "executing").length,
      completed: plans.filter((p) => p.status === "completed").length,
      failed: plans.filter((p) => p.status === "failed").length,
      adapted: plans.filter((p) => p.status === "adapted").length,
    };
  }

  /**
   * Cancel active plan
   */
  cancel(planId?: string): boolean {
    const id = planId ?? this.activePlanId;
    if (!id) return false;

    const plan = this.plans.get(id);
    if (!plan) return false;

    plan.status = "failed";
    if (this.activePlanId === id) {
      this.activePlanId = undefined;
    }
    this.save();
    return true;
  }

  /**
   * Clear all plans
   */
  clear(): void {
    this.plans.clear();
    this.activePlanId = undefined;
    this.save();
  }

  /**
   * Format plan for display
   */
  formatPlan(planId?: string): string {
    const id = planId ?? this.activePlanId;
    if (!id) return "No active plan.";

    const plan = this.plans.get(id);
    if (!plan) return "Plan not found.";

    const lines: string[] = [
      `Plan: ${plan.description} (${plan.status})`,
      `Progress: ${plan.currentStepIndex}/${plan.steps.length}`,
      "",
    ];

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const symbol =
        step.status === "completed"
          ? "✓"
          : step.status === "in_progress"
            ? "▶"
            : step.status === "failed"
              ? "✗"
              : "○";
      const marker =
        i === plan.currentStepIndex && step.status === "in_progress" ? " (current)" : "";
      lines.push(`${symbol} Step ${i + 1}: ${step.description}${marker}`);
      lines.push(`   Type: ${step.type} | Expected: ${step.expectedOutcome}`);
    }

    return lines.join("\n");
  }

  private save(): void {
    if (!this.storagePath) return;

    try {
      const state: PlannerState = {
        plans: Array.from(this.plans.values()),
        activePlanId: this.activePlanId,
        version: 1,
      };
      const dir = dirname(this.storagePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.storagePath, JSON.stringify(state, null, 2));
    } catch {
      // Silent fail
    }
  }

  private load(): void {
    if (!this.storagePath) return;
    if (!existsSync(this.storagePath)) return;

    try {
      const data = readFileSync(this.storagePath, "utf-8");
      const state: PlannerState = JSON.parse(data);
      if (state.plans) {
        for (const plan of state.plans) {
          this.plans.set(plan.id, plan);
        }
      }
      if (state.activePlanId) {
        this.activePlanId = state.activePlanId;
      }
    } catch {
      // Silent fail
    }
  }

  private generatePlanId(): string {
    return `plan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}
