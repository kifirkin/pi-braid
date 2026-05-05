import type { HealthReport, CheckResult } from "./types.js";

export function generateReport(checks: CheckResult[]): HealthReport {
  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const skipped = checks.filter((c) => c.status === "skip").length;

  let overall: "healthy" | "degraded" | "unhealthy";
  if (failed > 0) {
    overall = "unhealthy";
  } else if (warned > 0) {
    overall = "degraded";
  } else {
    overall = "healthy";
  }

  return {
    timestamp: new Date().toISOString(),
    overall,
    checks,
    summary: {
      total: checks.length,
      passed,
      failed,
      warned,
      skipped,
    },
  };
}

export function formatReport(report: HealthReport): string {
  const statusIcon = (s: string) => {
    switch (s) {
      case "pass":
        return "✅";
      case "fail":
        return "❌";
      case "warn":
        return "⚠️";
      case "skip":
        return "⏭️";
      default:
        return "❓";
    }
  };

  const overallIcon = {
    healthy: "🟢 HEALTHY",
    degraded: "🟡 DEGRADED",
    unhealthy: "🔴 UNHEALTHY",
  }[report.overall];

  const lines: string[] = [
    `# Agent Healthcheck Report`,
    `**Status:** ${overallIcon}`,
    `**Time:** ${report.timestamp}`,
    `**Results:** ${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed, ${report.summary.warned} warnings`,
    "",
  ];

  // Group by category
  const categories = [...new Set(report.checks.map((c) => c.category))];
  for (const cat of categories) {
    lines.push(`## ${cat}`);
    lines.push("");
    const catChecks = report.checks.filter((c) => c.category === cat);
    for (const c of catChecks) {
      const detail = c.details ? `\n  ${c.details}` : "";
      lines.push(
        `${statusIcon(c.status)} **${c.name}**: ${c.message} (${c.durationMs}ms)${detail}`,
      );
    }
    lines.push("");
  }

  // Summary recommendations
  if (report.summary.failed > 0 || report.summary.warned > 0) {
    lines.push("## Recommendations");
    lines.push("");
    const issues = report.checks.filter((c) => c.status === "fail" || c.status === "warn");
    for (const issue of issues) {
      if (issue.status === "fail") {
        lines.push(`- 🔴 **${issue.category}/${issue.name}**: ${issue.message}`);
      } else {
        lines.push(`- 🟡 **${issue.category}/${issue.name}**: ${issue.message}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
