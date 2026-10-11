/**
 * Scratchpad Persistence - disk I/O for session memory
 *
 * Uses an append-only JSONL event log (events.jsonl) instead of a single
 * overwritten JSON file. Multiple agent sessions append their own
 * checkpoints without overwriting each other's state. The log is bounded
 * by a prune after each save; both the append and the prune run under the
 * shared store lock, so a prune never rewrites a snapshot that a
 * concurrent append has already extended.
 *
 * On load: reads all lines from events.jsonl, takes the last checkpoint
 * as the effective state. Old checkpoints are preserved in the log for
 * audit and can be replayed for merge in the future.
 *
 * Migration: if events.jsonl doesn't exist but latest.json does, imports
 * latest.json as the first checkpoint and switches to JSONL mode.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BRAID_DIR, SCRATCHPAD_DIR } from "../../../lib/config/braid-paths.js";
import { nextId } from "../../../lib/utils/id.js";
import { createLogger } from "../../../lib/core/logger.js";
import { withStoreLock } from "../../../lib/memory/store-lock.js";
import type {
  TaskScratchpad,
  PlanStep,
  Decision,
  DoneItem,
  NoteItem,
  HypothesisItem,
} from "./types.js";

/**
 * Max checkpoint lines to keep in the append-only events.jsonl log.
 * Old lines are trimmed after save to prevent unbounded growth.
 * Each line is a full state serialization (~20-80KB), so 50 lines
 * is ~1-4MB — well within reasonable bounds.
 */
const MAX_CHECKPOINT_LINES = 50;

const log = createLogger("scratchpad-persistence");

// Touching BRAID_DIR here ensures the braid directory exists before any
// scratchpad path under it is used.
const _ = BRAID_DIR;
void _;

export function projectSlugFromCwd(cwd?: string): string {
  if (!cwd) return "default";
  const segments = cwd.split("/").filter(Boolean);
  return "--" + segments.join("-") + "--";
}

function projectDir(projectSlug: string): string {
  return path.join(SCRATCHPAD_DIR, projectSlug);
}

/** Legacy single-file path (used for migration). */
function scratchpadFilePath(projectSlug: string): string {
  return path.join(projectDir(projectSlug), "latest.json");
}

/** Append-only event log. */
function eventsFilePath(projectSlug: string): string {
  return path.join(projectDir(projectSlug), "events.jsonl");
}

/** Exclusive lock guarding append + prune on the checkpoint log. */
function eventsLockPath(projectSlug: string): string {
  return `${eventsFilePath(projectSlug)}.lock`;
}

export function createScratchpad(goal: string, projectSlug: string): TaskScratchpad {
  return {
    goal,
    prior_goal: "",
    plan: [] as PlanStep[],
    done: [] as DoneItem[],
    decisions: [] as Decision[],
    hypotheses: [] as HypothesisItem[],
    notes: [] as NoteItem[],
    session: {
      turn: 0,
      phase: "idle",
      mode: "normal",
      last_compact_turn: 0,
      session_start: Date.now(),
      updated_at: Date.now(),
    },
    constraints: [],
    key_learnings: [],
    updatedAt: Date.now(),
    projectSlug,
  };
}

/**
 * Per-type migration helpers. Each takes the raw `unknown[]` from the
 * loaded JSON and returns a freshly-typed array. Keeps the main
 * migrateScratchpad function clean and avoids mutating the input record.
 */

function migrateDoneItems(items: unknown[], fallbackAddedAt: number): DoneItem[] {
  return items.map((item): DoneItem => {
    if (typeof item === "string") {
      return {
        id: nextId("dn"),
        text: item,
        turn: 0,
        addedAt: fallbackAddedAt,
      };
    }
    if (typeof item === "object" && item !== null) {
      const obj = item as Partial<DoneItem>;
      return {
        id: obj.id ?? nextId("dn"),
        text: obj.text ?? "",
        turn: obj.turn ?? 0,
        addedAt: obj.addedAt ?? fallbackAddedAt,
      };
    }
    return { id: nextId("dn"), text: String(item), turn: 0, addedAt: Date.now() };
  });
}

