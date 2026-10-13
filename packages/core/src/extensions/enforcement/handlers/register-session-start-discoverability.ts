/**
 * register-session-start-discoverability - Surface disk-backed state on SESSION_START.
 *
 * The key insight: discoverability must fire BEFORE the first turn, not after.
 * When the agent reloads (fresh pi instance), turn-end handlers fire only
 * after the first turn completes -- by then the agent has already responded
 * without knowing about scratchpad, memory, or episodes.
 *
 * This handler runs in SessionPhase.Background (fire-and-forget, non-blocking)
 * so it doesn't delay agent startup. It checks for:
 *   1. Scratchpad latest.json for this project
 *   2. Episodes file with content
 *   3. Semantic memory file with content
 *   4. Prior session .jsonl files (session-recall)
 *   5. Resume file from prior session shutdown
 *   6. (Always when prior state exists) Context hygiene & preservation tip
 *
 * For each that exists, it emits a whisper so the agent knows to use
 * `scratchpad action=continue`, `memory action=recall_search`, or
 * `session action=search` before starting new work, plus context management
 * and state preservation tools for ongoing session hygiene.
 *
 * This is environmental discoverability: the agent's environment makes
 * its own state visible, rather than hiding it behind tool calls the
 * agent doesn't know to make.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { createLogger } from "../../../lib/core/logger.js";
import {
  registerSessionStartHandler,
  SessionPhase,
} from "../../../lib/state/session-start-queue.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { getState } from "../state.js";
import { enforcementSignals, type EnforcementSignalEntry } from "../signals.js";
import {
  isProjectSignalShown,
  markProjectSignalShown,
  reconstructShownSignalsFromBranch,
  type DiscoverySignalType,
} from "../../../lib/state/global-state.js";
import {
  scratchpadDir,
  episodesFilePath,
  semanticMemoryFilePath,
  AGENT,
  braidDir,
  tagsSlugFromCwd,
} from "../../../lib/config/braid-paths.js";
import { projectSlugFromCwd } from "../../memory/scratchpad/persistence.js";

const log = createLogger("enforcement:session-start-discoverability");

/**
 * Register the SESSION_START discoverability handler.
 *
 * Runs in Background phase (fire-and-forget) so it doesn't block startup.
 */
