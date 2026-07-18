/**
 * context_inspect - Inspect session context health at any detail level.
 *
 * Consolidates context_snapshot (quick), context_audit (detailed), and
 * context_prune dry-run into one tool with a `detail` parameter.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { analyzeSession } from "../../analysis.js";
import { getCmState, formatPruneCandidates } from "../shared.js";

export const contextInspectSchema = Type.Object({
  detail: Type.Optional(
    Type.String({
      enum: ["quick", "detailed", "full", "prune"],
      description:
        "quick = 5-line summary (like context_snapshot). detailed = full audit with recommendations (like context_audit). " +
        "full = detailed + top 20 prune candidates. prune = only prune candidates (like context_prune dry-run). Default: quick.",
    }),
  ),
  minAge: Type.Optional(
    Type.Number({ description: "Minimum age in turns for prune candidates (default 5). Only used with detail=prune." }),
  ),
  toolFilter: Type.Optional(
    Type.Array(Type.String(), { description: "Only include candidates matching these tool names. Only used with detail=prune." }),
  ),
  includeRecommendations: Type.Optional(
    Type.Boolean({ description: "Include recommendations in report. Default: true. Only used with detail=detailed|full." }),
  ),
});

function computeHygieneScore(audit: ReturnType<typeof analyzeSession>): number {
  let score = 1.0;
  if (audit.usage.percent > 80) score -= 0.3;
  else if (audit.usage.percent > 60) score -= 0.15;
  if (audit.tagCount === 0 && audit.branchLength > 10) score -= 0.2;
  if (audit.candidates.length > 10) score -= 0.15;
  if (audit.summaryCount === 0 && audit.branchLength > 20) score -= 0.2;
  return Math.max(0, Math.min(1, score));
}

export function registerContextInspect(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "context_inspect",
    label: "Context Inspect",
    promptSnippet: "Inspect session context health and prune candidates",
    description:
      "Inspect session context health and prune candidates. " +
      "Use detail=quick for a 5-line summary (like context_snapshot), " +
      "detail=detailed for full audit with recommendations (like context_audit), " +
      "detail=full for detailed + top prune candidates, " +
      "detail=prune to see only candidates eligible for removal (like context_prune dry-run). " +
      "When to use: quick after every checkpoint operation. " +
      "Detailed when the session feels bloated or slow. " +
      "Prune to see what could be removed before a forced compact.",
    parameters: contextInspectSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
      const detail = params.detail ?? "quick";
      const audit = analyzeSession(ctx);
      const hygieneScore = computeHygieneScore(audit);
      const lines: string[] = [];

      // ── QUICK: 5-line summary ─────────────────────────────────────
      if (detail === "quick") {
        const scoreIcon = hygieneScore >= 0.8 ? "[v]" : hygieneScore >= 0.5 ? "[warn]" : "[x]";
        const topRec = audit.recommendations
          .filter((r: any) => r.priority === "high" || r.priority === "medium")
          .slice(0, 1);
        lines.push(
          `**Context:** ${audit.usage.percent.toFixed(1)}% (${Math.round(audit.usage.tokens / 1024)}K/${Math.round(audit.usage.contextWindow / 1024)}K)`,
        );
        lines.push(
          `**Session:** ${audit.branchLength} entries, ${audit.tagCount} tags, ${audit.summaryCount} summaries`,
        );
        lines.push(`**Hygiene:** ${scoreIcon} ${(hygieneScore * 100).toFixed(0)}%`);
        lines.push(`**Prune candidates:** ${audit.candidates.length}`);
        if (topRec.length > 0) {
          lines.push(`**Top action:** ${topRec[0].action} - ${topRec[0].reason}`);
        }
        const hygieneAction = hygieneScore < 0.5
          ? { tool: "context_compress", action: "archive", reason: "hygiene score below 50%" }
          : hygieneScore < 0.8
            ? { tool: "context_navigate", action: "tag", name: "before-cleanup", reason: "hygiene score below 80%" }
            : undefined;
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            detail,
            usagePercent: audit.usage.percent,
            branchLength: audit.branchLength,
            tagCount: audit.tagCount,
            hygieneScore,
            pruneCandidates: audit.candidates.length,
            topRecommendation: topRec[0]?.action ?? null,
            hygieneAction,
            nextStep: hygieneAction ? { tool: hygieneAction.tool, note: hygieneAction.reason } : undefined,
          },
        };
      }

      // ── DETAILED / FULL: Full audit report ─────────────────────────
      if (detail === "detailed" || detail === "full") {
        const incRecs = params.includeRecommendations ?? true;
        const scoreEmoji = hygieneScore >= 0.8 ? "[v]" : hygieneScore >= 0.5 ? "[warn]" : "[x]";
        lines.push("## Context Audit Report");
        lines.push("\n### Usage Statistics");
        lines.push(
          `- **Context:** ${audit.usage.percent.toFixed(1)}% (${Math.round(audit.usage.tokens / 1024)}K/${Math.round(audit.usage.contextWindow / 1024)}K tokens)`,
        );
        lines.push(`- **Branch length:** ${audit.branchLength} entries`);
        lines.push(`- **Tree depth:** ${audit.treeDepth} total nodes`);
        lines.push(`- **Tags:** ${audit.tagCount}`);
        lines.push(`- **Summaries:** ${audit.summaryCount}`);
        lines.push(`- **Branches:** ${audit.branchCount}`);
        if (audit.oldestEntry)
          lines.push(
            `- **Oldest entry:** ${audit.oldestEntry.id.slice(0, 8)} (${audit.oldestEntry.age} turns ago)`,
          );
        lines.push(`\n### Hygiene Score: ${scoreEmoji} ${(hygieneScore * 100).toFixed(0)}%`);

        if (incRecs && audit.recommendations.length > 0) {
          lines.push("\n### Recommendations");
          for (const rec of audit.recommendations) {
            const icon = rec.priority === "high" ? "[high]" : rec.priority === "medium" ? "[med]" : "[low]";
            lines.push(`${icon} **[${rec.priority.toUpperCase()}]** ${rec.action}`);
            lines.push(`   └─ ${rec.reason}`);
          }
        }

        if (audit.branchingTriggers.length > 0) {
          lines.push("\n### Branching Triggers");
          lines.push("Consider `context_checkout` with `backupTag` to branch if:");
          for (const trigger of audit.branchingTriggers) {
            lines.push(`- ${trigger.reason}: ${trigger.current} (threshold: ${trigger.threshold})`);
          }
        }

        // Prune candidates (full = top 20, detailed = top 5)
        const topPrune = audit.candidates.slice(0, detail === "full" ? 20 : 5);
        if (topPrune.length > 0) {
          lines.push(`\n### Top Prune Candidates (${topPrune.length})`);
          lines.push(formatPruneCandidates(topPrune, topPrune.length));
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { detail, hygieneScore, audit },
        };
      }

      // ── PRUNE: Only prune candidates (like context_prune dry-run) ──
      if (detail === "prune") {
        const minAge = params.minAge ?? 5;
        let candidates = audit.candidates.filter((c: any) => c.age >= minAge);
        if (params.toolFilter?.length) {
          candidates = candidates.filter(
            (c: any) => c.toolName && params.toolFilter.includes(c.toolName),
          );
        }
        const topCandidates = candidates.slice(0, 15);
        lines.push(`## Context Prune - ${topCandidates.length} of ${candidates.length} candidates`);
        lines.push("\nTo remove these, use `context_compress` with `action=compact`.");
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
          lines.push("\n[v] No prune candidates found (session is clean)");
        } else {
          lines.push(`\n${formatPruneCandidates(topCandidates)}`);
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            detail,
            candidatesFound: candidates.length,
            topCandidates: topCandidates.map((c: any) => ({
              id: c.id,
              score: c.score,
              reason: c.reason,
            })),
            stats: getCmState(ctx).pruningState.stats,
            nextStep: candidates.length > 0
              ? { tool: "context_compress", action: "compact", note: `${candidates.length} prune candidates available` }
              : undefined,
          },
        };
      }

      return {
        content: [{ type: "text" as const, text: "Unknown detail level. Use quick|detailed|full|prune." }],
        details: { error: true },
      };
    },
  });
}
