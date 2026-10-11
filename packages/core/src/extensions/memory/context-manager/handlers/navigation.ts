// Navigation handler: session_before_tree, turn_end checkout, agent_end retry.

import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { analyzeSession } from "../analysis.js";
import { log, getCmState, overflowRetryState, resetOverflowRetry } from "./shared.js";
import { sendTrackedMessage } from "../../../../lib/utils/injection-tracker.js";
import { getSessionManager } from "../../../../lib/state/session-manager.js";
import { TURN_END, AGENT_END } from "../../../../lib/core/event-names.js";

export function registerBeforeTreeHandler(pi: ExtensionAPI): void {
  pi.on("session_before_tree", async (event: any, ctx: ExtensionContext) => {
    try {
      const audit = analyzeSession(ctx);
      const preparation = event.preparation;

      const prep = preparation as { summaryEntry?: unknown; targetId?: string };
      if (!prep.summaryEntry && prep.targetId) {
        const sm = getSessionManager(ctx);
        const branch = sm.getBranch();
        const targetIndex = branch.findIndex((e) => e.id === prep.targetId);

        let nearestTag = "checkpoint";
        if (targetIndex >= 0) {
          for (let i = targetIndex; i >= 0; i--) {
            const label = sm.getLabel(branch[i].id);
            if (label) {
              nearestTag = label;
              break;
            }
          }
        }

        return {
          summary: {
            summary: `[Branch from ${nearestTag}] Session state before branching.`,
            details: {
              contextPercent: audit.usage.percent.toFixed(0),
              branchLength: audit.branchLength,
              checkpoint: nearestTag,
            },
          },
        };
      }
    } catch (err) {
      log.error("session_before_tree error:", err);
    }
  });
}

export function registerTurnEndCheckoutHandler(pi: ExtensionAPI): void {
  pi.on(TURN_END, async (_event: any, ctx: ExtensionContext) => {
    try {
      const state = getCmState(ctx);
      if (state.checkoutParams) {
        sendTrackedMessage(
          pi,
          {
            customType: "context",
            content: [
              {
                type: "text" as const,
                text: `**Context checkout prepared.** Run \`context_checkout(target="${state.checkoutParams.target}")\` when ready.`,
              },
            ],
            display: true,
          },
          // triggerTurn: true - direct action instruction ("Run context_checkout").
          // Wakes the agent so it can execute the prepared checkout instead of
          // waiting for user input.
          { deliverAs: "steer", triggerTurn: true },
          { type: "context", source: "context-manager/navigation" },
        );
        state.checkoutParams = null;
      }
    } catch (err) {
      log.error("turn_end checkout error:", err);
    }
  });
}

export function registerAgentEndRetryHandler(pi: ExtensionAPI): void {
  pi.on(AGENT_END, async (_event: any, _ctx: ExtensionContext) => {
    try {
      // Clean up overflow retry state if agent ends during retry
      if (overflowRetryState.retryTimeout) {
        clearTimeout(overflowRetryState.retryTimeout);
        overflowRetryState.retryTimeout = null;
      }
      resetOverflowRetry();
    } catch (err) {
      log.error("agent_end retry cleanup error:", err);
    }
  });
}
