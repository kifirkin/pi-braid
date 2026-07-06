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
import { getNudgeManager, type NudgeType } from "../nudge-manager.js";
import { getState, ERROR_BURST_THRESHOLD, RECOVERY_GRACE_TURNS, markNudgeSent, shouldNudgeForMemory, markMemoryNudgeSent } from "../state.js";
import { recordNudgeSuppressed, getNudgeAnalytics } from "../../../lib/reasoning/nudge-analytics.js";
import {
  recordTurnEnd,
  detectToolLoop,
  getToolLoopState,
  markLoopFired,
} from "../../../lib/detection/tool-loop-detector.js";
import { getStopReason, getMessageContent, getContextUsageFromEvent } from "../../../lib/state/extension-state.js";
import { type TurnState } from "../types.js";
import { validateTurn } from "../validation.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { knownFiles, loadFileContent } from "../similarity.js";
import { enforcementSignals, determineContrastMode, pruneSignals, SIGNAL_KEYS } from "../signals.js";
import {
  USAGE_WHISPER_CRITICAL,
  USAGE_FIRED_RESET_BELOW,
  USAGE_COMPACT_MEDIUM,
  USAGE_TOKENS_SOFT,
  USAGE_TOKENS_WARNING,
} from "../../../lib/detection/context-thresholds.js";

const log = createLogger("enforcement:turn-end");

// EW-7.2: L2 sub-signals that have a dedicated NudgeType use the
// type's own cooldown (memory: 45s, scratchpad: 60s, context: 90s).
// Sub-signals without a dedicated type fall through to `sessionSignals`
// with the subKey distinguishing them (think, localization).
const L2_NUDGE_TYPE: Record<string, { type: NudgeType; subKey?: string }> = {
  memory: { type: "memory" },
  scratchpad: { type: "scratchpad" },
  "context-tokens": { type: "context", subKey: "tokens" },
  "context-percent": { type: "context", subKey: "percent" },
  think: { type: "sessionSignals", subKey: "think" },
  startup: { type: "sessionSignals", subKey: "startup" },
  finalize: { type: "sessionSignals", subKey: "finalize" },
  verify: { type: "sessionSignals", subKey: "verify" },
};

