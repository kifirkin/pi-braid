/**
 * Scratchpad action handlers - split from index.ts for maintainability.
 *
 * Each handler group is a function that takes the action-specific params
 * plus the loaded pad, mutates the pad, returns the result text and
 * (optionally) a save error.
 *
 * Groups:
 *   1. read+continue+set_goal - state inspection and goal management
 *   2. plan lifecycle - add_plan, mark_done, remove_plan, elevate_to_plan
 *   3. notes/decisions/hypotheses - add_*, remove_*, clear_done, archive_done
 *   4. learning+constraint - add_learning, add_constraint, remove_constraint, persist_learnings
 *   5. maintenance - note_compact, update_session, elevate_to_goal
 *
 * The dispatch logic lives in index.ts:scratchpadExecute. This file is
 * pure (no I/O) - all persistence is handled by mutateAndSave in index.ts.
 */

import { appendFile } from "node:fs/promises";
import * as path from "node:path";
import { SCRATCHPAD_DIR } from "../../../lib/config/braid-paths.js";
import { nextId } from "../../../lib/utils/id.js";
import type {
  Constraint,
  Decision,
  DoneItem,
  HypothesisItem,
  KeyLearning,
  NoteItem,
  PlanStep,
  SessionPhase,
  TaskScratchpad,
} from "./types.js";
import { formatScratchpad, formatContinueDigest } from "./format.js";
import {
  capPush,
  generateConstraintId,
  generateLearningId,
  findByIdOrText,
  resolveCategory,
  VALID_LEARNING_CATEGORIES,
  RECYCLE,
  mutateAndSave,
  scratchpadClean,
} from "./utils.js";

// ── Shared handler result type ─────────────────────────────────────────

export interface HandlerResult {
  resultText: string;
  saveError?: string;
}

// ── 1. Read / Continue / Set Goal ──────────────────────────────────────

export function handleRead(
  pad: TaskScratchpad,
  filter?: {
    ids?: string[];
    sinceTurn?: number;
    untilTurn?: number;
    category?: string;
    limit?: number;
  },
): HandlerResult {
  return { resultText: formatScratchpad(pad, filter) };
}

export function handleContinue(pad: TaskScratchpad): HandlerResult {
  return { resultText: formatContinueDigest(pad) };
}

export async function handleSetGoal(
  pad: TaskScratchpad,
  text: string,
  priorGoal: string,
): Promise<HandlerResult> {
  if (!text.trim()) {
    return {
      resultText: "set_goal requires non-empty 'text' describing the objective.",
    };
  }
  if (pad.goal && pad.goal !== "Untitled" && pad.goal !== text) {
    pad.prior_goal = pad.goal;
  }
  pad.goal = text;
  pad.prior_goal = pad.prior_goal || priorGoal;
  const saveError = await mutateAndSave(pad);
  return {
    resultText: `Goal set: ${text}`,
    saveError: saveError ?? undefined,
  };
}

// ── 2. Plan Lifecycle ──────────────────────────────────────────────────

export async function handleAddPlan(
  pad: TaskScratchpad,
  text: string,
): Promise<HandlerResult> {
  if (!text.trim()) {
    return {
      resultText: "add_plan requires non-empty 'text' describing the step.",
    };
  }
  // Parse optional budget field [budget:N]
  let budgetCalls: number | undefined;
  let planText = text;
  const budgetMatch = text.match(/\s*\[budget:\s*(\d+)\]\s*$/i);
  if (budgetMatch) {
    budgetCalls = parseInt(budgetMatch[1], 10);
    planText = text.slice(0, budgetMatch.index!).trim();
  }
  const step: PlanStep = {
    id: nextId("pl"),
    text: planText,
    budgetCalls,
    spentCalls: 0,
    startTurn: pad.session.turn,
    doneTurn: 0,
    startTotalCalls: 0,
  };
  const budgetStr = budgetCalls ? ` [budget: ${budgetCalls} calls]` : "";
  capPush(pad.plan, step, RECYCLE.MAX_PLAN);
  const saveError = await mutateAndSave(pad);
  return {
    resultText: `Step added: ${planText}${budgetStr} (id: ${step.id})`,
    saveError: saveError ?? undefined,
  };
}

