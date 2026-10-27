// Context-manager event handlers: agent_end (retry handling + API-error
// guidance), context (pruning workflow). pi-core 0.85.1 has no auto_retry_end
// extension event; the API-error guidance registers on agent_end and reads
// the last assistant message's stopReason.

import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addEvidence } from "../../../../lib/store/evidence-pool.js";
import { sendTrackedMessage } from "../../../../lib/utils/injection-tracker.js";
import { applyPruningWorkflow } from "../pruning.js";
import {
  findReasoningBlocks,
  confirmReasoningBlock,
  recordSummarization,
  shouldSummarizeReasoning,
  estimateTokensSaved,
  extractReasoningSummary,
} from "../../../../lib/reasoning/reasoning-summary.js";
import { addEpisode, getState } from "../../three-memory-stores/index.js";
import { deriveProjectIdFromCwd } from "../../../../lib/memory/past-insights.js";
import {
  describeWriteDecision,
  selectRecentEpisodes,
} from "../../../../lib/memory/write-quality.js";
import { applyWriteGateLogged } from "../../../../lib/memory/write-log.js";
import { getMemoryWriteGateConfig } from "../../../../lib/config/braid-settings.js";
import { determineCompressionLevel } from "../../../../lib/detection/compression-strategy.js";
import { semanticCompress } from "../semantic-compress.js";
import { updateContextDensity } from "../../../heartbeat/analytics/index.js";
import { AGENT_END } from "../../../../lib/core/event-names.js";
import {
  clearRequestShapeFailure,
  noteRequestShapeFailure,
} from "../../../../lib/utils/wake-gate.js";
import { isContextLengthRequestShape } from "../../../../lib/errors/llm-error.js";
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

