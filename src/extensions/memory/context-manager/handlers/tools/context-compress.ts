/**
 * context_compress - Free up context space by compaction, archiving, or deep-clean.
 *
 * Consolidates context_compact, context_archive, context_prune, and the
 * proposed tag-based/percentage/keepRecentTurns range params into one tool.
 *
 * 2026-07-02 improvements:
 *   - Tag-based archive range (startTag / endTag / beforeTag)
 *   - Percentage-based range (range: "80%")
 *   - Keep-recent-turns shortcut (keepRecentTurns: 20)
 *   - Token-savings feedback after archive
 *   - "deep_clean" meta-action: tag + archive + compact in one call
 */

import { Type } from "typebox";
import type { CompactOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { analyzeSession } from "../../analysis.js";
import * as timerMod from "../../../../scheduling/timer/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve a tag name to a branch entry index by scanning the session branch
 * for entries whose label matches `tagName`. Returns -1 if not found.
 */
function resolveTagToIndex(ctx: any, tagName: string): number {
  try {
    const sm = ctx.sessionManager;
    if (!sm) return -1;
    const branch = sm.getBranch() ?? [];
    for (let i = 0; i < branch.length; i++) {
      const label = sm.getLabel?.(branch[i].id);
      if (label === tagName) return i;
    }
    return -1;
  } catch {
    return -1;
  }
}

/**
 * Capture current context usage for pre/post feedback.
 */
function captureUsage(ctx: any): { percent: number; tokens: number; contextWindow: number } | null {
  try {
    const audit = analyzeSession(ctx);
    return audit.usage;
  } catch {
    return null;
  }
}

// ── Schema ───────────────────────────────────────────────────────────────────

export const contextCompressSchema = Type.Object({
  action: Type.String({
    enum: ["compact", "archive", "deep_clean"],
    description:
      "compact = remove obsolete/duplicate entries (like context_compact). " +
      "archive = compress a range of messages into a topic summary (like context_archive). " +
      "deep_clean = tag current position, archive everything before the tag, then compact. All-in-one.",
  }),
  // compact params
  keep: Type.Optional(
    Type.Number({
      description: "Number of most recent messages to preserve. Only used with action=compact.",
    }),
  ),
  // archive params (original numeric range)
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
  // archive params (tag-based range, 2026-07-02)
  startTag: Type.Optional(
    Type.String({
      description:
        "Tag name for archive start boundary. Overrides startIndex when set. Only used with action=archive.",
    }),
  ),
  endTag: Type.Optional(
    Type.String({
      description:
        "Tag name for archive end boundary. Overrides endIndex when set. Only used with action=archive.",
    }),
  ),
  beforeTag: Type.Optional(
    Type.String({
      description:
        "Convenience: archive all entries before this tag (startIndex=0, endIndex=tagIndex-1). " +
        "Equivalent to startTag+endIndex. Only used with action=archive.",
    }),
  ),
  // percentage-based range, 2026-07-02
  range: Type.Optional(
    Type.String({
      description:
        'Percentage of session to archive, e.g. "80%". Overrides startIndex/endIndex. Only used with action=archive.',
    }),
  ),
  // keep-recent-turns shortcut, 2026-07-02
  keepRecentTurns: Type.Optional(
    Type.Number({
      description:
        "Keep the last N user turns, archive everything older. Overrides startIndex/endIndex. Only used with action=archive.",
    }),
  ),
  // archive params (shared)
  topic: Type.Optional(
    Type.String({
      description:
        "Brief topic label (e.g., 'Auth Implementation'). Required for action=archive and action=deep_clean.",
    }),
  ),
  summary: Type.Optional(
    Type.String({
      description:
        "Comprehensive summary of what was accomplished. Required for action=archive and action=deep_clean.",
    }),
  ),
  // deep_clean params
  tagName: Type.Optional(
    Type.String({
      description:
        "Tag name to create at current position. Only used with action=deep_clean. Default: 'before-cleanup'.",
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
      "Range can be specified via startIndex/endIndex, startTag/endTag, range ('80%'), or keepRecentTurns (N). " +
      "Action=deep_clean: tag + archive before tag + compact -- one-shot context hygiene. " +
      "Original messages preserved in session file. " +
      "IMPORTANT: do NOT call this tool in the same parallel batch as other tools. " +
      "ctx.compact() aborts the current turn, which discards any pending tool " +
      "results from the same batch. Issue this tool call alone.",
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
          const usage = captureUsage(ctx);
          const usageLine = usage
            ? `${usage.percent.toFixed(1)}% used (${Math.round(usage.tokens / 1024)}K tokens)`
            : "unknown";

          const result = {
            content: [
              {
                type: "text" as const,
                text: [
                  `**Compaction triggered** - agent will resume after compression.`,
                  `  Before: ${usageLine}`,
                  `  Keep recent: ${params?.keep ?? "auto"}`,
                  ``,
                  `On resume: [compaction] summary shows what was preserved.`,
                ].join("\n"),
              },
            ],
            details: {
              action,
              compactionTriggered: true,
              keep: params?.keep ?? "auto",
            },
          };

          try {
            // Cancel any stale resume timer from a previous compaction cycle.
            const sessionId =
              (ctx as { sessionManager?: { getSessionId?: () => string } })?.sessionManager?.getSessionId?.() ??
              "anonymous";
            timerMod.cancelTimersByTag(sessionId, "compaction-resume");
            timerMod.cancelTimersByTag(sessionId, "auto-compaction-resume");
          } catch {
            // Non-fatal - timer unavailable
          }

          const options: CompactOptions = {};
          if (params?.keep != null) {
            options.customInstructions = `Keep the most recent ${params.keep} messages.`;
          }

          setTimeout(() => {
            try {
              ctx.compact(options);
            } catch {
              // Agent already disconnected - non-fatal
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

        const usageBefore = captureUsage(ctx);
        const sessionLength = analyzeSession(ctx).branchLength;

        // Resolve range via priority: startTag/endTag > beforeTag > range > keepRecentTurns > startIndex/endIndex > auto
        let startIndex: number | undefined = params.startIndex;
        let endIndex: number | undefined = params.endIndex;

        // Priority 1: Tag-based range
        if (params.startTag !== undefined) {
          const idx = resolveTagToIndex(ctx, params.startTag);
          if (idx < 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Tag '${params.startTag}' not found in session branch. Use context_navigate action=log to see available tags.`,
                },
              ],
              details: { action, error: `tag not found: ${params.startTag}` },
            };
          }
          startIndex = idx;

          if (params.endTag !== undefined) {
            const idxEnd = resolveTagToIndex(ctx, params.endTag);
            if (idxEnd < 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Tag '${params.endTag}' not found in session branch. Use context_navigate action=log to see available tags.`,
                  },
                ],
                details: { action, error: `tag not found: ${params.endTag}` },
              };
            }
            endIndex = idxEnd;
          }
        }

        // Priority 1b: beforeTag convenience (archive everything before this tag)
        if (startIndex === undefined && params.beforeTag !== undefined) {
          const idx = resolveTagToIndex(ctx, params.beforeTag);
          if (idx < 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Tag '${params.beforeTag}' not found in session branch. Use context_navigate action=log to see available tags.`,
                },
              ],
              details: { action, error: `tag not found: ${params.beforeTag}` },
            };
          }
          startIndex = 0;
          endIndex = Math.max(0, idx - 1);
        }

        // Priority 2: Percentage-based range
        if (params.range !== undefined && (startIndex === undefined || endIndex === undefined)) {
          const match = String(params.range).match(/^(\d+)%$/);
          if (!match) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Invalid range format: '${params.range}'. Use 'N%' e.g. '80%'.`,
                },
              ],
              details: { action, error: `invalid range: ${params.range}` },
            };
          }
          const pct = parseInt(match[1], 10);
          if (pct <= 0 || pct > 100) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Range must be 1-100%. Got ${pct}%.`,
                },
              ],
              details: { action, error: `invalid percentage: ${pct}` },
            };
          }
          const count = Math.max(1, Math.floor((sessionLength * pct) / 100));
          startIndex = 0;
          endIndex = count - 1;
        }

        // Priority 3: Keep-recent-turns
        if (
          (startIndex === undefined || endIndex === undefined) &&
          params.keepRecentTurns !== undefined
        ) {
          const keep = params.keepRecentTurns;
          if (keep <= 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "keepRecentTurns must be >= 1.",
                },
              ],
              details: { action, error: "invalid keepRecentTurns" },
            };
          }

          // Walk backwards from end, counting user messages
          const sm = ctx.sessionManager;
          const branch = sm.getBranch() ?? [];
          let userMessagesSeen = 0;
          let cutIndex = 0;
          for (let i = branch.length - 1; i >= 0; i--) {
            const entry = branch[i];
            if (entry?.type === "user" || entry?.role === "user") {
              userMessagesSeen++;
              if (userMessagesSeen >= keep) {
                cutIndex = i;
                break;
              }
            }
          }
          startIndex = 0;
          endIndex = Math.max(0, cutIndex - 1);
        }

        // Default: auto-select oldest ~20%
        if (startIndex === undefined || endIndex === undefined) {
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

        // Build feedback with before/after comparison
        const count = endIndex - startIndex + 1;
        const feedbackLines: string[] = [
          `Compressed ${count} messages into summary: "${topic}"`,
        ];

        if (usageBefore) {
          // Estimate freed tokens proportionally: (count / sessionLength) of current usage
          const estimatedFreed = Math.round(
            (usageBefore.tokens * count) / Math.max(sessionLength, 1),
          );
          const estimatedAfterPct = Math.max(
            0,
            usageBefore.percent - (usageBefore.percent * count) / Math.max(sessionLength, 1),
          );
          feedbackLines.push(
            `  Estimated freed: ~${Math.round(estimatedFreed / 1024)}K tokens`,
          );
          feedbackLines.push(
            `  Before: ${usageBefore.percent.toFixed(1)}% -> estimated after: ${estimatedAfterPct.toFixed(1)}%`,
          );
        }

        feedbackLines.push(
          "",
          "The summary will be visible in context. Original messages are preserved in session file.",
        );

        return {
          content: [
            {
              type: "text" as const,
              text: feedbackLines.join("\n"),
            },
          ],
          details: {
            action,
            compressed: count,
            topic,
            startIndex,
            endIndex,
            estimatedFreedTokens: usageBefore
              ? Math.round((usageBefore.tokens * count) / Math.max(sessionLength, 1))
              : undefined,
          },
        };
      }

      // ── DEEP_CLEAN ─────────────────────────────────────────────────
      if (action === "deep_clean") {
        const topic = params.topic;
        const summary = params.summary;
        if (!topic || !summary) {
          return {
            content: [
              {
                type: "text" as const,
                text: "topic and summary are required for action=deep_clean",
              },
            ],
            details: { action, error: "missing required params" },
          };
        }

        const tagName = params.tagName ?? "before-cleanup";
        const usageBefore = captureUsage(ctx);

        try {
          // Step 1: Tag current position
          const sm = ctx.sessionManager;
          const branch = sm.getBranch() ?? [];
          const currentLeaf = branch.length > 0 ? branch[branch.length - 1].id : null;
          if (currentLeaf) {
            sm.appendLabelChange(currentLeaf, tagName);
          }

          // Step 2: Archive everything before the tag
          const tagIndex = currentLeaf ? resolveTagToIndex(ctx, tagName) : -1;
          const archiveEnd = tagIndex > 0 ? tagIndex - 1 : -1;

          if (archiveEnd >= 0) {
            sm.appendCustomEntry("context_compression", {
              topic,
              startIndex: 0,
              endIndex: archiveEnd,
              summary,
              timestamp: Date.now(),
              fromDeepClean: true,
            });
          }

          // Step 3: Trigger compaction
          const options: CompactOptions = {};
          setTimeout(() => {
            try {
              ctx.compact(options);
            } catch {
              // Non-fatal
            }
          }, 0);

          const count = archiveEnd >= 0 ? archiveEnd + 1 : 0;
          const usageLine = usageBefore
            ? ` (before: ${usageBefore.percent.toFixed(1)}%)`
            : "";

          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `**Deep clean triggered.**`,
                  `  1. Tagged '${tagName}' at current position`,
                  `  2. Archived ${count} messages before tag`,
                  `  3. Compaction triggered -- agent will resume after compression${usageLine}`,
                  "",
                  `Topic: ${topic}`,
                ].join("\n"),
              },
            ],
            details: {
              action: "deep_clean",
              tagName,
              archived: count,
              compactionTriggered: true,
              topic,
            },
          };
        } catch (e: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to deep clean: ${e.message}`,
              },
            ],
            details: { action, error: e.message },
          };
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: "Unknown action. Use compact, archive, or deep_clean.",
          },
        ],
        details: { action, error: true },
      };
    },
  });
}