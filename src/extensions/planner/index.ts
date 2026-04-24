/**
 * @fileoverview Budget-aware planning tool.
 *
 * Tracks tool call costs and budget limits. Provides estimates before starting
 * large tasks and checkpoints to verify progress.
 *
 * Part of TIER 1 infrastructure activation.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../lib/logger.js";
import { getExtensionState } from "../../lib/extension-state.js";

const log = createLogger("planner");

// ── Cost estimates ──────────────────────────────────────────────────────────

/** Estimated cost per tool type (tool calls) */
const TOOL_COSTS: Record<string, number> = {
  bash: 3,          // Terminal commands often quick
  repl: 5,          // Code execution with iterations
  read: 1,          // File read - cheap
  grep: 1,          // Search - cheap
  find: 1,          // Find - cheap
  write: 3,          // File write with verification
  edit: 3,           // Targeted change
  think: 2,          // Reasoning
  finalize: 0,        // End of task
  web_fetch: 5,      // External calls
  browser_navigate: 4, // Browser interaction
  // Default for unknown tools
};

const DEFAULT_COST = 2;

interface BudgetState {
  budget: number;
  spent: number;
  checkpoints: BudgetCheckpoint[];
  warnings: string[];
}

interface BudgetCheckpoint {
  name: string;
  spentAt: number;
  reached: boolean;
}

function createBudgetState(): BudgetState {
  return { budget: 50, spent: 0, checkpoints: [], warnings: [] };
}

function estimateTaskCost(task: string): { calls: number; tokens: number; phases: number } {
  // Heuristic: larger/ vaguer tasks cost more
  const words = task.split(/\s+/).length;
  const phases = Math.max(1, Math.min(5, Math.floor(words / 10)));
  const calls = phases * 8 + words; // Rough estimate
  const tokens = calls * 200; // Average 200 tokens per call
  return { calls: Math.min(calls, 100), tokens, phases };
}

function checkBudget(state: BudgetState, task: string): {
  overBudget: boolean;
  warning: string | null;
  percentUsed: number;
} {
  const { calls } = estimateTaskCost(task);
  const totalNeeded = state.spent + calls;
  const percentUsed = state.budget > 0 ? (totalNeeded / state.budget) * 100 : 100;
  const overBudget = totalNeeded > state.budget;

  let warning = null;
  if (percentUsed >= 100) {
    warning = `Task estimated at ${calls} calls. Budget exceeded (${state.spent}/${state.budget} used). Consider narrowing scope.`;
  } else if (percentUsed >= 80) {
    warning = `Budget warning: ${state.spent + calls}/${state.budget} calls needed (${Math.round(percentUsed)}% of budget).`;
  }

  return { overBudget, warning, percentUsed };
}

