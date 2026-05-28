// ── Navigation Handler ────────────────────────────────────────────────────────
// Handles session_before_tree, turn_end checkout, and agent_end retry.

import type { ExtensionContext, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { analyzeSession } from "../analysis.js";
import { log, getCmState, overflowRetryState, resetOverflowRetry } from "./shared.js";
import { sendTrackedMessage } from "../../../../lib/injection-tracker.js";
import { getSessionManager } from "../../../../lib/state/session-manager.js";

// ── Session Before Tree ───────────────────────────────────────────────────────
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

// ── Turn End Checkout ─────────────────────────────────────────────────────────
export function registerTurnEndCheckoutHandler(pi: ExtensionAPI): void {
  pi.on("turn_end", async (_event: any, ctx: ExtensionContext) => {
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
          { deliverAs: "steer", triggerTurn: false },
          { type: "context", source: "context-manager/navigation" },
        );
        state.checkoutParams = null;
      }
    } catch (err) {
      log.error("turn_end checkout error:", err);
    }
  });
}

// ── Agent End Retry Handling ──────────────────────────────────────────────────
export function registerAgentEndRetryHandler(pi: ExtensionAPI): void {
  pi.on("agent_end", async (_event: any, _ctx: ExtensionContext) => {
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
