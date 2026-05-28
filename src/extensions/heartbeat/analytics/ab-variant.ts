/**
 * Analytics — A/B variant measurement (BR3).
 */

import { existsSync, readFileSync } from "node:fs";
import { METRICS_FILE } from "../../../lib/config/braid-paths.js";
import { createLogger } from "../../../lib/core/logger.js";
const log = createLogger("analytics:ab-variant");

interface VariantStats {
  variant: string;
  sessions: number;
  totalToolCalls: number;
  successCount: number;
  partialCount: number;
  failureCount: number;
  avgToolsPerSession: number;
  avgErrorRate: number;
  nudgesSent: number;
  nudgesSuppressed: number;
}

export function loadAnalyticsByVariant(storagePath?: string): Map<string, VariantStats> {
  const path = storagePath ?? METRICS_FILE;
  const variants = new Map<string, VariantStats>();
  if (!existsSync(path)) return variants;

  try {
    for (const line of readFileSync(path, "utf-8").trim().split("\n")) {
      try {
        const entry = JSON.parse(line);
        const variant = entry.abVariant || "control";
        const sm = entry.sessionMetrics || {};
        const tms = entry.toolMetrics || [];
        let v = variants.get(variant);
        if (!v) {
          v = {
            variant,
            sessions: 0,
            totalToolCalls: 0,
            successCount: 0,
            partialCount: 0,
            failureCount: 0,
            avgToolsPerSession: 0,
            avgErrorRate: 0,
            nudgesSent: 0,
            nudgesSuppressed: 0,
          };
          variants.set(variant, v);
        }
        v.sessions++;
        v.totalToolCalls += sm.totalToolCalls || 0;
        if (entry.outcome === "success") v.successCount++;
        else if (entry.outcome === "failure") v.failureCount++;
        else v.partialCount++;
        v.avgToolsPerSession =
          (v.avgToolsPerSession * (v.sessions - 1) + (sm.totalToolCalls || 0)) / v.sessions;
        v.nudgesSent += entry.nudgesSent || 0;
        v.nudgesSuppressed += entry.nudgesSuppressed || 0;
        const totalCalls = sm.totalToolCalls || 0;
        const failedCalls = tms.reduce((sum: number, m: any) => sum + (m.failedCalls || 0), 0);
        v.avgErrorRate =
          (v.avgErrorRate * (v.sessions - 1) + (totalCalls > 0 ? failedCalls / totalCalls : 0)) /
          v.sessions;
      } catch (err) {
        log.warn(`Could not aggregate error rate: ${err}`);
      }
    }
  } catch (err) {
    log.warn(`Could not load variant data: ${err}`);
  }
  return variants;
}

export function formatABResults(variants?: Map<string, VariantStats>): string {
  const v = variants ?? loadAnalyticsByVariant();
  if (v.size === 0)
    return "## A/B Results\n\n*No historical data yet. Run `/analytics:setVariant` to configure variants.*\n";

  const lines = [
    "## A/B Experiment Results",
    "",
    "| Variant | Sessions | Success | Partial | Failure | Avg Tools | Nudges Sent | Suppressed | Avg Error Rate |",
    "|---------|----------|---------|---------|---------|-----------|-------------|------------|----------------|",
  ];
  for (const vs of v.values()) {
    lines.push(
      `| ${vs.variant} | ${vs.sessions} | ${vs.sessions > 0 ? ((vs.successCount / vs.sessions) * 100).toFixed(0) : "0"}% | ${vs.sessions > 0 ? ((vs.partialCount / vs.sessions) * 100).toFixed(0) : "0"}% | ${vs.sessions > 0 ? ((vs.failureCount / vs.sessions) * 100).toFixed(0) : "0"}% | ${vs.avgToolsPerSession.toFixed(1)} | ${vs.nudgesSent} | ${vs.nudgesSuppressed} | ${(vs.avgErrorRate * 100).toFixed(0)}% |`,
    );
  }

  const control = v.get("control");
  const noNudges = v.get("no_nudges");
  if (control && noNudges && control.sessions >= 3 && noNudges.sessions >= 3) {
    const delta = (
      (noNudges.successCount / noNudges.sessions - control.successCount / control.sessions) *
      100
    ).toFixed(1);
    lines.push(
      "",
      `**Delta (no_nudges vs control): ${delta}% ${parseFloat(delta) > 0 ? "improvement" : "regression"}**`,
    );
  }

  return lines.join("\n");
}