export async function handleMarkDone(
  pad: TaskScratchpad,
  text: string,
  idOrText: string | undefined,
): Promise<HandlerResult> {
  // Accept either text match (legacy) or id (preferred).
  const target = idOrText ?? text;
  const step = pad.plan.find((s) => s.id === target || s.text === target);
  const now = Date.now();
  if (step) {
    step.doneTurn = pad.session.turn;
    const doneItem: DoneItem = {
      id: nextId("dn"),
      text: step.text,
      turn: pad.session.turn,
      addedAt: now,
    };
    capPush(pad.done, doneItem, RECYCLE.MAX_DONE);
    const saveError = await mutateAndSave(pad);
    return {
      resultText: `Completed: ${doneItem.text} (id: ${doneItem.id})`,
      saveError: saveError ?? undefined,
    };
  }
  // Fallback: id provided but no matching plan step
  if (idOrText) {
    return {
      resultText: `Plan step not found: ${idOrText}. Use scratchpad read to list available steps.`,
    };
  }
  // Fallback: text match only (legacy), add to done directly
  if (!text.trim()) {
    return {
      resultText: "mark_done requires an 'id' (from add_plan) or 'text' (matching a plan step).",
    };
  }
  const doneItem: DoneItem = {
    id: nextId("dn"),
    text,
    turn: pad.session.turn,
    addedAt: now,
  };
  capPush(pad.done, doneItem, RECYCLE.MAX_DONE);
  const saveError = await mutateAndSave(pad);
  return {
    resultText: `Completed: ${doneItem.text} (id: ${doneItem.id})`,
    saveError: saveError ?? undefined,
  };
}

export async function handleRemovePlan(
  pad: TaskScratchpad,
  target: string | undefined,
): Promise<HandlerResult> {
  if (!target) {
    return { resultText: "remove_plan requires 'id' or 'text'." };
  }
  const { item, index } = findByIdOrText(pad.plan, target);
  if (!item) {
    return { resultText: `Plan step not found: ${target}` };
  }
  pad.plan.splice(index, 1);
  const saveError = await mutateAndSave(pad);
  return {
    resultText: `Plan step removed: ${item.text} (id: ${item.id})`,
    saveError: saveError ?? undefined,
  };
}

export async function handleElevateToPlan(
  pad: TaskScratchpad,
  text: string,
): Promise<HandlerResult> {
  if (text) {
    const step: PlanStep = {
      id: nextId("pl"),
      text,
      budgetCalls: undefined,
      spentCalls: 0,
      startTurn: pad.session.turn,
      doneTurn: 0,
      startTotalCalls: 0,
    };
    capPush(pad.plan, step, RECYCLE.MAX_PLAN);
  }
  const saveError = await mutateAndSave(pad);
  return {
    resultText: `Elevated to plan: ${text || "current plan"}`,
    saveError: saveError ?? undefined,
  };
}

// ── 3. Notes / Decisions / Hypotheses (and bulk operations) ──────────────

export async function handleAddDecision(
  pad: TaskScratchpad,
  text: string,
): Promise<HandlerResult> {
  if (!text.trim()) {
    return {
      resultText: "add_decision requires non-empty 'text' describing the decision.",
    };
  }
  // Parse optional reason: "decision|reason"
  let decisionText = text;
  let reason: string | undefined;
  const sepIndex = text.indexOf("|");
  if (sepIndex > 0) {
    decisionText = text.slice(0, sepIndex).trim();
    reason = text.slice(sepIndex + 1).trim();
  }
  const decision: Decision = {
    id: nextId("dc"),
    text: decisionText,
    reason,
    turn: pad.session.turn,
  };
  capPush(pad.decisions, decision, RECYCLE.MAX_DECISIONS);
  const saveError = await mutateAndSave(pad);
  return {
    resultText: `Decision recorded: ${decisionText}${reason ? ` (${reason})` : ""} (id: ${decision.id})`,
    saveError: saveError ?? undefined,
  };
}

