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

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../lib/logger.js";
import { safeSessionManager } from "../../lib/extension-state.js";
import { sendTrackedMessage } from "../../lib/injection-tracker.js";
import { registerSessionStartHandler, SessionPhase } from "../../lib/session-start-queue.js";
import { detectMalformedToolCalls } from "./detection/malformed.js";
import { getReplyInstruction, setLanguage, detectLanguage } from "../../lib/language-hint.js";
import { checkBlocking } from "./handlers/blocking.js";
import {
  addEvidence,
  getUnresolvedConflicts,
  detectConflicts,
  formatConflictMessage,
} from "../../lib/evidence-pool.js";
import {
  processConflicts as processConflictQAs,
  formatConflictWhisper,
} from "../../lib/conflict-qa.js";
import {
  emitSignal,
  getNextRecommendation,
  reportRecommendationOutcome,
} from "../../lib/belief-policy-engine.js";
import { recordBashDetails, recordToolCall, recordToolInput } from "./handlers/tool-tracker.js";
import {
  checkLocalizationRisk,
  recordFileTouch,
  updateProblemContext,
} from "../../lib/bidirectional-verifier.js";
import { analyzeMessage } from "./handlers/message-analysis.js";
import { registerTurnEndHandler } from "./handlers/turn-end-handler.js";
import { type NudgeManager } from "./nudge-manager.js";

