/**
 * context_prune — Analyze session for entries eligible for removal.
 */

import { Type } from "typebox";
import type { CompactOptions, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { analyzeSession } from "../../analysis.js";
import { log, getCmState, formatPruneCandidates } from "../shared.js";

export const contextPruneSchema = Type.Object({
  minAge: Type.Optional(Type.Number({ description: "Minimum age in turns (default 5)" })),
  toolFilter: Type.Optional(Type.Array(Type.String())),
  dryRun: Type.Optional(
    Type.Boolean({
      description:
        "If true (default), shows what would be removed without deleting. Set to false to actually remove entries.",
    }),
  ),
});

export function registerContextPrune(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "context_prune",
    label: "Context Prune",
    promptSnippet: "Identify and remove obsolete session entries",
    description:
      "Analyze session for entries eligible for removal. " +
      "Dry-run (default) filters candidates by minAge/toolFilter to show what would be removed. " +
      "Set dryRun=false to remove them via compaction with auto-resume. " +
      "Accepts optional `keep` to preserve recent N messages.",
    parameters: contextPruneSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
      const isDryRun = params.dryRun !== false;
      const minAge = params.minAge ?? 5;
      const audit = analyzeSession(ctx);
      let candidates = audit.candidates.filter((c) => c.age >= minAge);
      if (params.toolFilter?.length) {
        candidates = candidates.filter((c) => c.toolName && params.toolFilter.includes(c.toolName));
      }

      // ── EXECUTION MODE (dryRun=false): Actually remove entries ────────
      if (!isDryRun) {
        try {
          try {
            const { scheduleTimer } = await import("../../../../tools/timer/index.js");
            scheduleTimer(
              3 * 60 * 1000,
              "Context pruning done — continue your task",
              "compaction-resume",
            );
          } catch {
            // Non-fatal — timer unavailable, agent must type to resume
          }
          const options: CompactOptions = {};
          if (params?.keep != null) {
            options.customInstructions = `Keep the most recent ${params.keep} messages.`;
          }

          const result = {
            content: [
              {
                type: "text" as const,
                text: [
                  `**Prune executed** (dryRun=false): pi.compact() triggered`,
                  `  Before: ${audit.usage.percent.toFixed(1)}% context used (${Math.round(audit.usage.tokens / 1024)}K tokens)`,
                  `  Candidates identified: ${candidates.length}`,
                  `  Keep recent: ${params?.keep ?? "auto"}`,
                  ``,
                  `Agent will resume after compaction completes.`,
                ].join("\n"),
              },
            ],
            details: {
              mode: "execute",
              triggered: true,
              beforeUsagePercent: audit.usage.percent,
              candidatesFound: candidates.length,
              keepMessages: params?.keep ?? "auto",
            },
          };

          setTimeout(() => {
            try {
              ctx.compact(options);
            } catch {
              // Non-fatal — agent disconnect
            }
          }, 0);

          return result;
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `Failed to prune: ${e.message}` }],
            details: { mode: "execute", error: e.message },
          };
        }
      }

      // ── DRY-RUN MODE (default) ──────────────────────────────────────
      const topCandidates = candidates.slice(0, 15);
      const lines: string[] = [];
      lines.push(`## Context Prune — Dry Run`);
      lines.push("\n**Dry-run mode** — set dryRun=false to actually remove these.");
      lines.push("Automatic rule-based pruning also runs on every LLM call.");
      lines.push(
        `\n**Context Usage:** ${audit.usage.percent.toFixed(1)}% (${Math.round(audit.usage.tokens / 1024)}K tokens)`,
      );
      lines.push(
        `**Session:** ${audit.branchLength} entries, ${audit.tagCount} tags, ${audit.summaryCount} summaries`,
      );
      lines.push(
        `**Auto-pruned:** ${getCmState(ctx).pruningState.stats.totalPruned} messages (${getCmState(ctx).pruningState.stats.totalProcessed} total processed)`,
      );

      if (topCandidates.length === 0) {
        lines.push("\n✓ No prune candidates found (session is clean)");
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            mode: "analyze",
            candidatesFound: 0,
            audit,
            stats: getCmState(ctx).pruningState.stats,
          },
        };
      }

      lines.push(`\n## Prune Candidates (${topCandidates.length} of ${candidates.length} shown)`);
      lines.push("\n" + formatPruneCandidates(topCandidates));
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          mode: "analyze",
          candidatesFound: candidates.length,
          topCandidates: topCandidates.map((c) => ({ id: c.id, score: c.score, reason: c.reason })),
          audit,
          stats: getCmState(ctx).pruningState.stats,
        },
      };
    },
  });
}
