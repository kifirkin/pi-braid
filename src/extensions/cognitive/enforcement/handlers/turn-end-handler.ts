/**
 * Turn End Handler — main enforcement loop.
 *
 * Fires on turn_end: error burst detection, context overflow, redundancy,
 * critical signals, orphan chain detection, claim tracking, L2 signal bundling.
 *
 * Extracted from handler-registry.ts to reduce it from 1054L.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../../../lib/logger.js";
import { sendTrackedMessage } from "../../../../lib/injection-tracker.js";
import { eventBus } from "../../../../lib/event-bus.js";
import {
  detectMissingVerification,
  recordCodeChange as detectRecordCodeChange,
} from "../detection/verification.js";
import {
  type TurnAnalysisContext,
  detectRedundancySignal,
  handleCriticalSignals,
} from "./turn-analysis.js";
import { detectOrphanChains } from "./orphan-chains.js";
import { type NudgeManager } from "../nudge-manager.js";
import { getState } from "../state.js";
import { recordNudgeSent, recordNudgeSuppressed, getAnalyticsState } from "../../../heartbeat/analytics/index.js";
import { type TurnState } from "../types.js";
import { validateTurn } from "../validation.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { knownFiles, loadFileContent } from "../similarity.js";
import { enforcementSignals, determineContrastMode } from "../signals.js";

const log = createLogger("enforcement:turn-end");
const ERROR_BURST_THRESHOLD = 3;

export function registerTurnEndHandler(pi: ExtensionAPI, nudgeManager: NudgeManager): void {
  pi.on("turn_end" as never, async (event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) return;

    const actualTools: string[] = (event.toolResults || []).map((r: any) => r.toolName);
    const erroredTools: Set<string> = new Set(
      (event.toolResults || []).filter((r: any) => r.isError).map((r: any) => r.toolName),
    );
    const hadErrors = erroredTools.size > 0;

    // ── Error burst detection ──────────────────────────────────────────────
    if (hadErrors) {
      const state = getState(ctx);
      state.consecutiveErrorTurns++;
      if (state.consecutiveErrorTurns === ERROR_BURST_THRESHOLD) {
        sendEnforcementWhisper(
          pi,
          `Error burst detected: ${state.consecutiveErrorTurns} consecutive errors. Consider stepping back.`,
        );
      }
    } else {
      getState(ctx).consecutiveErrorTurns = 0;
    }
    const isBurst = getState(ctx).consecutiveErrorTurns >= ERROR_BURST_THRESHOLD;

    // ── Context overflow detection ─────────────────────────────────────────
    const msgContent =
      (event.message as unknown as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
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
      detectRecordCodeChange(getState(ctx).currentTurn);
    }

    if (!isBurst) {
      detectMissingVerification(pi as never, getState(ctx).currentTurn);
    }

    const scratchpadUpdated = actualTools.includes("scratchpad");
    if (scratchpadUpdated) {
      getState(ctx).lastScratchpadNudgeTurn = -100;
    }

    const memoryUpdated = actualTools.some((t: string) =>
      ["memory_store", "memory_recall", "memory_list"].includes(t),
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
        pi, ctx, state: getState(ctx),
        event: {
          role: event.message.role,
          stopReason: (event.message as unknown as { stopReason?: string }).stopReason,
        },
        actualTools, erroredTools, hadErrors, knownFiles, enforcementSignals,
        sendWhisper: (msg) => sendEnforcementWhisper(pi, msg),
        loadFileContent,
      };
      if (!isBurst) {
        await detectRedundancySignal(tac);
      }
    }

    // ── L3: Critical signals ────────────────────────────────────────────────
    const prevTurn = getState(ctx).turnHistory.get(getState(ctx).currentTurn - 1);
    const tac: TurnAnalysisContext = {
      pi, ctx, state: getState(ctx),
      event: {
        role: event.message.role,
        stopReason: (event.message as unknown as { stopReason?: string }).stopReason,
      },
      actualTools, erroredTools, hadErrors, knownFiles, enforcementSignals,
      sendWhisper: (msg) => sendEnforcementWhisper(pi, msg),
      loadFileContent,
    };
    handleCriticalSignals(tac, prevTurn, turnState, nudgeManager, validateTurn);

    // ── Orphan thought chain detection ─────────────────────────────────────
    const orphanResult = detectOrphanChains(getState(ctx));
    if (!isBurst && orphanResult) {
      sendEnforcementWhisper(pi, orphanResult.suggestion);
    }

    // ── Claim tracker (cross-turn contradiction detection) ─────────────────
    if (!isBurst && event.message?.role === "assistant" && event.message?.content) {
      const msgText = Array.isArray(event.message.content)
        ? event.message.content
            .filter((c: any) => c?.type === "text")
            .map((c: any) => c?.text || "")
            .join(" ")
        : typeof event.message.content === "string"
          ? event.message.content
          : "";

      if (msgText.length > 50) {
        try {
          const { processAgentResponse, formatContradictionWhisper } = await import("../../../../lib/claim-tracker.js");
          const contradictions = processAgentResponse(msgText, ctx, getState(ctx).currentTurn);
          if (contradictions.length > 0) {
            sendEnforcementWhisper(pi, formatContradictionWhisper(contradictions));
          }
        } catch (err) {
          log.warn("claim-tracker error (suppressed):", err);
        }
      }
    }

    // ── L2: Session Signals bundling ────────────────────────────────────────

    // BR3: Check A/B variant
    const abVariant = getAnalyticsState(ctx).abVariant;
    const suppressNudges = abVariant === "no_nudges";
    if (suppressNudges) {
      getState(ctx).nudgeSuppressedCount = (getState(ctx).nudgeSuppressedCount || 0) + 1;
      recordNudgeSuppressed(ctx);
    }

    const sessionSignals: string[] = [];

    if (suppressNudges) {
      // Skip all L2 signal collection when nudges are suppressed
    }

    // Memory signal
    const RECOVERY_GRACE_TURNS = 5;
    const inOverflowRecovery =
      getState(ctx).currentTurn - getState(ctx).overflowRecently < RECOVERY_GRACE_TURNS;

    if (
      !hadErrors && !inOverflowRecovery &&
      getState(ctx).config.enforceMemory &&
      getState(ctx).hasCodeChanges &&
      getState(ctx).turnsSinceMemory >= 20 &&
      !getState(ctx).memoryNudgeSent
    ) {
      getState(ctx).memoryNudgeSent = true;
      sessionSignals.push(
        "Code changed but nothing stored. Capture the key pattern or fix: " +
          'memory_store(content="...", tags=["pattern", "fix"])',
      );
    }

    // Scratchpad signal
    if (
      !hadErrors && !inOverflowRecovery &&
      getState(ctx).config.enforceScratchpad &&
      actualTools.some((t: string) => ["edit", "write"].includes(t)) &&
      !scratchpadUpdated
    ) {
      if (getState(ctx).currentTurn - getState(ctx).lastScratchpadNudgeTurn >= 8) {
        getState(ctx).lastScratchpadNudgeTurn = getState(ctx).currentTurn;
        sessionSignals.push(
          `Code changed without updating scratchpad. Consider updating scratchpad(action="add_note", text="...")`,
        );
      }
    }

    // Think tool enforcement
    if (
      !hadErrors && !inOverflowRecovery &&
      getState(ctx).toolChain.lastThinkCall === 0 &&
      getState(ctx).currentTurn >= 5 &&
      getState(ctx).currentTurn % 5 === 0
    ) {
      sessionSignals.push(
        `${getState(ctx).currentTurn} turns without think() — consider think(observation, decision, reason) to track reasoning`,
      );
    }

    // Context usage signal
    if (
      actualTools.some((t: string) =>
        ["context_tag", "context_log", "context_checkout", "context_prune", "context_audit"].includes(t),
      )
    ) {
      getState(ctx).lastContextCheckTurn = getState(ctx).currentTurn;
      getState(ctx).contextNudgeSent = false;
    }

    let usagePercent = 0;
    try {
      const ctxFromEvent = (
        event as unknown as { ctx?: { getContextUsage?(): { percent?: number } } }
      )?.ctx;
      const usage = ctxFromEvent?.getContextUsage?.();
      if (usage) usagePercent = usage.percent ?? 0;
    } catch { /* ignore */ }

    if (
      !hadErrors && actualTools.length > 0 &&
      getState(ctx).currentTurn - getState(ctx).lastContextCheckTurn >= getState(ctx).contextCheckInterval &&
      !getState(ctx).contextNudgeSent && usagePercent > 0
    ) {
      getState(ctx).contextNudgeSent = true;
      if (usagePercent > 85) {
        sessionSignals.push(
          "Context at critical levels — run /compact or use context_checkout to branch before continuing",
        );
      } else if (usagePercent > 75) {
        sessionSignals.push(
          "Context getting high — consider /compact or context_tag to mark progress",
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
    if (sessionSignals.length > 0) {
      for (const key of Object.keys(enforcementSignals)) {
        if (enforcementSignals[key].turn < getState(ctx).currentTurn - 1) {
          delete enforcementSignals[key];
        }
      }
      for (const signal of sessionSignals) {
        const entry = { turn: getState(ctx).currentTurn, text: signal, acted: false };
        if (signal.includes("nothing stored") || signal.includes("memory_store")) {
          enforcementSignals["memory"] = { ...entry, acted: getState(ctx).memoryNudgeSent };
        } else if (signal.includes("scratchpad")) {
          enforcementSignals["scratchpad"] = entry;
        } else if (signal.includes("critical")) {
          enforcementSignals["context_critical"] = entry;
        } else if (signal.includes("high") || signal.includes("/compact") || signal.includes("context")) {
          enforcementSignals["context_high"] = entry;
        } else {
          enforcementSignals["generic"] = entry;
        }
      }

      pi.events.emit("enforcement_signals", {
        turn: getState(ctx).currentTurn,
        signals: { ...enforcementSignals },
        contrastMode: determineContrastMode(ctx),
      });

      // BR3: Only bundle and send if nudges are not suppressed
      if (!suppressNudges && sessionSignals.length > 0) {
        const bundled = `[Session Signals]\n${sessionSignals.map((s) => `- ${s}`).join("\n")}`;
        const { shouldSend } = nudgeManager.shouldSendNudge("scratchpad", bundled);
        if (shouldSend) {
          sendEnforcementWhisper(pi, bundled);
          recordNudgeSent(ctx);
        }
      }
    }
  });
}
