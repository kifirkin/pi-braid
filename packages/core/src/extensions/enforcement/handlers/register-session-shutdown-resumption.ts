/**
 * register-session-shutdown-resumption - Write "resume here" file on session end.
 *
 * On SESSION_SHUTDOWN, writes a lightweight resumption file containing:
 *   - Last known goal and open plan items from scratchpad
 *   - Uncommitted file list (git status)
 *   - Recent decisions and learnings
 *   - Timestamp and session metadata
 *
 * This file is read by the SESSION_START discoverability handler on the
 * next session to provide a "resume here" signal -- not auto-loading,
 * but discoverability so the agent knows prior work exists.
 *
 * File location: <braidDir()>/sessions/<projectSlug>/resume.json
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createLogger } from "../../../lib/core/logger.js";
import { onEvent } from "../../../lib/events/event-types.js";
import { getState } from "../state.js";
import { braidDir } from "../../../lib/config/braid-paths.js";
import { SESSION_SHUTDOWN } from "../../../lib/core/event-names.js";
import { projectSlugFromCwd } from "../../memory/scratchpad/persistence.js";
import { flushPendingScratchpadWrites } from "../../memory/scratchpad/utils.js";
import {
  readResumeScratchpadState,
  type ResumeDecisionItem,
  type ResumeLearningItem,
  type ResumePlanItem,
} from "../resume-state.js";

const log = createLogger("enforcement:session-shutdown-resumption");

interface ResumptionFile {
  writtenAt: string;
  cwd: string;
  goal: string | null;
  openPlans: ResumePlanItem[];
  recentDecisions: ResumeDecisionItem[];
  recentLearnings: ResumeLearningItem[];
  uncommittedFiles: string[];
  toolCallCount: number;
  verificationCount: number;
}

/**
 * Register the SESSION_SHUTDOWN resumption writer.
 */
export function registerSessionShutdownResumption(pi: ExtensionAPI): void {
  onEvent(pi, SESSION_SHUTDOWN, async (_event: any, ctx: ExtensionContext) => {
    try {
      const cwd = (ctx as { cwd?: string }).cwd ?? "";
      const slug = projectSlugFromCwd(cwd);

      // Flush the debounced scratchpad write queue first: at shutdown the
      // in-memory pad may hold the session's last mutations and the read
      // below only sees what reached the checkpoint log.
      await flushPendingScratchpadWrites().catch(() => {});

      // Prior state is a READ through the scratchpad store's own loader (the
      // checkpoint log, not a hand-built path), so a schema or storage change
      // in the store moves this reader with it. A refused root (no absolute
      // braid home) degrades to an empty prior-state section instead of
      // failing the resume write below.
      const resumeState = await readResumeScratchpadState(slug);
      const { goal, openPlans, recentDecisions, recentLearnings } = resumeState;

      let uncommittedFiles: string[] = [];
      try {
        // Scope to the project dir only. When ctx.cwd is missing, `cwd` is "" and
        // git would otherwise run in the daemon's process.cwd() and record an
        // unrelated project's dirty files.
        if (cwd && existsSync(cwd)) {
          const status = execSync("git status --porcelain", {
            cwd,
            encoding: "utf-8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"],
          });
          uncommittedFiles = status
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => l.slice(3));
        }
      } catch {
        // not a git repo or git not available -- skip
      }

      const state = getState(ctx);
      const toolCallCount = state.totalToolCalls;
      const verificationCount = state.verificationsDone;

      const resumption: ResumptionFile = {
        writtenAt: new Date().toISOString(),
        cwd,
        goal,
        openPlans,
        recentDecisions,
        recentLearnings,
        uncommittedFiles,
        toolCallCount,
        verificationCount,
      };

      const sessionsDir = path.join(braidDir(), "sessions", slug);
      if (!existsSync(sessionsDir)) {
        mkdirSync(sessionsDir, { recursive: true });
      }
      const resumeFile = path.join(sessionsDir, "resume.json");
      writeFileSync(resumeFile, JSON.stringify(resumption, null, 2), "utf-8");

      log.info(
        `[session-shutdown-resumption] Wrote resume.json for ${slug} ` +
          `(${openPlans.length} open plans, ${uncommittedFiles.length} uncommitted files)`,
      );
    } catch (err) {
      log.warn(`[session-shutdown-resumption] Failed to write resume file: ${err}`);
    }
  });

  log.debug("session-shutdown-resumption registered");
}
