/**
 * Turn End Handler - main enforcement loop.
 *
 * Fires on turn_end: error burst detection, context overflow, redundancy,
 * critical signals, orphan chain detection, claim tracking, L2 signal bundling.
 *
 * Extracted from handler-registry.ts to reduce it from 1054L.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { detectMissingVerification, recordCodeChange } from "../detection/verification.js";
import {
  type TurnAnalysisContext,
  detectRedundancySignal,
  handleCriticalSignals,
} from "./turn-analysis.js";
import { detectOrphanChains } from "./orphan-chains.js";
import { getNudgeManager } from "../nudge-manager.js";
import { getState, ERROR_BURST_THRESHOLD, RECOVERY_GRACE_TURNS, markNudgeSent, shouldNudgeForMemory, markMemoryNudgeSent } from "../state.js";
import { recordNudgeSuppressed, getNudgeAnalytics } from "../../../lib/reasoning/nudge-analytics.js";
import { type TurnState } from "../types.js";
import { validateTurn } from "../validation.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { knownFiles, loadFileContent } from "../similarity.js";
import { enforcementSignals, determineContrastMode, pruneSignals } from "../signals.js";
import {
  USAGE_WHISPER_CRITICAL,
  USAGE_FIRED_RESET_BELOW,
  USAGE_COMPACT_MEDIUM,
  USAGE_TOKENS_SOFT,
  USAGE_TOKENS_WARNING,
} from "../../../lib/detection/context-thresholds.js";

const log = createLogger("enforcement:turn-end");

export async function dispatchTurnEndLoop(
  pi: ExtensionAPI,
  event: any,
  ctx: ExtensionContext,
): Promise<void> {
  if (!getState(ctx).enforcementActive) return;

  const actualTools: string[] = (event.toolResults || [])
    .map((r: any) => r.toolName)
    .filter((name: string) => name && name.trim().length > 0);
  const erroredTools: Set<string> = new Set(
    (event.toolResults || [])
      .filter((r: any) => r.isError && r.toolName && r.toolName.trim().length > 0)
      .map((r: any) => r.toolName),
  );
  const hadErrors = erroredTools.size > 0;

  // ── Error burst detection ──────────────────────────────────────────────
  if (hadErrors) {
    const state = getState(ctx);
    state.consecutiveErrorTurns++;
    if (state.consecutiveErrorTurns === ERROR_BURST_THRESHOLD) {
      sendEnforcementWhisper(
        pi,
        ctx,
        `Error burst detected: ${state.consecutiveErrorTurns} consecutive errors. Consider stepping back.`,
        true, // critical - needs agent response
      );
    }
  } else {
    getState(ctx).consecutiveErrorTurns = 0;
  }
  const isBurst = getState(ctx).consecutiveErrorTurns >= ERROR_BURST_THRESHOLD;

  // ── Context overflow detection ─────────────────────────────────────────
  const msgContent =
    (event.message as unknown as { content?: Array<{ type: string; text?: string }> })?.content ??
    [];
  const isOverflowTurn =
    event.message.role === "assistant" &&
    "stopReason" in event.message &&
    (event.message as unknown as { stopReason?: string }).stopReason === "error" &&
    msgContent
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c?.text || "")
      .join(" ")
      .toLowerCase()
      .includes("context") &&
    msgContent
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c?.text || "")
      .join(" ")
      .toLowerCase()
      .includes("overflow");

  if (isOverflowTurn) {
    getState(ctx).overflowRecently = getState(ctx).currentTurn;
  }

  // ── Code change tracking ───────────────────────────────────────────────
  if (actualTools.some((t: string) => ["edit", "write"].includes(t))) {
    recordCodeChange(getState(ctx).currentTurn, ctx);
  }

  if (!isBurst) {
    detectMissingVerification(pi, ctx, getState(ctx).currentTurn);
  }

  const scratchpadUpdated = actualTools.includes("scratchpad");
  if (scratchpadUpdated) {
    getState(ctx).lastScratchpadNudgeTurn = -100;
  }

  const memoryUpdated = actualTools.some((t: string) =>
    ["memory_store", "memory"].includes(t),
  );

  if (memoryUpdated && enforcementSignals["unpersisted_learnings"]) {
    delete enforcementSignals["unpersisted_learnings"];
  }

  if (!memoryUpdated) {
    if (actualTools.length > 0 && !hadErrors) {
      getState(ctx).turnsSinceMemory++;
    }
  } else {
    getState(ctx).turnsSinceMemory = 0;
  }

  // ── Turn state recording ────────────────────────────────────────────────
  const turnState: TurnState = {
    turnIndex: getState(ctx).currentTurn,
    plannedTools: [],
    actualTools,
    scratchpadUpdated,
    memoryUpdated,
    sequenceRepetitionCount: 0,
    thinkCalledBeforeEdit: getState(ctx).toolChain.lastThinkCall >= getState(ctx).currentTurn - 2,
    planCalledForBugFix: getState(ctx).toolChain.lastPlanCall >= getState(ctx).currentTurn - 3,
  };

  getState(ctx).turnHistory.set(getState(ctx).currentTurn, turnState);
  if (getState(ctx).turnHistory.size > 50) {
    const oldest = Math.min(...getState(ctx).turnHistory.keys());
    getState(ctx).turnHistory.delete(oldest);
  }

  // ── Redundancy detection ────────────────────────────────────────────────
  if (actualTools.some((t: string) => ["edit", "write"].includes(t))) {
    const tac: TurnAnalysisContext = {
      pi,
      ctx,
      state: getState(ctx),
      event: {
        role: event.message.role,
        stopReason: (event.message as unknown as { stopReason?: string }).stopReason,
      },
      actualTools,
      erroredTools,
      hadErrors,
      knownFiles,
      enforcementSignals,
      sendWhisper: (msg) => sendEnforcementWhisper(pi, ctx, msg),
      loadFileContent,
    };
    if (!isBurst) {
      await detectRedundancySignal(tac);
    }
  }

  // ── L3: Critical signals ────────────────────────────────────────────────
  const prevTurn = getState(ctx).turnHistory.get(getState(ctx).currentTurn - 1);
  const tac: TurnAnalysisContext = {
    pi,
    ctx,
    state: getState(ctx),
    event: {
      role: event.message.role,
      stopReason: (event.message as unknown as { stopReason?: string }).stopReason,
    },
    actualTools,
    erroredTools,
    hadErrors,
    knownFiles,
    enforcementSignals,
    sendWhisper: (msg) => sendEnforcementWhisper(pi, ctx, msg),
    loadFileContent,
  };
  handleCriticalSignals(tac, prevTurn, turnState, getNudgeManager(ctx), validateTurn);

  // ── Orphan thought chain detection ─────────────────────────────────────
  const orphanResult = detectOrphanChains(getState(ctx));
  if (!isBurst && orphanResult) {
    sendEnforcementWhisper(pi, ctx, orphanResult.suggestion);
  }

  // ── L2: Session Signals bundling ────────────────────────────────────────

  // BR3: Check A/B variant
  const abVariant = getNudgeAnalytics(ctx).abVariant;
  const suppressNudges = abVariant === "no_nudges";
  if (suppressNudges) {
    getState(ctx).nudgeSuppressedCount = (getState(ctx).nudgeSuppressedCount || 0) + 1;
    recordNudgeSuppressed(ctx);
    if (getState(ctx).nudgeSuppressedCount === 1) {
      log.debug("Nudge suppression active - L2 signals will be collected but not delivered");
    }
  }

  const sessionSignals: string[] = [];

  if (suppressNudges) {
    // Skip all L2 signal collection when nudges are suppressed
  }

  // Memory signal
  const inOverflowRecovery =
    getState(ctx).currentTurn - getState(ctx).overflowRecently < RECOVERY_GRACE_TURNS;

  if (
    !hadErrors &&
    !inOverflowRecovery &&
    shouldNudgeForMemory(getState(ctx), getState(ctx).currentTurn, 20)
  ) {
    markMemoryNudgeSent(getState(ctx));
    sessionSignals.push(
      "Code changed but nothing stored. Capture the key pattern or fix: " +
        'memory_store(content="...", tags=["pattern", "fix"])',
    );
  }

  // Scratchpad signal - widened: fires on (a) write/edit without scratchpad,
  // or (b) complex turn (3+ tools) without scratchpad
  const madeFileChanges = actualTools.some((t: string) => ["edit", "write"].includes(t));
  const isComplexTurn = actualTools.length >= 3;
  const needsScratchpad = (madeFileChanges || isComplexTurn) && !scratchpadUpdated;
  if (!hadErrors && !inOverflowRecovery && needsScratchpad) {
    const cooldown = madeFileChanges ? 8 : 15; // Tighter for file changes, relaxed for complexity
    if (getState(ctx).currentTurn - getState(ctx).lastScratchpadNudgeTurn >= cooldown) {
      getState(ctx).lastScratchpadNudgeTurn = getState(ctx).currentTurn;
      const reason = madeFileChanges
        ? "Code changed without updating scratchpad"
        : `Complex turn (${actualTools.length} tools) without scratchpad`;
      sessionSignals.push(`${reason}. Consider updating scratchpad(action="add_note", text="...")`);
    }
  }

  // Think tool enforcement - widened: fires on (a) no think ever called by turn 5,
  // or (b) high-stakes actions (edit/write/finalize) without prior think this session
  const madeHighStakesAction = actualTools.some((t: string) =>
    ["edit", "write", "finalize"].includes(t),
  );
  const noThinkThisSession = getState(ctx).toolChain.lastThinkCall === 0;
  const thinkNeeded =
    (noThinkThisSession && getState(ctx).currentTurn >= 5 && getState(ctx).currentTurn % 5 === 0) ||
    (madeHighStakesAction && noThinkThisSession && getState(ctx).currentTurn >= 3);
  if (!hadErrors && !inOverflowRecovery && thinkNeeded) {
    sessionSignals.push(
      madeHighStakesAction
        ? `High-stakes action without prior think(). Consider think(observation, decision, reason) before the next change.`
        : `${getState(ctx).currentTurn} turns without think() - consider think(observation, decision, reason) to track reasoning`,
    );
  }

  // Context usage signal: agent called one of the real context tools
  // (consolidated from the old context_tag/context_log/context_checkout/
  // context_prune/context_audit sub-action names).
  const contextToolNames = new Set([
    "context_inspect",
    "context_compress",
    "context_navigate",
    "context_proposals",
  ]);
  if (actualTools.some((t) => contextToolNames.has(t))) {
    getState(ctx).lastContextCheckTurn = getState(ctx).currentTurn;
    getState(ctx).contextNudgeSent = false;
  }

  let usagePercent = 0;
  let usageTokens = 0;
  try {
    const ctxFromEvent = (
      event as unknown as { ctx?: { getContextUsage?(): { percent?: number; tokens?: number } } }
    )?.ctx;
    const usage = ctxFromEvent?.getContextUsage?.();
    if (usage) {
      usagePercent = usage.percent ?? 0;
      usageTokens = usage.tokens ?? 0;
    }
  } catch {
    /* ignore */
  }

  // Reset contextNudgeSent if usage dropped below reset threshold
  // (e.g. after compaction or archive freed space)
  if (getState(ctx).contextNudgeSent && usagePercent < USAGE_FIRED_RESET_BELOW) {
    getState(ctx).contextNudgeSent = false;
  }

  // ── Token-count early check (tighter interval, fires before percentage) ──
  // Uses a shorter interval (8 turns) because we want preventive nudges at
  // 30K tokens, not reactive ones at 80%.
  if (!hadErrors && actualTools.length > 0 && !getState(ctx).contextNudgeSent && usageTokens > 0) {
    const tokenCheckInterval = 8;
    const turnsSinceLastCheck = getState(ctx).currentTurn - getState(ctx).lastContextCheckTurn;
    if (turnsSinceLastCheck >= tokenCheckInterval) {
      if (usageTokens >= USAGE_TOKENS_WARNING) {
        markNudgeSent(getState(ctx), getState(ctx).currentTurn);
        sessionSignals.push(
          `Context at ${Math.round(usageTokens / 1000)}K tokens (${Math.round(usagePercent)}%). ` +
            `Pipeline: context_navigate(action="tag") → context_compress(action="archive") → compact (last resort).`,
        );
      } else if (usageTokens >= USAGE_TOKENS_SOFT) {
        markNudgeSent(getState(ctx), getState(ctx).currentTurn);
        sessionSignals.push(
          `Context at ${Math.round(usageTokens / 1000)}K tokens. ` +
            `Consider context_inspect(detail="prune") to see candidates, or tag position with context_navigate(action="tag").`,
        );
      }
    }
  }

  // ── Percentage-based check (original, longer interval) ──────────────────
  if (
    !hadErrors &&
    actualTools.length > 0 &&
    getState(ctx).currentTurn - getState(ctx).lastContextCheckTurn >=
      getState(ctx).contextCheckInterval &&
    !getState(ctx).contextNudgeSent &&
    usagePercent > 0
  ) {
    markNudgeSent(getState(ctx), getState(ctx).currentTurn);
    const pct = Math.round(usagePercent);
    if (usagePercent >= USAGE_COMPACT_MEDIUM) {
      sessionSignals.push(
        `Context at ${pct}%. Pipeline: context_navigate(action="tag") → ` +
          `context_compress(action="archive") → compact (last resort). Tag your position first.`,
      );
    } else if (usagePercent >= USAGE_WHISPER_CRITICAL) {
      sessionSignals.push(
        `Context at ${pct}%. Tag with context_navigate(action="tag"), then context_compress(action="archive") to branch with a summary.`,
      );
    }
  }

  // BV1: Surface localization risk
  if (getState(ctx)._localizationRisk) {
    sessionSignals.push(`[localization] ${getState(ctx)._localizationRisk}`);
    getState(ctx)._localizationRisk = "";
  }

  // Suppress L2 signals during error burst
  if (isBurst) {
    sessionSignals.length = 0;
  }

  // ── Signal emission ─────────────────────────────────────────────────────
  // Emit contrast mode so prompt-builder can render truthfulness guardrails.
  pi.events.emit("enforcement_signals", {
    contrastMode: determineContrastMode(ctx),
  });

  // Clean up stale enforcement signals (kept for cross-turn MARS readback)
  if (sessionSignals.length > 0) {
    pruneSignals(getState(ctx).currentTurn);

    // BR3: Only bundle and send if nudges are not suppressed
    if (!suppressNudges && sessionSignals.length > 0) {
      const bundled = `[Session Signals]\n${sessionSignals.map((s) => `- ${s}`).join("\n")}`;
      const { shouldSend } = getNudgeManager(ctx).shouldSendNudge("scratchpad", bundled);
      if (shouldSend) {
        sendEnforcementWhisper(pi, ctx, bundled);
      }
    }
  }
}
