/**
 * Scratchpad Persistence — disk I/O for session memory
 *
 * Split from scratchpad/index.ts for maintainability.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileMutationQueue } from "../../../lib/utils/file-mutation-queue.js";
import { BRAID_DIR, SCRATCHPAD_DIR } from "../../../lib/config/braid-paths.js";
import type { TaskScratchpad, PlanStep, Decision } from "./types.js";

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

// tasks.json storage was used by the now-removed 'task' tool (task.ts).
// The scratchpad's add_plan/mark_done actions cover the same use case.
// loadTaskStore/saveTaskStore/mutateTaskStore removed with that tool.
// The taskFilePath() helper above is intentionally retained for cleanup
// tooling that may want to remove legacy tasks.json files.
void taskFilePath;
