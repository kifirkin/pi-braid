/**
 * Scratchpad Extension — Structured Session Memory (CCA L2)
 *
 * Per-loop persistent state for continuity of thought across turns.
 * Persists to disk per-project so it survives process restarts.
 *
 * Types extracted to types.ts, persistence to persistence.ts.
 * Index re-exports both for backward compatibility.
 */

import { createLogger } from "../../../lib/core/logger.js";

const log = createLogger("scratchpad");

import { Type } from "typebox";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

// ── Re-export types and persistence for importers ─────────────────────────
export * from "./types.js";
export * from "./persistence.js";

import type {
  TaskScratchpad,
  Decision,
  Constraint,
  KeyLearning,
  SessionPhase,
  PlanStep,
} from "./types.js";

import {
  projectSlugFromCwd,
  createScratchpad,
  saveScratchpadToDisk,
  loadScratchpadFromDisk,
} from "./persistence.js";

import { getExtensionState } from "../../../lib/state/extension-state.js";

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
  pruned_plan: number;
  pruned_done: number;
  pruned_decisions: number;
  pruned_hypotheses: number;
  pruned_notes: number;
  pruned_learnings: number;
  pruned_constraints: number;
  archived_goal: string | null;
  total_pruned: number;
};

function scratchpadClean(pad: TaskScratchpad): RecycleStats {
  const stats: RecycleStats = {
    pruned_plan: 0,
    pruned_done: 0,
    pruned_decisions: 0,
    pruned_hypotheses: 0,
    pruned_notes: 0,
    pruned_learnings: 0,
    pruned_constraints: 0,
    archived_goal: null,
    total_pruned: 0,
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
    stats.pruned_plan +
    stats.pruned_done +
    stats.pruned_decisions +
    stats.pruned_hypotheses +
    stats.pruned_notes +
    stats.pruned_learnings +
    stats.pruned_constraints;
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

function generateLearningId(): string {
  return `lrn-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
}
function generateConstraintId(): string {
  return `con-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
}

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
  cycles: number;
  pruned: number;
  goals: number;
  decisions: number;
  learnings: number;
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
  const cwd = (ctx as { cwd?: string }).cwd ?? "";
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
  const cwd = (ctx as { cwd?: string }).cwd ?? "";
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
]);

const VALID_LEARNING_CATEGORIES = [
  "root_cause",
  "pattern",
  "fix",
  "constraint",
  "codebase_fact",
] as const;
type LearningCategory = (typeof VALID_LEARNING_CATEGORIES)[number];

/** Aliases that map to canonical categories. Lowercased before matching. */
const LEARNING_CATEGORY_ALIASES: Record<string, LearningCategory> = {
  // root_cause aliases
  rootcause: "root_cause",
  "root-cause": "root_cause",
  root: "root_cause",
  cause: "root_cause",
  bug: "root_cause",
  defect: "root_cause",
  // pattern aliases
  pattern: "pattern",
  convention: "pattern",
  idiom: "pattern",
  heuristic: "pattern",
  insight: "pattern",
  // fix aliases
  fix: "fix",
  solution: "fix",
  solution_summary: "fix",
  resolved: "fix",
  workaround: "fix",
  patch: "fix",
  // constraint aliases
  constraint: "constraint",
  rule: "constraint",
  limit: "constraint",
  invariant: "constraint",
  requirement: "constraint",
  // codebase_fact aliases
  codebase_fact: "codebase_fact",
  codebase: "codebase_fact",
  fact: "codebase_fact",
  "codebase-fact": "codebase_fact",
  "code-fact": "codebase_fact",
  codefact: "codebase_fact",
};

function resolveCategory(raw: string): LearningCategory | null {
  const key = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if ((VALID_LEARNING_CATEGORIES as readonly string[]).includes(key)) {
    return key as LearningCategory;
  }
  return LEARNING_CATEGORY_ALIASES[key] ?? null;
}

