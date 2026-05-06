/**
 * Scratchpad Extension — Structured Session Memory (CCA L2)
 *
 * Per-loop persistent state for continuity of thought across turns.
 * Persists to disk per-project so it survives process restarts.
 *
 * Types extracted to types.ts, persistence to persistence.ts.
 * Index re-exports both for backward compatibility.
 */

import { createLogger } from "../../../lib/logger.js";

const log = createLogger("scratchpad");

import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-coding-agent";

// ── Re-export types and persistence for importers ─────────────────────────
export * from "./types.js";
export * from "./persistence.js";

import type {
  TaskScratchpad,
  PlanStep,
  Decision,
  TaskStore,
  TaskItem,
  SessionMeta,
  Constraint,
  KeyLearning,
  SessionPhase,
} from "./types.js";

import {
  projectSlugFromCwd,
  createScratchpad,
  saveScratchpadToDisk,
  loadScratchpadFromDisk,
  saveTaskStore,
  loadTaskStore,
} from "./persistence.js";

import { getExtensionState } from "../../../lib/extension-state.js";

// ── Recycling Config ──────────────────────────────────────────────────────
const RECYCLE = {
  MAX_PLAN: 20,
  MAX_DONE: 50,
  MAX_DECISIONS: 30,
  MAX_HYPOTHESES: 20,
  MAX_NOTES: 30,
  MAX_LEARNINGS: 50,
  MAX_CONSTRAINTS: 20,
  MAX_TASKS: 50,
  GOAL_HISTORY: 3,
} as const;

type RecycleStats = {
  pruned_plan: number; pruned_done: number; pruned_decisions: number;
  pruned_hypotheses: number; pruned_notes: number;
  pruned_learnings: number; pruned_constraints: number;
  archived_goal: string | null; total_pruned: number;
};

function scratchpadClean(pad: TaskScratchpad): RecycleStats {
  const stats: RecycleStats = {
    pruned_plan: 0, pruned_done: 0, pruned_decisions: 0,
    pruned_hypotheses: 0, pruned_notes: 0,
    pruned_learnings: 0, pruned_constraints: 0,
    archived_goal: null, total_pruned: 0,
  };

  if (pad.plan.length > RECYCLE.MAX_PLAN) {
    stats.pruned_plan = pad.plan.length - RECYCLE.MAX_PLAN;
    pad.plan = pad.plan.slice(-RECYCLE.MAX_PLAN);
  }
  if (pad.done.length > RECYCLE.MAX_DONE) {
    stats.pruned_done = pad.done.length - RECYCLE.MAX_DONE;
    pad.done = pad.done.slice(-RECYCLE.MAX_DONE);
  }
  if (pad.decisions.length > RECYCLE.MAX_DECISIONS) {
    stats.pruned_decisions = pad.decisions.length - RECYCLE.MAX_DECISIONS;
    pad.decisions = pad.decisions.slice(-RECYCLE.MAX_DECISIONS);
  }
  if (pad.hypotheses.length > RECYCLE.MAX_HYPOTHESES) {
    stats.pruned_hypotheses = pad.hypotheses.length - RECYCLE.MAX_HYPOTHESES;
    pad.hypotheses = pad.hypotheses.slice(-RECYCLE.MAX_HYPOTHESES);
  }
  if (pad.notes.length > RECYCLE.MAX_NOTES) {
    stats.pruned_notes = pad.notes.length - RECYCLE.MAX_NOTES;
    pad.notes = pad.notes.slice(-RECYCLE.MAX_NOTES);
  }
  if (pad.key_learnings.length > RECYCLE.MAX_LEARNINGS) {
    stats.pruned_learnings = pad.key_learnings.length - RECYCLE.MAX_LEARNINGS;
    pad.key_learnings = pad.key_learnings.slice(-RECYCLE.MAX_LEARNINGS);
  }
  if (pad.constraints.length > RECYCLE.MAX_CONSTRAINTS) {
    stats.pruned_constraints = pad.constraints.length - RECYCLE.MAX_CONSTRAINTS;
    pad.constraints = pad.constraints.slice(-RECYCLE.MAX_CONSTRAINTS);
  }
  stats.total_pruned =
    stats.pruned_plan + stats.pruned_done + stats.pruned_decisions +
    stats.pruned_hypotheses + stats.pruned_notes +
    stats.pruned_learnings + stats.pruned_constraints;
  return stats;
}

