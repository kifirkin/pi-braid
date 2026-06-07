/**
 * context_compress — Free up context space by compaction or archiving.
 *
 * Consolidates context_compact (trigger compaction), context_archive (compress
 * to summary), and context_prune execute mode into one tool with action param.
 */

import { Type } from "typebox";
import type { CompactOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { analyzeSession } from "../../analysis.js";

export const contextCompressSchema = Type.Object({
  action: Type.String({
    enum: ["compact", "archive"],
    description:
      "compact = remove obsolete/duplicate entries (like context_compact). " +
      "archive = compress a range of messages into a topic summary (like context_archive).",
  }),
  // compact params
  keep: Type.Optional(
    Type.Number({
      description: "Number of most recent messages to preserve. Only used with action=compact.",
    }),
  ),
  // archive params
  topic: Type.Optional(
    Type.String({
      description: "Brief topic label (e.g., 'Auth Implementation'). Required for action=archive.",
    }),
  ),
  summary: Type.Optional(
    Type.String({
      description: "Comprehensive summary of what was accomplished. Required for action=archive.",
    }),
  ),
  startIndex: Type.Optional(
    Type.Number({
      description: "Index of first message to compress (auto if omitted). Only used with action=archive.",
    }),
  ),
  endIndex: Type.Optional(
    Type.Number({
      description: "Index of last message to compress (auto if omitted). Only used with action=archive.",
    }),
  ),
});

export function registerContextCompress(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "context_compress",
    label: "Context Compress",
    promptSnippet: "Free context space by compaction or archiving",
    description:
      "Free up context space by compaction or archiving. " +
      "action=compact: remove obsolete/duplicate entries (like context_compact). " +
      "Supports optional `keep` to preserve recent N messages. Auto-resumes after completion. " +
      "action=archive: compress a range of messages into a topic summary (like context_archive). " +
      "Original messages preserved in session file. Auto-selects oldest ~20% when range omitted.",
    parameters: contextCompressSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
      const action = params.action;

      // ── COMPACT ──────────────────────────────────────────────────────
      if (action === "compact") {
        try {
          const audit = analyzeSession(ctx);
          const result = {
            content: [
              {
                type: "text" as const,
                text: [
                  `**Compaction triggered** — agent will resume after compression.`,
                  `  Before: ${audit.usage.percent.toFixed(1)}% used (${Math.round(audit.usage.tokens / 1024)}K tokens)`,
                  `  Keep recent: ${params?.keep ?? "auto"}`,
                  ``,
                  `On resume: [compaction] summary shows what was preserved.`,
                ].join("\n"),
              },
            ],
            details: {
              action,
              compactionTriggered: true,
              beforeUsagePercent: audit.usage.percent,
              keep: params?.keep ?? "auto",
            },
          };

          try {
            const timerMod = await import("../../../../tools/timer/index.js");
            // Cancel any stale resume timer from a previous compaction cycle.
            // Without this, an old timer can fire during a later TURN_END and
            // deliver a misplaced [timer] whisper (the "strange order" issue).
            timerMod.cancelTimersByTag("compaction-resume");
            timerMod.cancelTimersByTag("auto-compaction-resume");
            timerMod.scheduleTimer(
              3 * 60 * 1000,
              "Context compaction done — continue your task",
              "compaction-resume",
            );
          } catch {
            // Non-fatal — timer unavailable
          }

          const options: CompactOptions = {};
          if (params?.keep != null) {
            options.customInstructions = `Keep the most recent ${params.keep} messages.`;
          }

          setTimeout(() => {
            try {
              ctx.compact(options);
            } catch {
              // Agent already disconnected — non-fatal
            }
          }, 0);

          return result;
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `Failed to compact: ${e.message}` }],
            details: { action, error: e.message },
          };
        }
      }

      // ── ARCHIVE ────────────────────────────────────────────────────
      if (action === "archive") {
        const { topic, summary } = params;
        if (!topic || !summary) {
          return {
            content: [
              {
                type: "text" as const,
                text: "topic and summary are required for action=archive",
              },
            ],
            details: { action, error: "missing required params" },
          };
        }
        let { startIndex, endIndex } = params;

        if (startIndex === undefined || endIndex === undefined) {
          const audit = analyzeSession(ctx);
          const sessionLength = audit.branchLength;
          const archiveCount = Math.min(Math.max(Math.floor(sessionLength * 0.2), 10), 100);
          startIndex = 0;
          endIndex = archiveCount - 1;
        }

        if (startIndex < 0 || endIndex < startIndex) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Invalid range: startIndex must be >= 0 and endIndex must be >= startIndex",
              },
            ],
            details: { action, error: true },
          };
        }
        const sm = ctx.sessionManager;
        sm.appendCustomEntry("context_compression", {
          topic,
          startIndex,
          endIndex,
          summary,
          timestamp: Date.now(),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Compressed ${endIndex - startIndex + 1} messages into summary: "${topic}"\n\nThe summary will be visible in context. Original messages are preserved in session file.`,
            },
          ],
          details: { action, compressed: endIndex - startIndex + 1, topic },
        };
      }

      return {
        content: [{ type: "text" as const, text: "Unknown action. Use compact or archive." }],
        details: { action, error: true },
      };
    },
  });
}
