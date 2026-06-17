/**
 * Scratchpad Persistence - disk I/O for session memory
 *
 * Split from scratchpad/index.ts for maintainability.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileMutationQueue } from "../../../lib/utils/file-mutation-queue.js";
import { BRAID_DIR, SCRATCHPAD_DIR } from "../../../lib/config/braid-paths.js";
import { nextId } from "../../../lib/utils/id.js";
import type {
  TaskScratchpad,
  PlanStep,
  Decision,
  DoneItem,
  NoteItem,
  HypothesisItem,
} from "./types.js";

// SCRATCHPAD_DIR already points to ~/.pi/agent/braid/scratchpads
const _ = BRAID_DIR; // ensure braid dir exists
void _;

export function projectSlugFromCwd(cwd?: string): string {
  if (!cwd) return "default";
  const segments = cwd.split("/").filter(Boolean);
  return "--" + segments.join("-") + "--";
}

function scratchpadFilePath(projectSlug: string): string {
  return path.join(SCRATCHPAD_DIR, projectSlug, "latest.json");
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
 * Migrate an old-format scratchpad loaded from disk to the current schema.
 * Adds IDs to items that pre-date the ID system. Idempotent: if items
 * already have IDs (e.g., reloaded after a save), the migration is a no-op.
 */
function migrateScratchpad(data: Record<string, unknown>): TaskScratchpad {
  // done: was string[]; is now DoneItem[]
  if (Array.isArray(data.done)) {
    data.done = data.done.map((item: unknown, i: number): DoneItem => {
      if (typeof item === "string") {
        return {
          id: nextId("dn"),
          text: item,
          turn: 0,
          addedAt: (data.updatedAt as number) ?? Date.now(),
        };
      }
      if (typeof item === "object" && item !== null) {
        const obj = item as Partial<DoneItem>;
        return {
          id: obj.id ?? nextId("dn"),
          text: obj.text ?? "",
          turn: obj.turn ?? 0,
          addedAt: obj.addedAt ?? (data.updatedAt as number) ?? Date.now(),
        };
      }
      return { id: nextId("dn"), text: String(item), turn: 0, addedAt: Date.now() };
    });
  } else {
    data.done = [];
  }

  // plan: was PlanStep[] without id; is now PlanStep[] with id
  if (Array.isArray(data.plan)) {
    data.plan = data.plan.map((item: unknown): PlanStep => {
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
  } else {
    data.plan = [];
  }

  // notes: was string[]; is now NoteItem[]
  if (Array.isArray(data.notes)) {
    data.notes = data.notes.map((item: unknown): NoteItem => {
      if (typeof item === "string") {
        return {
          id: nextId("nt"),
          text: item,
          turn: 0,
          addedAt: (data.updatedAt as number) ?? Date.now(),
        };
      }
      if (typeof item === "object" && item !== null) {
        const obj = item as Partial<NoteItem>;
        return {
          id: obj.id ?? nextId("nt"),
          text: obj.text ?? "",
          turn: obj.turn ?? 0,
          addedAt: obj.addedAt ?? (data.updatedAt as number) ?? Date.now(),
        };
      }
      return { id: nextId("nt"), text: String(item), turn: 0, addedAt: Date.now() };
    });
  } else {
    data.notes = [];
  }

  // decisions: was Decision[] without id; is now Decision[] with id
  if (Array.isArray(data.decisions)) {
    data.decisions = data.decisions.map((item: unknown): Decision => {
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
  } else {
    data.decisions = [];
  }

  // hypotheses: was string[]; is now HypothesisItem[]
  if (Array.isArray(data.hypotheses)) {
    data.hypotheses = data.hypotheses.map((item: unknown): HypothesisItem => {
      if (typeof item === "string") {
        return {
          id: nextId("hp"),
          text: item,
          turn: 0,
          addedAt: (data.updatedAt as number) ?? Date.now(),
        };
      }
      if (typeof item === "object" && item !== null) {
        const obj = item as Partial<HypothesisItem>;
        return {
          id: obj.id ?? nextId("hp"),
          text: obj.text ?? "",
          turn: obj.turn ?? 0,
          addedAt: obj.addedAt ?? (data.updatedAt as number) ?? Date.now(),
        };
      }
      return { id: nextId("hp"), text: String(item), turn: 0, addedAt: Date.now() };
    });
  } else {
    data.hypotheses = [];
  }

  return data as unknown as TaskScratchpad;
}

export async function saveScratchpadToDisk(scratchpad: TaskScratchpad): Promise<void> {
  try {
    const filePath = scratchpadFilePath(scratchpad.projectSlug);
    await fileMutationQueue.write(filePath, scratchpad);
  } catch {
    // Silent fail - operates in memory if disk write fails
  }
}

export async function loadScratchpadFromDisk(projectSlug: string): Promise<TaskScratchpad | null> {
  try {
    const filePath = scratchpadFilePath(projectSlug);
    const data = JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
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
    // Migrate list items to ID-based addressing.
    return migrateScratchpad(data);
  } catch {
    // Silent fail - file doesn't exist or parse error
  }
  return null;
}

function taskFilePath(projectSlug: string): string {
  return path.join(SCRATCHPAD_DIR, projectSlug, "tasks.json");
}

// tasks.json storage was used by the now-removed 'task' tool (task.ts).
// The scratchpad's add_plan/mark_done actions cover the same use case.
// loadTaskStore/saveTaskStore/mutateTaskStore removed with that tool.
// The taskFilePath() helper above is intentionally retained for cleanup
// tooling that may want to remove legacy tasks.json files.
void taskFilePath;
