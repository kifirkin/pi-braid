/**
 * dreamer-handler — Dreamer prediction advice dispatch on turn_end.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sendTrackedMessage } from "../../../../lib/utils/injection-tracker.js";
import { emitSignal } from "../../../../lib/reasoning/belief-policy-engine.js";
import { dream } from "../../../../lib/reasoning/dreamer.js";
import { recordAdvice } from "../../../../lib/reasoning/advice-tracker.js";
import { getState } from "../../state.js";

export async function dreamerHandler(pi: any, _event: any, ctx: ExtensionContext): Promise<void> {
  const gs = getState(ctx);
  if (!gs.enforcementActive) return;

  // Build historical sequences from per-turn tool data for Markov transitions
  const historicalSequences: string[][] = [];
  for (const [, turn] of gs.turnHistory) {
    if (turn.actualTools.length > 0) {
      historicalSequences.push(turn.actualTools);
    }
  }

  const dreamAdvice = dream(ctx, gs.toolLog, historicalSequences);
  if (!dreamAdvice) return;

  emitSignal(ctx, "stability", "predicted-decline", "info", false, {
    source: "dreamer",
    message: dreamAdvice.message.slice(0, 200),
  });
  sendTrackedMessage(
    pi,
    {
      customType: "context",
      display: true,
      content: [{ type: "text", text: `[enforcement] ${dreamAdvice.message}` }],
    },
    { deliverAs: "steer", triggerTurn: false },
    { type: "enforcement", source: "enforcement/dreamer" },
  );
  recordAdvice("dreamer", dreamAdvice.prediction || "unknown", gs.currentTurn);
}
