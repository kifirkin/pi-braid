/**
 * Scratchpad Extension - structured session memory.
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
// Import dispatch table from handlers.ts (per-action logic is co-located there).
import { ACTION_DISPATCH } from "./handlers.js";
export { ACTION_DISPATCH } from "./handlers.js";

import type { TaskScratchpad } from "./types.js";

import { projectSlugFromCwd, createScratchpad, loadScratchpadFromDisk } from "./persistence.js";

interface ScratchpadCache {
  pad: TaskScratchpad | null;
}

/**
 * A blank string is "not provided". A client that emits every schema key sends
 * "" for the keys it does not use, and `??` alone keeps that "" as a real value
 * (a blank id would then be looked up literally instead of falling back to the
 * text). Whitespace-only counts as blank: the handlers refuse such text anyway.
 */
function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
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

  const cache = getCache(ctx);
  if (cache.pad) return cache.pad;

  const saved = await loadScratchpadFromDisk(slug);
  if (saved) {
    cache.pad = saved;
    return saved;
  }

  if (!goal) goal = "Untitled";
  const pad = createScratchpad(goal, slug);
  cache.pad = pad;
  return pad;
}

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
        "add_learning category: root_cause, pattern, fix, constraint, codebase_fact (aliases accepted).",
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
  constraint_id: Type.Optional(Type.String({ description: "Constraint ID" })),
  expires_in_ms: Type.Optional(Type.Number({ description: "TTL in ms for constraint expiry" })),
  // ID for targeted removal of plan/note/decision/hypothesis items.
  // Accepts the id returned by add_* / mark_done, or a text match.
  id: Type.Optional(
    Type.String({
      description: "ID for remove_* actions. Falls back to text match if not an exact id.",
    }),
  ),
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
  const text = nonBlank(params.text) ?? "";
  const idOrText = nonBlank(params.id) ?? text;

  const pad = await getOrCreateScratchpad(ctx);

  if (!pad) {
    return {
      content: [{ type: "text" as const, text: "Error: Could not load scratchpad." }],
      details: { error: "scratchpad_load_failed" },
    };
  }

  const priorGoal = pad.goal;
  let resultText: string;
  let lastSaveError: string | null = null;

  const handler = ACTION_DISPATCH[action];
  if (handler) {
    const r = await handler(pad, params, text, idOrText, priorGoal);
    resultText = r.resultText;
    lastSaveError = r.saveError ?? null;
  } else {
    resultText = `Unknown action: ${action}. Use: read, continue, set_goal, add_plan, mark_done, add_decision, add_hypothesis, add_note, update_session, add_constraint, remove_constraint, add_learning, persist_learnings, note_compact, elevate_to_goal, elevate_to_plan, remove_plan, remove_note, remove_decision, remove_hypothesis, clear_done, archive_done. For task management, use the 'task' tool.`;
  }

  // Append the disk-write error to the result when the most
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

function createScratchpadTool(): ToolDefinition<any, any, any> {
  return {
    name: "scratchpad",
    label: "Scratchpad",
    promptSnippet: "Structured session memory for goal, plan, and decisions",
    description:
      "Track goals, plans, TODOs, notes, decisions, and learnings across multi-step tasks with structured session memory. " +
      "Use set_goal + add_plan to start, add_note/mark_done to log progress, continue to resume; for project-scoped work, not the SDK task tool.",
    parameters: scratchpadParams,
    execute: scratchpadExecute,
  };
}

export default function scratchpadExtension(pi: ExtensionAPI): void {
  pi.registerTool(createScratchpadTool());
}
