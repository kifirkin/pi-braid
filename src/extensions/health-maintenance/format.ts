import type { HealthMaintenanceResult } from "./types.js";

export function formatHealthMaintenanceOutput(result: HealthMaintenanceResult): string {
  const lines: string[] = [];

  switch (result.action) {
    case "status": {
      const data = result.data as any;
      lines.push("# Agent Evolution Status");
      lines.push("");

      if (data?.metrics) {
        const m = data.metrics;
        lines.push("**Performance Metrics:**");
        lines.push(`- Total Turns: ${m.totalTurns}`);
        lines.push(`- Avg Healthcheck: ${m.avgHealthcheck?.toFixed(1)}%`);
        lines.push(`- Avg Error Rate: ${(m.avgErrorRate * 100)?.toFixed(1)}%`);
        lines.push(`- Avg Tool Success: ${m.avgToolSuccess?.toFixed(1)}%`);
        lines.push("");
        lines.push(`**Status:** ${m.degraded ? "🔴 DEGRADED" : "🟢 HEALTHY"}`);
      }

      if (data?.metacognition) {
        const mc = data.metacognition;
        lines.push("");
        lines.push("**Metacognition:**");
        lines.push(`- Confidence: ${(mc.confidence * 100)?.toFixed(0)}%`);
        if (mc.knowledgeGaps?.length > 0) {
          lines.push(`- Knowledge Gaps: ${mc.knowledgeGaps.join(", ")}`);
        }
      }
      break;
    }

    case "health": {
      const data = result.data as any;
      lines.push("# Healthcheck Result");
      lines.push("");
      lines.push(`**Status:** ${(data?.overall ?? "unknown").toUpperCase()}`);
      lines.push(`**Score:** ${data?.score ?? 0}/100`);
      break;
    }

    case "check": {
      const data = result.data as any;
      lines.push("# Degradation Check");
      lines.push("");
      lines.push(`**Degraded:** ${data?.degraded ? "🔴 YES" : "🟢 NO"}`);
      break;
    }

    case "commit":
    case "rollback":
    case "config":
    case "reset":
    case "benchmark": {
      lines.push(`# ${result.action.toUpperCase()}`);
      lines.push("");
      lines.push(result.success ? "✅ Success" : "❌ Failed");
      if (result.error) {
        lines.push(`**Error:** ${result.error}`);
      }
      break;
    }
  }

  return lines.join("\n");
}
