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
 * next session to provide a "resume here" signal — not auto-loading,
 * but discoverability so the agent knows prior work exists.
 *
 * File location: ~/.pi/agent/braid/sessions/<projectSlug>/resume.json
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { createLogger } from "../../../lib/core/logger.js";
import { onEvent } from "../../../lib/events/event-types.js";
import { getState } from "../state.js";
import { SCRATCHPAD_DIR } from "../../../lib/config/braid-paths.js";
import { SESSION_SHUTDOWN } from "../../../lib/core/event-names.js";
import { projectSlugFromCwd } from "../../memory/scratchpad/persistence.js";

const log = createLogger("enforcement:session-shutdown-resumption");

interface ResumptionFile {
  writtenAt: string;
  cwd: string;
  goal: string | null;
  openPlans: Array<{ id: string; text: string }>;
  recentDecisions: Array<{ id: string; text: string }>;
  recentLearnings: Array<{ category: string; content: string }>;
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

      // Read scratchpad for goal + open plans
      let goal: string | null = null;
      let openPlans: Array<{ id: string; text: string }> = [];
      let recentDecisions: Array<{ id: string; text: string }> = [];
      let recentLearnings: Array<{ category: string; content: string }> = [];

      const scratchpadFile = path.join(SCRATCHPAD_DIR, slug, "latest.json");
      if (existsSync(scratchpadFile)) {
        try {
          const content = readFileSync(scratchpadFile, "utf-8");
          const parsed = JSON.parse(content);
          goal = parsed.goal ?? null;
          openPlans = (Array.isArray(parsed.plans) ? parsed.plans : [])
            .filter((p: any) => !p.done)
            .slice(0, 10)
            .map((p: any) => ({ id: p.id ?? "", text: p.text ?? "" }));
          recentDecisions = (Array.isArray(parsed.decisions) ? parsed.decisions : [])
            .slice(-5)
            .map((d: any) => ({ id: d.id ?? "", text: d.text ?? d.content ?? "" }));
          recentLearnings = (Array.isArray(parsed.learnings) ? parsed.learnings : [])
            .slice(-5)
            .map((l: any) => ({
              category: l.category ?? "",
              content: l.content ?? l.text ?? "",
            }));
        } catch {
          // scratchpad parse error — non-fatal
        }
      }

      // Get uncommitted files via git status
      let uncommittedFiles: string[] = [];
      try {
        const status = execSync("git status --porcelain", {
          cwd,
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        uncommittedFiles = status
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => l.slice(3)); // strip status codes
      } catch {
        // not a git repo or git not available — skip
      }

      // Get session stats from enforcement state
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

      // Write to ~/.pi/agent/braid/sessions/<slug>/resume.json
      const sessionsDir = path.join(
        os.homedir(),
        ".pi",
        "agent",
        "braid",
        "sessions",
        slug,
      );
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