function migratePlanSteps(items: unknown[]): PlanStep[] {
  return items.map((item): PlanStep => {
    if (typeof item === "object" && item !== null) {
      const obj = item as Partial<PlanStep>;
      return {
        id: obj.id ?? nextId("pl"),
        text: obj.text ?? "",
        estimateCalls: obj.estimateCalls,
        budgetCalls: obj.budgetCalls,
        spentCalls: obj.spentCalls ?? 0,
        startTurn: obj.startTurn ?? 0,
        doneTurn: obj.doneTurn ?? 0,
        startTotalCalls: obj.startTotalCalls ?? 0,
      };
    }
    return {
      id: nextId("pl"),
      text: String(item),
      spentCalls: 0,
      startTurn: 0,
      doneTurn: 0,
      startTotalCalls: 0,
    };
  });
}

function migrateNoteItems(items: unknown[], fallbackAddedAt: number): NoteItem[] {
  return items.map((item): NoteItem => {
    if (typeof item === "string") {
      return {
        id: nextId("nt"),
        text: item,
        turn: 0,
        addedAt: fallbackAddedAt,
      };
    }
    if (typeof item === "object" && item !== null) {
      const obj = item as Partial<NoteItem>;
      return {
        id: obj.id ?? nextId("nt"),
        text: obj.text ?? "",
        turn: obj.turn ?? 0,
        addedAt: obj.addedAt ?? fallbackAddedAt,
      };
    }
    return { id: nextId("nt"), text: String(item), turn: 0, addedAt: Date.now() };
  });
}

function migrateDecisions(items: unknown[]): Decision[] {
  return items.map((item): Decision => {
    if (typeof item === "object" && item !== null) {
      const obj = item as Partial<Decision>;
      return {
        id: obj.id ?? nextId("dc"),
        text: obj.text ?? "",
        reason: obj.reason,
        turn: obj.turn ?? 0,
      };
    }
    return { id: nextId("dc"), text: String(item), turn: 0 };
  });
}

function migrateHypotheses(items: unknown[], fallbackAddedAt: number): HypothesisItem[] {
  return items.map((item): HypothesisItem => {
    if (typeof item === "string") {
      return {
        id: nextId("hp"),
        text: item,
        turn: 0,
        addedAt: fallbackAddedAt,
      };
    }
    if (typeof item === "object" && item !== null) {
      const obj = item as Partial<HypothesisItem>;
      return {
        id: obj.id ?? nextId("hp"),
        text: obj.text ?? "",
        turn: obj.turn ?? 0,
        addedAt: obj.addedAt ?? fallbackAddedAt,
      };
    }
    return { id: nextId("hp"), text: String(item), turn: 0, addedAt: Date.now() };
  });
}

/**
 * Migrate an old-format scratchpad loaded from disk to the current schema.
 * Adds IDs to items that pre-date the ID system. Idempotent: if items
 * already have IDs (e.g., reloaded after a save), the migration is a no-op.
 *
 * Builds a fresh TaskScratchpad from the input record - the input is never
 * mutated. This lets TypeScript verify the result type structurally with
 * no `as unknown as` cast at the boundary.
 */
function migrateScratchpad(data: Record<string, unknown>): TaskScratchpad {
  const fallbackAddedAt = (data.updatedAt as number) ?? Date.now();
  const session = (data.session as TaskScratchpad["session"]) ?? {
    turn: 0,
    phase: "idle" as const,
    mode: "normal" as const,
    last_compact_turn: 0,
    session_start: fallbackAddedAt,
    updated_at: fallbackAddedAt,
  };

  return {
    goal: (data.goal as string) ?? "",
    prior_goal: (data.prior_goal as string) ?? "",
    plan: Array.isArray(data.plan) ? migratePlanSteps(data.plan) : [],
    done: Array.isArray(data.done) ? migrateDoneItems(data.done, fallbackAddedAt) : [],
    decisions: Array.isArray(data.decisions) ? migrateDecisions(data.decisions) : [],
    hypotheses: Array.isArray(data.hypotheses)
      ? migrateHypotheses(data.hypotheses, fallbackAddedAt)
      : [],
    notes: Array.isArray(data.notes) ? migrateNoteItems(data.notes, fallbackAddedAt) : [],
    session,
    constraints: (data.constraints as TaskScratchpad["constraints"]) ?? [],
    key_learnings: (data.key_learnings as TaskScratchpad["key_learnings"]) ?? [],
    updatedAt: (data.updatedAt as number) ?? Date.now(),
    projectSlug: (data.projectSlug as string) ?? "default",
  };
}

/**
 * Test seam: pause the save between the prune's read and its rewrite, so a
 * regression test can drive a concurrent append into that window
 * deterministically. No-op unless a test installs a hook.
 */
let pruneWriteHookForTest: (() => Promise<void>) | null = null;
export function __setPruneWriteHookForTest(hook: (() => Promise<void>) | null): void {
  pruneWriteHookForTest = hook;
}

