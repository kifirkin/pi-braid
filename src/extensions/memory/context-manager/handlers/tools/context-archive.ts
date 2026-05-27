/**
 * context_archive — Compress a range of messages into a topic summary.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { analyzeSession } from "../../analysis.js";

export function registerContextArchive(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "context_archive",
    label: "Compress Context",
    promptSnippet: "Compress conversation range into a summary",
    description:
      "Compress a range of messages into a topic summary, freeing context space. " +
      "Original messages are preserved in session file (not deleted). " +
      "Auto-selects oldest ~20% when startIndex/endIndex omitted.",
    parameters: Type.Object({
      topic: Type.String({
        description: "Brief topic label (e.g., 'Auth Implementation', 'Bug Fix')",
      }),
      startIndex: Type.Optional(
        Type.Number({ description: "Index of first message to compress (auto if omitted)" }),
      ),
      endIndex: Type.Optional(
        Type.Number({ description: "Index of last message to compress (auto if omitted)" }),
      ),
      summary: Type.String({ description: "Comprehensive summary of what was accomplished" }),
    }),
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
      const { topic, summary } = params;
      let { startIndex, endIndex } = params;

      // Auto-detect range if omitted
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
          details: { error: true },
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
        details: { compressed: endIndex - startIndex + 1, topic },
      };
    },
  });
}
