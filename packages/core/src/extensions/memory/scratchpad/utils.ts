/**
 * Shared scratchpad utilities.
 *
 * Both index.ts and handlers.ts import from here (this module breaks their
 * import cycle). index.ts also re-exports these names for backward
 * compatibility with any existing importers.
 */

import { nextId } from "../../../lib/utils/id.js";
import { createLogger } from "../../../lib/core/logger.js";
import { saveScratchpadToDisk } from "./persistence.js";
import type { TaskScratchpad } from "./types.js";

const log = createLogger("scratchpad-flush");

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

/**
 * Append an item to an array, evicting the oldest items if the array
 * exceeds the cap. Eviction is silent (no return value) -- observable
 * pruning stats are computed by `scratchpadClean()` for the
 * `note_compact` action. Callers can use `scratchpadClean()` after a
 * batch of writes if they need an eviction count.
 */
export function capPush<T>(arr: T[], item: T, max: number): void {
  arr.push(item);
  if (arr.length > max) {
    arr.splice(0, arr.length - max);
  }
}

export function generateLearningId(): string {
  return nextId("lrn");
}

export function generateConstraintId(): string {
  return nextId("con");
}

/**
 * Find an item in a list by id (preferred) or by text match (fallback).
 * Returns the item and its index, or { item: null, index: -1 } if not found.
 */
export function findByIdOrText<T extends { id: string; text: string }>(
  list: T[],
  idOrText: string,
): { item: T | null; index: number } {
  // Exact id match takes precedence over the text fallback.
  const idxById = list.findIndex((it) => it.id === idOrText);
  if (idxById >= 0) return { item: list[idxById]!, index: idxById };
  // Fall back to text match
  const idxByText = list.findIndex((it) => it.text === idOrText);
  if (idxByText >= 0) return { item: list[idxByText]!, index: idxByText };
  return { item: null, index: -1 };
}

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
  "rootcause": "root_cause",
  "root-cause": "root_cause",
  "root": "root_cause",
  "cause": "root_cause",
  "bug": "root_cause",
  "defect": "root_cause",
  // pattern aliases
  "pattern": "pattern",
  "convention": "pattern",
  "idiom": "pattern",
  "heuristic": "pattern",
  "insight": "pattern",
  // fix aliases
  "fix": "fix",
  "solution": "fix",
  "solution_summary": "fix",
  "resolved": "fix",
  "workaround": "fix",
  "patch": "fix",
  // constraint aliases
  "constraint": "constraint",
  "rule": "constraint",
  "limit": "constraint",
  "invariant": "constraint",
  "requirement": "constraint",
  // codebase_fact aliases
  "codebase_fact": "codebase_fact",
  "codebase": "codebase_fact",
  "fact": "codebase_fact",
  "codebase-fact": "codebase_fact",
  "code-fact": "codebase_fact",
  "codefact": "codebase_fact",
};

export function resolveCategory(raw: string): LearningCategory | null {
  const key = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if ((VALID_LEARNING_CATEGORIES as readonly string[]).includes(key)) {
    return key as LearningCategory;
  }
  return LEARNING_CATEGORY_ALIASES[key] ?? null;
}

/**
 * Debounced write queue for scratchpad persistence.
 *
 * Batch rapid mutations into a single disk write.
 * When a handler calls mutateAndSave, we schedule a flush on the next
 * microtask tick (via setTimeout 0). If another mutateAndSave arrives
 * before the flush fires, we update the pending pad reference instead of
 * scheduling a second write. The final flush writes the latest state once.
 *
 * On turn-end, register-turn-end-hygiene.ts calls flushPendingScratchpadWrites()
 * to guarantee the pad is on disk before the next turn begins.
 *
 * Trade-off: disk write errors surface on the NEXT mutateAndSave call, or
 * are logged by flushPendingScratchpadWrites, not on the call that queued
 * them. Acceptable since write failures are rare and the error surface is the
 * same.
 */

let _pendingPad: TaskScratchpad | null = null;
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
let _lastError: string | null = null;

/**
 * Flush the pending pad to disk. Called by the debounce timer and by
 * flushPendingScratchpadWrites(). Captures the latest pad state.
 */
async function doFlush(): Promise<void> {
  _flushTimer = null;
  const pad = _pendingPad;
  _pendingPad = null;
  if (!pad) return;
  try {
    await saveScratchpadToDisk(pad);
    _lastError = null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    _lastError = `Disk write failed: ${msg}. Your changes are in memory only and will be lost on restart.`;
  }
}

/**
 * Persist the pad to disk (debounced). Returns null on success, or a
 * user-facing warning string on failure. Multiple rapid calls are
 * coalesced into a single disk write. The in-memory pad is mutated
 * (updatedAt bumped) regardless; only the disk write can fail.
 *
 * If a previous write failed, this call returns the error from that
 * failed write (so it surfaces to the user). A successful flush clears
 * the error state.
 */
export async function mutateAndSave(scratchpad: TaskScratchpad): Promise<string | null> {
  scratchpad.updatedAt = Date.now();
  _pendingPad = scratchpad;

  if (!_flushTimer) {
    _flushTimer = setTimeout(doFlush, 0);
  }

  // Surface any error from the previous flush
  if (_lastError) {
    const err = _lastError;
    _lastError = null;
    return err;
  }

  return null;
}

/**
 * Force-flush any pending scratchpad write. Call from turn-end handlers to
 * guarantee the pad is on disk before the next turn begins. Best-effort: a
 * failed write is logged here, where it is guaranteed a reader, rather than
 * returned to a caller that has nothing to do with the warning.
 */
export async function flushPendingScratchpadWrites(): Promise<void> {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
  }
  await doFlush();
  if (_lastError) {
    log.warn(_lastError);
    _lastError = null;
  }
}