/**
 * Append a state checkpoint to the events.jsonl log and prune the log to
 * MAX_CHECKPOINT_LINES. Each line is a JSON object: { ts, state }.
 *
 * Append and prune run under the shared store lock (the same primitive the
 * episodes store uses). Without it the prune's read-modify-write is a lost
 * update: an append from another session that lands between the prune's read
 * and its rewrite is dropped when the stale snapshot is written back. The
 * prune rewrites through a temp file and rename, so a concurrent reader
 * never observes a truncated log.
 */
export async function saveScratchpadToDisk(scratchpad: TaskScratchpad): Promise<void> {
  const filePath = eventsFilePath(scratchpad.projectSlug);
  const line = JSON.stringify({
    ts: Date.now(),
    state: scratchpad,
  });
  await withStoreLock(eventsLockPath(scratchpad.projectSlug), async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, line + "\n", "utf-8");

    // Each line is a full state serialization (~20-80KB). Without pruning,
    // the file grows indefinitely (observed: 146MB from 1,618 checkpoints).
    // We keep only MAX_CHECKPOINT_LINES (50) most recent entries. The whole
    // save holds the store lock, so the snapshot read here cannot miss an
    // append that lands before the rewrite.
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      if (lines.length > MAX_CHECKPOINT_LINES) {
        const pruned = lines.slice(-MAX_CHECKPOINT_LINES);
        if (pruneWriteHookForTest) await pruneWriteHookForTest();
        const tmpPath = `${filePath}.pruning`;
        await fs.writeFile(tmpPath, pruned.join("\n") + "\n", "utf-8");
        await fs.rename(tmpPath, filePath);
      }
    } catch {
      // Non-fatal: pruning failed, the file still has the latest checkpoint
    }
  });
}

/**
 * Append-only checkpoint format:
 *   {"ts": 1700000000000, "state": { ... full TaskScratchpad ... }}
 */
interface CheckpointEvent {
  ts: number;
  state: TaskScratchpad;
}

/**
 * Load scratchpad from the append-only events.jsonl log.
 *
 * Strategy:
 *   1. Read all lines from events.jsonl
 *   2. Parse each as a CheckpointEvent
 *   3. Return the LAST checkpoint's state (most recent)
 *   4. If events.jsonl doesn't exist, try legacy latest.json (migration)
 *   5. If latest.json exists and events.jsonl doesn't, migrate it by
 *      writing it as the first checkpoint event, then return its state.
 */
export async function loadScratchpadFromDisk(projectSlug: string): Promise<TaskScratchpad | null> {
  const eventsPath = eventsFilePath(projectSlug);

  try {
    const content = await fs.readFile(eventsPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length > 0) {
      // Take the LAST complete line (most recent checkpoint)
      const lastLine = lines[lines.length - 1];
      const event = JSON.parse(lastLine) as CheckpointEvent;
      const data = event.state as unknown as Record<string, unknown>;
      return migrateScratchpad(data);
    }
    // events file exists but is empty -- treat as no data
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;

    if (code === "ENOENT") {
      // events.jsonl doesn't exist yet. Try legacy latest.json for migration.
      try {
        const legacyPath = scratchpadFilePath(projectSlug);
        const legacyContent = await fs.readFile(legacyPath, "utf-8");
        const data = JSON.parse(legacyContent) as Record<string, unknown>;
        if (!data.updatedAt) data.updatedAt = Date.now();
        if (!data.projectSlug) data.projectSlug = projectSlug;
        if (!data.prior_goal) data.prior_goal = "";
        if (!data.session) {
          data.session = {
            turn: 0,
            phase: "idle",
            mode: "normal",
            last_compact_turn: 0,
            session_start: data.updatedAt,
            updated_at: data.updatedAt,
          };
        }
        if (!data.constraints) data.constraints = [];
        if (!data.key_learnings) data.key_learnings = [];
        const migrated = migrateScratchpad(data);

        log.info(`[scratchpad] Migrating latest.json to events.jsonl for ${projectSlug}`);
        await saveScratchpadToDisk(migrated);

        return migrated;
      } catch (legacyErr) {
        const legacyCode = (legacyErr as NodeJS.ErrnoException)?.code;
        if (legacyCode === "ENOENT") return null; // No data at all -- first session
        throw legacyErr;
      }
    }

    // Non-ENOENT error -- re-throw for the caller to handle
    throw err;
  }
}
