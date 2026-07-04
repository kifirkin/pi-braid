/**
 * register-message-end - Conflict detection -> message analysis -> verification judge.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { onEvent } from "../../../lib/events/event-types.js";
import {
  getUnresolvedConflicts,
  detectConflicts,
  formatConflictMessage,
  resolveConflict,
  pruneResolvedEvidence,
  classifyConflictsWithLLM,
  detectSemanticConflicts,
} from "../../../lib/store/evidence-pool.js";
import {
  processConflicts as processConflictQAs,
  formatConflictWhisper,
  checkResponseForResolution,
} from "../../../lib/store/conflict-qa.js";
import { emitSignal } from "../../../lib/reasoning/belief-policy-engine.js";
import { detectMalformedToolCalls } from "../detection/malformed.js";
import { analyzeMessage } from "./message-analysis.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { getState, ERROR_BURST_THRESHOLD, startJudge, completeJudge } from "../state.js";
import { runVerificationJudge, formatVerificationNudge } from "../verification-judge.js";
import { enforcementSignals } from "../signals.js";
import { createLogger } from "../../../lib/core/logger.js";
import { MESSAGE_END } from "../../../lib/core/event-names.js";

const log = createLogger("enforcement:message-end");

export function registerMessageEndHandler(pi: ExtensionAPI): void {
  onEvent(pi, MESSAGE_END, async (event: any, ctx: any) => {
    if (!getState(ctx).enforcementActive) return;
    const isBurst = getState(ctx).consecutiveErrorTurns >= ERROR_BURST_THRESHOLD;

    // Part 1: Conflict detection
    if (!isBurst) {
      const newConflicts = detectConflicts(ctx);
      if (newConflicts.length > 0) {
        const msg = formatConflictMessage(newConflicts[0]);
        sendEnforcementWhisper(pi, ctx, msg);
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
        sendEnforcementWhisper(
          pi,
          ctx,
          `[conflict] ${unresolved.length} unresolved source conflicts. ` +
            `Consider resolving: memory_store content with conflict_verified tag.`,
        );
      }

      // Non-blocking LLM re-classification: upgrade heuristic "implication"
      // conflicts to "direct" when the triple-critic system detects a
      // real contradiction. Runs in background -- does not await.
      if (newConflicts.length > 0) {
        classifyConflictsWithLLM(ctx, newConflicts).catch(() => {});
      }

      // Non-blocking semantic conflict detection: catch evidence pairs that
      // the 30% token-overlap heuristic pre-filter missed (same topic,
      // different wording). Limited to 10 LLM checks per turn.
      detectSemanticConflicts(ctx).catch(() => {});

      const newQAs = processConflictQAs(ctx);
      for (const qa of newQAs) {
        sendEnforcementWhisper(pi, ctx, formatConflictWhisper(qa));
        // Bridge qa-xxx -> c-xxx ID space: store conflictId so resolveConflict() can find it
        const cId = qa.conflictId || qa.id;
        if (!getState(ctx).pendingConflictIds.includes(cId)) {
          getState(ctx).pendingConflictIds.push(cId);
          getState(ctx).conflictDetectionTurn.set(cId, getState(ctx).currentTurn);
        }
      }

      if (event.message?.role === "assistant") {
        const textContent = Array.isArray(event.message.content)
          ? event.message.content
              .filter((c: any) => c?.type === "text")
              .map((c: any) => c?.text || "")
              .join(" ")
          : String(event.message.content ?? "");

        if (textContent.length > 50 && getState(ctx).pendingConflictIds.length > 0) {
          const verdict = await checkResponseForResolution(ctx, textContent);
          if (verdict) {
            for (const conflictId of getState(ctx).pendingConflictIds) {
              resolveConflict(ctx, conflictId, verdict, "agent");
              log.info(`[conflict] Resolved ${conflictId} (${verdict}) from agent response`);
            }
            getState(ctx).pendingConflictIds = [];
          }
        }

        // Periodic evidence pool cleanup - prune evidence tied to resolved conflicts
        if (getState(ctx).currentTurn % 5 === 0) {
          const pruned = pruneResolvedEvidence(ctx);
          if (pruned > 0) {
            log.debug(`[evidence-pool] Pruned ${pruned} evidence entries from resolved conflicts`);
          }
        }

        const currentTurn = getState(ctx).currentTurn;
        for (const id of getState(ctx).pendingConflictIds) {
          const detectedTurn = getState(ctx).conflictDetectionTurn.get(id) ?? 0;
          if (currentTurn - detectedTurn >= 5) {
            sendEnforcementWhisper(
              pi,
              ctx,
              `[conflict] Conflict ${id} unresolved for ${currentTurn - detectedTurn} turns. ` +
                `Consider resolving explicitly.`,
            );
          }
        }
      }
    }

    // Part 2: Message analysis + verification judge
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

    const analysisSignals = await analyzeMessage(textContent, thinkingContent, getState(ctx), ctx);
    getState(ctx).lastUserMessage = "";
    const signalEntries = analysisSignals as Record<
      string,
      { turn: number; text: string; acted: boolean }
    >;
    for (const [key, signal] of Object.entries(signalEntries)) {
      if (signal?.text) {
        (enforcementSignals as Record<string, { turn: number; text: string; acted: boolean }>)[key] = signal;
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
    const currentTurn = getState(ctx).currentTurn;
    const turnsSinceLastJudge = currentTurn - getState(ctx).lastVerificationJudgeTurn;
    const timeSinceLastJudge = Date.now() - getState(ctx).lastJudgeTime;

    // Judge triggers (first one wins):
    // 1. Always judge on finalize - agent is declaring done
    // 2. Judge after code changes with reasonable gap (5+ turns)
    // 3. Periodic check every 15 turns regardless
    const shouldJudge =
      getState(ctx).pendingFinalize ||
      (getState(ctx).hasCodeChanges && turnsSinceLastJudge >= 5 && timeSinceLastJudge > 30_000) ||
      (turnsSinceLastJudge >= 15 && timeSinceLastJudge > 60_000);

    if (shouldJudge) {
      startJudge(getState(ctx));

      const toolLog: string[] = [];
      for (const [, turn] of getState(ctx).turnHistory) {
        if (turn.actualTools.length > 0) {
          const toolLine = `Turn ${turn.turnIndex}: [${turn.actualTools.join(", ")}]`;
          // Include truncated tool output so the verification judge can see actual results
          const outputLines = (turn.toolOutputs || []).slice(0, 8); // limit to 8 outputs per turn
          toolLog.push(toolLine + (outputLines.length > 0
            ? "\n" + outputLines.map(o => `  -> ${o}`).join("\n")
            : ""));
        }
      }

      const judgeCtx: any = {
        userRequest: getState(ctx).originalRequest || getState(ctx).lastUserMessage || "",
        toolsUsed: Array.from(getState(ctx).uniqueToolsUsed),
        toolLog,
        hasCodeChanges: getState(ctx).hasCodeChanges,
        hasVerification: userHasBash,
        lastResponse: fullContent,
        thinking: thinkingContent,
      };

      const result = await runVerificationJudge(ctx, judgeCtx, {
        timeoutMs: 120_000,
        // Thread ctx.signal so ESC / session shutdown aborts the
        // judge cleanly. The MESSAGE_END handler runs while the
        // session is still active (subsequent assistant messages
        // may follow, or the agent may finalize); without this the
        // judge runs to its 30s timeout even after the user cancels.
        // ctx.signal is undefined when the agent is idle, in which
        // case the 30s timeout is the only abort path - which is
        // the right behavior for a background audit.
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      getState(ctx).pendingFinalize = false;
      completeJudge(getState(ctx), getState(ctx).currentTurn);

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
}
