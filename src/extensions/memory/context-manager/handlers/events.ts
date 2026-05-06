// ── Context-Manager Event Handlers ───────────────────────────────────────────
// agent_end (retry handling), auto_retry_end (API errors), context (pruning workflow).

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { addEvidence } from "../../../../lib/evidence-pool.js";
import { sendTrackedMessage } from "../../../../lib/injection-tracker.js";
import { applyPruningWorkflow } from "../pruning.js";
import {
  findReasoningBlocks,
  recordSummarization,
  shouldSummarizeReasoning,
  estimateTokensSaved,
  extractReasoningSummary,
} from "../../../../lib/reasoning-summary.js";
import { addEpisode, getState } from "../../three-memory-stores/index.js";
import { determineCompressionLevel } from "../../../../lib/compression-strategy.js";
import { semanticCompress } from "../semantic-compress.js";
import { updateContextDensity } from "../../../heartbeat/analytics/index.js";
import {
  log,
  getCmState,
  compactionRetryState,
  overflowRetryState,
  COMPACTION_RETRY_MAX_ATTEMPTS,
  OVERFLOW_RETRY_MAX_ATTEMPTS,
  COMPACTION_RETRY_CUSTOM_TYPE,
  resetCompactionRetry,
  resetOverflowRetry,
  getCompactionRetryDelay,
  getOverflowRetryDelay,
} from "./shared.js";

// ── Agent End Retry Handling ──────────────────────────────────────────────────
export function registerAgentEndRetryHandler(pi: any): void {
  pi.on("agent_end", async (event: any, ctx: any) => {
    try {
      const messages = event.messages;
      let hasRetryTrigger = false;
      let hasOverflowRetryTrigger = false;

      for (const msg of messages) {
        if (msg.role === "custom" && msg.customType === COMPACTION_RETRY_CUSTOM_TYPE) {
          hasRetryTrigger = true;
          break;
        }
        if (msg.role === "custom" && msg.customType === "__overflow_retry_trigger") {
          hasOverflowRetryTrigger = true;
        }
      }

      // Handle overflow retry
      if (hasOverflowRetryTrigger) {
        let lastAssistant: any = null;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "assistant") {
            lastAssistant = messages[i];
            break;
          }
        }

        if (
          lastAssistant &&
          lastAssistant.stopReason !== "error" &&
          lastAssistant.stopReason !== "aborted"
        ) {
          if (overflowRetryState.attempt > 0) {
            ctx.ui.notify(
              `Overflow recovery succeeded on attempt ${overflowRetryState.attempt}!`,
              "info",
            );
          }
          resetOverflowRetry();
          return;
        }

        const errorMessage = lastAssistant?.errorMessage || overflowRetryState.lastError;
        if (overflowRetryState.attempt >= OVERFLOW_RETRY_MAX_ATTEMPTS) {
          resetOverflowRetry();
          return;
        }

        overflowRetryState.attempt++;
        overflowRetryState.lastError = errorMessage;
        const delayMs = getOverflowRetryDelay(overflowRetryState.attempt);
        ctx.ui.setStatus(
          "context-manager",
          `Overflow recovery "${errorMessage}", retrying (${overflowRetryState.attempt}/${OVERFLOW_RETRY_MAX_ATTEMPTS}) in ${(delayMs / 1000).toFixed(0)}s...`,
        );
        triggerOverflowRetryFromAgentEnd(pi, overflowRetryState.attempt, errorMessage, ctx);
        return;
      }

      if (!hasRetryTrigger) return;

      let lastAssistant: any = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
          lastAssistant = messages[i];
          break;
        }
      }

      if (
        lastAssistant &&
        lastAssistant.stopReason !== "error" &&
        lastAssistant.stopReason !== "aborted"
      ) {
        if (compactionRetryState.attempt > 0) {
          ctx.ui.notify(
            `Compaction retry succeeded on attempt ${compactionRetryState.attempt}.`,
            "info",
          );
        }
        resetCompactionRetry();
        return;
      }

      const errorMessage = lastAssistant?.errorMessage || compactionRetryState.lastError;
      if (compactionRetryState.attempt >= COMPACTION_RETRY_MAX_ATTEMPTS) {
        log.error(
          `Compaction retry exhausted after ${COMPACTION_RETRY_MAX_ATTEMPTS} attempts: ${errorMessage}`,
        );
        ctx.ui.notify(
          `Compaction failed permanently after ${COMPACTION_RETRY_MAX_ATTEMPTS} retries: ${errorMessage}`,
          "error",
        );
        ctx.ui.setStatus("context-manager", undefined);
        resetCompactionRetry();
        return;
      }

      compactionRetryState.attempt++;
      compactionRetryState.lastError = errorMessage;
      const delayMs = getCompactionRetryDelay(compactionRetryState.attempt);
      ctx.ui.setStatus(
        "context-manager",
        `Compaction failed "${errorMessage}", retrying (${compactionRetryState.attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS}) in ${(delayMs / 1000).toFixed(0)}s...`,
      );
      triggerCompactionRetryFromAgentEnd(pi, compactionRetryState.attempt, errorMessage);
    } catch (err) {
      log.error("agent_end retry error:", err);
    }
  });
}