export async function handleAddHypothesis(
  pad: TaskScratchpad,
  text: string,
): Promise<HandlerResult> {
  if (!text.trim()) {
    return {
      resultText: "add_hypothesis requires non-empty 'text' describing the hypothesis.",
    };
  }
  const hyp: HypothesisItem = {
    id: nextId("hp"),
    text,
    turn: pad.session.turn,
    addedAt: Date.now(),
  };
  capPush(pad.hypotheses, hyp, RECYCLE.MAX_HYPOTHESES);
  const saveError = await mutateAndSave(pad);
  return {
    resultText: `Hypothesis added: ${text} (id: ${hyp.id})`,
    saveError: saveError ?? undefined,
  };
}

export async function handleAddNote(
  pad: TaskScratchpad,
  text: string,
): Promise<HandlerResult> {
  if (!text.trim()) {
    return {
      resultText: "add_note requires non-empty 'text' describing the note.",
    };
  }
  const note: NoteItem = {
    id: nextId("nt"),
    text,
    turn: pad.session.turn,
    addedAt: Date.now(),
  };
  capPush(pad.notes, note, RECYCLE.MAX_NOTES);
  const saveError = await mutateAndSave(pad);
  return {
    resultText: `Note added: ${text} (id: ${note.id})`,
    saveError: saveError ?? undefined,
  };
}

export async function handleRemoveNote(
  pad: TaskScratchpad,
  target: string | undefined,
): Promise<HandlerResult> {
  if (!target) {
    return { resultText: "remove_note requires 'id' or 'text'." };
  }
  const { item, index } = findByIdOrText(pad.notes, target);
  if (!item) {
    return { resultText: `Note not found: ${target}` };
  }
  pad.notes.splice(index, 1);
  const saveError = await mutateAndSave(pad);
  return {
    resultText: `Note removed: ${item.text} (id: ${item.id})`,
    saveError: saveError ?? undefined,
  };
}

export async function handleRemoveDecision(
  pad: TaskScratchpad,
  target: string | undefined,
): Promise<HandlerResult> {
  if (!target) {
    return { resultText: "remove_decision requires 'id' or 'text'." };
  }
  const { item, index } = findByIdOrText(pad.decisions, target);
  if (!item) {
    return { resultText: `Decision not found: ${target}` };
  }
  pad.decisions.splice(index, 1);
  const saveError = await mutateAndSave(pad);
  return {
    resultText: `Decision removed: ${item.text} (id: ${item.id})`,
    saveError: saveError ?? undefined,
  };
}

export async function handleRemoveHypothesis(
  pad: TaskScratchpad,
  target: string | undefined,
): Promise<HandlerResult> {
  if (!target) {
    return { resultText: "remove_hypothesis requires 'id' or 'text'." };
  }
  const { item, index } = findByIdOrText(pad.hypotheses, target);
  if (!item) {
    return { resultText: `Hypothesis not found: ${target}` };
  }
  pad.hypotheses.splice(index, 1);
  const saveError = await mutateAndSave(pad);
  return {
    resultText: `Hypothesis removed: ${item.text} (id: ${item.id})`,
    saveError: saveError ?? undefined,
  };
}

export async function handleClearDone(pad: TaskScratchpad): Promise<HandlerResult> {
  const count = pad.done.length;
  pad.done = [];
  const saveError = await mutateAndSave(pad);
  return {
    resultText: `Cleared ${count} done items.`,
    saveError: saveError ?? undefined,
  };
}

export async function handleArchiveDone(pad: TaskScratchpad): Promise<HandlerResult> {
  // Append archived done items to <slug>/archive.jsonl. Items are
  // NOT deleted from memory; this just moves them to disk in
  // append-only form so a future session can query them.
  const slug = pad.projectSlug;
  const archivePath = path.join(SCRATCHPAD_DIR, slug, "archive.jsonl");
  const lines = pad.done.map((d) =>
    JSON.stringify({
      kind: "done",
      text: d.text,
      turn: d.turn,
      addedAt: d.addedAt,
      id: d.id,
    }),
  );
  if (lines.length > 0) {
    try {
      await appendFile(archivePath, lines.join("\n") + "\n", "utf-8");
    } catch {
      // Best-effort archive
    }
  }
  const count = pad.done.length;
  pad.done = [];
  const saveError = await mutateAndSave(pad);
  return {
    resultText: `Archived ${count} done items to ${archivePath}`,
    saveError: saveError ?? undefined,
  };
}

