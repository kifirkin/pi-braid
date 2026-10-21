/**
 * Resume handoff state - the scratchpad program a fresh seat needs after a
 * mastership transfer.
 *
 * The resume file (`<braidDir>/sessions/<slug>/resume.json`) is written by
 * two handlers (the turn-end pre-save, the session shutdown writer) and read
 * by a third (session-start discoverability). All three need the same
 * projection of the scratchpad, so it lives here once.
 *
 * The scratchpad is an append-only checkpoint log (`events.jsonl`, last line
 * wins), not a single JSON snapshot, so this reads through the store's own
 * loader - `loadScratchpadFromDisk` - instead of re-deriving a path and a
 * parse. The loader also runs the store's migrations, which is why a legacy
 * `latest.json` still yields state here.
 *
 * The field names come from `TaskScratchpad`: `plan`, `decisions`,
 * `key_learnings`. Reading `plans`/`learnings` off the persisted state
 * silently yields nothing.
 */

import { createLogger } from "../../lib/core/logger.js";
import { loadScratchpadFromDisk } from "../memory/scratchpad/persistence.js";
import type { TaskScratchpad } from "../memory/scratchpad/types.js";

const log = createLogger("enforcement:resume-state");

/**
 * How many entries of each list the resume file carries. Sized for a
 * transfer, not an audit: the first open plan steps are the program a
 * successor continues (later steps are usually its to rewrite), and five
 * decisions/learnings cover the recent working assumptions. The uncapped
 * counts travel alongside so a reader can report "20 open, 10 shown".
 */
export const RESUME_OPEN_PLAN_LIMIT = 10;
export const RESUME_RECENT_DECISION_LIMIT = 5;
export const RESUME_RECENT_LEARNING_LIMIT = 5;

/** A plan step is live once it has been started (see `add_plan`/`mark_done`). */
export type ResumePlanStatus = "in_progress" | "pending";

export interface ResumePlanItem {
  id: string;
  text: string;
  status: ResumePlanStatus;
}

export interface ResumeDecisionItem {
  id: string;
  text: string;
  reason?: string;
}

export interface ResumeLearningItem {
  category: string;
  content: string;
}

export interface ResumeScratchpadState {
  goal: string | null;
  /** First RESUME_OPEN_PLAN_LIMIT unfinished steps, in plan order. */
  openPlans: ResumePlanItem[];
  /** Unfinished steps overall, before the display cap. */
  openPlanCount: number;
  recentDecisions: ResumeDecisionItem[];
  recentLearnings: ResumeLearningItem[];
}

/** The projection of "no scratchpad": every section empty, never undefined. */
export function emptyResumeScratchpadState(): ResumeScratchpadState {
  return {
    goal: null,
    openPlans: [],
    openPlanCount: 0,
    recentDecisions: [],
    recentLearnings: [],
  };
}

/**
 * Project a loaded scratchpad onto the resume fields. Pure: the input pad is
 * never mutated.
 *
 * Plan completion lives in `doneTurn` (mark_done stamps the turn and leaves
 * the step in `plan`), so "open" is `doneTurn === 0` - the step is still in
 * the plan, unfinished. A started-but-unfinished step is the live one.
 */
export function projectResumeScratchpad(pad: TaskScratchpad | null): ResumeScratchpadState {
  if (!pad) return emptyResumeScratchpadState();

  const openSteps = pad.plan.filter((step) => !step.doneTurn);
  return {
    goal: pad.goal && pad.goal.length > 0 ? pad.goal : null,
    openPlans: openSteps.slice(0, RESUME_OPEN_PLAN_LIMIT).map((step) => ({
      id: step.id,
      text: step.text,
      status: step.startTurn > 0 ? "in_progress" : "pending",
    })),
    openPlanCount: openSteps.length,
    recentDecisions: pad.decisions.slice(-RESUME_RECENT_DECISION_LIMIT).map((decision) => ({
      id: decision.id,
      text: decision.text,
      ...(decision.reason ? { reason: decision.reason } : {}),
    })),
    recentLearnings: pad.key_learnings
      .slice(-RESUME_RECENT_LEARNING_LIMIT)
      .map((learning) => ({ category: learning.category, content: learning.content })),
  };
}

/**
 * Read this project's scratchpad and project it onto the resume fields.
 *
 * Degrades to the empty projection on any read failure: a resume file with no
 * prior-state section is worth less than a program, but far more than a
 * handler that threw during shutdown or before a compaction. The refusal is
 * logged at debug - the empty projection is the visible outcome.
 */
export async function readResumeScratchpadState(
  projectSlug: string,
): Promise<ResumeScratchpadState> {
  try {
    return projectResumeScratchpad(await loadScratchpadFromDisk(projectSlug));
  } catch (err) {
    log.debug(`scratchpad read for resume failed: ${err}`);
    return emptyResumeScratchpadState();
  }
}
