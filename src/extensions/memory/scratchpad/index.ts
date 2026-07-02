/**
 * Scratchpad Extension - Structured Session Memory (CCA L2)
 *
 * Per-loop persistent state for continuity of thought across turns.
 * Persists to disk per-project so it survives process restarts.
 *
 * Types extracted to types.ts, persistence to persistence.ts.
 * Index re-exports both for backward compatibility.
 */


import { getExtensionState } from "../../../lib/state/extension-state.js";

import { Type } from "typebox";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

// ── Re-export types, persistence, and format for importers ──────────────
export * from "./types.js";
export * from "./persistence.js";
export * from "./format.js";
// Re-export shared utilities (handlers.ts imports from utils.ts; index.ts
// keeps the public surface for backward compat with any external importers).
export {
  RECYCLE,
  scratchpadClean,
  capPush,
  generateLearningId,
  generateConstraintId,
  findByIdOrText,
  resolveCategory,
  VALID_LEARNING_CATEGORIES,
  LEARNING_CATEGORY_ALIASES,
  mutateAndSave,
} from "./utils.js";
// Import handler functions for local use (and re-export them).
import {
  handleRead,
  handleContinue,
  handleSetGoal,
  handleAddPlan,
  handleMarkDone,
  handleAddDecision,
  handleAddHypothesis,
  handleAddNote,
  handleAddConstraint,
  handleRemoveConstraint,
  handleAddLearning,
  handlePersistLearnings,
  handleNoteCompact,
  handleUpdateSession,
  handleElevateToGoal,
  handleElevateToPlan,
  handleRemovePlan,
  handleRemoveNote,
  handleRemoveDecision,
  handleRemoveHypothesis,
  handleClearDone,
  handleArchiveDone,
} from "./handlers.js";
export {
  handleRead,
  handleContinue,
  handleSetGoal,
  handleAddPlan,
  handleMarkDone,
  handleAddDecision,
  handleAddHypothesis,
  handleAddNote,
  handleAddConstraint,
  handleRemoveConstraint,
  handleAddLearning,
  handlePersistLearnings,
  handleNoteCompact,
  handleUpdateSession,
  handleElevateToGoal,
  handleElevateToPlan,
  handleRemovePlan,
  handleRemoveNote,
  handleRemoveDecision,
  handleRemoveHypothesis,
  handleClearDone,
  handleArchiveDone,
} from "./handlers.js";

import type {
  TaskScratchpad,
} from "./types.js";

import {
  projectSlugFromCwd,
  createScratchpad,
  loadScratchpadFromDisk,
} from "./persistence.js";

// ── Note: RECYCLE, scratchpadClean, capPush, generateLearningId,
// generateConstraintId, findByIdOrText, mutateAndSave are imported from
// ./utils.js (re-exported above for backward compat). Validation
// category resolution (resolveCategory, VALID_LEARNING_CATEGORIES,
// LEARNING_CATEGORY_ALIASES) also lives in utils.ts.

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
  // Targeted removal actions for long-session hygiene.
  // Accept either an id ("pl-1234567-abc") or a text match.
  Type.Literal("remove_plan"),
  Type.Literal("remove_note"),
  Type.Literal("remove_decision"),
  Type.Literal("remove_hypothesis"),
  // Bulk actions for clearing history.
  Type.Literal("clear_done"),
  // Archive done items to disk (does NOT delete from memory; moves to
  // <slug>/archive.jsonl and removes from the active list).
  Type.Literal("archive_done"),
  // Resumption digest for fresh sessions. Call this with `continue` to
  // see goal + open plan + recent decisions + recent notes in one shot.
  // Cheaper than `read` for picking up where you left off.
  Type.Literal("continue"),
]);