// ── Auto-Retry End Event ──────────────────────────────────────────────────────
export function registerAutoRetryEndHandler(pi: any): void {
  pi.on(
    "auto_retry_end" as never,
    async (
      event: { success?: boolean; attempt?: number; finalError?: string },
      _ctx: ExtensionContext,
    ) => {
      try {
        const { success, attempt, finalError } = event as {
          success?: boolean;
          attempt?: number;
          finalError?: string;
        };
        if (!success) {
          sendTrackedMessage(
            pi,
            {
              customType: "context",
              content: [
                {
                  type: "text" as const,
                  text: [
                    "## ⚠️ API retry failed after " + attempt + " attempt(s)",
                    finalError ?? "Unknown error",
                    "",
                    "The API kept returning errors despite retries. Possible causes:",
                    "- Rate limit (429) - wait a moment or switch models",
                    "- Server error (500/502/503) - provider is having issues",
                    "- Network error - check your connection",
                    "",
                    "Actions: Run `/model` to switch models, or wait and retry.",
                  ].join("\n"),
                },
              ],
              display: true,
            },
            { deliverAs: "steer", triggerTurn: true },
            { type: "context", source: "context-manager/auto-retry" },
          );
        }
      } catch (err) {
        log.error("auto_retry_end error:", err);
      }
    },
  );
}

