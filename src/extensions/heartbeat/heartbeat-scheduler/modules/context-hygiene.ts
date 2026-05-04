/**
 * Context Hygiene Module — proactive context management.
 *
 * Based on SimpleMem (2601.02553) and GenericAgent (2604.17091).
 * Monitors context density, token usage, and duplicate messages.
 * Emits density signals into the S-MMU lifecycle for policy evaluation.
 */

import type { CognitiveModule } from "../types.js";
import { createLogger } from "../../../../lib/logger.js";
import { getExtensionState } from "../../../../lib/extension-state.js";
import {
  generateDensitySignals,
  evaluatePolicies,
} from "../../../memory/context-lifecycle/policy-engine.js";

const log = createLogger("heartbeat:context-hygiene");

/** Replace {placeholder} in message with values from context dict. */
function interpolateMessage(message: string, ctx: Record<string, number | string>): string {
  let result = message;
  for (const [key, value] of Object.entries(ctx)) {
    result = result.replace(new RegExp(`{${key}(?:%|}|[a-zA-Z])`, "g"), String(value));
  }
  for (const [key, value] of Object.entries(ctx)) {
    result = result.replace(new RegExp(`{${key}}`, "g"), String(value));
  }
  return result;
}

export const contextHygieneModule: CognitiveModule = {
  name: "context-hygiene",
  description: "Proactive context management (SimpleMem 2601.02553, GenericAgent 2604.17091)",
  priority: 0.9,

  shouldActivate(context): boolean {
    const turns = context.turnCount;
    const threshold = turns < 30 ? 10 : 5;
    const last = context.lastActivation.get("context-hygiene") ?? 0;
    return turns - last >= threshold;
  },

  async activate(context): Promise<void> {
    const ctx = context.ctx;
    const { evaluateContextDensity } = await import("../../../../lib/context-density.js");
    const density = evaluateContextDensity(ctx);

    // Emit density signals into S-MMU lifecycle
    const signals = generateDensitySignals(ctx);

    try {
      for (const signal of signals) {
        const state = getExtensionState(ctx, "context-lifecycle", () => ({
          signalQueue: [] as any[],
        }));
        state.signalQueue.push(signal);
      }
      const proposals = evaluatePolicies(ctx, signals);
      for (const proposal of proposals) {
        if (proposal.action.type === "propose" && proposal.priority > 55) {
          const msg = interpolateMessage(proposal.action.message, {
            density: Math.round(density.density * 100),
            noise: density.noisyMessages,
            signal: density.signalMessages,
            ratio: Math.round(density.tokenRatio * 100),
            count: density.duplicates,
          });
          ctx.whisper?.(msg, { category: "cognitive", priority: "medium" });
        }
      }
    } catch {
      log.debug("Density policies not available, using direct whisper");
    }

    if (density.density < 0.4) {
      ctx.whisper?.(
        "Low context density (" +
          Math.round(density.density * 100) +
          "% signal). " +
          "Noisy: " + density.noisyMessages +
          ", Signal: " + density.signalMessages +
          ". " +
          "Consider: context_archive() or context_prune().",
        { category: "cognitive", priority: density.density < 0.25 ? "high" : "medium" },
      );
    } else if (density.tokenRatio > 0.6) {
      ctx.whisper?.(
        "High density (" +
          Math.round(density.density * 100) +
          "%) but large context (" +
          Math.round(density.tokenRatio * 100) +
          "% of limit). " +
          "Semantic compression could preserve meaning at 30% token cost (SimpleMem).",
        { category: "cognitive", priority: "low" },
      );
    }

    if (density.duplicates > 2) {
      ctx.whisper?.(
        density.duplicates +
          " near-duplicate messages in context. " +
          "Consider: context_prune() to remove redundant context.",
        { category: "cognitive", priority: "medium" },
      );
    }
  },
};
