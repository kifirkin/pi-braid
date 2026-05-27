/**
 * context_compact — Trigger compaction to free up context space.
 */

import { Type } from "typebox";
import type { CompactOptions, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { analyzeSession } from "../../analysis.js";
import { log } from "../shared.js";

export function registerContextCompact(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "context_compact",
    label: "Compact Context",
    promptSnippet: "Trigger compaction to free up context space",
    description:
      "Remove obsolete/duplicate entries via compaction. " +
      "Accepts optional `keep` parameter to preserve recent N messages. " +
      "Auto-resumes after completion — freed space visible next turn.",
    parameters: Type.Object({
      keep: Type.Optional(
        Type.Number({
          description: "Number of most recent messages to preserve from pruning (default: auto)",
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
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
                `On resume: the [compaction] summary shows what was preserved.`,
              ].join("\n"),
            },
          ],
          details: {
            compactionTriggered: true,
            beforeUsagePercent: audit.usage.percent,
            keep: params?.keep ?? "auto",
          },
        };

        try {
          const { scheduleTimer } = await import("../../../../tools/timer/index.js");
          scheduleTimer(
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
          details: { error: e.message },
        };
      }
    },
  });
}