function nudgeTypeForKey(key: string): { type: NudgeType; subKey?: string } {
  return L2_NUDGE_TYPE[key] ?? { type: "sessionSignals", subKey: key };
}

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

  // ── Tool output extraction (for verification judge) ───────────────────
  const toolOutputs: string[] = [];
  const MAX_OUTPUT_CHARS = 300;
  for (const r of event.toolResults || []) {
    const outputText = (r.content || [])
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text || "")
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")  // collapse excessive blank lines
      .trim();
    if (outputText) {
      const truncated = outputText.length > MAX_OUTPUT_CHARS
        ? outputText.slice(0, MAX_OUTPUT_CHARS) + "..."
        : outputText;
      toolOutputs.push(`${r.toolName}: ${truncated}`);
    }
  }

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

  // ── Tool loop detection (per-turn tool sets) ───────────────────────────
  if (!isBurst) {
    const loopState = getToolLoopState(ctx);
    recordTurnEnd(loopState);
    const loopResult = detectToolLoop(loopState);
    if (loopResult.isLoop) {
      markLoopFired(loopState);
      // BUGFIX 2026-07-06: tool-loop whispers must NOT trigger a new turn.
      // `triggerTurn: false` keeps the violation event for MARS/analytics
      // but prevents pi-core from starting a new LLM turn. Without this,
      // a tool-loop whisper creates turn N+1, which also loops, creating
      // turn N+2 -- a cascade that inflates the turn count and floods the
      // session. The agent sees the warning on its next natural turn.
      sendEnforcementWhisper(pi, ctx, loopResult.message, true, { triggerTurn: false });
    }
  }

  // ── Context overflow detection ─────────────────────────────────────────
  const msgContent = getMessageContent(event.message);
  const isOverflowTurn =
    event.message.role === "assistant" &&
    "stopReason" in event.message &&
    getStopReason(event.message) === "error" &&
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

  if (memoryUpdated && enforcementSignals[SIGNAL_KEYS.unpersisted_learnings]) {
    delete enforcementSignals[SIGNAL_KEYS.unpersisted_learnings];
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
    toolOutputs,
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
        stopReason: getStopReason(event.message),
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
      stopReason: getStopReason(event.message),
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
    const count = (getState(ctx).nudgeSuppressedCount || 0) + 1;
    getState(ctx).nudgeSuppressedCount = count;
    recordNudgeSuppressed(ctx);
    if (count === 1) {
      log.debug("Nudge suppression active - L2 signals will be collected but not delivered");
    }
    // EW-7.14 / P3-5: surface count to TUI every 5 suppressions
    if (count % 5 === 0) {
      try {
        ctx.ui.setStatus("nudge-suppressed", `${count}`);
      } catch {
        /* TUI not available */
      }
    }
  }

  // EW-7.9: each L2 session signal carries its own subKey so per-signal
  // cooldowns and dedup are independent. Adding/removing a signal no
  // longer re-arms the others (was the bundle bug fixed here).
  const sessionSignals: { key: string; content: string }[] = [];

  if (suppressNudges) {
    // Skip all L2 signal collection when nudges are suppressed
  }

  // Memory signal
  const inOverflowRecovery =
    getState(ctx).currentTurn - getState(ctx).overflowRecently < RECOVERY_GRACE_TURNS;

  // D-57: memory usage is a static instruction — covered by memory_store tool description
  // and MEMORY_AWARENESS system prompt. Keep the state counter for analytics but
  // suppress the repetitive whisper.
  if (
    !hadErrors &&
    !inOverflowRecovery &&
    shouldNudgeForMemory(getState(ctx), getState(ctx).currentTurn, 20)
  ) {
    markMemoryNudgeSent(getState(ctx));
    // whisper suppressed — instruction lives in tool description
  }

  // Scratchpad signal - widened: fires on (a) write/edit without scratchpad,
  // or (b) complex turn (3+ tools) without scratchpad
  const madeFileChanges = actualTools.some((t: string) => ["edit", "write"].includes(t));
  const isComplexTurn = actualTools.length >= 3;
  const needsScratchpad = (madeFileChanges || isComplexTurn) && !scratchpadUpdated;
  // D-57: scratchpad usage is a static instruction — covered by scratchpad tool description.
  // Keep cooldown tracking for potential future use but suppress the repetitive whisper.
  if (!hadErrors && !inOverflowRecovery && needsScratchpad) {
    const cooldown = madeFileChanges ? 8 : 15;
    if (getState(ctx).currentTurn - getState(ctx).lastScratchpadNudgeTurn >= cooldown) {
      getState(ctx).lastScratchpadNudgeTurn = getState(ctx).currentTurn;
      // whisper suppressed — instruction lives in tool description
    }
  }

  // Planning signal: tool calls without scratchpad goal at any turn.
  // Increments toolsSinceLastPlan when the agent makes tool calls without
  // setting a scratchpad goal. Resets when scratchpad is used.
  // drives determineContrastMode PLANNING mode via toolsSinceLastPlan >= 3.
  if (!hadErrors && !inOverflowRecovery && actualTools.length > 0) {
    if (scratchpadUpdated) {
      getState(ctx).toolsSinceLastPlan = 0;
    } else {
      // Only increment if the agent actually did work (not just read/ls)
      const workTools = actualTools.filter((t: string) =>
        !["read", "ls", "grep", "find", "memory"].includes(t),
      );
      if (workTools.length > 0) {
        getState(ctx).toolsSinceLastPlan += 1;
      }
    }
  }

  // Think tool enforcement - session level: fires on (a) no think ever called by turn 5,
  // or (b) high-stakes actions (edit/write/finalize) without prior think this session
  const madeHighStakesAction = actualTools.some((t: string) =>
    ["edit", "write", "finalize"].includes(t),
  );
  const noThinkThisSession = getState(ctx).toolChain.lastThinkCall === 0;
  const thinkNeeded =
    (noThinkThisSession && getState(ctx).currentTurn >= 5 && getState(ctx).currentTurn % 5 === 0) ||
    (madeHighStakesAction && noThinkThisSession && getState(ctx).currentTurn >= 3);
  // D-57: think usage is a static instruction — covered by think tool description
  // ("Required before editing, writing files, or making high-stakes changes").
  // Keep the detection logic for potential analytics but suppress the whisper.
  if (!hadErrors && !inOverflowRecovery && thinkNeeded) {
    // whisper suppressed — instruction lives in tool description
  }

  // Per-turn think-before-edit enforcement
  // Fires when edit/write is used in this turn but think was NOT called in this turn.
  // Uses a 3-turn cooldown (faster than the session-level 5-turn check above).
  if (!hadErrors && !inOverflowRecovery && getState(ctx).currentTurn >= 2) {
    const madeEditThisTurn = actualTools.some((t: string) => ["edit", "write"].includes(t));
    const thinkCalledThisTurn = getState(ctx).toolChain.lastThinkCall === getState(ctx).currentTurn;
    if (madeEditThisTurn && !thinkCalledThisTurn) {
      const perTurnCooldown = 3;
      if (getState(ctx).currentTurn - getState(ctx).lastThinkPerTurnNudge >= perTurnCooldown) {
        getState(ctx).lastThinkPerTurnNudge = getState(ctx).currentTurn;
        // D-57: per-turn think whisper suppressed — instruction lives in tool description
      }
    }
  }

  // Finalize enforcement
  // Fires when a turn has significant work (edit/write, or plans marked done)
  // but finalize was not called. Uses a 5-turn cooldown.
  if (!hadErrors && !inOverflowRecovery && getState(ctx).currentTurn >= 3) {
    const hasCompletionWork = actualTools.some((t: string) =>
      ["edit", "write", "finalize"].includes(t),
    );
    const calledFinalize = actualTools.includes("finalize");
    if (hasCompletionWork && !calledFinalize) {
      const finalizeCooldown = 5;
      if (getState(ctx).currentTurn - getState(ctx).lastFinalizeNudge >= finalizeCooldown) {
        getState(ctx).lastFinalizeNudge = getState(ctx).currentTurn;
        // D-57: finalize whisper suppressed — instruction lives in tool description
      }
    }
  }

  // Verify enforcement
  // Fires when code was changed (edit/write) but verify was not called in the same turn.
  // Uses a 5-turn cooldown.
  if (!hadErrors && !inOverflowRecovery) {
    const madeCodeChange = actualTools.some((t: string) => ["edit", "write"].includes(t));
    const calledVerify = actualTools.some((t: string) =>
      ["verify", "verify_claim"].includes(t),
    );
    if (madeCodeChange && !calledVerify) {
      const verifyCooldown = 5;
      if (getState(ctx).currentTurn - getState(ctx).lastVerifyNudge >= verifyCooldown) {
        getState(ctx).lastVerifyNudge = getState(ctx).currentTurn;
        // D-57: verify whisper suppressed — instruction lives in tool description
      }
    }
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
    const usage = getContextUsageFromEvent(event);
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
        sessionSignals.push({
          key: "context-tokens",
          content:
            `Context at ${Math.round(usageTokens / 1000)}K tokens (${Math.round(usagePercent)}%). ` +
            `Pipeline: context_navigate(action="tag") -> context_compress(action="archive") -> compact (last resort).`,
        });
      } else if (usageTokens >= USAGE_TOKENS_SOFT) {
        markNudgeSent(getState(ctx), getState(ctx).currentTurn);
        sessionSignals.push({
          key: "context-tokens",
          content:
            `Context at ${Math.round(usageTokens / 1000)}K tokens. ` +
            `Consider context_inspect(detail="prune") to see candidates, or tag position with context_navigate(action="tag").`,
        });
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
      sessionSignals.push({
        key: "context-percent",
        content:
          `Context at ${pct}%. Pipeline: context_navigate(action="tag") -> ` +
          `context_compress(action="archive") -> compact (last resort). Tag your position first.`,
      });
    } else if (usagePercent >= USAGE_WHISPER_CRITICAL) {
      sessionSignals.push({
        key: "context-percent",
        content:
          `Context at ${pct}%. Tag with context_navigate(action="tag"), then context_compress(action="archive") to branch with a summary.`,
      });
    }
  }

  // BV1: Surface localization risk
  if (getState(ctx).localizationRisk) {
    sessionSignals.push({
      key: "localization",
      content: `[localization] ${getState(ctx).localizationRisk}`,
    });
    getState(ctx).localizationRisk = "";
  }

  // Suppress L2 signals during error burst
  // ROADMAP P3-6 / EW-7.15: rename intent. Previously labeled as broad
  // "burst suppression" but only the L2 `sessionSignals` bundle was
  // wiped. L1 `enforcementSignals`, claim-tracker, verification judge,
  // and conflict detection continued to fire. The original goal of
  // burst suppression is to reduce noise during a crash; the current
  // implementation only freezes the Session Signals bundle. Keeping
  // the narrower scope intentional, but documenting it here so future
  // contributors don't assume broader suppression.
  if (isBurst) {
    sessionSignals.length = 0;
  }

  // ── Signal emission ─────────────────────────────────────────────────────
  // Emit behavior mode so prompt-builder can render the active directive.
  // The mode is determined by enforcement state (errors, overflow, edits
  // without think) and defaults to TRUTH-SEEKING.
  pi.events.emit("enforcement_signals", {
    contrastMode: determineContrastMode(ctx),
  });

  // Clean up stale enforcement signals (kept for cross-turn MARS readback)
  if (sessionSignals.length > 0) {
    pruneSignals(getState(ctx).currentTurn);

    // BR3: Only bundle and send if nudges are not suppressed.
    // EW-7.9: per-signal gating. Each sub-signal has its own cooldown
    // + dedup history keyed by `sig.key`. The bundle is built from
    // only the signals that pass the gate, so adding a new signal
    // does NOT re-arm previously-suppressed ones (the old bundle bug).
    if (!suppressNudges) {
      const nudgeManager = getNudgeManager(ctx);
      const unsent: string[] = [];
      for (const sig of sessionSignals) {
        const { type, subKey } = nudgeTypeForKey(sig.key);
        const { shouldSend } = nudgeManager.shouldSendNudge(
          type,
          sig.content,
          subKey,
        );
        if (shouldSend) {
          unsent.push(sig.content);
        }
      }
      if (unsent.length > 0) {
        const bundled = `[Session Signals]\n${unsent.map((s) => `- ${s}`).join("\n")}`;
        sendEnforcementWhisper(pi, ctx, bundled);
      }
    }
  }
}
