/**
 * Measurement Module — proactive degradation detection and reasoning quality measurement.
 *
 * Checks agent degradation status and surfaces metrics summaries.
 */

import type { CognitiveModule } from "../types.js";
import { createLogger } from "../../../../lib/logger.js";
import {
  isDegraded,
  getDegradationReasons,
  getMetricsSummary,
} from "../../../../lib/degradation-detector.js";

const log = createLogger("heartbeat:measurement");

export const measurementModule: CognitiveModule = {
  name: "measurement",
  description: "Proactive degradation detection and reasoning quality measurement",
  priority: 0.7,

  shouldActivate(context): boolean {
    const lastCheck = context.lastActivation.get("measurement") ?? 0;
    const turnsSinceCheck = context.turnCount - lastCheck;
    return turnsSinceCheck >= 10;
  },

  async activate(context): Promise<void> {
    const degraded = isDegraded(context.ctx);
    if (degraded) {
      const reasons = getDegradationReasons(context.ctx);
      log.warn(`Degradation detected: ${reasons.join(", ")}`);
      context.ctx.whisper?.(
        `Degradation detected: ${reasons.join(", ")}. Consider: context audit, session recall, or wrapping up.`,
        { category: "cognitive", priority: "medium" },
      );
    }

    const summary = getMetricsSummary(context.ctx);
    if (summary.totalTurns > 0) {
      log.info(
        `Metrics: ${summary.totalTurns} turns, error rate: ${(summary.avgErrorRate * 100).toFixed(0)}%, ` +
          `tool success: ${(summary.avgToolSuccess * 100).toFixed(0)}%, degraded: ${summary.degraded}`,
      );
    }
  },
};