// ── 4. Learning / Constraint ───────────────────────────────────────────

export async function handleAddConstraint(
  pad: TaskScratchpad,
  text: string,
  expires_in_ms: number | undefined,
): Promise<HandlerResult> {
  if (!text.trim()) {
    return {
      resultText: "add_constraint requires non-empty 'text' in format 'type|description'.",
    };
  }
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
  const saveError = await mutateAndSave(pad);
  return {
    resultText: `Constraint added: [${constraint.type}] ${desc} (id: ${constraint.id})`,
    saveError: saveError ?? undefined,
  };
}

export async function handleRemoveConstraint(
  pad: TaskScratchpad,
  constraintId: string,
): Promise<HandlerResult> {
  const idx = pad.constraints.findIndex((c) => c.id === constraintId);
  if (idx >= 0) {
    pad.constraints.splice(idx, 1);
    const saveError = await mutateAndSave(pad);
    return {
      resultText: `Constraint removed: ${constraintId}`,
      saveError: saveError ?? undefined,
    };
  }
  return { resultText: `Constraint not found: ${constraintId}` };
}

export async function handleAddLearning(
  pad: TaskScratchpad,
  explicitCategory: string | undefined,
  explicitContent: string | undefined,
  explicitScope: string[] | undefined,
): Promise<HandlerResult> {
  // Single format: explicit category + content + scope.
  // Legacy pipe-delimited text format removed in P2-9 (2026-07-02).
  const rawCategory = (explicitCategory ?? "").trim();
  const content = (explicitContent ?? "").trim();
  const scope = Array.isArray(explicitScope) ? explicitScope : [];
  if (!rawCategory || !content) {
    return {
      resultText:
        `add_learning requires both 'category' and 'content'. ` +
        `Got: category=${JSON.stringify(explicitCategory)}, content=${JSON.stringify(explicitContent)}. ` +
        `Valid categories: ${VALID_LEARNING_CATEGORIES.join(", ")} (aliases accepted).`,
    };
  }

  const category = resolveCategory(rawCategory);
  if (!category) {
    return {
      resultText:
        `Invalid category: "${rawCategory}". ` +
        `Valid: ${VALID_LEARNING_CATEGORIES.join(", ")}. ` +
        `Common aliases: bug/defect->root_cause, insight/idiom->pattern, ` +
        `solution/patch->fix, rule/requirement->constraint, fact/codefact->codebase_fact.`,
    };
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
  const saveError = await mutateAndSave(pad);
  return {
    resultText: `Learning added: [${category}] ${content} (scope: ${scope.join(", ") || "all"}) (id: ${learning.id})`,
    saveError: saveError ?? undefined,
  };
}

export async function handlePersistLearnings(pad: TaskScratchpad): Promise<HandlerResult> {
  const unp = pad.key_learnings.filter((l) => !l.persisted);
  for (const l of unp) l.persisted = true;
  const saveError = await mutateAndSave(pad);
  return {
    resultText: `${unp.length} unp persisted learnings flagged for persistence (id: ${unp.map((l) => l.id).join(", ")})`,
    saveError: saveError ?? undefined,
  };
}

// ── 5. Maintenance ─────────────────────────────────────────────────────

export async function handleNoteCompact(pad: TaskScratchpad): Promise<HandlerResult> {
  const stats = scratchpadClean(pad);
  // ROADMAP P3-8 / DR-M-1: skip disk write when nothing was pruned.
  if (stats.total_pruned > 0) {
    const saveError = await mutateAndSave(pad);
    return {
      resultText: `Scratchpad compacted: plan(-${stats.pruned_plan}), done(-${stats.pruned_done}), decisions(-${stats.pruned_decisions}), hypotheses(-${stats.pruned_hypotheses}), notes(-${stats.pruned_notes})`,
      saveError: saveError ?? undefined,
    };
  }
  return { resultText: "Scratchpad already compact (nothing to prune)." };
}

export async function handleUpdateSession(
  pad: TaskScratchpad,
  params: Record<string, unknown>,
): Promise<HandlerResult> {
  if (params.turn !== undefined) pad.session.turn = params.turn as number;
  if (params.phase !== undefined) pad.session.phase = params.phase as SessionPhase;
  if (params.mode !== undefined)
    pad.session.mode = params.mode as "normal" | "deep_think" | "recovery";
  pad.session.updated_at = Date.now();
  const saveError = await mutateAndSave(pad);
  return {
    resultText: `Session: turn=${pad.session.turn}, phase=${pad.session.phase}, mode=${pad.session.mode}`,
    saveError: saveError ?? undefined,
  };
}

export async function handleElevateToGoal(
  pad: TaskScratchpad,
  text: string,
): Promise<HandlerResult> {
  if (text) {
    if (pad.goal && pad.goal !== "Untitled") pad.prior_goal = pad.goal;
    pad.goal = text;
  }
  const saveError = await mutateAndSave(pad);
  return {
    resultText: `Elevated to goal: ${text || "current goal"}`,
    saveError: saveError ?? undefined,
  };
}

// ── Dispatch Table ────────────────────────────────────────────────────────
//
// Replaces a ~200-line switch in scratchpadExecute (index.ts) with a
// uniform dispatch lookup. Each entry maps an action name to a function
// with the canonical (pad, params, text, idOrText, priorGoal) signature.
// Extra params (filter, expires_in_ms, category, etc.) are extracted from
// the raw params Record inside each dispatch function body.

export type ActionFn = (
  pad: TaskScratchpad,
  params: Record<string, unknown>,
  text: string,
  idOrText: string,
  priorGoal: string,
) => HandlerResult | Promise<HandlerResult>;

export const ACTION_DISPATCH: Record<string, ActionFn> = {
  read: (p, params) => handleRead(p, params.filter as any),
  continue: (p) => handleContinue(p),
  set_goal: (p, params, text, _idOrText, priorGoal) => handleSetGoal(p, text, priorGoal),
  add_plan: (p, _params, text) => handleAddPlan(p, text),
  mark_done: (p, _params, text, idOrText) => handleMarkDone(p, text, idOrText),
  add_decision: (p, _params, text) => handleAddDecision(p, text),
  add_hypothesis: (p, _params, text) => handleAddHypothesis(p, text),
  add_note: (p, _params, text) => handleAddNote(p, text),
  update_session: (p, params) => handleUpdateSession(p, params),
  add_constraint: (p, params, text) =>
    handleAddConstraint(p, text, params.expires_in_ms as number | undefined),
  remove_constraint: (p, params, text) => {
    const constraintId = (params.constraint_id as string | undefined) ?? text;
    return handleRemoveConstraint(p, constraintId);
  },
  add_learning: (p, params) =>
    handleAddLearning(
      p,
      params.category as string | undefined,
      params.content as string | undefined,
      params.scope as string[] | undefined,
    ),
  persist_learnings: (p) => handlePersistLearnings(p),
  note_compact: (p) => handleNoteCompact(p),
  elevate_to_goal: (p, _params, text) => handleElevateToGoal(p, text),
  elevate_to_plan: (p, _params, text) => handleElevateToPlan(p, text),
  remove_plan: (p, _params, _text, idOrText) => handleRemovePlan(p, idOrText),
  remove_note: (p, _params, _text, idOrText) => handleRemoveNote(p, idOrText),
  remove_decision: (p, _params, _text, idOrText) => handleRemoveDecision(p, idOrText),
  remove_hypothesis: (p, _params, _text, idOrText) => handleRemoveHypothesis(p, idOrText),
  clear_done: (p) => handleClearDone(p),
  archive_done: (p) => handleArchiveDone(p),
};
