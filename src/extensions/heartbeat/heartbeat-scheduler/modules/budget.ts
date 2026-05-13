/**
 * Budget Tracker Module — Budget-Aware Value Tree Search (BAVT).
 *
 * Tracks plan step budgets and warns at 80/90/100% thresholds.
 * Budgets are set via `[budget:N]` in plan steps.
 * Based on: 2604.13408 "Budget-Aware Value Estimation in LLM Agent Tree Search"
 *
 * Rate-limiting: per-step per-threshold cooldown — each threshold fires
 * at most once per threshold crossing. Clearing when ratio drops below.
 */

import type { CognitiveModule } from "../types.js";
import { createLogger } from "../../../../lib/logger.js";
import { getExtensionState } from "../../../../lib/extension-state.js";

const log = createLogger("heartbeat:budget-tracker");

interface BudgetTrackerState {
  /** Set of "stepIndex:threshold" keys that have already fired. */
  firedThresholds: Set<string>;
}

export const budgetModule: CognitiveModule = {
  name: "budget-tracker",
  description: "Track plan step budgets and warn at 80/90/100% thresholds (BAVT)",
  priority: 0.85,

  shouldActivate(): boolean {
    return true;
  },

  async activate(context): Promise<void> {
    try {
      const { loadScratchpadFromDisk, saveScratchpadToDisk } =
        await import("../../../core/scratchpad/index.js");
      const { emitSignal } = await import("../../../../lib/belief-policy-engine.js");

      const cwd = (context.ctx as any).cwd ?? "";
      const segments = cwd.split("/").filter(Boolean);
      const slug = "--" + segments.join("-") + "--";

      const pad = await loadScratchpadFromDisk(slug);
      if (!pad || pad.plan.length === 0) return;

      const state = getExtensionState(context.ctx, "budget-tracker", () => ({
        firedThresholds: new Set<string>(),
      }));

      const currentTotalCalls = context.totalToolCalls;

      for (let stepIdx = 0; stepIdx < pad.plan.length; stepIdx++) {
        const step = pad.plan[stepIdx];
        if (step.doneTurn > 0) continue;
        if (!step.budgetCalls || step.budgetCalls <= 0) continue;

        if (step.startTotalCalls === 0 && step.startTurn < pad.session.turn) {
          step.startTotalCalls = currentTotalCalls;
        }

        const spent = Math.max(0, currentTotalCalls - step.startTotalCalls);
        step.spentCalls = spent;
        const budget = step.budgetCalls;
        const ratio = budget > 0 ? spent / budget : 0;

        // Define thresholds in descending order (highest first)
        const thresholds: Array<{ pct: number; priority: string; msg: string }> = [
          {
            pct: 100,
            priority: "medium",
            msg: `[budget] Step "${step.text.slice(0, 50)}" exceeded budget: ${spent}/${budget} calls. Consider simplifying or marking done.`,
          },
          {
            pct: 90,
            priority: "low",
            msg: `[budget] Step "${step.text.slice(0, 50)}" at ${(ratio * 100).toFixed(0)}% budget: ${spent}/${budget} calls. Consider wrapping up.`,
          },
          {
            pct: 80,
            priority: "low",
            msg: `[budget] Step "${step.text.slice(0, 50)}" at 80% budget: ${spent}/${budget} calls.`,
          },
        ];

        for (const threshold of thresholds) {
          const key = `${stepIdx}:${threshold.pct}`;

          if (ratio >= threshold.pct / 100) {
            // Threshold crossed — only fire once per crossing
            if (!state.firedThresholds.has(key)) {
              state.firedThresholds.add(key);

              if (threshold.pct >= 100) {
                emitSignal(context.ctx, "tool-use", "overuse", "warn", false, {
                  reason: "budget-exceeded",
                  step: step.text.slice(0, 60),
                  spent,
                  budget,
                });
              }

              context.ctx.whisper?.(threshold.msg, {
                category: "cognitive",
                priority: threshold.priority as "low" | "medium",
              });
            }
          } else {
            // Ratio dropped below threshold — clear fired flag so it can re-fire
            state.firedThresholds.delete(key);
          }
        }
      }

      try {
        await saveScratchpadToDisk(pad);
      } catch {
        // Silent ignore
      }
    } catch (err) {
      log.debug(`budget-tracker: ${err}`);
    }
  },
};
