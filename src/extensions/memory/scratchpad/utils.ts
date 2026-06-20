/**
 * Shared scratchpad utilities - extracted from index.ts to break the
 * circular dependency with handlers.ts.
 *
 * Both index.ts and handlers.ts import from here. index.ts also
 * re-exports these names for backward compatibility with any existing
 * importers.
 */

import { nextId } from "../../../lib/utils/id.js";
import { saveScratchpadToDisk } from "./persistence.js";
import type { TaskScratchpad } from "./types.js";

// ── Recycling Config ──────────────────────────────────────────────────────

export const RECYCLE = {
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

export type RecycleStats = {
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

export function scratchpadClean(pad: TaskScratchpad): RecycleStats {
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

export function capPush<T>(arr: T[], item: T, max: number): number {
  arr.push(item);
  if (arr.length > max) {
    const excess = arr.length - max;
    arr.splice(0, excess);
    return excess;
  }
  return 0;
}

// ── ID generation ───────────────────────────────────────────────────────

export function generateLearningId(): string {
  return nextId("lrn");
}

export function generateConstraintId(): string {
  return nextId("con");
}

// ── ID-or-text matching ─────────────────────────────────────────────────

/**
 * Find an item in a list by id (preferred) or by text match (fallback).
 * Returns the item and its index, or { item: null, index: -1 } if not found.
 */
export function findByIdOrText<T extends { id: string; text: string }>(
  list: T[],
  idOrText: string,
): { item: T | null; index: number } {
  // Try exact id match first
  const idxById = list.findIndex((it) => it.id === idOrText);
  if (idxById >= 0) return { item: list[idxById]!, index: idxById };
  // Fall back to text match
  const idxByText = list.findIndex((it) => it.text === idOrText);
  if (idxByText >= 0) return { item: list[idxByText]!, index: idxByText };
  return { item: null, index: -1 };
}

// ── Learning category resolution ─────────────────────────────────────────

export const VALID_LEARNING_CATEGORIES = [
  "root_cause",
  "pattern",
  "fix",
  "constraint",
  "codebase_fact",
] as const;
export type LearningCategory = (typeof VALID_LEARNING_CATEGORIES)[number];

/** Aliases that map to canonical categories. Lowercased before matching. */
export const LEARNING_CATEGORY_ALIASES: Record<string, LearningCategory> = {
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

export function resolveCategory(raw: string): LearningCategory | null {
  const key = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if ((VALID_LEARNING_CATEGORIES as readonly string[]).includes(key)) {
    return key as LearningCategory;
  }
  return LEARNING_CATEGORY_ALIASES[key] ?? null;
}

// ── Persistence helper ──────────────────────────────────────────────────

/**
 * Persist the pad to disk. Returns null on success, or a user-facing
 * warning string on failure. The in-memory pad is mutated (updatedAt
 * bumped) regardless; only the disk write can fail.
 */
export async function mutateAndSave(
  scratchpad: TaskScratchpad,
): Promise<string | null> {
  scratchpad.updatedAt = Date.now();
  try {
    await saveScratchpadToDisk(scratchpad);
    return null;
  } catch (err) {
    // ROADMAP P0-2 / DR-H-4: surface disk-write failures. Previously silent.
    // The in-memory pad is still updated; the user's next session will lose
    // these changes. Return the error so the caller can append a hint to the
    // tool result.
    const msg = err instanceof Error ? err.message : String(err);
    return `⚠️ Disk write failed: ${msg}. Your changes are in memory only and will be lost on restart.`;
  }
}