export function registerSessionStartDiscoverability(pi: ExtensionAPI): void {
  registerSessionStartHandler(
    pi,
    SessionPhase.Background,
    async (_event: any, ctx: ExtensionContext) => {
      if (!getState(ctx).enforcementActive) return;

      // 0. Rebuild shown-signal state from the active branch
      // The branch decides what THIS session has already shown; the project
      // disk index is a derived cache only. Must run before the filter at the
      // bottom of this handler.
      try {
        reconstructShownSignalsFromBranch(ctx.sessionManager.getBranch());
      } catch {
        // Stale ctx (or an older pi without getBranch): keep the last map.
      }

      const cwd = (ctx as { cwd?: string }).cwd ?? "";
      // Signal TYPE is the dedup key (stable across content changes); TEXT
      // carries the user-facing content (may change on every emission via
      // dynamic fields like openPlans count or goal slice).
      const signals: Array<{ type: DiscoverySignalType; text: string }> = [];

      // Clear module-level enforcementSignals from the previous session.
      // This prevents stale signal data (e.g. unpersisted_learnings flag,
      // old contrast mode indicators) from leaking into the new session.
      // The signals map is module-level, not session-scoped, so it persists
      // across /reload unless explicitly cleared.
      for (const key of Object.keys(enforcementSignals)) {
        delete (enforcementSignals as Record<string, EnforcementSignalEntry>)[key];
      }

      // 1. Scratchpad. The store root is resolved on every call, never a
      // module-load constant: a pinned run must read the tree the writers
      // wrote to, and a refused root (no absolute braid home) degrades.
      try {
        const slug = projectSlugFromCwd(cwd);
        const scratchpadFile = path.join(scratchpadDir(), slug, "latest.json");
        if (existsSync(scratchpadFile)) {
          const stat = statSync(scratchpadFile);
          if (stat.size > 10) {
            const content = readFileSync(scratchpadFile, "utf-8");
            const parsed = JSON.parse(content);
            const hasGoal = parsed.goal && parsed.goal.length > 0;
            const openPlans = Array.isArray(parsed.plans)
              ? parsed.plans.filter((p: any) => !p.done).length
              : 0;
            if (hasGoal || openPlans > 0) {
              signals.push({
                type: "scratchpad_prior",
                text:
                  `Prior scratchpad data exists for this project (${openPlans} open plan items). ` +
                  `Use \`scratchpad action=continue\` to resume -- it returns goal + open plan + recent context in one call.`,
              });
            }
          }
        }
      } catch (err) {
        log.debug(`scratchpad discoverability check failed: ${err}`);
      }

      // 2. Episodes
      let hasEpisodes = false;
      try {
        if (existsSync(episodesFilePath())) {
          const stat = statSync(episodesFilePath());
          if (stat.size > 10) hasEpisodes = true;
        }
      } catch {
        // ignore
      }

      // 3. Semantic memory
      let hasSemantic = false;
      try {
        if (existsSync(semanticMemoryFilePath())) {
          const content = readFileSync(semanticMemoryFilePath(), "utf-8");
          const parsed = JSON.parse(content);
          const count = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
          if (count > 0) hasSemantic = true;
        }
      } catch {
        // ignore
      }

      if (hasEpisodes || hasSemantic) {
        const sources: string[] = [];
        if (hasEpisodes) sources.push("episodes");
        if (hasSemantic) sources.push("semantic memory");
        signals.push({
          type: "memory_prior",
          text:
            `Prior ${sources.join(" and ")} available. Use \`memory action=recall_search\` with a relevant query ` +
            `to surface insights from past sessions before starting new work.`,
        });
      }

      // 4. Prior session files
      try {
        const sessionsDir = path.join(AGENT, "sessions");
        if (existsSync(sessionsDir)) {
          const entries = readdirSync(sessionsDir, { withFileTypes: true });
          const jsonlCount = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).length;
          if (jsonlCount > 0) {
            signals.push({
              type: "sessions_prior",
              text:
                `${jsonlCount} prior session${jsonlCount > 1 ? "s" : ""} on record. ` +
                `Use \`session action=search\` with keywords to find relevant past work.`,
            });
          }
        }
      } catch {
        // ignore
      }

      // 5. Resume file from prior session
      try {
        const slug = projectSlugFromCwd(cwd);
        const resumeFile = path.join(braidDir(), "sessions", slug, "resume.json");
        if (existsSync(resumeFile)) {
          const content = readFileSync(resumeFile, "utf-8");
          const parsed = JSON.parse(content);
          const openCount = Array.isArray(parsed.openPlans) ? parsed.openPlans.length : 0;
          const uncommitted = Array.isArray(parsed.uncommittedFiles)
            ? parsed.uncommittedFiles.length
            : 0;
          if (openCount > 0 || parsed.goal || uncommitted > 0) {
            const parts: string[] = [];
            if (parsed.goal) parts.push(`goal: "${String(parsed.goal).slice(0, 80)}"`);
            if (openCount > 0) parts.push(`${openCount} open plan items`);
            if (uncommitted > 0)
              parts.push(`${uncommitted} uncommitted file${uncommitted > 1 ? "s" : ""}`);
            signals.push({
              type: "resume",
              text:
                `Prior session left ${parts.join(", ")}. ` +
                `Use \`scratchpad action=continue\` to resume the full context.`,
            });
          }
        }
      } catch {
        // ignore
      }

      // 6. Cross-session tags from prior sessions. The same slug rule the tag
      // writer uses (tagsSlugFromCwd), never the scratchpad/sessions form: a
      // reader on a second spelling reads a file that was never written.
      try {
        const slug = tagsSlugFromCwd(cwd);
        const tagsFile = path.join(braidDir(), "tags", `${slug}.json`);
        if (existsSync(tagsFile)) {
          const content = readFileSync(tagsFile, "utf-8");
          const tags = JSON.parse(content);
          const tagNames = Object.keys(tags);
          if (tagNames.length > 0) {
            signals.push({
              type: "tags_prior",
              text:
                `Cross-session tags available: ${tagNames.slice(0, 5).join(", ")}${tagNames.length > 5 ? ` +${tagNames.length - 5} more` : ""}. ` +
                `Use \`context_navigate(action="checkout", target="<tag-name>")\` to navigate to a tagged position.`,
            });
          }
        }
      } catch {
        // ignore
      }

      // 7. Context hygiene & state preservation tip: forward-looking
      // guidance — when prior state exists, remind the agent how to manage
      // context and preserve state against crashes.
      // Shown only when there's prior state to manage (other signals exist).
      if (signals.length > 0) {
        signals.push({
          type: "context_hygiene_tip",
          text:
            `Session state auto-preserves: scratchpad saves to disk, shutdown writes a resume file. ` +
            `Monitor context with \`context_inspect\`, archive with \`context_compress\` when near capacity, ` +
            `and capture workspace files with \`workspace_snapshot(action='capture')\`. ` +
            `These surfaces survive crashes.`,
        });
      }

      // Per-signal dedup, keyed by stable signal TYPE: per-project
      // persistence (via `projectSlugFromCwd`) lets `pi --session <id>` (a new
      // process) read previously shown signals from disk and skip them, so the
      // discoverability bundle doesn't re-fire on session resume.
      const slug = signals.length > 0 && (cwd ? projectSlugFromCwd(cwd) : "");
      const unseenSignals = slug
        ? signals.filter((s) => !isProjectSignalShown(slug, s.type))
        : signals.filter((s) => !isProjectSignalShown("default", s.type));
      if (unseenSignals.length > 0) {
        const bundled = unseenSignals.map((s) => s.text).join("\n");
        for (const s of unseenSignals) {
          markProjectSignalShown(slug || "default", s.type, pi);
        }
        // Informational pointers to prior state: park (no forced turn).
        sendEnforcementWhisper(pi, ctx, bundled, false, { delivery: "park" });
        log.debug(
          `[discoverability] ${unseenSignals.length}/${signals.length} new signal(s) emitted for ${cwd} ` +
            `(${signals.length - unseenSignals.length} already shown)`,
        );
      }
    },
    "session-start-discoverability",
  );

  log.debug("session-start-discoverability registered (Background phase)");
}