// ── Context Event Handler (pruning + semantic compression + trigger cleanup) ──
export function registerContextPruningHandler(pi: any): void {
  pi.on("context", async (event: any, ctx: any) => {
    try {
      log.bindContext(ctx);
      const messages = event.messages;
      if (!messages || messages.length === 0) {
        log.debug("context: no messages, skipping");
        return;
      }
      const beforeCount = messages.length;

      // Step 1: Semantic pruning with adaptive compression level (2604.15877)
      let filtered = messages;
      const { pruningState } = getCmState(ctx);
      if (pruningState) {
        log.debug(`context: ${beforeCount} messages before pruning`);

        // Determine compression level (Experience Compression Spectrum)
        const decision = determineCompressionLevel(ctx as ExtensionContext, {
          turnCount: ctx.turnCount ?? beforeCount / 2,
          turnsSinceCompression: pruningState.turnsSinceCompression ?? Infinity,
          consecutiveFailures: pruningState.consecutiveFailures ?? 0,
          reasoningChainDepth: (pruningState as any).reasoningChainDepth ?? 0,
          messageCount: beforeCount,
        });
        if (decision.estimatedSavings > 0) {
          log.info(
            `context: compression ${decision.level} (${decision.trigger}) — ${decision.reason}`,
          );
        }

        filtered = applyPruningWorkflow(pruningState, messages);
        const pruned = beforeCount - filtered.length;
        if (pruned > 0) {
          log.info(`context: pruned ${pruned}/${beforeCount} messages → ${filtered.length} remain`);
          addEvidence(
            ctx,
            "context_pruned",
            "session",
            `Pruned ${pruned} messages from context`,
            0.7,
          );
        } else {
          log.debug(`context: no pruning needed (${filtered.length} messages)`);
        }
      } else {
        log.debug("context: no pruning state initialized, skipping semantic pruning");
      }

      // Step 2: Medium-term reasoning chain detection (2604.15877)
      if (shouldSummarizeReasoning(ctx as ExtensionContext)) {
        try {
          const blocks = findReasoningBlocks(
            filtered.map((m: any, i: number) => ({ ...m, turn: m.turn ?? i })),
            3, // min 3 consecutive reasoning messages
          );
          if (blocks.length > 0) {
            log.info(
              `context: ${blocks.length} reasoning block(s) found — medium-term compression opportunity`,
            );
            for (const block of blocks) {
              recordSummarization(ctx as ExtensionContext, block, estimateTokensSaved(block));
              // P1.6: Extract high-value reasoning chains as episodic memories
              const summary = extractReasoningSummary(block);
              const toolNames = block.messages
                .flatMap((m: any) => m.content.match(/`(edit|read|bash|grep|write)`/g) ?? [])
                .map((t: string) => t.slice(1, -1))
                .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
                .slice(0, 6);
              try {
                addEpisode(
                  getState(ctx),
                  `Reasoning: ${summary.slice(0, 120)}`,
                  summary,
                  "partial",
                  toolNames,
                  ["reasoning-chain"],
                );
              } catch {
                // Non-fatal — three-memory-stores may not be available
              }
            }
            if (pruningState)
              (pruningState as any).reasoningChainDepth = Math.max(
                ...blocks.map((b: any) => b.messages.length),
              );
          }
        } catch (err) {
          log.error("context: reasoning block detection error:", err);
        }
      }

      // Step 2.5: Semantic compression prototype (2604.15877)
      let summarized = filtered;
      try {
        const { compressed, stats } = semanticCompress(filtered);
        if (stats.messagesOut < stats.messagesIn) {
          summarized = compressed;
          log.debug(
            `context: semantic compress ${stats.messagesIn}→${stats.messagesOut} ` +
              `(${stats.unitsCollapsed} collapsed, ${stats.unitsDropped} dropped)`,
          );
        }
        // Wire compression stats into heartbeat density tracking (BCR → analytics loop)
        updateContextDensity(
          ctx as ExtensionContext,
          1 - stats.messagesOut / Math.max(stats.messagesIn, 1),
        );
      } catch (err) {
        log.error("context: semantic compression error:", err);
      }

      // Step 3: Remove hidden retry trigger messages from compacted context.
      let cleanedCount = 0;
      const cleaned = summarized
        .map((msg: any) => {
          if (
            msg.role === "custom" &&
            (msg.customType === COMPACTION_RETRY_CUSTOM_TYPE ||
              msg.customType === "__overflow_retry_trigger")
          ) {
            cleanedCount++;
            return null;
          }
          return msg;
        })
        .filter(Boolean);

      if (cleanedCount > 0) {
        log.info(
          `context: removed ${cleanedCount} hidden retry triggers → ${cleaned.length} messages`,
        );
      }

      return { messages: cleaned };
    } catch (err) {
      log.error("context event error:", err);
    } finally {
      log.unbindContext();
    }
  });
}

// ── Retry trigger helpers (for agent_end) ─────────────────────────────────────
// These helpers are kept for backward compatibility but now simply update status.
// Actual compaction retries are handled by compaction.ts via ctx.compact() calls.
// No more triggerTurn:true hidden turns — they caused context bloat.
function triggerCompactionRetryFromAgentEnd(
  _pi: any,
  _attempt: number,
  _errorMessage: string,
): void {
  // Intentionally empty — compaction.ts handles retries via ctx.compact()
  // The agent_end handler just updates the retry counter above
  log.debug("[Compaction] agent_end retry signal received, compaction.ts handles actual retry");
}

function triggerOverflowRetryFromAgentEnd(
  _pi: any,
  _attempt: number,
  _errorMessage: string,
  _ctx: any,
): void {
  // Intentionally empty — compaction.ts handles retries via ctx.compact()
  log.debug("[Overflow] agent_end overflow signal received, compaction.ts handles actual retry");
}
