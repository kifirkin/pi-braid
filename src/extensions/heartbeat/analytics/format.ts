/**
 * Analytics - formatting helpers for /analytics command output.
 */

import type { AnalyticsState } from "./shared.js";
import { getToolSequences, getSessionMetrics, loadAnalytics } from "./core.js";

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
