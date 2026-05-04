/**
 * Enforcement Handler Registry — all pi.on() registrations.
 *
 * Extracted from index.ts to reduce it from 1268L to a thin wrapper.
 * Exports a single function that registers all event handlers.
 *
 * Signal Architecture:
 * - L1 (Internal): Tool usage, context hygiene, turn validation tracked in state only
 * - L2 (Structured hints): Bundled per-turn into a SINGLE Session Signals nudge
 * - L3 (Critical): Overflow failures, infrastructure errors, dangerous commands
 *   that passed review - individual visible messages with semantic framing
 *
 * Key design: Agent gets ONE [enforcement] message per turn max for non-critical signals.
 */

import type { ExtensionAPI, SessionCompactEvent, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../../lib/logger.js";
import { sendTrackedMessage } from "../../../lib/injection-tracker.js";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/session-start-queue.js";
import { eventBus } from "../../../lib/event-bus.js";
import { detectMalformedToolCalls } from "./detection/malformed.js";
import { getReplyInstruction, setLanguage, detectLanguage } from "../../../lib/language-hint.js";
import {
  detectMissingVerification,
  recordCodeChange as detectRecordCodeChange,
} from "./detection/verification.js";
import { checkBlocking } from "./handlers/blocking.js";
import {
  addEvidence,
  getUnresolvedConflicts,
  detectConflicts,
  formatConflictMessage,
} from "../../../lib/evidence-pool.js";
import {
  processConflicts as processConflictQAs,
  formatConflictWhisper,
} from "../../../lib/conflict-qa.js";
import {
  emitSignal,
  getNextRecommendation,
  reportRecommendationOutcome,
} from "../../../lib/belief-policy-engine.js";
import { recordBashDetails, recordToolCall, recordToolInput } from "./handlers/tool-tracker.js";
import {
  checkLocalizationRisk,
  recordFileTouch,
  updateProblemContext,
} from "../../../lib/bidirectional-verifier.js";
import { analyzeMessage } from "./handlers/message-analysis.js";
import {
  type TurnAnalysisContext,
  detectRedundancySignal,
  handleCriticalSignals,
} from "./handlers/turn-analysis.js";
import { detectOrphanChains } from "./handlers/orphan-chains.js";
import { type NudgeManager } from "./nudge-manager.js";
import { getState } from "./state.js";
import { recordNudgeSent, recordNudgeSuppressed } from "../../heartbeat/analytics/index.js";
import { type TurnState } from "./types.js";
import { getAnalyticsState } from "../../heartbeat/analytics/index.js";
import { validateToolForPhase, validateTurn } from "./validation.js";
import {
  clearPendingBlockAction,
  getPendingBlockAction,
  queueEnforcementWhisper,
  sendEnforcementWhisper,
} from "./whisper.js";
import { knownFiles, loadFileContent } from "./similarity.js";
import { enforcementSignals, determineContrastMode } from "./signals.js";
import { resetState } from "./state.js";

const log = createLogger("enforcement");
const ERROR_BURST_THRESHOLD = 3;

/**
 * Register all enforcement event handlers on the given pi instance.
 */
export function registerHandlers(pi: ExtensionAPI, nudgeManager: NudgeManager): void {
  pi.on("input", async (event: { text?: string; source?: string }, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) return;
    const text = event.text || "";
    if (!text || text.startsWith("/") || event.source === "extension") return;

    const lang = detectLanguage(text);
    if (lang.code === "EN") return;

    setLanguage(ctx, lang.code, lang.name);
    getState(ctx).lastUserMessage = text;
    updateProblemContext(ctx, text);
    const replyLang = getReplyInstruction(ctx);
    if (!replyLang) return;

    const session = (
      ctx as unknown as {
        sessionManager?: {
          getCurrentSession?(): { updateSystemPrompt?(opts: { append: string }): void };
        };
      }
    ).sessionManager?.getCurrentSession?.();
    if (session?.updateSystemPrompt) {
      session.updateSystemPrompt({ append: replyLang });
    }
  });

  registerSessionStartHandler(pi, SessionPhase.CoreInit, async (event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) return;
    const task =
      (event as unknown as { task?: string; prompt?: string }).task ||
      (event as unknown as { task?: string; prompt?: string }).prompt ||
      getState(ctx).originalRequest ||
      "";
    if (task) {
      getState(ctx).driftDetector?.setTaskContext(task);
    }

    getState(ctx).currentTurn++;

    // Block action must surface via system prompt
    const pendingBlock = getPendingBlockAction();
    clearPendingBlockAction();

    if (pendingBlock) {
      sendTrackedMessage(
        pi,
        {
          customType: "context",
          display: true,
          content: [{ type: "text", text: `[enforcement] BLOCKED: ${pendingBlock.reason}` }],
        },
        undefined,
        { type: "enforcement", source: "enforcement/block" },
      );
    }
  });

  pi.on("tool_call" as never, async (event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) {
      return undefined;
    }

    const toolName = event.toolName;
    const input = event?.input as Record<string, unknown> | undefined;

    recordToolCall(toolName);
    recordToolInput(toolName, input);

    if (toolName === "bash") {
      const cmd = (input as { command?: string } | undefined)?.command || "";
      recordBashDetails(cmd);
    }

    if (toolName === "edit" || toolName === "write") {
      detectRecordCodeChange(getState(ctx).currentTurn);
      getState(ctx).hasCodeChanges = true;
      const fp = (input?.path as string) ?? (input?.target as string) ?? "";
      if (fp) {
        recordFileTouch(ctx, fp, getState(ctx).currentTurn, true);
        const risk = checkLocalizationRisk(ctx, fp, getState(ctx).currentTurn);
        if (risk) {
          getState(ctx)._localizationRisk = risk;
        }
      }
    }

    if (toolName === "read" || toolName === "grep" || toolName === "find") {
      const fp =
        (input?.path as string) ?? (input?.target as string) ?? (input?.pattern as string) ?? "";
      if (fp) {
        recordFileTouch(ctx, fp, getState(ctx).currentTurn, false);
      }
    }

    if (toolName === "edit" || toolName === "write") {
      const filePath = (input as { path?: string } | undefined)?.path;
      if (filePath) {
        knownFiles.set(filePath, { content: "", turn: getState(ctx).currentTurn });
      }
    }

    getState(ctx).toolLog.push(`${toolName}`);

    // Task 4a: Reflection gap + Task 4b: Thought chain tracking
    if (toolName === "think") {
      const thinkType = (input as { type?: string })?.type || "unknown";
      const parentId = (input as { parent_id?: string })?.parent_id || null;
      const confidence = (input as { confidence?: number })?.confidence;
      if (typeof confidence === "number") getState(ctx).lastThinkConfidence = confidence;
      const thoughtId = `t${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      getState(ctx).thoughtChains.push({
        id: thoughtId,
        parentId,
        type: thinkType,
        timestamp: Date.now(),
      });

      if (thinkType === "reflection" || thinkType === "conclusion") {
        getState(ctx).toolsSinceReflection = 0;
      } else {
        getState(ctx).toolsSinceReflection++;
      }
    } else {
      getState(ctx).toolsSinceReflection++;
    }

    // Blocking enforcement
    const blockResult = checkBlocking(pi, toolName, input, getState(ctx));
    if (blockResult.blocked) {
      return { block: true, reason: blockResult.reason };
    }

    // Phase validation nudge
    const { message } = validateToolForPhase(toolName, getState(ctx).currentTurn);
    if (message) {
      const now = Date.now();
      if (now - getState(ctx).lastNudgeTime > getState(ctx).nudgeCooldownMs) {
        getState(ctx).lastNudgeTime = now;
        queueEnforcementWhisper(message);
      }
    }

    return undefined;
  });

  pi.on("message_end" as never, async (event: any, ctx: any) => {
    if (!getState(ctx).enforcementActive) return;
    const isBurst = getState(ctx).consecutiveErrorTurns >= ERROR_BURST_THRESHOLD;
    if (isBurst) return;

    // Run conflict detection and surface unresolved conflicts
    const newConflicts = detectConflicts(ctx);
    if (newConflicts.length > 0) {
      const msg = formatConflictMessage(newConflicts[0]);
      queueEnforcementWhisper(msg);
      // Emit to Belief Policy Engine
      emitSignal(
        ctx,
        "conflict",
        "detected",
        newConflicts[0]?.for[0]?.confidence > 0.7 ? "warn" : "info",
        false,
        { conflictId: newConflicts[0]?.id },
      );
    }

    const unresolved = getUnresolvedConflicts(ctx);
    if (unresolved.length > 0) {
      emitSignal(ctx, "conflict", "unresolved", "info", false, { count: unresolved.length });
    }
    if (unresolved.length > 0 && unresolved.length % 5 === 0) {
      queueEnforcementWhisper(
        `[conflict] ${unresolved.length} unresolved source conflicts. ` +
          `Consider resolving: memory_store content with conflict_verified tag.`,
      );
    }

    // Conflict QA: classify conflicts and generate resolution questions
    if (!isBurst) {
      const newQAs = processConflictQAs(ctx);
      for (const qa of newQAs) {
        queueEnforcementWhisper(formatConflictWhisper(qa));
      }
    }
  });

  pi.on("tool_end" as never, async (event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) return;
    const isBurst = getState(ctx).consecutiveErrorTurns >= ERROR_BURST_THRESHOLD;
    const toolName = event?.tool || "";
    if (toolName === "think") return;

    const predicted = getState(ctx).lastThinkConfidence;
    const actual = event?.error ? 0 : 1;
    getState(ctx).calibrationPairs.push({
      predicted,
      actual,
      tool: toolName,
      turn: getState(ctx).currentTurn,
    });

    if (getState(ctx).calibrationPairs.length > 50) {
      getState(ctx).calibrationPairs = getState(ctx).calibrationPairs.slice(-50);
    }

    addEvidence(
      ctx,
      `Tool ${toolName} ${event?.error ? "failed" : "succeeded"}`,
      "session",
      `${toolName}: ${event?.error ? "failure" : "success"} (confidence: ${predicted.toFixed(2)})`,
      predicted,
    );

    const error = Math.abs(predicted - actual);
    if (!isBurst && getState(ctx).calibrationPairs.length >= 10 && error > 0.4) {
      const recent = getState(ctx).calibrationPairs.slice(-10);
      const avgError =
        recent.reduce((s, p) => s + Math.abs(p.predicted - p.actual), 0) / recent.length;
      if (avgError > 0.3) {
        emitSignal(ctx, "calibration", "high-error", "warn", false, {
          error: avgError,
          tool: toolName,
          pairCount: getState(ctx).calibrationPairs.length,
        });

        sendEnforcementWhisper(
          pi,
          `[calibration] High prediction error: ${(error * 100).toFixed(0)}% off on last ${toolName}. ` +
            `Avg error last 10 tools: ${(avgError * 100).toFixed(0)}%`,
        );
      }
    }
  });

  pi.on("turn_end" as never, async (event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) return;

    const actualTools: string[] = (event.toolResults || []).map((r: any) => r.toolName);
    const erroredTools: Set<string> = new Set(
      (event.toolResults || []).filter((r: any) => r.isError).map((r: any) => r.toolName),
    );
    const hadErrors = erroredTools.size > 0;

    // Error burst detection
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

    // Detect context overflow
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

    // Track code changes
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

    // ── Redundancy Detection ─────────────────────────────────────────────────
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
        sendWhisper: (msg) => sendEnforcementWhisper(pi, msg),
        loadFileContent,
      };
      if (!isBurst) {
        await detectRedundancySignal(tac);
      }
    }

    // ── L3: Critical signals ───────────────────────────────────────────────
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
      sendWhisper: (msg) => sendEnforcementWhisper(pi, msg),
      loadFileContent,
    };
    handleCriticalSignals(tac, prevTurn, turnState, nudgeManager, validateTurn);

    // ── Task 4b: Orphan thought chain detection ────────────────────────────
    const orphanResult = detectOrphanChains(getState(ctx));
    if (!isBurst && orphanResult) {
      sendEnforcementWhisper(pi, orphanResult.suggestion);
    }

    // ── P3.2: Lie-Detector (RepE) — cross-turn claim tracker ─────────────
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
          const { processAgentResponse, formatContradictionWhisper } = await import("../../../lib/claim-tracker.js");
          const contradictions = processAgentResponse(msgText, ctx, getState(ctx).currentTurn);
          if (contradictions.length > 0) {
            sendEnforcementWhisper(pi, formatContradictionWhisper(contradictions));
          }
        } catch (err) {
          log.warn("claim-tracker error (suppressed):", err);
        }
      }
    }

    // ── L2: Non-critical signals → bundled Session Signals nudge ─────────

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
      !hadErrors &&
      !inOverflowRecovery &&
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
      !hadErrors &&
      !inOverflowRecovery &&
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
      !hadErrors &&
      !inOverflowRecovery &&
      getState(ctx).toolChain.lastThinkCall === 0 &&
      getState(ctx).currentTurn >= 5 &&
      getState(ctx).currentTurn % 5 === 0
    ) {
      sessionSignals.push(
        `${getState(ctx).currentTurn} turns without think() - consider think(observation, decision, reason) to track reasoning`,
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
    } catch {
      /* ignore */
    }

    if (
      !hadErrors &&
      actualTools.length > 0 &&
      getState(ctx).currentTurn - getState(ctx).lastContextCheckTurn >=
        getState(ctx).contextCheckInterval &&
      !getState(ctx).contextNudgeSent &&
      usagePercent > 0
    ) {
      getState(ctx).contextNudgeSent = true;

      if (usagePercent > 85) {
        sessionSignals.push(
          "Context at critical levels - run /compact or use context_checkout to branch before continuing",
        );
      } else if (usagePercent > 75) {
        sessionSignals.push(
          "Context getting high - consider /compact or context_tag to mark progress",
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

    if (sessionSignals.length > 0) {
      // Clear stale signals
      for (const key of Object.keys(enforcementSignals)) {
        if (enforcementSignals[key].turn < getState(ctx).currentTurn - 1) {
          delete enforcementSignals[key];
        }
      }

      // Populate L1 signal store
      for (const signal of sessionSignals) {
        const entry = { turn: getState(ctx).currentTurn, text: signal, acted: false };
        if (signal.includes("nothing stored") || signal.includes("memory_store")) {
          enforcementSignals["memory"] = { ...entry, acted: getState(ctx).memoryNudgeSent };
        } else if (signal.includes("scratchpad")) {
          enforcementSignals["scratchpad"] = entry;
        } else if (signal.includes("critical")) {
          enforcementSignals["context_critical"] = entry;
        } else if (
          signal.includes("high") ||
          signal.includes("getting high") ||
          signal.includes("/compact") ||
          signal.includes("context")
        ) {
          enforcementSignals["context_high"] = entry;
        } else {
          enforcementSignals["generic"] = entry;
        }
      }

      // Emit for prompt-builder
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

  pi.on("session_compact" as never, async (event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) return;

    const compactTurn = getState(ctx).currentTurn;

    try {
      const scratchpadResult = await (
        ctx as unknown as { tools?: { scratchpad?(params: { action: string }): Promise<unknown> } }
      ).tools?.scratchpad?.({ action: "read" });
      const details = (
        scratchpadResult as
          | { details?: { key_learnings?: Array<{ persisted?: boolean }> } }
          | undefined
      )?.details;
      const learnings = details?.key_learnings ?? [];
      const unpersisted = learnings.filter((l) => !l.persisted);

      if (unpersisted.length > 0) {
        sendEnforcementWhisper(
          pi,
          `Context compacted at turn ${compactTurn}. ` +
            `${unpersisted.length} key learning(s) not yet persisted - these will be harder to recover:\n\n` +
            unpersisted
              .map(
                (l: any) =>
                  `- memory_store(content="${l.content}", memoryType="insight", tags=["${l.category}", "session"])`,
              )
              .join("\n") +
            `\n\nPersist them now - this is the minimum-fidelity moment.`,
        );
        enforcementSignals["unpersisted_learnings"] = {
          turn: getState(ctx).currentTurn,
          text: `${unpersisted.length} key learning(s) not yet persisted - persist them now`,
          acted: false,
        };
        pi.events.emit("enforcement_signals", {
          turn: getState(ctx).currentTurn,
          signals: { ...enforcementSignals },
          contrastMode: determineContrastMode(ctx),
        });
      }

      // Reset hygiene counters
      getState(ctx).contextNudgeSent = false;
      getState(ctx).lastContextCheckTurn = getState(ctx).currentTurn;
      getState(ctx).lastCompactionTurn = compactTurn;
      getState(ctx).lastScratchpadNudgeTurn = getState(ctx).currentTurn;
      getState(ctx).overflowRecently = getState(ctx).currentTurn;
      getState(ctx).hasCodeChanges = false;
      getState(ctx).lastCodeChangeTurn = 0;
      getState(ctx).memoryNudgeSent = false;
      getState(ctx).turnsSinceMemory = 0;
    } catch {
      /* Non-fatal: enforcement state access failed */
    }
  });

  // ── auto_retry_end ────────────────────────────────────────────────────────
  pi.on("auto_retry_end" as never, async (event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) return;

    const { success, attempt, finalError } = event;

    if (!success) {
      getState(ctx).validationFailures++;

      const now = Date.now();
      if (now - getState(ctx).lastNudgeTime < getState(ctx).nudgeCooldownMs) return;
      getState(ctx).lastNudgeTime = now;

      const errorType = _classifyRetryError(finalError ?? "");

      let msg = "";
      if (errorType === "rate_limit") {
        msg = `Rate limit after ${attempt} retry(s). Switch model with /model or wait.`;
      } else if (errorType === "server_error") {
        msg = `Server error after ${attempt} retry(s) (${finalError}). Provider may be overloaded.`;
      } else if (errorType === "network") {
        msg = `Network error after ${attempt} retry(s). Check your connection.`;
      } else {
        msg = `API error after ${attempt} retry(s): ${finalError ?? "unknown"}.`;
      }

      sendEnforcementWhisper(
        pi,
        `## ⚠️ ${msg}\n\nStore for reference: memory_store(content="API error: ${finalError}", tags=["error", "api"])`,
      );
    }
  });

  pi.on("message_end" as never, async (event: any, ctx: any) => {
    if (!getState(ctx).enforcementActive) return;

    if (event.message.role !== "assistant") return;

    const textContent = event.message.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => (c as { type: "text"; text: string }).text)
      .join("\n");

    const thinkingContent = event.message.content
      .filter((c: any) => c.type === "thinking")
      .map((c: any) => (c as { type: "thinking"; thinking: string }).thinking)
      .join("\n");

    const fullContent = thinkingContent
      ? `## REASONING\n${thinkingContent}\n\n## RESPONSE\n${textContent}`
      : textContent;

    if (textContent.length < 100) return;

    // ── Message Analysis ──────────────────────────────────────────────────
    const analysisSignals = analyzeMessage(textContent, thinkingContent, getState(ctx));
    getState(ctx).lastUserMessage = "";
    const signalEntries = analysisSignals as Record<
      string,
      { turn: number; text: string; acted: boolean }
    >;
    for (const [key, signal] of Object.entries(signalEntries)) {
      if (signal?.text) {
        enforcementSignals[key] = signal;
        if (key === "stability") {
          emitSignal(ctx, "stability", "decline", "warn", false, {
            overlap: signal.text.match(/overlap=([0-9.]+)/)?.[1] ?? 0,
            reason: signal.text,
          });
        }
      }
    }

    const turnState = getState(ctx).turnHistory.get(getState(ctx).currentTurn);
    if (turnState) {
      detectMalformedToolCalls(textContent, pi);
    }

    if (getState(ctx).verificationJudgeRunning) return;

    const userHasBash = Array.from(getState(ctx).uniqueToolsUsed).includes("bash");

    const VERIFICATION_GAP_TURNS = getState(ctx).config.verifyAfterCodeChanges ? 8 : Infinity;
    const turnsSinceCodeChange =
      getState(ctx).currentTurn - getState(ctx).lastVerificationJudgeTurn;
    const hasVerificationGap =
      getState(ctx).hasCodeChanges &&
      !userHasBash &&
      turnsSinceCodeChange >= VERIFICATION_GAP_TURNS;

    const isPeriodicCheck =
      getState(ctx).config.verificationJudgeInterval > 0 &&
      getState(ctx).hasCodeChanges &&
      getState(ctx).currentTurn - getState(ctx).lastVerificationJudgeTurn >=
        getState(ctx).config.verificationJudgeInterval;

    if (
      !getState(ctx).verificationJudgeRunning &&
      (hasVerificationGap || isPeriodicCheck) &&
      getState(ctx).uniqueToolsUsed.size > 0
    ) {
      const now = Date.now();
      if (now - getState(ctx).lastJudgeTime < 60_000) return;

      getState(ctx).verificationJudgeRunning = true;

      const toolLog: string[] = [];
      for (const [, turn] of getState(ctx).turnHistory) {
        if (turn.actualTools.length > 0) {
          toolLog.push(`Turn ${turn.turnIndex}: [${turn.actualTools.join(", ")}]`);
        }
      }

      const judgeCtx: any = {
        userRequest: getState(ctx).originalRequest,
        toolsUsed: Array.from(getState(ctx).uniqueToolsUsed),
        toolLog,
        hasCodeChanges: getState(ctx).hasCodeChanges,
        hasVerification: userHasBash,
        lastResponse: fullContent,
        thinking: thinkingContent,
      };

      const { runVerificationJudge, formatVerificationNudge } = await import("./verification-judge.js");
      const result = await runVerificationJudge(ctx as never, judgeCtx, { timeoutMs: 30000 });

      getState(ctx).lastVerificationJudgeTurn = getState(ctx).currentTurn;
      getState(ctx).verificationJudgeRunning = false;

      if (result) {
        if (result.verdict === "fail" || result.verdict === "warn") {
          sendEnforcementWhisper(pi, formatVerificationNudge(result));
          if (result.verdict === "fail") {
            getState(ctx).validationFailures++;
          }
        }
      }
    }

    // Legacy LLM Judge
    if (getState(ctx).config.useJudge && turnState && turnState.actualTools.length === 0) {
      const now = Date.now();
      if (now - getState(ctx).lastJudgeTime < getState(ctx).config.judgeCooldownMs) return;

      getState(ctx).judgeSkipCounter++;
      if (getState(ctx).judgeSkipCounter < getState(ctx).config.judgeSkipTurns) return;
      getState(ctx).judgeSkipCounter = 0;

      const history: string[] = [];
      for (const [turnIdx, turn] of getState(ctx).turnHistory) {
        if (turnIdx >= getState(ctx).currentTurn) continue;
        const tools = turn.actualTools.length > 0 ? ` [Tools: ${turn.actualTools.join(", ")}]` : "";
        history.push(`[Turn ${turnIdx}]${tools}`);
      }

      const { analyzeWithJudge } = await import("./judge.js");
      const { analysis, action } = await analyzeWithJudge(ctx as never, fullContent, history, {
        timeoutMs: 30000,
      });

      getState(ctx).lastJudgeTime = now;
      getState(ctx).lastJudgeAnalysis = analysis;

      if (action.type === "nudge" && action.nudgeMessage) {
        const rateLimitOk = now - getState(ctx).lastNudgeTime > getState(ctx).nudgeCooldownMs;
        if (rateLimitOk) {
          getState(ctx).lastNudgeTime = now;
          sendEnforcementWhisper(pi, action.nudgeMessage);

          if (action.priority === "critical" || action.priority === "high") {
            getState(ctx).validationFailures++;
          }
        }
      }
    }
  });

  pi.on("turn_end" as never, async (_event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive || !getState(ctx).driftDetector) return;
    const session =
      (
        ctx as unknown as {
          sessionManager?: {
            getCurrentSession?(): { messages?: Array<{ role?: string; content?: unknown }> };
          };
        }
      ).sessionManager?.getCurrentSession?.() || null;
    const recentMsgs = session?.messages?.slice(-4) ?? [];
    for (let i = recentMsgs.length - 1; i >= 0; i--) {
      const msg = recentMsgs[i];
      const text = extractTextContent(msg);
      if (msg?.role === "user" && text.length > 10) {
        getState(ctx).driftDetector.addTurn(text);
        break;
      }
    }
    const driftCheck = getState(ctx).driftDetector.check();
    if (driftCheck.drifted) {
      const whisper = getState(ctx).driftDetector.generateWhisper(driftCheck);
      if (whisper) {
        sendTrackedMessage(
          pi,
          {
            customType: "context",
            display: true,
            content: [{ type: "text", text: `[enforcement] ${whisper}` }],
          },
          undefined,
          { type: "enforcement", source: "enforcement/drift" },
        );
      }
      emitSignal(
        ctx,
        "topic-drift",
        "detected",
        driftCheck.severity === "strong" ? "warn" : "info",
        false,
        { severity: driftCheck.severity },
      );
    }

    // D0: Report previous recommendation outcome
    const enState = getState(ctx);
    const lastRecType = (pi as any).__lastRecommendationType;
    if (lastRecType) {
      const madeProgress = enState.totalToolCalls > (enState.toolCallsAtLastRecommendation ?? 0);
      reportRecommendationOutcome(ctx, lastRecType, madeProgress);
    }

    // Belief Policy Engine
    const bpeRec = getNextRecommendation(ctx);
    if (bpeRec) {
      (pi as any).__lastRecommendationType = bpeRec.type;
      enState.toolCallsAtLastRecommendation = enState.totalToolCalls;
      sendTrackedMessage(
        pi,
        {
          customType: "context",
          display: true,
          content: [{ type: "text", text: `[policy] ${bpeRec.message}` }],
        },
        undefined,
        { type: "enforcement", source: "enforcement/policy" },
      );
    }

    // MARS
    const { shouldAdvise: marsShouldAdvise } = await import("../../../lib/mars-reflector.js");
    const marsAdvice = marsShouldAdvise(ctx);
    if (marsAdvice) {
      const signalType: any =
        marsAdvice.type === "tool_overuse"
          ? "tool-use"
          : marsAdvice.type === "error_recurrence"
            ? "error"
            : marsAdvice.type === "confidence_decline"
              ? "reasoning"
              : "stability";
      const signalValue =
        marsAdvice.type === "tool_overuse"
          ? "overuse"
          : marsAdvice.type === "error_recurrence"
            ? "recurrence"
            : marsAdvice.type === "confidence_decline"
              ? "decline"
              : "decline";
      emitSignal(ctx, signalType, signalValue, marsAdvice.severity, false, {
        type: marsAdvice.type,
        message: marsAdvice.message.slice(0, 200),
      });
      sendTrackedMessage(
        pi,
        {
          customType: "context",
          display: true,
          content: [{ type: "text", text: `[enforcement] ${marsAdvice.message}` }],
        },
        undefined,
        { type: "enforcement", source: "enforcement/mars" },
      );
    }

    // Dreamer
    const { dream } = await import("../../../lib/dreamer.js");
    const dreamAdvice = dream(ctx, getState(ctx).toolLog);
    if (dreamAdvice) {
      emitSignal(ctx, "stability", "predicted-decline", "info", false, {
        source: "dreamer",
        message: dreamAdvice.message.slice(0, 200),
      });
      sendTrackedMessage(
        pi,
        {
          customType: "context",
          display: true,
          content: [{ type: "text", text: `[enforcement] ${dreamAdvice.message}` }],
        },
        undefined,
        { type: "enforcement", source: "enforcement/dreamer" },
      );
    }

    // Reflection gap signal
    if (getState(ctx).toolsSinceReflection >= 8) {
      emitSignal(ctx, "reflection", "absent", "info", false, {
        toolsSince: getState(ctx).toolsSinceReflection,
      });
    }
  });

  pi.on("session_shutdown" as never, async (_event: any, ctx: ExtensionContext) => {
    const state = getState(ctx);
    const sessionId = ctx.cwd ?? "default";

    log.info(
      `[session_shutdown] Session ${sessionId}: ` +
        `${state.totalToolCalls} tool calls, ${state.uniqueToolsUsed.size} unique tools, ` +
        `${state.verificationsDone} verifications, ${state.validationFailures} failures`,
    );

    resetState(state);
    log.info(`[session_shutdown] Enforcement state reset for session ${sessionId}`);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _classifyRetryError(
  errorMsg: string,
): "rate_limit" | "server_error" | "network" | "unknown" {
  // Use a simple heuristic classification without importing error-classifier.
  // Covers the same patterns as classifyErrorLib but doesn't need the full module.
  if (/429|rate.?limit/i.test(errorMsg)) return "rate_limit";
  if (/5\d\d|server.?error|internal|overloaded|unavailable/i.test(errorMsg)) return "server_error";
  if (/network|connection|fetch failed|socket|timeout|timed out/i.test(errorMsg))
    return "network";
  return "unknown";
}

function extractTextContent(msg: any): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c: any) =>
        c.type === "text" ? c.text : c.type === "toolCall" ? `tool:${c.name}` : "",
      )
      .join(" ");
  }
  return "";
}
