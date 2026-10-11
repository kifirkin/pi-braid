/**
 * context_inspect - Inspect session context health at any detail level.
 *
 * Consolidates context_snapshot (quick), context_audit (detailed), and
 * context_prune dry-run into one tool with a `detail` parameter.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { analyzeSession } from "../../analysis.js";
import {
  getCmState,
  formatPruneCandidates,
  formatCompactionLossLine,
  formatNavigationAdoptionLine,
  getCompactionHealth,
} from "../shared.js";
import { formatDriftLine } from "../../../../../lib/telemetry/drift-signals.js";
import { CONTEXT_COMPACT_REFUSE_PERCENT } from "../../../../../lib/detection/context-thresholds.js";
import { formatTokensK } from "../../../../../lib/detection/context-usage.js";
import { readExtensionState } from "../../../../../lib/state/extension-state.js";
import { formatPendingCompactionsLine, readPendingCompactions } from "./context-compress.js";

export const contextInspectSchema = Type.Object({
  detail: Type.Optional(
    Type.String({
      enum: ["quick", "detailed", "full", "prune"],
      description:
        "Detail: quick (5-line summary), detailed (full audit), full (detail + top 20 candidates), prune (candidates only). Default: quick.",
    }),
  ),
  minAge: Type.Optional(
    Type.Number({
      description: "Min age in turns for prune candidates (default 5); detail=prune only.",
    }),
  ),
  toolFilter: Type.Optional(
    Type.Array(Type.String(), {
      description: "Only include candidates matching these tool names; detail=prune only.",
    }),
  ),
  includeRecommendations: Type.Optional(
    Type.Boolean({
      description: "Include recommendations; default true; detail=detailed|full only.",
    }),
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
    exposure: "deferred",
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

      // QUICK: 5-line summary
      if (detail === "quick") {
        const scoreIcon = hygieneScore >= 0.8 ? "[v]" : hygieneScore >= 0.5 ? "[warn]" : "[x]";
        const topRec = audit.recommendations
          .filter((r: any) => r.priority === "high" || r.priority === "medium")
          .slice(0, 1);
        lines.push(
          `**Context:** ${audit.usage.percent.toFixed(1)}% (${formatTokensK(audit.usage.tokens)}/${formatTokensK(audit.usage.contextWindow)}) - live working set (${audit.usageSource})`,
        );
        if (audit.branchTokens > audit.usage.tokens) {
          lines.push(`**Branch total (not sent):** ${formatTokensK(audit.branchTokens)} tokens`);
        }
        lines.push(
          `**Session:** ${audit.branchLength} entries, ${audit.tagCount} tags, ${audit.summaryCount} summaries`,
        );
        lines.push(`**Hygiene:** ${scoreIcon} ${(hygieneScore * 100).toFixed(0)}%`);
        lines.push(`**Prune candidates:** ${audit.candidates.length}`);
        if (topRec.length > 0) {
          lines.push(`**Top action:** ${topRec[0].action} - ${topRec[0].reason}`);
        }
        // Armed-but-unfired compactions: the live usage reads pre-compaction
        // state until the settle-point compact fires, so a just-armed slide
        // looks like a no-op here unless the pending state is visible.
        const pendingLine = formatPendingCompactionsLine(ctx);
        if (pendingLine) {
          lines.push(`**Pending:** ${pendingLine}`);
        }
        // P2c: loss/drift health - one short line, only when nonzero.
        const lossLine = formatCompactionLossLine();
        const driftLine = formatDriftLine();
        if (lossLine || driftLine) {
          lines.push(`**Loss:** ${[lossLine, driftLine].filter(Boolean).join(" · ")}`);
        }
        // Hygiene ACT counters (turn-end auto-compact): one line, only when nonzero.
        const enfState = readExtensionState<{
          contextHygieneActs?: {
            total: number;
            byKind: Record<string, number>;
            lastDropped: number;
          };
          contextHygieneSkips?: number;
          liveUsageSamples?: number[];
        }>(ctx, "enforcement");
        const acts = enfState?.contextHygieneActs;
        if (acts?.total) {
          const kinds = Object.entries(acts.byKind)
            .map(([k, n]) => `${k} ${n}`)
            .join(", ");
          lines.push(
            `**Hygiene acts:** ${acts.total} (${kinds}; last dropped ~${acts.lastDropped} entries)` +
              (enfState?.contextHygieneSkips ? ` · ${enfState.contextHygieneSkips} skipped` : ""),
          );
        }
        // Machine-readable last-compaction loss counters (absent
        // when never measured) — the text line above carries the same data.
        const health = getCompactionHealth();
        const lossCounters =
          health.lastCompactedMessages !== undefined
            ? { compacted: health.lastCompactedMessages, kept: health.lastKeptMessages }
            : undefined;
        // Proactive early-tagging steer for the MEDIUM
        // band (55% up to CONTEXT_COMPACT_REFUSE_PERCENT, owner:
        // lib/detection/context-thresholds.ts) — only when the session has zero
        // recorded tags, so a session that already adopted tagging is not
        // nagged. The high tier (above CONTEXT_COMPACT_REFUSE_PERCENT) below
        // stays the existing crisis line. 55 is a local heuristic.
        const taggedThisSession = (getCmState(ctx).navigationAdoption?.tags ?? 0) > 0;
        if (
          audit.usage.percent > 55 &&
          audit.usage.percent <= CONTEXT_COMPACT_REFUSE_PERCENT &&
          !taggedThisSession
        ) {
          lines.push(
            `**Steer:** tag now (lossless checkpoint) — context_navigate(action=tag) before usage climbs into archive-and-compact territory`,
          );
        }
        // Navigation-first steer — suggestion line only,
        // no behavior change to the audit itself. Shown when usage is high.
        if (audit.usage.percent > CONTEXT_COMPACT_REFUSE_PERCENT) {
          lines.push(
            `**High usage:** tag + archive before compact — context_navigate(action=tag) → context_compress(action=archive)`,
          );
        }
        const hygieneAction =
          hygieneScore < 0.5
            ? { tool: "context_compress", action: "archive", reason: "hygiene score below 50%" }
            : hygieneScore < 0.8
              ? {
                  tool: "context_navigate",
                  action: "tag",
                  name: "before-cleanup",
                  reason: "hygiene score below 80%",
                }
              : undefined;
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            detail,
            usagePercent: audit.usage.percent,
            usageTokens: audit.usage.tokens,
            usageSource: audit.usageSource,
            branchTokens: audit.branchTokens,
            branchLength: audit.branchLength,
            tagCount: audit.tagCount,
            hygieneScore,
            pruneCandidates: audit.candidates.length,
            topRecommendation: topRec[0]?.action ?? null,
            lossCounters,
            hygieneActs: enfState?.contextHygieneActs,
            hygieneSkips: enfState?.contextHygieneSkips,
            liveUsageSamples: enfState?.liveUsageSamples,
            pendingCompactions: readPendingCompactions(ctx),
            hygieneAction,
            nextStep: hygieneAction
              ? { tool: hygieneAction.tool, note: hygieneAction.reason }
              : undefined,
          },
        };
      }

      // DETAILED / FULL: Full audit report
      if (detail === "detailed" || detail === "full") {
        const incRecs = params.includeRecommendations ?? true;
        const scoreEmoji = hygieneScore >= 0.8 ? "[v]" : hygieneScore >= 0.5 ? "[warn]" : "[x]";
        lines.push("## Context Audit Report");
        lines.push("\n### Usage Statistics");
        lines.push(
          `- **Context:** ${audit.usage.percent.toFixed(1)}% (${formatTokensK(audit.usage.tokens)}/${formatTokensK(audit.usage.contextWindow)} tokens)`,
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
            const icon =
              rec.priority === "high" ? "[high]" : rec.priority === "medium" ? "[med]" : "[low]";
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

        // P2c: loss/drift health section for the full audit, only when nonzero.
        const lossLine = formatCompactionLossLine();
        const driftLine = formatDriftLine();
        if (lossLine || driftLine) {
          lines.push("\n### Compaction Loss / Drift Health");
          if (lossLine) lines.push(`- ${lossLine}`);
          if (driftLine) lines.push(`- ${driftLine}`);
        }

        // Armed-but-unfired compactions (same honesty as the quick view).
        const pendingDetailed = formatPendingCompactionsLine(ctx);
        if (pendingDetailed) {
          lines.push("\n### Pending Compactions");
          lines.push(`- ${pendingDetailed}`);
        }

        // Per-session navigation-adoption counters. Only when the
        // agent actually steered (the block exists), and loss-preferring
        // navigation (tag/checkout/archive/slide) is visually separated from
        // compacts so the adoption trend reads at a glance.
        const navLine = formatNavigationAdoptionLine(getCmState(ctx).navigationAdoption);
        if (navLine) {
          lines.push("\n### Navigation Adoption");
          lines.push(`- ${navLine}`);
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

      // PRUNE: Only prune candidates (like context_prune dry-run)
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
          `\n**Context Usage:** ${audit.usage.percent.toFixed(1)}% (${formatTokensK(audit.usage.tokens)} tokens)`,
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
            nextStep:
              candidates.length > 0
                ? {
                    tool: "context_compress",
                    action: "compact",
                    note: `${candidates.length} prune candidates available`,
                  }
                : undefined,
          },
        };
      }

      return {
        content: [
          { type: "text" as const, text: "Unknown detail level. Use quick|detailed|full|prune." },
        ],
        details: { error: true },
      };
    },
  });
}