function capPush<T>(arr: T[], item: T, max: number): number {
  arr.push(item);
  if (arr.length > max) {
    const excess = arr.length - max;
    arr.splice(0, excess);
    return excess;
  }
  return 0;
}

function generateTaskId(): string { return `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }
function generateLearningId(): string { return `lrn-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`; }
function generateConstraintId(): string { return `con-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`; }

// ── Format Scratchpad ─────────────────────────────────────────────────────

export function formatScratchpad(pad: TaskScratchpad): string {
  const lines: string[] = [];
  lines.push(`Goal: ${pad.goal}`);
  if (pad.prior_goal) lines.push(`Prior goal: ${pad.prior_goal}`);

  // Plan
  if (pad.plan.length > 0) {
    lines.push("\nPlan:");
    for (let i = 0; i < pad.plan.length; i++) {
      const step = pad.plan[i];
      const status = step.doneTurn > 0 ? "✅" : step.startTurn > 0 ? "🔄" : "⬜";
      const budget = step.budgetCalls ? `/${step.budgetCalls}` : "";
      const over = step.budgetCalls && step.spentCalls > step.budgetCalls ? " ⚠" : "";
      lines.push(`  ${i + 1}. ${status} ${step.text} [${step.spentCalls}${budget} calls${over}]`);
    }
  }

  // Done
  if (pad.done.length > 0) {
    lines.push(`\nDone (${pad.done.length}):`);
    for (const d of pad.done) lines.push(`  ✅ ${d}`);
  }

  // Decisions
  if (pad.decisions.length > 0) {
    lines.push("\nDecisions:");
    for (const d of pad.decisions.slice(-5)) {
      lines.push(`  - ${d.text}${d.reason ? ` (${d.reason})` : ""}`);
    }
  }

  // Notes
  if (pad.notes.length > 0) {
    lines.push("\nNotes:");
    for (const n of pad.notes.slice(-5)) lines.push(`  ${n}`);
  }

  // CCA L2 sections
  if (pad.constraints.length > 0) {
    lines.push("\nConstraints:");
    for (const c of pad.constraints.slice(-3)) {
      lines.push(`  [${c.type}] ${c.description}${c.acknowledged ? " (acknowledged)" : ""}`);
    }
  }
  if (pad.key_learnings.length > 0) {
    lines.push(`\nLearnings (${pad.key_learnings.length}):`);
    for (const l of pad.key_learnings.slice(-3)) {
      lines.push(`  [${l.category}] ${l.content}`);
    }
  }

  return lines.join("\n");
}

export function formatSessionSummary(pad: TaskScratchpad): {
  cycles: number; pruned: number; goals: number; decisions: number; learnings: number;
} {
  return {
    cycles: pad.session.turn,
    pruned: 0,
    goals: pad.prior_goal ? 1 : 0,
    decisions: pad.decisions.length,
    learnings: pad.key_learnings.length,
  };
}

// ── Scratchpad Cache ──────────────────────────────────────────────────────

interface ScratchpadCache {
  pad: TaskScratchpad | null;
}

function getCache(ctx?: ExtensionContext): ScratchpadCache {
  if (!ctx) return { pad: null };
  return getExtensionState(ctx, "scratchpad-cache", () => ({ pad: null }));
}

function resolveProjectSlug(cwd?: string): string {
  return cwd ? projectSlugFromCwd(cwd) : "default";
}

async function getOrCreateScratchpad(
  ctx: ExtensionContext,
  goal?: string,
): Promise<TaskScratchpad | null> {
  const cwd = (ctx as any).cwd ?? "";
  const slug = resolveProjectSlug(cwd);

  // Check cache first
  const cache = getCache(ctx);
  if (cache.pad) return cache.pad;

  // Load from disk
  const saved = await loadScratchpadFromDisk(slug);
  if (saved) {
    cache.pad = saved;
    return saved;
  }

  // Create new
  if (!goal) goal = "Untitled";
  const pad = createScratchpad(goal, slug);
  cache.pad = pad;
  return pad;
}

async function mutateAndSave(scratchpad: TaskScratchpad): Promise<void> {
  scratchpad.updatedAt = Date.now();
  await saveScratchpadToDisk(scratchpad);
}

function resolveProjectSlugFromCtx(ctx: ExtensionContext): string {
  const cwd = (ctx as any).cwd ?? "";
  return resolveProjectSlug(cwd);
}

// ── Tool Schemas ──────────────────────────────────────────────────────────

const readAction = Type.Union([
  Type.Literal("read"),
  Type.Literal("set_goal"),
  Type.Literal("add_plan"),
  Type.Literal("mark_done"),
  Type.Literal("add_decision"),
  Type.Literal("add_hypothesis"),
  Type.Literal("add_note"),
  Type.Literal("update_session"),
  Type.Literal("add_constraint"),
  Type.Literal("remove_constraint"),
  Type.Literal("add_learning"),
  Type.Literal("persist_learnings"),
  Type.Literal("note_compact"),
  Type.Literal("elevate_to_goal"),
  Type.Literal("elevate_to_plan"),
  Type.Literal("task_add"),
  Type.Literal("task_list"),
  Type.Literal("task_complete"),
  Type.Literal("task_fail"),
  Type.Literal("task_next"),
  Type.Literal("task_remove"),
  Type.Literal("task_stats"),
  Type.Literal("task_clear"),
]);

const scratchpadParams = Type.Object({
  action: readAction,
  text: Type.Optional(Type.String({ description: "Text content" })),
  successCriteria: Type.Optional(Type.Array(Type.String(), { description: "Success criteria" })),
  priority: Type.Optional(Type.Number({ description: "Priority 0-10" })),
  dependencies: Type.Optional(Type.Array(Type.String(), { description: "Dependencies" })),
  task_id: Type.Optional(Type.String({ description: "Task ID" })),
  constraint_id: Type.Optional(Type.String({ description: "Constraint ID" })),
  expires_in_ms: Type.Optional(Type.Number({ description: "TTL in ms for constraint expiry" })),
});

// ── Tool Execute ──────────────────────────────────────────────────────────

async function scratchpadExecute(
  toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal,
  _onUpdate: (chunk: string) => void,
  ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
  const action = params.action as string;
  const text = (params.text as string) ?? "";
  const successCriteria = params.successCriteria as string[] | undefined;
  const priority = params.priority as number | undefined;
  const dependencies = params.dependencies as string[] | undefined;
  const task_id = params.task_id as string | undefined;
  const constraint_id = params.constraint_id as string | undefined;
  const expires_in_ms = params.expires_in_ms as number | undefined;

  const pad = await getOrCreateScratchpad(ctx);

  if (!pad) {
    return {
      content: [{ type: "text" as const, text: "Error: Could not load scratchpad." }],
      details: { error: "scratchpad_load_failed" },
    };
  }

  const priorGoal = pad.goal;
  let resultText = "";

  switch (action) {
    case "read": {
      resultText = formatScratchpad(pad);
      break;
    }

    case "set_goal": {
      if (pad.goal && pad.goal !== "Untitled" && pad.goal !== text) {
        pad.prior_goal = pad.goal;
      }
      pad.goal = text;
      pad.prior_goal = pad.prior_goal || priorGoal;
      await mutateAndSave(pad);
      resultText = `Goal set: ${text}`;
      break;
    }

    case "add_plan": {
      // Parse optional budget field [budget:N]
      let budgetCalls: number | undefined;
      let planText = text;
      const budgetMatch = text.match(/\s*\[budget:\s*(\d+)\]\s*$/i);
      if (budgetMatch) {
        budgetCalls = parseInt(budgetMatch[1], 10);
        planText = text.slice(0, budgetMatch.index!).trim();
      }
      pad.plan.push({
        text: planText,
        budgetCalls,
        spentCalls: 0,
        startTurn: pad.session.turn,
        doneTurn: 0,
        startTotalCalls: 0,
      });
      const budgetStr = budgetCalls ? ` [budget: ${budgetCalls} calls]` : "";
      capPush(pad.plan, pad.plan[pad.plan.length - 1], RECYCLE.MAX_PLAN);
      await mutateAndSave(pad);
      resultText = `Step added: ${planText}${budgetStr}`;
      break;
    }

    case "mark_done": {
      const step = pad.plan.find((s) => s.text === text);
      if (step) {
        step.doneTurn = pad.session.turn;
        pad.done.push(text);
        capPush(pad.done, text, RECYCLE.MAX_DONE);
        resultText = `Completed: ${text}`;
      } else {
        // Fallback: just add to done
        pad.done.push(text);
        capPush(pad.done, text, RECYCLE.MAX_DONE);
        resultText = `Completed: ${text}`;
      }
      await mutateAndSave(pad);
      break;
    }

    case "add_decision": {
      // Parse optional reason: "decision|reason"
      let decisionText = text;
      let reason: string | undefined;
      const sepIndex = text.indexOf("|");
      if (sepIndex > 0) {
        decisionText = text.slice(0, sepIndex).trim();
        reason = text.slice(sepIndex + 1).trim();
      }
      const decision: Decision = { text: decisionText, reason, turn: pad.session.turn };
      pad.decisions.push(decision);
      capPush(pad.decisions, decision, RECYCLE.MAX_DECISIONS);
      await mutateAndSave(pad);
      resultText = `Decision recorded: ${decisionText}${reason ? ` (${reason})` : ""}`;
      break;
    }

    case "add_hypothesis": {
      pad.hypotheses.push(text);
      capPush(pad.hypotheses, text, RECYCLE.MAX_HYPOTHESES);
      await mutateAndSave(pad);
      resultText = `Hypothesis added: ${text}`;
      break;
    }

    case "add_note": {
      pad.notes.push(text);
      capPush(pad.notes, text, RECYCLE.MAX_NOTES);
      await mutateAndSave(pad);
      resultText = `Note added: ${text}`;
      break;
    }

    case "update_session": {
      if (params.turn !== undefined) pad.session.turn = params.turn as number;
      if (params.phase !== undefined) pad.session.phase = params.phase as SessionPhase;
      if (params.mode !== undefined) pad.session.mode = params.mode as "normal" | "deep_think" | "recovery";
      pad.session.updated_at = Date.now();
      await mutateAndSave(pad);
      resultText = `Session: turn=${pad.session.turn}, phase=${pad.session.phase}, mode=${pad.session.mode}`;
      break;
    }

    case "add_constraint": {
      // Format: "type|description"
      const [type, ...descParts] = text.split("|");
      const desc = descParts.join("|") || type;
      const cType = type as Constraint["type"] || "custom";
      const constraint: Constraint = {
        id: generateConstraintId(),
        type: ["blocker", "enforcement_rule", "invariant", "custom"].includes(cType) ? cType : "custom",
        description: desc,
        added_at: Date.now(),
        expires_at: expires_in_ms ? Date.now() + expires_in_ms : 0,
        acknowledged: false,
      };
      pad.constraints.push(constraint);
      capPush(pad.constraints, constraint, RECYCLE.MAX_CONSTRAINTS);
      await mutateAndSave(pad);
      resultText = `Constraint added: [${constraint.type}] ${desc} (id: ${constraint.id})`;
      break;
    }

    case "remove_constraint": {
      const idx = pad.constraints.findIndex((c) => c.id === text);
      if (idx >= 0) {
        pad.constraints.splice(idx, 1);
        await mutateAndSave(pad);
        resultText = `Constraint removed: ${text}`;
      } else {
        resultText = `Constraint not found: ${text}`;
      }
      break;
    }

    case "add_learning": {
      // Format: "category|content|scope"
      const parts = text.split("|").map((s) => s.trim());
      const category = parts[0] as KeyLearning["category"];
      const content = parts[1] || parts[0];
      const scope = parts[2] ? parts[2].split(",").map((s) => s.trim()) : [];

      if (!["root_cause", "pattern", "fix", "constraint", "codebase_fact"].includes(category)) {
        resultText = `Invalid category: ${category}. Use: root_cause, pattern, fix, constraint, codebase_fact`;
        break;
      }

      const learning: KeyLearning = {
        id: generateLearningId(),
        content,
        category,
        scope,
        added_at: Date.now(),
        persisted: false,
      };
      pad.key_learnings.push(learning);
      capPush(pad.key_learnings, learning, RECYCLE.MAX_LEARNINGS);
      await mutateAndSave(pad);
      resultText = `Learning added: [${category}] ${content} (scope: ${scope.join(", ") || "all"}) (id: ${learning.id})`;
      break;
    }

    case "persist_learnings": {
      const unp = pad.key_learnings.filter((l) => !l.persisted);
      resultText = `${unp.length} unp persisted learnings flagged for persistence (id: ${unp.map((l) => l.id).join(", ")})`;
      for (const l of unp) l.persisted = true;
      await mutateAndSave(pad);
      break;
    }

    case "note_compact": {
      const stats = scratchpadClean(pad);
      await mutateAndSave(pad);
      resultText = `Scratchpad compacted: plan(-${stats.pruned_plan}), done(-${stats.pruned_done}), decisions(-${stats.pruned_decisions}), hypotheses(-${stats.pruned_hypotheses}), notes(-${stats.pruned_notes})`;
      break;
    }

    case "elevate_to_goal": {
      if (text) {
        if (pad.goal && pad.goal !== "Untitled") pad.prior_goal = pad.goal;
        pad.goal = text;
      }
      if (successCriteria) { /* stored for future use */ }
      await mutateAndSave(pad);
      resultText = `Elevated to goal: ${text || "current goal"}`;
      break;
    }

    case "elevate_to_plan": {
      if (text) {
        pad.plan.push({ text, budgetCalls: undefined, spentCalls: 0, startTurn: pad.session.turn, doneTurn: 0, startTotalCalls: 0 });
      }
      await mutateAndSave(pad);
      resultText = `Elevated to plan: ${text || "current plan"}`;
      break;
    }

    // ── Task Operations ─────────────────────────────────────────────
    case "task_add": {
      const slug = resolveProjectSlugFromCtx(ctx);
      const store = await loadTaskStore(slug);
      const task: TaskItem = {
        id: generateTaskId(),
        text,
        priority: priority ?? 5,
        dependencies: dependencies ?? [],
        status: "pending",
        created_at: Date.now(),
        updated_at: Date.now(),
        tags: [],
      };
      store.tasks.push(task);
      await saveTaskStore(slug, store);
      resultText = `Task added: ${text} (id: ${task.id})`;
      break;
    }

    case "task_list": {
      const slug = resolveProjectSlugFromCtx(ctx);
      const store = await loadTaskStore(slug);
      const tasksByStatus: Record<string, TaskItem[]> = { pending: [], in_progress: [], completed: [], failed: [] };
      for (const t of store.tasks) { (tasksByStatus[t.status] ??= []).push(t); }
      resultText = `Tasks: ${store.tasks.length} total (${tasksByStatus.pending.length} pending, ${tasksByStatus.in_progress.length} in progress, ${tasksByStatus.completed.length} completed, ${tasksByStatus.failed.length} failed)`;
      break;
    }

    case "task_complete": {
      const slug = resolveProjectSlugFromCtx(ctx);
      const store = await loadTaskStore(slug);
      const t = store.tasks.find((t) => t.id === task_id);
      if (t) { t.status = "completed"; t.updated_at = Date.now(); await saveTaskStore(slug, store); resultText = `Task completed: ${t.text}`; }
      else resultText = `Task not found: ${task_id}`;
      break;
    }

    case "task_fail": {
      const slug = resolveProjectSlugFromCtx(ctx);
      const store = await loadTaskStore(slug);
      const t = store.tasks.find((t) => t.id === task_id);
      if (t) { t.status = "failed"; t.updated_at = Date.now(); await saveTaskStore(slug, store); resultText = `Task failed: ${t.text}`; }
      else resultText = `Task not found: ${task_id}`;
      break;
    }

    case "task_next": {
      const slug = resolveProjectSlugFromCtx(ctx);
      const store = await loadTaskStore(slug);
      const next = store.tasks.find((t) => t.status === "pending");
      if (next) resultText = `Next task: ${next.text} (id: ${next.id})`;
      else resultText = "No pending tasks.";
      break;
    }

    case "task_remove": {
      const slug = resolveProjectSlugFromCtx(ctx);
      const store = await loadTaskStore(slug);
      const idx = store.tasks.findIndex((t) => t.id === task_id);
      if (idx >= 0) { const removed = store.tasks.splice(idx, 1)[0]; await saveTaskStore(slug, store); resultText = `Task removed: ${removed.text}`; }
      else resultText = `Task not found: ${task_id}`;
      break;
    }

    case "task_stats": {
      const slug = resolveProjectSlugFromCtx(ctx);
      const store = await loadTaskStore(slug);
      const byStatus = { pending: 0, in_progress: 0, completed: 0, failed: 0 };
      for (const t of store.tasks) { if (t.status in byStatus) byStatus[t.status as keyof typeof byStatus]++; }
      resultText = `Task stats: ${store.tasks.length} total, ${byStatus.pending} pending, ${byStatus.in_progress} in-progress, ${byStatus.completed} completed, ${byStatus.failed} failed`;
      break;
    }

    case "task_clear": {
      const slug = resolveProjectSlugFromCtx(ctx);
      const store = await loadTaskStore(slug);
      const before = store.tasks.length;
      store.tasks = [];
      await saveTaskStore(slug, store);
      resultText = `Task store cleared: ${before} tasks removed`;
      break;
    }

    default:
      resultText = `Unknown action: ${action}. Use: read, set_goal, add_plan, mark_done, add_decision, add_hypothesis, add_note, update_session, add_constraint, remove_constraint, add_learning, persist_learnings, note_compact, elevate_to_goal, elevate_to_plan, task_add, task_list, task_complete, task_fail, task_next, task_remove, task_stats, task_clear`;
  }

  return {
    content: [{ type: "text" as const, text: resultText }],
    details: { action, prior_goal: pad.prior_goal ? "exists" : undefined, plan: pad.plan.length },
  };
}

// ── Tool Registration ─────────────────────────────────────────────────────

export default function scratchpadExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    {
      name: "scratchpad",
      label: "Scratchpad",
      promptSnippet: "Structured session memory for goal, plan, and decisions",
      description:
        "Structured session memory: goal, plan, decisions, hypotheses, notes, constraints, learnings, tasks.",
      parameters: scratchpadParams,
      execute: scratchpadExecute,
    } as any,
  );
}
