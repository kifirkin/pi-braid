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
import * as os from "node:os";
import { createLogger } from "../../../lib/core/logger.js";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/state/session-start-queue.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { getState } from "../state.js";
import { enforcementSignals, type EnforcementSignalEntry } from "../signals.js";
import { getShownDiscoveryBundles } from "../../../lib/state/global-state.js";
import { SCRATCHPAD_DIR, EPISODES_FILE, SEMANTIC_MEMORY_FILE, AGENT } from "../../../lib/config/braid-paths.js";
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

      const cwd = (ctx as { cwd?: string }).cwd ?? "";
      const signals: string[] = [];

      // Clear module-level enforcementSignals from the previous session.
      // This prevents stale signal data (e.g. unpersisted_learnings flag,
      // old contrast mode indicators) from leaking into the new session.
      // The signals map is module-level, not session-scoped, so it persists
      // across /reload unless explicitly cleared.
      for (const key of Object.keys(enforcementSignals)) {
        delete (enforcementSignals as Record<string, EnforcementSignalEntry>)[key];
      }

      // ── 1. Scratchpad ──────────────────────────────────────────────
      try {
        const slug = projectSlugFromCwd(cwd);
        const scratchpadFile = path.join(SCRATCHPAD_DIR, slug, "latest.json");
        if (existsSync(scratchpadFile)) {
          const stat = statSync(scratchpadFile);
          if (stat.size > 10) {
            // Read to check if it has an open goal or plan items
            const content = readFileSync(scratchpadFile, "utf-8");
            const parsed = JSON.parse(content);
            const hasGoal = parsed.goal && parsed.goal.length > 0;
            const openPlans = Array.isArray(parsed.plans)
              ? parsed.plans.filter((p: any) => !p.done).length
              : 0;
            if (hasGoal || openPlans > 0) {
              signals.push(
                `Prior scratchpad data exists for this project (${openPlans} open plan items). ` +
                  `Use \`scratchpad action=continue\` to resume -- it returns goal + open plan + recent context in one call.`,
              );
            }
          }
        }
      } catch (err) {
        log.debug(`scratchpad discoverability check failed: ${err}`);
      }

      // ── 2. Episodes ────────────────────────────────────────────────
      let hasEpisodes = false;
      try {
        if (existsSync(EPISODES_FILE)) {
          const stat = statSync(EPISODES_FILE);
          if (stat.size > 10) hasEpisodes = true;
        }
      } catch {
        // ignore
      }

      // ── 3. Semantic memory ─────────────────────────────────────────
      let hasSemantic = false;
      try {
        if (existsSync(SEMANTIC_MEMORY_FILE)) {
          const content = readFileSync(SEMANTIC_MEMORY_FILE, "utf-8");
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
        signals.push(
          `Prior ${sources.join(" and ")} available. Use \`memory action=recall_search\` with a relevant query ` +
            `to surface insights from past sessions before starting new work.`,
        );
      }

      // ── 4. Prior session files ─────────────────────────────────────
      try {
        const sessionsDir = path.join(AGENT, "sessions");
        if (existsSync(sessionsDir)) {
          const entries = readdirSync(sessionsDir, { withFileTypes: true });
          const jsonlCount = entries.filter(
            (e) => e.isFile() && e.name.endsWith(".jsonl"),
          ).length;
          if (jsonlCount > 0) {
            signals.push(
              `${jsonlCount} prior session${jsonlCount > 1 ? "s" : ""} on record. ` +
                `Use \`session action=search\` with keywords to find relevant past work.`,
            );
          }
        }
      } catch {
        // ignore
      }

      // ── 5. Resume file from prior session ───────────────────────────
      try {
        const slug = projectSlugFromCwd(cwd);
        const resumeFile = path.join(
          os.homedir(), ".pi", "agent", "braid", "sessions", slug, "resume.json",
        );
        if (existsSync(resumeFile)) {
          const content = readFileSync(resumeFile, "utf-8");
          const parsed = JSON.parse(content);
          const openCount = Array.isArray(parsed.openPlans) ? parsed.openPlans.length : 0;
          const uncommitted = Array.isArray(parsed.uncommittedFiles) ? parsed.uncommittedFiles.length : 0;
          if (openCount > 0 || parsed.goal || uncommitted > 0) {
            const parts: string[] = [];
            if (parsed.goal) parts.push(`goal: "${String(parsed.goal).slice(0, 80)}"`);
            if (openCount > 0) parts.push(`${openCount} open plan items`);
            if (uncommitted > 0) parts.push(`${uncommitted} uncommitted file${uncommitted > 1 ? "s" : ""}`);
            signals.push(
              `Prior session left ${parts.join(", ")}. ` +
                `Use \`scratchpad action=continue\` to resume the full context.`,
            );
          }
        }
      } catch {
        // ignore
      }

      // ── 6. Context hygiene & state preservation tip ────────────────
      // Forward-looking guidance: when prior state exists, remind the agent
      // how to manage context and preserve state against crashes.
      // Shown only when there's prior state to manage (other signals exist).
      if (signals.length > 0) {
        signals.push(
          `Session state auto-preserves: scratchpad saves to disk, shutdown writes a resume file. ` +
            `Monitor context with \`context_inspect\`, archive with \`context_compress\` when near capacity, ` +
            `and capture workspace files with \`workspace_snapshot(action=\'capture\')\`. ` +
            `These surfaces survive crashes.`,
        );
      }

      // ── Emit bundled signals (single whisper, process-level dedup) ─
      // Bundling prevents flood: the discoverability handler can detect up
      // to 6 sources (scratchpad, episodes, semantic, prior sessions, resume, context tip).
      // Emitting each as a separate whisper would stack in the first turn.
      // The braid-whisper prefix is added by the trunk (sendTrackedMessage),
      // so we just join the body-level signals with newlines.
      //
      // Process-level dedup: `getShownDiscoveryBundles()` returns a Set stored
      // in global-state.ts (library module, never re-evaluated on /reload).
      // Same process → same Set → identical text is skipped.
      // Fresh `pi` process → empty Set → shows once.
      if (signals.length > 0) {
        const shown = getShownDiscoveryBundles();
        const bundled = signals.join("\n");
        if (!shown.has(bundled)) {
          shown.add(bundled);
          sendEnforcementWhisper(pi, ctx, bundled);
        } else {
          log.debug(`[discoverability] Skipping already-shown bundle (${signals.length} signals)`);
        }
      }

      if (signals.length > 0) {
        log.info(`[discoverability] ${signals.length} signal(s) emitted for ${cwd}`);
      }
    },
    "session-start-discoverability",
  );

  log.debug("session-start-discoverability registered (Background phase)");
}
