/**
 * Budget Tracker Module — Budget-Aware Value Tree Search (BAVT).
 *
 * Tracks plan step budgets and warns at 80/90/100% thresholds.
 * Budgets are set via `[budget:N]` in plan steps.
 * Based on: 2604.13408 "Budget-Aware Value Estimation in LLM Agent Tree Search"
 */

import type { CognitiveModule } from "../types.js";
import { createLogger } from "../../../../lib/logger.js";

const log = createLogger("heartbeat:budget-tracker");

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

      const currentTotalCalls = context.totalToolCalls;

      for (const step of pad.plan) {
        if (step.doneTurn > 0) continue;
        if (!step.budgetCalls || step.budgetCalls <= 0) continue;

        if (step.startTotalCalls === 0 && step.startTurn < pad.session.turn) {
          step.startTotalCalls = currentTotalCalls;
        }

        const spent = Math.max(0, currentTotalCalls - step.startTotalCalls);
        step.spentCalls = spent;
        const budget = step.budgetCalls;
        const ratio = budget > 0 ? spent / budget : 0;

        if (ratio >= 1.0) {
          emitSignal(context.ctx, "tool-use", "overuse", "warn", false, {
            reason: "budget-exceeded",
            step: step.text.slice(0, 60),
            spent,
            budget,
          });
          context.ctx.whisper?.(
            `[budget] Step "${step.text.slice(0, 50)}" exceeded budget: ${spent}/${budget} calls. Consider simplifying or marking done.`,
            { category: "cognitive", priority: "medium" },
          );
        } else if (ratio >= 0.9) {
          context.ctx.whisper?.(
            `[budget] Step "${step.text.slice(0, 50)}" at ${(ratio * 100).toFixed(0)}% budget: ${spent}/${budget} calls. Consider wrapping up.`,
            { category: "cognitive", priority: "low" },
          );
        } else if (ratio >= 0.8) {
          context.ctx.whisper?.(
            `[budget] Step "${step.text.slice(0, 50)}" at 80% budget: ${spent}/${budget} calls.`,
            { category: "cognitive", priority: "low" },
          );
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