const scratchpadParams = Type.Object({
  action: readAction,
  text: Type.Optional(Type.String({ description: "Text content" })),
  category: Type.Optional(
    Type.String({
      description:
        "Category for add_learning. One of: root_cause, pattern, fix, constraint, codebase_fact (aliases accepted).",
    }),
  ),
  content: Type.Optional(
    Type.String({
      description: "Learning content for add_learning.",
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
  // ID for targeted removal of plan/note/decision/hypothesis items.
  // Accepts the id returned by add_* / mark_done, or a text match.
  id: Type.Optional(
    Type.String({
      description: "ID for remove_* actions. Falls back to text match if not an exact id.",
    }),
  ),
  // Filter for the read action.
  filter: Type.Optional(
    Type.Object({
      /** Show only items with id in this list. */
      ids: Type.Optional(Type.Array(Type.String())),
      /** Show only items added after this turn. */
      sinceTurn: Type.Optional(Type.Number()),
      /** Show only items added before this turn. */
      untilTurn: Type.Optional(Type.Number()),
      /** Show only items in this category (for key_learnings). */
      category: Type.Optional(Type.String()),
      /** Limit total items returned per list. */
      limit: Type.Optional(Type.Number()),
    }),
  ),
});

// ── Tool Execute ──────────────────────────────────────────────────────────
//
// The actual case-by-case logic is in handlers.ts. This file is a thin
// router that extracts common params, calls the right handler, and wraps
// the result in the AgentToolResult envelope.

async function scratchpadExecute(
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
  const action = params.action as string;
  const text = (params.text as string) ?? "";
  const successCriteria = params.successCriteria as string[] | undefined;
  const expires_in_ms = params.expires_in_ms as number | undefined;
  const idOrText = (params.id as string | undefined) ?? text;

  const pad = await getOrCreateScratchpad(ctx);

  if (!pad) {
    return {
      content: [{ type: "text" as const, text: "Error: Could not load scratchpad." }],
      details: { error: "scratchpad_load_failed" },
    };
  }

  const priorGoal = pad.goal;
  let resultText = "";
  let lastSaveError: string | null = null;

  // ── Route to handler ──────────────────────────────────────────────
  switch (action) {
    case "read": {
      resultText = handleRead(
        pad,
        params.filter as
          | {
              ids?: string[];
              sinceTurn?: number;
              untilTurn?: number;
              category?: string;
              limit?: number;
            }
          | undefined,
      ).resultText;
      break;
    }
    case "continue":
      resultText = handleContinue(pad).resultText;
      break;
    case "set_goal": {
      const r = await handleSetGoal(pad, text, priorGoal);
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    case "add_plan": {
      const r = await handleAddPlan(pad, text);
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    case "mark_done": {
      const r = await handleMarkDone(pad, text, idOrText);
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    case "add_decision": {
      const r = await handleAddDecision(pad, text);
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    case "add_hypothesis": {
      const r = await handleAddHypothesis(pad, text);
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    case "add_note": {
      const r = await handleAddNote(pad, text);
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    case "update_session": {
      const r = await handleUpdateSession(pad, params);
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    case "add_constraint": {
      const r = await handleAddConstraint(pad, text, expires_in_ms);
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    case "remove_constraint": {
      const r = await handleRemoveConstraint(pad, text);
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    case "add_learning": {
      const r = await handleAddLearning(
        pad,
        params.category as string | undefined,
        params.content as string | undefined,
        params.scope as string[] | undefined,
      );
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    case "persist_learnings": {
      const r = await handlePersistLearnings(pad);
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    case "note_compact": {
      const r = await handleNoteCompact(pad);
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    case "elevate_to_goal": {
      const r = await handleElevateToGoal(pad, text, successCriteria);
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    case "elevate_to_plan": {
      const r = await handleElevateToPlan(pad, text);
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    case "remove_plan": {
      const r = await handleRemovePlan(pad, idOrText);
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    case "remove_note": {
      const r = await handleRemoveNote(pad, idOrText);
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    case "remove_decision": {
      const r = await handleRemoveDecision(pad, idOrText);
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    case "remove_hypothesis": {
      const r = await handleRemoveHypothesis(pad, idOrText);
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    case "clear_done": {
      const r = await handleClearDone(pad);
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    case "archive_done": {
      const r = await handleArchiveDone(pad);
      resultText = r.resultText;
      lastSaveError = r.saveError ?? null;
      break;
    }
    default:
      resultText = `Unknown action: ${action}. Use: read, continue, set_goal, add_plan, mark_done, add_decision, add_hypothesis, add_note, update_session, add_constraint, remove_constraint, add_learning, persist_learnings, note_compact, elevate_to_goal, elevate_to_plan, remove_plan, remove_note, remove_decision, remove_hypothesis, clear_done, archive_done. For task management, use the 'task' tool.`;
  }

  // ROADMAP P0-2 / DR-H-4: append disk-write error to result if the most
  // recent save failed. The in-memory pad is still updated; the next
  // session will lose these changes.
  if (lastSaveError) {
    resultText = `${resultText}\n\n${lastSaveError}`;
  }

  return {
    content: [{ type: "text" as const, text: resultText }],
    details: {
      action,
      prior_goal: pad.prior_goal ? "exists" : undefined,
      plan: pad.plan.length,
      save_error: lastSaveError ? true : undefined,
    },
  };
}

// ── Tool Registration ─────────────────────────────────────────────────────

function createScratchpadTool(): ToolDefinition<any, any, any> {
  return {
    name: "scratchpad",
    label: "Scratchpad",
    promptSnippet: "Structured session memory for goal, plan, and decisions",
    description:
      "Track goals, plans, TODOs, notes, decisions, and learnings throughout multi-step tasks using structured session memory. " +
      "Before starting work, use set_goal to define the objective and add_plan to break into steps. " +
      "After code changes, use add_note to track progress. Between sessions, call continue to resume full context. " +
      "Common actions: set_goal, add_plan, mark_done, add_note, add_decision, add_learning, continue, read. " +
      "The `continue` action returns a focused resumption digest (goal + open plan + recent context); `read` gives the full picture, or accept a `filter` for targeted inspection of long lists. " +
      "Long-session hygiene: `remove_plan/remove_note/remove_decision/remove_hypothesis` (by id), `clear_done`, `archive_done` (moves done to disk). " +
      "For add_learning, use the explicit 'category' + 'content' fields. " +
      "Plan items (added via add_plan, completed via mark_done) serve as the task list. " +
      "Use this scratchpad for project-scoped work - do NOT use the SDK's separate 'task' tool for the same purpose.",
    parameters: scratchpadParams,
    execute: scratchpadExecute,
  };
}

export default function scratchpadExtension(pi: ExtensionAPI): void {
  pi.registerTool(createScratchpadTool());
}