export function registerAgentEndRetryHandler(pi: ExtensionAPI): void {
  pi.on(AGENT_END, async (event: any, ctx: any) => {
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

// pi-core 0.85.1 has no auto_retry_end extension event: when the provider
// keeps erroring past the auto-retry budget, the run simply ends with the
// last assistant message stopReason "error". Register on agent_end and
// surface the same causes/actions guidance.
export function registerAgentEndApiErrorHandler(pi: ExtensionAPI): void {
  pi.on(AGENT_END, async (event: { messages?: any[] }, _ctx: ExtensionContext) => {
    try {
      const messages = event.messages ?? [];
      let lastAssistant: any = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "assistant") {
          lastAssistant = messages[i];
          break;
        }
      }
      if (!lastAssistant || lastAssistant.stopReason !== "error") {
        // A turn that ended without an error means a request fit and came back:
        // the shape verdict from an earlier refusal no longer applies.
        clearRequestShapeFailure();
        return;
      }
      const finalError: string = lastAssistant.errorMessage ?? "Unknown error";

      // A context-length refusal is the request's shape, not the provider's
      // mood. Record it here so the wake gate can keep failed-open wakes from
      // re-firing a request that cannot succeed.
      if (isContextLengthRequestShape(finalError)) {
        noteRequestShapeFailure(finalError.slice(0, 200));
      }

      sendTrackedMessage(
        pi,
        {
          customType: "context",
          content: [
            {
              type: "text" as const,
              text: [
                "## [warn] The agent run ended with an API error",
                finalError,
                "",
                "The API kept returning errors despite retries. Possible causes:",
                "- Rate limit (429) - wait a moment or switch models",
                "- Server error (500/502/503) - provider is having issues",
                "- Network error - check your connection",
                "",
                "Actions: Run `/model` to switch models, or wait and retry.",
                "",
                `Store for reference: memory_store(content="API error: ${finalError}", tags=["error", "api"])`,
              ].join("\n"),
            },
          ],
          display: true,
        },
        { delivery: "park", deliverAs: "steer" },
        { type: "context", source: "context-manager/api-error" },
      );
    } catch (err) {
      log.error("agent_end api-error guidance error:", err);
    }
  });
}

// Context Event Handler (pruning + semantic compression + trigger cleanup)
export function registerContextPruningHandler(pi: ExtensionAPI): void {
  pi.on("context", async (event: any, ctx: any) => {
    try {
      const messages = event.messages;
      if (!messages || messages.length === 0) {
        log.debug("context: no messages, skipping");
        return;
      }
      const beforeCount = messages.length;

      // Semantic pruning with adaptive compression level (2604.15877).
      let filtered = messages;
      const { pruningState } = getCmState(ctx);
      if (pruningState) {
        log.debug(`context: ${beforeCount} messages before pruning`);

        // Determine compression level (Experience Compression Spectrum)
        const decision = await determineCompressionLevel(ctx as ExtensionContext, {
          // ExtensionContext has no turnCount - use message count as proxy
          turnCount: Math.round(beforeCount / 2),
          turnsSinceCompression: pruningState.turnsSinceCompression ?? Infinity,
          consecutiveFailures: pruningState.consecutiveFailures ?? 0,
          reasoningChainDepth:
            (pruningState as { reasoningChainDepth?: number }).reasoningChainDepth ?? 0,
          messageCount: beforeCount,
        });
        if (decision.estimatedSavings > 0) {
          log.info(
            `context: compression ${decision.level} (${decision.trigger}) - ${decision.reason}`,
          );
        }

        filtered = applyPruningWorkflow(pruningState, messages);
        const pruned = beforeCount - filtered.length;
        if (pruned > 0) {
          log.info(
            `context: pruned ${pruned}/${beforeCount} messages -> ${filtered.length} remain`,
          );
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

      // Medium-term reasoning chain detection (2604.15877).
      if (shouldSummarizeReasoning(ctx as ExtensionContext)) {
        try {
          const blocks = findReasoningBlocks(
            filtered.map((m: any, i: number) => ({ ...m, turn: m.turn ?? i })),
            3, // min 3 consecutive reasoning messages
          );
          if (blocks.length > 0) {
            log.info(
              `context: ${blocks.length} reasoning block(s) found - medium-term compression opportunity`,
            );
            for (const block of blocks) {
              // Tier 2: Confirm with utility model before summarization
              const lastContent = block.messages[block.messages.length - 1]?.content ?? "";
              if (lastContent.length > 50) {
                const confirmed = await confirmReasoningBlock(
                  lastContent,
                  ctx as ExtensionContext,
                ).catch(() => true);
                if (!confirmed) {
                  log.debug("context: reasoning block rejected by utility model, skipping");
                  continue;
                }
              }
              recordSummarization(ctx as ExtensionContext, block, estimateTokensSaved(block));
              // P1.6: Extract high-value reasoning chains as episodic memories
              const summary = extractReasoningSummary(block);
              const toolNames = block.messages
                .flatMap((m: any) => m.content.match(/`(edit|read|bash|grep|write)`/g) ?? [])
                .map((t: string) => t.slice(1, -1))
                .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
                .slice(0, 6);
              try {
                const project =
                  typeof ctx.cwd === "string" ? deriveProjectIdFromCwd(ctx.cwd) : "unknown";
                const reasoningTask = `Reasoning: ${summary.slice(0, 120)}`;
                const state = getState(ctx);
                // Review-before-write: short summaries are fragments, and a
                // repeated chain must not be stored twice.
                const gate = applyWriteGateLogged(getMemoryWriteGateConfig(), {
                  site: "reasoningChains",
                  task: reasoningTask,
                  solution: summary,
                  toolSequence: toolNames,
                  recent: selectRecentEpisodes(state.episodes, project),
                });
                if (gate.write) {
                  addEpisode(
                    state,
                    reasoningTask,
                    gate.solution,
                    "partial",
                    toolNames,
                    ["reasoning-chain"],
                    project,
                  );
                } else {
                  log.debug(`context: reasoning episode ${describeWriteDecision(gate.decision)}`);
                }
              } catch {
                // Non-fatal - three-memory-stores may not be available
              }
            }
            if (pruningState)
              (pruningState as Record<string, number>).reasoningChainDepth = Math.max(
                ...blocks.map((b: any) => b.messages.length),
              );
          }
        } catch (err) {
          log.error("context: reasoning block detection error:", err);
        }
      }

      // Semantic compression prototype (2604.15877).
      let summarized = filtered;
      try {
        const { compressed, stats } = semanticCompress(filtered);
        if (stats.messagesOut < stats.messagesIn) {
          summarized = compressed;
          log.debug(
            `context: semantic compress ${stats.messagesIn}->${stats.messagesOut} ` +
              `(${stats.unitsCollapsed} collapsed, ${stats.unitsDropped} dropped)`,
          );
        }
        // Wire compression stats into heartbeat density tracking (BCR -> analytics loop)
        updateContextDensity(
          ctx as ExtensionContext,
          1 - stats.messagesOut / Math.max(stats.messagesIn, 1),
        );
      } catch (err) {
        log.error("context: semantic compression error:", err);
      }

      // After compaction crashes, session state can contain assistant messages
      // with `content: ` (empty array). This is invalid for OpenAI-compatible
      // APIs and triggers Venice WAF 403. Normalize such messages to valid format.
      let sanitizedCount = 0;
      const sanitized = summarized.map((msg: any) => {
        // Assistant/user messages with empty content array -> null content
        if (
          (msg.role === "assistant" || msg.role === "user") &&
          Array.isArray(msg.content) &&
          msg.content.length === 0
        ) {
          sanitizedCount++;
          return { ...msg, content: null };
        }
        // Tool results with empty content array -> empty string
        if (msg.role === "toolResult" && Array.isArray(msg.content) && msg.content.length === 0) {
          sanitizedCount++;
          return { ...msg, content: "" };
        }
        return msg;
      });

      if (sanitizedCount > 0) {
        log.warn(
          `context: sanitized ${sanitizedCount} corrupted message(s) with empty content arrays`,
        );
      }

      // Remove hidden retry trigger messages from compacted context.
      let cleanedCount = 0;
      const cleaned = sanitized
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
          `context: removed ${cleanedCount} hidden retry triggers -> ${cleaned.length} messages`,
        );
      }

      return { messages: cleaned };
    } catch (err) {
      log.error("context event error:", err);
    }
  });
}

// Retry trigger helpers (for agent_end): these only update status — actual
// compaction retries are handled by compaction.ts via ctx.compact() calls.
// Hidden triggerTurn:true turns caused context bloat, so none fire from here.
function triggerCompactionRetryFromAgentEnd(
  _pi: ExtensionAPI,
  _attempt: number,
  _errorMessage: string,
): void {
  // Intentionally empty - compaction.ts handles retries via ctx.compact()
  // The agent_end handler just updates the retry counter above
  log.debug("[Compaction] agent_end retry signal received, compaction.ts handles actual retry");
}

function triggerOverflowRetryFromAgentEnd(
  _pi: ExtensionAPI,
  _attempt: number,
  _errorMessage: string,
  _ctx: any,
): void {
  // Intentionally empty - compaction.ts handles retries via ctx.compact()
  log.debug("[Overflow] agent_end overflow signal received, compaction.ts handles actual retry");
}