import { validateToolForPhase } from "./validation.js";
import {
  clearPendingBlockAction,
  getPendingBlockAction,
  queueEnforcementWhisper,
  sendEnforcementWhisper,
} from "./whisper.js";
import { knownFiles } from "./similarity.js";
import { enforcementSignals, determineContrastMode } from "./signals.js";
import { getState, ENFORCEMENT_PARAMS } from "./state.js";
import { resetState } from "./state.js";
import { onEvent } from "../../lib/event-types.js";

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
    // Note: system prompt append via getReplyInstruction() was previously attempted
    // via getCurrentSession()/updateSystemPrompt() — neither API exists on SessionManager.
    // Language hint is still tracked in state via setLanguage() above.
  });

  registerSessionStartHandler(
    pi,
    SessionPhase.CoreInit,
    async (event: any, ctx: ExtensionContext) => {
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
          { deliverAs: "steer", triggerTurn: true },
          { type: "enforcement", source: "enforcement/block" },
        );
      }
    },
  );

  onEvent(pi, "tool_call", async (event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) {
      return undefined;
    }

    const toolName = event.toolName;
    const input = event?.input as Record<string, unknown> | undefined;

    // Drop empty/whitespace-only tool calls (LLM hallucinations like proxy artifacts)
    if (!toolName || !toolName.trim()) return undefined;

    recordToolCall(toolName, ctx);
    recordToolInput(toolName, input, getState(ctx));

    if (toolName === "bash") {
      const cmd = (input as { command?: string } | undefined)?.command || "";
      recordBashDetails(cmd, getState(ctx));
    }

    if (toolName === "edit" || toolName === "write") {
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
    const { message } = validateToolForPhase(toolName, getState(ctx).currentTurn, getState(ctx));
    if (message) {
      const now = Date.now();
      if (now - getState(ctx).lastNudgeTime > getState(ctx).nudgeCooldownMs) {
        getState(ctx).lastNudgeTime = now;
        queueEnforcementWhisper(message);
      }
    }

    return undefined;
  });

  // ── message_end: combined handler (conflict detection → message analysis → verification judge) ──
  onEvent(pi, "message_end", async (event: any, ctx: any) => {
    if (!getState(ctx).enforcementActive) return;
    const isBurst = getState(ctx).consecutiveErrorTurns >= ERROR_BURST_THRESHOLD;

    // Part 1: Conflict detection (runs for all messages, not just assistant)
    if (!isBurst) {
      const newConflicts = detectConflicts(ctx);
      if (newConflicts.length > 0) {
        const msg = formatConflictMessage(newConflicts[0]);
        queueEnforcementWhisper(msg);
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

      const newQAs = processConflictQAs(ctx);
      for (const qa of newQAs) {
        queueEnforcementWhisper(formatConflictWhisper(qa));
      }
    }

    // Part 2: Message analysis + verification judge (assistant messages only)
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
      detectMalformedToolCalls(textContent, pi, ctx);
    }

    if (getState(ctx).verificationJudgeRunning) return;

    const userHasBash = Array.from(getState(ctx).uniqueToolsUsed).includes("bash");

    if (
      !getState(ctx).verificationJudgeRunning &&
      turnState && turnState.actualTools.length === 0 &&
      getState(ctx).hasCodeChanges &&
      getState(ctx).currentTurn - getState(ctx).lastVerificationJudgeTurn >= 1
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

      const { runVerificationJudge, formatVerificationNudge } =
        await import("./verification-judge.js");
      const result = await runVerificationJudge(ctx as never, judgeCtx, { timeoutMs: 30000 });

      getState(ctx).lastVerificationJudgeTurn = getState(ctx).currentTurn;
      getState(ctx).verificationJudgeRunning = false;

      if (result) {
        if (result.verdict === "fail" || result.verdict === "warn") {
          sendEnforcementWhisper(pi, ctx, formatVerificationNudge(result));
          if (result.verdict === "fail") {
            getState(ctx).validationFailures++;
          }
        }
      }
    }
  });

  pi.on("tool_result", async (event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) return;
    const isBurst = getState(ctx).consecutiveErrorTurns >= ERROR_BURST_THRESHOLD;
    const toolName = event?.toolName || "";
    // Drop empty/whitespace-only tool names (LLM hallucinations like proxy artifacts)
    if (!toolName || !toolName.trim()) return;
    if (toolName === "think") return;

    const predicted = getState(ctx).lastThinkConfidence;

    // Skip calibration if agent hasn't provided explicit confidence via think()
    if (predicted === null) return;

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
      if (avgError > 0.5) {
        // Rate-limit: at most one calibration whisper per 120 seconds
        const enState = getState(ctx);
        const now = Date.now();
        if (now - enState.lastCalibrationWhisperTime < 120_000) return;
        enState.lastCalibrationWhisperTime = now;

        emitSignal(ctx, "calibration", "high-error", "warn", false, {
          error: avgError,
          tool: toolName,
          pairCount: getState(ctx).calibrationPairs.length,
        });

        sendEnforcementWhisper(
          pi,
          ctx,
          `[calibration] High prediction error: ${(error * 100).toFixed(0)}% off on last ${toolName}. ` +
            `Avg error last 10 tools: ${(avgError * 100).toFixed(0)}%`,
        );
      }
    }
  });

  // ── turn_end: main enforcement loop ──────────────────────────────────
  // Extracted to handlers/turn-end-handler.ts
  registerTurnEndHandler(pi, nudgeManager);

  onEvent(pi, "session_compact", async (event: any, ctx: ExtensionContext) => {
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
          ctx,
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
  onEvent(pi, "auto_retry_end", async (event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) return;

    const { success, attempt, finalError } = event;

    if (!success) {
      getState(ctx).validationFailures++;

      const now = Date.now();
      if (now - getState(ctx).lastNudgeTime < getState(ctx).nudgeCooldownMs) return;
      getState(ctx).lastNudgeTime = now;

      const errorType = _classifyRetryError(finalError ?? "");

      let msg = ""; // eslint-disable-line no-useless-assignment
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
        ctx,
        `## ⚠️ ${msg}\n\nStore for reference: memory_store(content="API error: ${finalError}", tags=["error", "api"])`,
      );
    }
  });

  onEvent(pi, "turn_end", async (_event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive || !getState(ctx).driftDetector) return;
    // Use getBranch() — getCurrentSession() does not exist on SessionManager
    // Use safeSessionManager to avoid assertActive() crash on stale ctx
    const sm = safeSessionManager(ctx) as any;
    const entries = sm?.getBranch?.() ?? [];
    const recentMsgs: Array<{ role?: string; content?: unknown }> = [];
    for (let i = entries.length - 1; i >= 0 && recentMsgs.length < 4; i--) {
      const entry = entries[i];
      if (entry.type === "message") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg = entry.message as any;
        recentMsgs.unshift({ role: msg.role, content: msg.content });
      }
    }
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
          { deliverAs: "steer", triggerTurn: false },
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

    // Belief Policy Engine - advisory, use hint (BPE recommendations are suggestions, not critical)
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
        { deliverAs: "steer", triggerTurn: false },
        { type: "enforcement", source: "enforcement/policy" },
      );
    }

    // MARS
    const { shouldAdvise: marsShouldAdvise } = await import("../../lib/mars-reflector.js");
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
        { deliverAs: "steer", triggerTurn: false },
        { type: "enforcement", source: "enforcement/mars" },
      );
    }

    // Dreamer
    const { dream } = await import("../../lib/dreamer.js");
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
        { deliverAs: "steer", triggerTurn: false },
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

  onEvent(pi, "session_shutdown", async (_event: any, ctx: ExtensionContext) => {
    const state = getState(ctx);
    const sessionId = ctx.cwd ?? "default";

    log.info(
      `[session_shutdown] Session ${sessionId}: ` +
        `${state.totalToolCalls} tool calls, ${state.uniqueToolsUsed.size} unique tools, ` +
        `${state.verificationsDone} verifications, ${state.validationFailures} failures`,
    );

    resetState(getState(ctx));
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
  if (/network|connection|fetch failed|socket|timeout|timed out/i.test(errorMsg)) return "network";
  return "unknown";
}

function extractTextContent(msg: any): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c: any) => (c.type === "text" ? c.text : c.type === "toolCall" ? `tool:${c.name}` : ""))
      .join(" ");
  }
  return "";
}
