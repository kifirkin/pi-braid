/**
 * Scratchpad Persistence - disk I/O for session memory
 *
 * Uses an append-only JSONL event log (events.jsonl) instead of a single
 * overwritten JSON file. This eliminates the concurrent-write race:
 * multiple agent sessions can append simultaneously without overwriting
 * each other's state.
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
import type {
  TaskScratchpad,
  PlanStep,
  Decision,
  DoneItem,
  NoteItem,
  HypothesisItem,
} from "./types.js";

const log = createLogger("scratchpad-persistence");

// SCRATCHPAD_DIR already points to ~/.pi/agent/braid/scratchpads
const _ = BRAID_DIR; // ensure braid dir exists
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

// ── Migration helpers ──────────────────────────────────────────────────────

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

// ── Append-only log ────────────────────────────────────────────────────────

/**
 * Append a state checkpoint to the events.jsonl log.
 * Each line is a JSON object: { ts, state }
 * Concurrent sessions both append — no overwrites.
 *
 * Uses fs.appendFile for atomic append. No read-modify-write race
 * because we never read the file before writing — we just append.
 * The file mutation queue is bypassed intentionally: append-only
 * logs can't race with themselves (POSIX pwrite is atomic for
 * writes under PIPE_BUF, and our JSONL lines are <4KB).
 */
export async function saveScratchpadToDisk(scratchpad: TaskScratchpad): Promise<void> {
  const filePath = eventsFilePath(scratchpad.projectSlug);
  const line = JSON.stringify({
    ts: Date.now(),
    state: scratchpad,
  });
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, line + "\n", "utf-8");
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
  const dir = projectDir(projectSlug);
  const eventsPath = eventsFilePath(projectSlug);

  try {
    // Step 1: Try events.jsonl first
    const content = await fs.readFile(eventsPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length > 0) {
      // Take the LAST complete line (most recent checkpoint)
      const lastLine = lines[lines.length - 1];
      const event = JSON.parse(lastLine) as CheckpointEvent;
      const data = event.state as unknown as Record<string, unknown>;
      return migrateScratchpad(data);
    }
    // events file exists but is empty — treat as no data
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;

    if (code === "ENOENT") {
      // events.jsonl doesn't exist yet. Try legacy latest.json for migration.
      try {
        const legacyPath = scratchpadFilePath(projectSlug);
        const legacyContent = await fs.readFile(legacyPath, "utf-8");
        const data = JSON.parse(legacyContent) as Record<string, unknown>;
        // Normalize the legacy data
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

        // Write migrated state as the first event.jsonl checkpoint
        log.info(`[scratchpad] Migrating latest.json to events.jsonl for ${projectSlug}`);
        await saveScratchpadToDisk(migrated);

        return migrated;
      } catch (legacyErr) {
        const legacyCode = (legacyErr as NodeJS.ErrnoException)?.code;
        if (legacyCode === "ENOENT") return null; // No data at all — first session
        throw legacyErr;
      }
    }

    // Non-ENOENT error — re-throw for the caller to handle
    throw err;
  }
}

function taskFilePath(projectSlug: string): string {
  return path.join(projectDir(projectSlug), "tasks.json");
}

// tasks.json storage was used by the now-removed 'task' tool (task.ts).
// The scratchpad's add_plan/mark_done actions cover the same use case.
// loadTaskStore/saveTaskStore/mutateTaskStore removed with that tool.
// The taskFilePath() helper above is intentionally retained for cleanup
// tooling that may want to remove legacy tasks.json files.
void taskFilePath;