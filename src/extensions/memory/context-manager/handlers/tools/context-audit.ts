/**
 * context_audit — Full health analysis of session context.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { analyzeSession } from "../../analysis.js";
import { formatPruneCandidates } from "../shared.js";

export const contextAuditSchema = Type.Object({
  includeRecommendations: Type.Optional(Type.Boolean({ default: true })),
  detailLevel: Type.Optional(Type.String({ enum: ["summary", "detailed", "full"] })),
});

export function registerContextAudit(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "context_audit",
    label: "Context Audit",
    promptSnippet: "Full analysis of session context health and recommendations",
    description:
      "Get a comprehensive analysis of session context health with recommendations — use when optimizing context or debugging session issues. Returns usage stats, hygiene score, prune candidates, branching triggers.",
    parameters: contextAuditSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ): Promise<any> => {
      const includeRecs = params.includeRecommendations ?? true;
      const detail = params.detailLevel ?? "detailed";
      const audit = analyzeSession(ctx);
      const lines: string[] = [];
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

      let hygieneScore = 1.0;
      if (audit.usage.percent > 80) hygieneScore -= 0.3;
      else if (audit.usage.percent > 60) hygieneScore -= 0.15;
      if (audit.tagCount === 0 && audit.branchLength > 10) hygieneScore -= 0.2;
      if (audit.candidates.length > 10) hygieneScore -= 0.15;
      if (audit.summaryCount === 0 && audit.branchLength > 20) hygieneScore -= 0.2;
      hygieneScore = Math.max(0, Math.min(1, hygieneScore));
      const scoreEmoji = hygieneScore >= 0.8 ? "✓" : hygieneScore >= 0.5 ? "⚠" : "✗";
      lines.push(`\n### Hygiene Score: ${scoreEmoji} ${(hygieneScore * 100).toFixed(0)}%`);

      if (includeRecs && audit.recommendations.length > 0) {
        lines.push("\n### Recommendations");
        for (const rec of audit.recommendations) {
          const icon = rec.priority === "high" ? "🔴" : rec.priority === "medium" ? "🟡" : "🟢";
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

      if (detail === "full" || detail === "detailed") {
        const topPrune = audit.candidates.slice(0, detail === "full" ? 20 : 5);
        if (topPrune.length > 0) {
          lines.push(`\n### Top Prune Candidates (${topPrune.length})`);
          lines.push(formatPruneCandidates(topPrune, topPrune.length));
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { hygieneScore, audit },
      };
    },
  });
}
