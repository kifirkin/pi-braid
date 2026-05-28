/**
 * Scratchpad Persistence — disk I/O for session memory
 *
 * Split from scratchpad/index.ts for maintainability.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileMutationQueue } from "../../../lib/utils/file-mutation-queue.js";
import { BRAID_DIR, SCRATCHPAD_DIR } from "../../../lib/config/braid-paths.js";
import type { TaskScratchpad, TaskStore, PlanStep, Decision } from "./types.js";

// SCRATCHPAD_DIR already points to ~/.pi/agent/braid/scratchpads
const _ = BRAID_DIR; // ensure braid dir exists
void _;

/**
 * Per-slug mutex for task store operations.
 * Serializes read-modify-write cycles so rapid concurrent calls don't clobber each other.
 * Each call chains off the previous pending promise for the same slug.
 */
const taskStoreMutex = new Map<string, Promise<void>>();

async function withTaskStoreMutex<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const prev = taskStoreMutex.get(slug) ?? Promise.resolve();
  // Chain: wait for previous, then run fn, then resolve
  const next = prev.then(
    () => fn(),
    () => fn(), // resume even if previous failed
  );
  // Chain error handler to prevent unhandled rejections from hanging subsequent operations
  taskStoreMutex.set(
    slug,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

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
    done: [],
    decisions: [] as Decision[],
    hypotheses: [],
    notes: [],
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

export async function saveScratchpadToDisk(scratchpad: TaskScratchpad): Promise<void> {
  try {
    const filePath = scratchpadFilePath(scratchpad.projectSlug);
    await fileMutationQueue.write(filePath, scratchpad);
  } catch {
    // Silent fail — operates in memory if disk write fails
  }
}

export async function loadScratchpadFromDisk(projectSlug: string): Promise<TaskScratchpad | null> {
  try {
    const filePath = scratchpadFilePath(projectSlug);
    const data = JSON.parse(await fs.readFile(filePath, "utf-8"));
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
    return data as TaskScratchpad;
  } catch {
    // Silent fail — file doesn't exist or parse error
  }
  return null;
}

function taskFilePath(projectSlug: string): string {
  return path.join(SCRATCHPAD_DIR, projectSlug, "tasks.json");
}

export async function saveTaskStore(slug: string, store: TaskStore): Promise<void> {
  try {
    const filePath = taskFilePath(slug);
    store.updatedAt = Date.now();
    await fileMutationQueue.write(filePath, store);
  } catch {
    // Silent fail
  }
}

export async function loadTaskStore(projectSlug: string): Promise<TaskStore> {
  try {
    const filePath = taskFilePath(projectSlug);
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as TaskStore;
  } catch {
    // Silent fail
  }
  return { tasks: [], updatedAt: Date.now() };
}

/**
 * Atomically read-modify-write the task store for a slug.
 * Serializes concurrent calls so rapid task_add/task_complete/etc don't clobber.
 */
export async function mutateTaskStore(
  slug: string,
  fn: (store: TaskStore) => TaskStore | Promise<TaskStore>,
): Promise<TaskStore> {
  return withTaskStoreMutex(slug, async () => {
    const store = await loadTaskStore(slug);
    const mutated = await fn(store);
    await saveTaskStore(slug, mutated);
    return mutated;
  });
}
