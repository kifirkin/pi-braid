/**
 * Analytics - formatting helpers for /analytics command output.
 */

import type { AnalyticsState } from "./shared.js";
import { getToolSequences, getSessionMetrics, loadAnalytics } from "./core.js";
import {
  computeCriticCost,
  getCriticStats,
} from "../../../lib/ai/cost-report.js";

/**
 * Compact critic-cost summary for the current session overview.
 * Returns a Markdown section with totals + top-3 most-expensive critics.
 * Returns empty string when no LLM-tier calls have fired (so the
 * overview doesn't grow an empty section for sessions with no critic
 * activity). Use the full per-critic breakdown table at the same path
 * when needed.
 */
function formatCriticCostSection(): string {
  const stats = getCriticStats();
  // Skip when only heuristic / cache / failed tiers fired (no real cost).
  const hasLlmTier =
    stats.totals.utility > 0 ||
    stats.totals.session > 0 ||
    stats.totals["max-power"] > 0;
  if (!hasLlmTier) return "";

  const report = computeCriticCost(stats);
  const lines: string[] = [
    "### Critic Cost (Tier 2 / utility + session LLM)",
    `**Total:** $${report.totals.costUsd.toFixed(4)} across ${report.totals.inputTokens.toLocaleString()} input + ${report.totals.outputTokens.toLocaleString()} output tokens`,
  ];

  if (report.totals.cacheHits > 0) {
    lines.push(
      `**Cache hits:** ${report.totals.cacheHits} (estimated savings: $${report.totals.cacheSavingsUsd.toFixed(4)})`,
    );
  }

  // Top-3 by cost, sorted descending, drop zero-cost rows.
  const top3 = Object.entries(report.perCritic)
    .sort(([, a], [, b]) => b.totalCostUsd - a.totalCostUsd)
    .slice(0, 3)
    .filter(([, b]) => b.totalCostUsd > 0);

  if (top3.length > 0) {
    lines.push("", "| Critic | Cost | Calls |", "|---|---:|---:|");
    for (const [label, breakdown] of top3) {
      const count = Object.values(breakdown.byTier).reduce(
        (sum, t) => sum + (t?.count ?? 0),
        0,
      );
      lines.push(`| ${label} | $${breakdown.totalCostUsd.toFixed(4)} | ${count} |`);
    }
  }

  return lines.join("\n");
}

export function formatCurrentSession(s: AnalyticsState): string {
  const metrics = Array.from(s.toolMetrics.values()).sort((a, b) => b.totalCalls - a.totalCalls);
  const sequences = getToolSequences(s, 2, 2);
  const sm = getSessionMetrics(s);
  const lines = [
    `## Tool Analytics - Current Session`,
    "",
    `**Session:** ${s.sessionId || "unknown"}`,
    `**Duration:** ${Math.round((Date.now() - s.sessionStartTime) / 1000)}s`,
    `**Total Tool Calls:** ${sm.totalToolCalls}`,
    `**Context Density:** ${s.contextDensity.toFixed(1)}%`,
    `**Unique Tools Used:** ${sm.uniqueToolsUsed}`,
    `**A/B Variant:** ${s.abVariant}`,
    `**Nudges Sent:** ${s.nudgesSent} | **Suppressed:** ${s.nudgesSuppressed}`,
    "",
  ];

  if (metrics.length > 0) {
    lines.push(
      "### Tool Usage",
      "| Tool | Calls | Success | Avg Duration |",
      "|------|-------|---------|--------------|",
    );
    for (const m of metrics.slice(0, 15)) {
      lines.push(
        `| ${m.toolName} | ${m.totalCalls} | ${((1 - m.errorRate) * 100).toFixed(0)}% | ${m.avgDurationMs}ms |`,
      );
    }
    lines.push("");
  }

  // ROADMAP P3-25: critic cost overview. Appended after tool-usage so the
  // dominant-cost critics sit next to the dominant tool calls — the two
  // signals together are how an operator spots LLM-vs-tool asymmetry.
  const costSection = formatCriticCostSection();
  if (costSection) {
    lines.push(costSection, "");
  }

  if (sequences.length > 0) {
    lines.push(
      "### Common Sequences",
      "| Pattern | Count | Success Rate |",
      "|---------|-------|--------------|",
    );
    for (const seq of sequences.slice(0, 10)) {
      lines.push(`| ${seq.pattern} | ${seq.count} | ${(seq.successRate * 100).toFixed(0)}% |`);
    }
    lines.push("");
  }

  if (metrics.length === 0) lines.push("*No tool calls recorded yet in this session.*");
  return lines.join("\n");
}

export function formatAllSessions(): string {
  const summary = loadAnalytics();
  const lines = [
    `## Tool Analytics - Historical Summary`,
    "",
    `**Total Sessions:** ${summary.totalSessions}`,
    `**Total Tool Calls:** ${summary.totalToolCalls}`,
    `**Avg Tools per Session:** ${summary.avgToolsPerSession.toFixed(1)}`,
    "",
  ];

  if (summary.topTools.length > 0) {
    lines.push(
      "### Top Tools (All Time)",
      "| Tool | Total Calls | Success Rate |",
      "|------|-------------|--------------|",
    );
    for (const tool of summary.topTools) {
      lines.push(`| ${tool.toolName} | ${tool.count} | ${(tool.successRate * 100).toFixed(0)}% |`);
    }
    lines.push("");
  }

  if (summary.sequences.length > 0) {
    lines.push(
      "### Common Sequences (All Time)",
      "| Pattern | Count | Success Rate |",
      "|---------|-------|--------------|",
    );
    for (const seq of summary.sequences.slice(0, 10)) {
      lines.push(`| ${seq.pattern} | ${seq.count} | ${(seq.successRate * 100).toFixed(0)}% |`);
    }
    lines.push("");
  }

  if (summary.totalSessions === 0) lines.push("*No historical data yet.*");
  return lines.join("\n");
}
