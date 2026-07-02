/**
 * register-turn-end-hygiene - Context hygiene on every turn_end.
 *
 * Fires on EVERY turn_end (not just when tools were called):
 *   1. Checks context usage -- if high, emit hygiene whispers
 *   2. At aggressive thresholds (>90% or >100K tokens), auto-compacts
 *      with a pre-save safety net (flush scratchpad + write resume.json)
 *      to guarantee zero data loss.
 *
 * ctx.compact() calls this._disconnectFromAgent() + this.abort() in pi-core
 * (agent-session.js:1245), which breaks the agent loop. To avoid this, the
 * compact call is deferred via setTimeout(0) so the handler returns first.
 * The agent auto-resumes after compaction completes.
 *
 * Discoverability (scratchpad/memory/episodes surfacing) has been moved to
 * SESSION_START (register-session-start-discoverability.ts) so it fires
 * BEFORE the first turn, not after.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { createLogger } from "../../../lib/core/logger.js";
import { registerTurnEndHandler } from "../../../lib/events/turn-end-coordinator.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { getState } from "../state.js";
import { getContextUsageFromEvent } from "../../../lib/state/extension-state.js";
import { fileMutationQueue } from "../../../lib/utils/file-mutation-queue.js";
import { SCRATCHPAD_DIR } from "../../../lib/config/braid-paths.js";
import { projectSlugFromCwd } from "../../memory/scratchpad/persistence.js";
import { flushPendingScratchpadWrites } from "../../memory/scratchpad/utils.js";
import {
  USAGE_TOKENS_SOFT,
  USAGE_TOKENS_WARNING,
  USAGE_TOKENS_CRITICAL,
  USAGE_WHISPER_CRITICAL,
  USAGE_COMPACT_MEDIUM,
  USAGE_COMPACT_AGGRESSIVE,
  HYGIENE_AUTO_COMPACT_COOLDOWN_TURNS,
} from "../../../lib/detection/context-thresholds.js";
import {
  recordCompaction,
} from "../substate/context-hygiene-state.js";

const log = createLogger("enforcement:turn-end-hygiene");

// ── Pre-save safety: flush scratchpad + write resume.json ───────────────

function saveStateBeforeCompact(cwd: string, ctx: ExtensionContext): void {
  try {
    // 1. Flush file mutation queue + scratchpad debounced queue
    fileMutationQueue.flushAll().catch(() => {});
    flushPendingScratchpadWrites().catch(() => {});
  } catch {
    // non-fatal
  }

  try {
    // 2. Write resume.json (same format as SESSION_SHUTDOWN handler)
    const slug = projectSlugFromCwd(cwd);
    const scratchpadFile = path.join(SCRATCHPAD_DIR, slug, "latest.json");
    let goal: string | null = null;
    let openPlans: Array<{ id: string; text: string }> = [];
    let recentDecisions: Array<{ id: string; text: string }> = [];
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
      } catch {
        // scratchpad parse error -- non-fatal
      }
    }

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
        .map((l) => l.slice(3));
    } catch {
      // not a git repo
    }

    const state = getState(ctx);
    const resumption = {
      writtenAt: new Date().toISOString(),
      cwd,
      goal,
      openPlans,
      recentDecisions,
      uncommittedFiles,
      toolCallCount: state?.totalToolCalls ?? 0,
      verificationCount: state?.verificationsDone ?? 0,
      reason: "turn-end auto-compact pre-save",
    };

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
  } catch {
    // non-fatal
  }
}

// ── Context usage check ─────────────────────────────────────────────────────

function checkContextUsage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: any,
): void {
  const state = getState(ctx);
  if (!state?.enforcementActive) return;

  let usagePercent = 0;
  let usageTokens = 0;
  try {
    const usage = getContextUsageFromEvent(event);
    if (usage) {
      usagePercent = usage.percent ?? 0;
      usageTokens = usage.tokens ?? 0;
    }
  } catch {
    return;
  }

  const currentTurn =
    typeof (event as any)?.turnIndex === "number"
      ? (event as any).turnIndex
      : state.lastContextCheckTurn + 1;

  if (usagePercent <= 0 && usageTokens <= 0) return;

  // Reset nudge flag if usage dropped (e.g., after compaction)
  if (state.contextNudgeSent && usagePercent < 50) {
    state.contextNudgeSent = false;
  }

  // ── Auto-compact at aggressive thresholds ───────────────────────────
  // Triggers compaction automatically when context is critically high,
  // with cooldown to avoid thrashing.
  const turnSinceLastCompact =
    currentTurn - (state.lastCompactionTurn ?? -100);
  const atAggressiveThreshold =
    usagePercent >= USAGE_COMPACT_AGGRESSIVE ||
    usageTokens >= USAGE_TOKENS_CRITICAL;

  if (
    atAggressiveThreshold &&
    turnSinceLastCompact >= HYGIENE_AUTO_COMPACT_COOLDOWN_TURNS
  ) {
    const cwd = (ctx as { cwd?: string }).cwd ?? "";
    state.contextNudgeSent = true;
    recordCompaction(state, currentTurn);

    // Pre-save safety net before compaction
    saveStateBeforeCompact(cwd, ctx);

    sendEnforcementWhisper(
      pi,
      ctx,
      `Auto-compacting: context at ${Math.round(usagePercent)}% ` +
        `(${Math.round(usageTokens / 1000)}K tokens). ` +
        `State saved -- resuming after compact.`,
    );

    // Defer ctx.compact() to after handler returns (ctx.compact() aborts
    // the agent loop -- setTimeout(0) ensures the handler exits first).
    setTimeout(() => {
      try {
        ctx.compact({ customInstructions: "Keep the most recent 10 messages." });
      } catch {
        // agent already disconnected -- non-fatal
      }
    }, 0);
    return;
  }

  if (state.contextNudgeSent) return;

  // ── Token-based whispers (fire earlier for large context windows) ───
  if (usageTokens >= USAGE_TOKENS_WARNING) {
    state.contextNudgeSent = true;
    sendEnforcementWhisper(
      pi,
      ctx,
      `Context at ${Math.round(usageTokens / 1000)}K tokens (${Math.round(usagePercent)}%). ` +
        `Pipeline: context_navigate(action="tag") -> context_compress(action="archive") -> compact (last resort).`,
    );
    return;
  }

  if (usageTokens >= USAGE_TOKENS_SOFT) {
    state.contextNudgeSent = true;
    sendEnforcementWhisper(
      pi,
      ctx,
      `Context at ${Math.round(usageTokens / 1000)}K tokens. ` +
        `Consider context_inspect(detail="prune") to see candidates, or tag position with context_navigate(action="tag").`,
    );
    return;
  }

  // ── Percentage-based whispers ───────────────────────────────────────
  if (usagePercent >= USAGE_COMPACT_MEDIUM) {
    state.contextNudgeSent = true;
    sendEnforcementWhisper(
      pi,
      ctx,
      `Context at ${Math.round(usagePercent)}%. Pipeline: context_navigate(action="tag") -> ` +
        `context_compress(action="archive") -> compact (last resort). Tag your position first.`,
    );
    return;
  }

  if (usagePercent >= USAGE_WHISPER_CRITICAL) {
    state.contextNudgeSent = true;
    sendEnforcementWhisper(
      pi,
      ctx,
      `Context at ${Math.round(usagePercent)}%. Tag with context_navigate(action="tag"), ` +
        `then context_compress(action="archive") to branch with a summary.`,
    );
  }
}

// ── Registration ────────────────────────────────────────────────────────────

/**
 * Register the turn-end hygiene handler.
 *
 * Priority 5 (low -- runs after all analysis and enforcement handlers,
 * so context hygiene signals arrive last, as a closing reminder).
 * Auto-compacts at aggressive thresholds with pre-save safety.
 */
export function registerTurnEndHygiene(pi: ExtensionAPI): void {
  registerTurnEndHandler("turn-end-hygiene", 5, async (event, ctx) => {
    try {
      checkContextUsage(pi, ctx, event);
    } catch (err) {
      log.error("turn-end-hygiene error:", err);
    }
  });

  log.debug("turn-end-hygiene registered (priority 5) -- auto-compact at >=90% or >=100K tokens, 15-turn cooldown");
}
