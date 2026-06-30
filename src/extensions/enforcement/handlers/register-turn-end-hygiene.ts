/**
 * register-turn-end-hygiene - Context hygiene + discoverability on every turn_end.
 *
 * Fires on EVERY turn_end (not just when tools were called), checking:
 * 1. Context usage — if high, emit hygiene whispers (tag → archive → compact)
 * 2. Disk-backed state discoverability — if scratchpad/memory data exists
 *    but hasn't been read this session, surface it so the agent knows to
 *    use `scratchpad action=continue` or `memory action=recall_search`.
 *
 * This is the "environmental discoverability" layer: the agent's environment
 * makes its own state visible, rather than hiding it behind tool calls the
 * agent doesn't know to make.
 *
 * Dedup: discoverability whispers fire at most once per session per signal
 * (tracked via WeakMap). Context usage whispers respect the existing
 * contextNudgeSent state.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { createLogger } from "../../../lib/core/logger.js";
import { registerTurnEndHandler } from "../../../lib/events/turn-end-coordinator.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { getState } from "../state.js";
import { getContextUsageFromEvent } from "../../../lib/state/extension-state.js";
import { SCRATCHPAD_DIR, EPISODES_FILE, SEMANTIC_MEMORY_FILE } from "../../../lib/config/braid-paths.js";
import { projectSlugFromCwd } from "../../memory/scratchpad/persistence.js";
import {
  USAGE_TOKENS_SOFT,
  USAGE_TOKENS_WARNING,
  USAGE_WHISPER_CRITICAL,
  USAGE_COMPACT_MEDIUM,
} from "../../../lib/detection/context-thresholds.js";

const log = createLogger("enforcement:turn-end-hygiene");

// ── Discoverability state (session-scoped, keyed by cwd) ────────────────────
// WeakMap on ctx doesn't survive ctx replacement between turns.
// Use a plain Map keyed by cwd (stable per session).

interface DiscoverabilityState {
  scratchpadSurfaced: boolean;
  memorySurfaced: boolean;
}

const discoverabilityStates = new Map<string, DiscoverabilityState>();

function getDiscoverabilityState(ctx: ExtensionContext): DiscoverabilityState {
  const cwd = (ctx as { cwd?: string }).cwd ?? "default";
  let state = discoverabilityStates.get(cwd);
  if (!state) {
    state = { scratchpadSurfaced: false, memorySurfaced: false };
    discoverabilityStates.set(cwd, state);
  }
  return state;
}

// ── Context usage check ─────────────────────────────────────────────────────

function checkContextUsage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: any,
): void {
  const state = getState(ctx);
  if (!state.enforcementActive) return;

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

  if (usagePercent <= 0 && usageTokens <= 0) return;

  // Reset nudge flag if usage dropped (e.g., after compaction)
  if (state.contextNudgeSent && usagePercent < 50) {
    state.contextNudgeSent = false;
  }

  if (state.contextNudgeSent) return;

  // Token-based check (fires earlier for large context windows)
  if (usageTokens >= USAGE_TOKENS_WARNING) {
    state.contextNudgeSent = true;
    sendEnforcementWhisper(
      pi,
      ctx,
      `Context at ${Math.round(usageTokens / 1000)}K tokens (${Math.round(usagePercent)}%). ` +
        `Pipeline: context_navigate(action="tag") → context_compress(action="archive") → compact (last resort).`,
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

  // Percentage-based check
  if (usagePercent >= USAGE_COMPACT_MEDIUM) {
    state.contextNudgeSent = true;
    sendEnforcementWhisper(
      pi,
      ctx,
      `Context at ${Math.round(usagePercent)}%. Pipeline: context_navigate(action="tag") → ` +
        `context_compress(action="archive") → compact (last resort). Tag your position first.`,
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

// ── Discoverability checks ──────────────────────────────────────────────────

function checkScratchpadDiscoverability(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  const discState = getDiscoverabilityState(ctx);
  if (discState.scratchpadSurfaced) return;

  const cwd = (ctx as { cwd?: string }).cwd ?? "";
  const slug = projectSlugFromCwd(cwd);
  const scratchpadFile = path.join(SCRATCHPAD_DIR, slug, "latest.json");

  if (!existsSync(scratchpadFile)) return;

  // Check if the agent has already called scratchpad this session
  // by looking at the tool log for any scratchpad tool calls
  const state = getState(ctx);
  const scratchpadCalled = state.toolLog.some((entry) => entry.includes("scratchpad"));
  if (scratchpadCalled) {
    discState.scratchpadSurfaced = true;
    return;
  }

  discState.scratchpadSurfaced = true;
  sendEnforcementWhisper(
    pi,
    ctx,
    `Prior scratchpad data exists for this project. Use \`scratchpad action=continue\` to resume — ` +
      `it returns goal + open plan + recent context in one call.`,
  );
}

function checkMemoryDiscoverability(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  const discState = getDiscoverabilityState(ctx);
  if (discState.memorySurfaced) return;

  // Check if episodes or semantic memory files exist and have content
  let hasEpisodes = false;
  let hasSemantic = false;

  try {
    if (existsSync(EPISODES_FILE)) {
      const stat = statSync(EPISODES_FILE);
      if (stat.size > 10) hasEpisodes = true;
    }
  } catch {
    // ignore
  }

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

  if (!hasEpisodes && !hasSemantic) return;

  // Check if memory tools have been called this session
  // hasRecalledOnStart is set when the agent calls `memory` tool
  const state = getState(ctx);
  if (state.hasRecalledOnStart) {
    discState.memorySurfaced = true;
    return;
  }

  discState.memorySurfaced = true;
  const sources: string[] = [];
  if (hasEpisodes) sources.push("episodes");
  if (hasSemantic) sources.push("semantic memory");

  sendEnforcementWhisper(
    pi,
    ctx,
    `Prior ${sources.join(" and ")} available. Use \`memory action=recall_search\` with a relevant query ` +
      `to surface insights from past sessions before starting new work.`,
  );
}

// ── Registration ────────────────────────────────────────────────────────────

/**
 * Register the turn-end hygiene handler.
 *
 * Priority 5 (low — runs after all analysis and enforcement handlers,
 * so hygiene + discoverability signals arrive last, as a closing reminder).
 */
export function registerTurnEndHygiene(pi: ExtensionAPI): void {
  registerTurnEndHandler("turn-end-hygiene", 5, async (event, ctx) => {
    try {
      checkContextUsage(pi, ctx, event);
      checkScratchpadDiscoverability(pi, ctx);
      checkMemoryDiscoverability(pi, ctx);
    } catch (err) {
      log.error("turn-end-hygiene error:", err);
    }
  });

  log.debug("turn-end-hygiene registered (priority 5)");
}