function createPhasedPlan(
  task: string,
  maxBudget: number,
): { phases: Array<{ name: string; goal: string; estimatedCalls: number }> } {
  const { phases } = estimateTaskCost(task);
  const perPhase = Math.ceil(maxBudget / phases);

  const phaseTemplates = [
    { name: "analyze", goal: "Understand requirements and existing code" },
    { name: "implement", goal: "Implement core functionality" },
    { name: "verify", goal: "Test and verify implementation" },
    { name: "refine", goal: "Fix issues and polish" },
    { name: "document", goal: "Document and finalize" },
  ];

  const selected = phaseTemplates.slice(0, phases);
  const phases_ = selected.map((p) => ({
    name: p.name,
    goal: p.goal,
    estimatedCalls: Math.ceil(perPhase * 0.8),
  }));

  return { phases: phases_ };
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function plannerExtension(pi: ExtensionAPI) {
  log.info("Planner extension registering");

  // ── plan_with_budget ──────────────────────────────────────────────────

  pi.registerTool({
    name: "plan_with_budget",
    label: "Plan With Budget",
    description: "Create a task plan with budget estimates and phased checkpoints.",
    parameters: Type.Object({
      task: Type.String({ description: "Task description" }),
      maxBudget: Type.Optional(Type.Number({ description: "Max tool calls allowed (default: 50)" })),
      context: Type.Optional(Type.String({ description: "Current context for better estimation" })),
    }),
    execute: async (_toolCallId: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext | undefined): Promise<any> => {
      const p = params as { task: string; maxBudget?: number; context?: string };
      const budget = p.maxBudget ?? 50;
      const cost = estimateTaskCost(p.task);
      const plan = createPhasedPlan(p.task, budget);

      const warnings: string[] = [];
      if (cost.calls > budget) {
        warnings.push(`Estimated ${cost.calls} calls exceeds budget ${budget}. Consider decomposing into subtasks.`);
      }
      if (cost.tokens > 50000) {
        warnings.push(`High token estimate: ~${cost.tokens}. Will require careful context management.`);
      }

      const planText = `Plan for: "${p.task.substring(0, 80)}..."\n${plan.phases.map((ph, i) => `  ${i + 1}. [${ph.name}] ${ph.goal} (~${ph.estimatedCalls} calls)`).join("\n")}\n\nBudget: ${cost.calls}/${budget} calls (${Math.round((cost.calls / budget) * 100)}%)`;
      return {
        content: [{ type: "text" as const, text: planText }],
        details: {
          task: p.task,
          budget,
          estimatedCalls: cost.calls,
          estimatedTokens: cost.tokens,
          estimatedPhases: cost.phases,
          phases: plan.phases,
          warnings,
          suggestions: warnings.length > 0
            ? warnings
            : [`Plan fits within budget. Consider adding checkpoints at phase boundaries.`],
        },
      };
    },
  } as any);

  // ── check_budget ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "check_budget",
    label: "Check Budget",
    description: "Check remaining budget and spending rate for the current session.",
    parameters: Type.Object({}),
    execute: async (_toolCallId: string, _params: any, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext | undefined): Promise<any> => {
      if (!ctx) return { content: [{ type: "text" as const, text: "No context available." }], details: {} };
      const state = getExtensionState(ctx, "planner-budget", createBudgetState);

      const remaining = Math.max(0, state.budget - state.spent);
      const percentUsed = state.budget > 0 ? (state.spent / state.budget) * 100 : 100;

      return {
        content: [{ type: "text" as const, text: `Budget: ${state.spent}/${state.budget} calls used (${Math.round(percentUsed)}%). ${remaining} remaining.` }],
        details: {
          budget: state.budget,
          spent: state.spent,
          remaining,
          percentUsed: Math.round(percentUsed),
          checkpoints: state.checkpoints,
          warnings: state.warnings,
        },
      };
    },
  } as any);

  // ── set_budget ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "set_budget",
    label: "Set Budget",
    description: "Set the tool call budget for the current session.",
    parameters: Type.Object({
      budget: Type.Number({ description: "Max tool calls allowed" }),
      reset: Type.Optional(Type.Boolean({ description: "Reset spent counter" })),
    }),
    execute: async (_toolCallId: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext | undefined): Promise<any> => {
      if (!ctx) return { content: [{ type: "text" as const, text: "No context available." }], details: {} };
      const state = getExtensionState(ctx, "planner-budget", createBudgetState);

      const p = params as { budget: number; reset?: boolean };
      state.budget = p.budget;
      if (p.reset) {
        state.spent = 0;
        state.checkpoints = [];
        state.warnings = [];
      }

      return {
        content: [{ type: "text" as const, text: `Budget set to ${state.budget} calls. Spent: ${state.spent}. Remaining: ${Math.max(0, state.budget - state.spent)}.` }],
        details: { budget: state.budget, spent: state.spent, remaining: Math.max(0, state.budget - state.spent) },
      };
    },
  } as any);

  log.info("Planner extension registered: plan_with_budget, check_budget, set_budget");
}
