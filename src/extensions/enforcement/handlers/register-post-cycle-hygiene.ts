/**
 * register-post-cycle-hygiene - Auto-tag + inspect + whisper on yield.
 *
 * Fires at turn-end when the agent yields with a text-only response
 * (no tool calls) after a cycle of work. Detects the natural cycle
 * boundary and:
 *   1. Auto-tags the position via sessionManager.setLabel
 *   2. Counts messages in the session for a lightweight status
 *   3. Whispers a brief hygiene advisory with actionable suggestions
 *
 * Trigger: text-only assistant response preceded by 2+ turns with
 *   edit/write/finalize tools. Minimum 10-turn cooldown between firings.
 *
 * Safety: never tags more than once per 10 turns, never fires during
 * error bursts, no archiving/compaction — just tag + inspect + advise.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { registerTurnEndHandler } from "../../../lib/events/turn-end-coordinator.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { getState } from "../state.js";
import { getSessionManager } from "../../../lib/state/session-manager.js";

const log = createLogger("enforcement:post-cycle-hygiene");

/** How many turns of work (tools with edits/writes) preceded a yield. */
const MIN_WORK_TURNS = 2;

/** Lookback window for detecting preceding work. */
const WORK_LOOKBACK = 5;

/** Cooldown between post-cycle hygiene firings. */
const HYGIENE_COOLDOWN_TURNS = 10;

/** Cooldown during error bursts — never fire. */
const ERROR_BURST_LOOKBACK = 3;

/**
 * Check whether the current turn is a text-only yield after work.
 */
function isWorkYield(
  ctx: ExtensionContext,
  event: any,
): boolean {
  const state = getState(ctx);
  if (!state?.enforcementActive) return false;

  const currentTurn = state.currentTurn;
  const turnState = state.turnHistory?.get(currentTurn);
  if (!turnState) return false;

  // Must be text-only in this turn (no tool calls)
  const hasToolCalls =
    turnState.actualTools?.length > 0 ||
    (Array.isArray(event?.toolResults) && event.toolResults.length > 0);
  if (hasToolCalls) return false;

  // Must have preceding work turns (edit/write/finalize)
  let workTurns = 0;
  for (let i = 1; i <= WORK_LOOKBACK; i++) {
    const prev = state.turnHistory?.get(currentTurn - i);
    if (prev?.actualTools) {
      if (prev.actualTools.includes("finalize")) {
        workTurns++;
        break; // finalize counts as the work anchor
      }
      if (prev.actualTools.some((t: string) => ["edit", "write"].includes(t))) {
        workTurns++;
      }
    }
  }
  if (workTurns < MIN_WORK_TURNS) return false;

  // Error burst suppression
  if (state.consecutiveErrorTurns >= ERROR_BURST_LOOKBACK) return false;

  return true;
}

/**
 * Perform post-cycle hygiene: auto-tag, inspect, whisper.
 */
function performPostCycleHygiene(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: any,
): void {
  const state = getState(ctx);
  const currentTurn = state.currentTurn;

  // ── 1. Auto-tag ────────────────────────────────────────────────────
  const tagName = `cycle-${currentTurn}`;
  try {
    const sm = getSessionManager(ctx);
    const leafId = sm.getLeafId();
    sm.setLabel(leafId, tagName);
    log.info(`Auto-tagged position as "${tagName}" on yield (turn ${currentTurn})`);
  } catch (err) {
    log.debug(`Auto-tag failed (non-fatal): ${err}`);
  }

  // ── 2. Lightweight session inspection ──────────────────────────────
  const branch = getSessionManager(ctx).getBranch();
  const assistantMessages = branch.filter(
    (e) => e.message?.role === "assistant",
  ).length;
  const toolResultMessages = branch.filter(
    (e) => e.message?.role === "toolResult",
  ).length;
  const userMessages = branch.filter(
    (e) => e.message?.role === "user",
  ).length;
  const totalMessages = branch.length;

  // Estimate pruning candidates: old tool results (age > 3 from leaf)
  // and assistant messages with minimal content.
  const branchLen = branch.length;
  const oldToolResults = branch.filter((e, i) => {
    if (e.message?.role !== "toolResult") return false;
    return branchLen - 1 - i > 3; // age > 3 from leaf
  }).length;

  // ── 3. Whisper brief hygiene advisory ─────────────────────────────
  const msgParts: string[] = [];
  msgParts.push(
    `Cycle boundary: ${assistantMessages} assistant / ${toolResultMessages} tool / ${userMessages} user messages.`,
  );

  if (oldToolResults > 5) {
    msgParts.push(
      `~${oldToolResults} older tool results are prune candidates — ` +
      `consider \`context_compress(action="compact")\` to remove redundant entries.`,
    );
  } else if (assistantMessages > 20) {
    msgParts.push(
      `${assistantMessages} assistant messages suggests rising context — ` +
      `consider \`context_inspect(detail="prune")\` to see candidates.`,
    );
  } else {
    msgParts.push(
      `Context looks clean (${totalMessages} messages, ${oldToolResults} old tool results).`,
    );
  }

  const whisper = msgParts.join(" ");
  sendEnforcementWhisper(pi, ctx, whisper, false, { triggerTurn: false });
  log.info(`Post-cycle hygiene: ${whisper}`);

  // Record this firing for cooldown
  state.lastPostCycleHygieneTurn = currentTurn;
}

// ── Registration ────────────────────────────────────────────────────────────

/**
 * Register the post-cycle hygiene turn-end handler.
 *
 * Priority 1 (lowest — runs after all analysis, enforcement, and hygiene
 * handlers). Only fires on text-only yields after work cycles.
 */
export function registerPostCycleHygiene(pi: ExtensionAPI): void {
  registerTurnEndHandler("post-cycle-hygiene", 1, async (event, ctx) => {
    try {
      const state = getState(ctx);
      if (!state?.enforcementActive) return;

      // Cooldown check
      const currentTurn = state.currentTurn;
      if (currentTurn - state.lastPostCycleHygieneTurn < HYGIENE_COOLDOWN_TURNS) return;

      // Trigger check
      if (!isWorkYield(ctx, event)) return;

      performPostCycleHygiene(pi, ctx, event);
    } catch (err) {
      log.error("post-cycle-hygiene error:", err);
    }
  });

  log.debug(
    "post-cycle-hygiene registered (priority 1) — auto-tags on yield, " +
    `${HYGIENE_COOLDOWN_TURNS}-turn cooldown`,
  );
}