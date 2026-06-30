/**
 * register-turn-end-hygiene - Context hygiene on every turn_end.
 *
 * Fires on EVERY turn_end (not just when tools were called), checking
 * context usage — if high, emit hygiene whispers (tag → archive → compact).
 *
 * Discoverability (scratchpad/memory/episodes surfacing) has been moved to
 * SESSION_START (register-session-start-discoverability.ts) so it fires
 * BEFORE the first turn, not after. This handler now focuses solely on
 * context usage, which changes per turn.
 *
 * Context usage whispers respect the existing contextNudgeSent state.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { registerTurnEndHandler } from "../../../lib/events/turn-end-coordinator.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { getState } from "../state.js";
import { getContextUsageFromEvent } from "../../../lib/state/extension-state.js";
import {
  USAGE_TOKENS_SOFT,
  USAGE_TOKENS_WARNING,
  USAGE_WHISPER_CRITICAL,
  USAGE_COMPACT_MEDIUM,
} from "../../../lib/detection/context-thresholds.js";

const log = createLogger("enforcement:turn-end-hygiene");

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

// ── Registration ────────────────────────────────────────────────────────────

/**
 * Register the turn-end hygiene handler.
 *
 * Priority 5 (low — runs after all analysis and enforcement handlers,
 * so context hygiene signals arrive last, as a closing reminder).
 * Discoverability signals have been moved to SESSION_START.
 */
export function registerTurnEndHygiene(pi: ExtensionAPI): void {
  registerTurnEndHandler("turn-end-hygiene", 5, async (event, ctx) => {
    try {
      checkContextUsage(pi, ctx, event);
    } catch (err) {
      log.error("turn-end-hygiene error:", err);
    }
  });

  log.debug("turn-end-hygiene registered (priority 5, context usage only)");
}