const scratchpadParams = Type.Object({
  action: readAction,
  text: Type.Optional(Type.String({ description: "Text content" })),
  category: Type.Optional(
    Type.String({
      description:
        "Category for add_learning (alternative to pipe-delimited text). One of: root_cause, pattern, fix, constraint, codebase_fact (aliases accepted).",
    }),
  ),
  content: Type.Optional(
    Type.String({
      description: "Learning content for add_learning (alternative to pipe-delimited text).",
    }),
  ),
  scope: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional scope tags for add_learning (file paths, areas, etc.).",
    }),
  ),
  successCriteria: Type.Optional(Type.Array(Type.String(), { description: "Success criteria" })),
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
  const expires_in_ms = params.expires_in_ms as number | undefined;

  const pad = await getOrCreateScratchpad(ctx);

  if (!pad) {
    return {
      content: [{ type: "text" as const, text: "Error: Could not load scratchpad." }],
      details: { error: "scratchpad_load_failed" },
    };
  }

  const priorGoal = pad.goal;
  let resultText = ""; // eslint-disable-line no-useless-assignment

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
      const step: PlanStep = {
        text: planText,
        budgetCalls,
        spentCalls: 0,
        startTurn: pad.session.turn,
        doneTurn: 0,
        startTotalCalls: 0,
      };
      const budgetStr = budgetCalls ? ` [budget: ${budgetCalls} calls]` : "";
      capPush(pad.plan, step, RECYCLE.MAX_PLAN);
      await mutateAndSave(pad);
      resultText = `Step added: ${planText}${budgetStr}`;
      break;
    }

    case "mark_done": {
      const step = pad.plan.find((s) => s.text === text);
      if (step) {
        step.doneTurn = pad.session.turn;
        capPush(pad.done, text, RECYCLE.MAX_DONE);
        resultText = `Completed: ${text}`;
      } else {
        // Fallback: just add to done
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
      capPush(pad.decisions, decision, RECYCLE.MAX_DECISIONS);
      await mutateAndSave(pad);
      resultText = `Decision recorded: ${decisionText}${reason ? ` (${reason})` : ""}`;
      break;
    }

    case "add_hypothesis": {
      capPush(pad.hypotheses, text, RECYCLE.MAX_HYPOTHESES);
      await mutateAndSave(pad);
      resultText = `Hypothesis added: ${text}`;
      break;
    }

    case "add_note": {
      capPush(pad.notes, text, RECYCLE.MAX_NOTES);
      await mutateAndSave(pad);
      resultText = `Note added: ${text}`;
      break;
    }

    case "update_session": {
      if (params.turn !== undefined) pad.session.turn = params.turn as number;
      if (params.phase !== undefined) pad.session.phase = params.phase as SessionPhase;
      if (params.mode !== undefined)
        pad.session.mode = params.mode as "normal" | "deep_think" | "recovery";
      pad.session.updated_at = Date.now();
      await mutateAndSave(pad);
      resultText = `Session: turn=${pad.session.turn}, phase=${pad.session.phase}, mode=${pad.session.mode}`;
      break;
    }

    case "add_constraint": {
      // Format: "type|description"
      const [type, ...descParts] = text.split("|");
      const desc = descParts.join("|") || type;
      const cType = (type as Constraint["type"]) || "custom";
      const constraint: Constraint = {
        id: generateConstraintId(),
        type: ["blocker", "enforcement_rule", "invariant", "custom"].includes(cType)
          ? cType
          : "custom",
        description: desc,
        added_at: Date.now(),
        expires_at: expires_in_ms ? Date.now() + expires_in_ms : 0,
        acknowledged: false,
      };
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
      // Two accepted formats (prefer the explicit fields):
      //   1. Explicit: params.category + params.content + params.scope
      //   2. Legacy pipe-delimited text: "category|content|scope1,scope2"
      //
      // The legacy format is still supported for backward compatibility, but
      // the explicit fields are easier for the model to use correctly.
      let rawCategory: string;
      let content: string;
      let scope: string[];

      const explicitCategory = params.category as string | undefined;
      const explicitContent = params.content as string | undefined;
      const explicitScope = params.scope as string[] | undefined;

      if (explicitCategory || explicitContent) {
        // Explicit-field path
        rawCategory = (explicitCategory ?? "").trim();
        content = (explicitContent ?? "").trim();
        scope = Array.isArray(explicitScope) ? explicitScope : [];
        if (!rawCategory || !content) {
          resultText =
            `add_learning requires both 'category' and 'content'. ` +
            `Got: category=${JSON.stringify(explicitCategory)}, content=${JSON.stringify(explicitContent)}. ` +
            `Valid categories: ${VALID_LEARNING_CATEGORIES.join(", ")} (aliases accepted).`;
          break;
        }
      } else {
        // Legacy pipe-delimited text path
        const parts = text.split("|").map((s) => s.trim());
        rawCategory = parts[0] ?? "";
        content = (parts[1] || parts[0] || "").trim();
        scope = parts[2] ? parts[2].split(",").map((s) => s.trim()).filter(Boolean) : [];
        if (!rawCategory) {
          resultText =
            `Invalid add_learning format. Provide 'category' and 'content' as separate fields, ` +
            `or use pipe-delimited text: "category|content|scope". ` +
            `Valid categories: ${VALID_LEARNING_CATEGORIES.join(", ")} (aliases accepted).`;
          break;
        }
      }

      const category = resolveCategory(rawCategory);
      if (!category) {
        resultText =
          `Invalid category: "${rawCategory}". ` +
          `Valid: ${VALID_LEARNING_CATEGORIES.join(", ")}. ` +
          `Common aliases: bug/defect→root_cause, insight/idiom→pattern, ` +
          `solution/patch→fix, rule/requirement→constraint, fact/codefact→codebase_fact. ` +
          `Tip: use the explicit 'category' and 'content' fields to avoid pipe-format confusion.`;
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
      if (successCriteria) {
        /* stored for future use */
      }
      await mutateAndSave(pad);
      resultText = `Elevated to goal: ${text || "current goal"}`;
      break;
    }

    case "elevate_to_plan": {
      if (text) {
        const step: PlanStep = {
          text,
          budgetCalls: undefined,
          spentCalls: 0,
          startTurn: pad.session.turn,
          doneTurn: 0,
          startTotalCalls: 0,
        };
        capPush(pad.plan, step, RECYCLE.MAX_PLAN);
      }
      await mutateAndSave(pad);
      resultText = `Elevated to plan: ${text || "current plan"}`;
      break;
    }

    default:
      resultText = `Unknown action: ${action}. Use: read, set_goal, add_plan, mark_done, add_decision, add_hypothesis, add_note, update_session, add_constraint, remove_constraint, add_learning, persist_learnings, note_compact, elevate_to_goal, elevate_to_plan. For task management, use the 'task' tool.`;
  }

  return {
    content: [{ type: "text" as const, text: resultText }],
    details: { action, prior_goal: pad.prior_goal ? "exists" : undefined, plan: pad.plan.length },
  };
}

// ── Tool Registration ─────────────────────────────────────────────────────

export default function scratchpadExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "scratchpad",
    label: "Scratchpad",
    promptSnippet: "Structured session memory for goal, plan, and decisions",
    description:
      "Track goals, plans, TODOs, notes, decisions, and learnings throughout multi-step tasks using structured session memory. " +
      "Common actions: set_goal, add_plan, mark_done, add_note, add_decision, add_learning, read. " +
      "For add_learning, prefer explicit 'category' + 'content' fields over pipe-delimited text. " +
      "Plan items (added via add_plan, completed via mark_done) serve as the task list. " +
      "For richer task state (priority, dependencies, tags, fail/next/clear), add plan items and use read to view them.",
    parameters: scratchpadParams,
    execute: scratchpadExecute,
  } as unknown as ToolDefinition<any, any, any>);
}
