/**
 * context_snapshot — Quick health check on session context.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { analyzeSession } from "../../analysis.js";

export function registerContextSnapshot(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "context_snapshot",
    label: "Context Snapshot",
    promptSnippet: "Quick health check of session context",
    description:
      "Quick health check on session context: usage %, hygiene score, prune candidates, top recommendation. " +
      "Use before other context management tools. Simpler than context_audit.",
    parameters: Type.Object({}),
    execute: async (
      _toolCallId: string,
      _params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
      const audit = analyzeSession(ctx);

      let hygieneScore = 1.0;
      if (audit.usage.percent > 80) hygieneScore -= 0.3;
      else if (audit.usage.percent > 60) hygieneScore -= 0.15;
      if (audit.tagCount === 0 && audit.branchLength > 10) hygieneScore -= 0.2;
      if (audit.candidates.length > 10) hygieneScore -= 0.15;
      if (audit.summaryCount === 0 && audit.branchLength > 20) hygieneScore -= 0.2;
      hygieneScore = Math.max(0, Math.min(1, hygieneScore));

      const scoreIcon = hygieneScore >= 0.8 ? "✓" : hygieneScore >= 0.5 ? "⚠" : "✗";
      const topRec = audit.recommendations
        .filter((r: any) => r.priority === "high" || r.priority === "medium")
        .slice(0, 1);

      const lines = [
        `**Context:** ${audit.usage.percent.toFixed(1)}% (${Math.round(audit.usage.tokens / 1024)}K/${Math.round(audit.usage.contextWindow / 1024)}K)`,
        `**Session:** ${audit.branchLength} entries, ${audit.tagCount} tags, ${audit.summaryCount} summaries`,
        `**Hygiene:** ${scoreIcon} ${(hygieneScore * 100).toFixed(0)}%`,
        `**Prune candidates:** ${audit.candidates.length}`,
      ];
      if (topRec.length > 0) {
        lines.push(`**Top action:** ${topRec[0].action} — ${topRec[0].reason}`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          usagePercent: audit.usage.percent,
          branchLength: audit.branchLength,
          tagCount: audit.tagCount,
          hygieneScore,
          pruneCandidates: audit.candidates.length,
          topRecommendation: topRec[0]?.action ?? null,
        },
      };
    },
  });
}
