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
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createLogger } from "../../../lib/core/logger.js";
import { onEvent } from "../../../lib/events/event-types.js";
import { getState } from "../state.js";
import { scratchpadDir, braidDir } from "../../../lib/config/braid-paths.js";
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

      let goal: string | null = null;
      let openPlans: Array<{ id: string; text: string }> = [];
      let recentDecisions: Array<{ id: string; text: string }> = [];
      let recentLearnings: Array<{ category: string; content: string }> = [];

      // Prior state is a READ: the scratchpad root is resolved on every call,
      // so a pinned run reads the tree the scratchpad writer wrote to. A
      // refused root (no absolute braid home) degrades to no prior-state
      // section instead of failing the resume write below.
      try {
        const scratchpadFile = path.join(scratchpadDir(), slug, "latest.json");
        if (existsSync(scratchpadFile)) {
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
        }
      } catch (err) {
        log.debug(`scratchpad prior-state read failed: ${err}`);
      }

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
