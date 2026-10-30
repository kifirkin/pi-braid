/**
 * dreamer-handler - Dreamer prediction advice dispatch on turn_end.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../../lib/core/logger.js";
import { sendTrackedMessage } from "../../../../lib/utils/injection-tracker.js";
import { emitSignal } from "../../../../lib/reasoning/belief-policy-engine.js";
import { dream } from "../../../../lib/reasoning/dreamer.js";
import { recordAdvice } from "../../../../lib/reasoning/advice-tracker.js";
import { tryClaim } from "../../../../lib/enforcement/turn-dedup.js";
import { getToolLoopState } from "../../../../lib/detection/tool-loop-detector.js";
import { getState } from "../../state.js";

const log = createLogger("enforcement:dreamer");

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

  // The loop path reads the detector's own recorded calls (tool + argument
  // identity); gs.toolLog is names only and cannot distinguish one call
  // repeated from many different calls under one name.
  const dreamAdvice = dream(ctx, gs.toolLog, historicalSequences, getToolLoopState(ctx).history);
  if (!dreamAdvice) return;

  emitSignal(ctx, "stability", "predicted-decline", "info", false, {
    source: "dreamer",
    message: dreamAdvice.message.slice(0, 200),
  });

  // Fold the loop-detector path: the dreamer's 4th, still-live loop whisper
  // (its path 1, dream.ts) returns the SAME unified "Tool loop detected"
  // message as the enforcement detector (detectToolLoopFromSequence). It only
  // escapes double-delivery today because the enforcement loop fires first
  // (priority 90) with an identical body and the 20-min reprime window
  // suppresses the dreamer's twin — timing luck, not structure. Fold it: the
  // BPE/MARS observation signal above and recordAdvice accuracy tracking stay;
  // the whisper does NOT deliver. Per-episode single delivery is the surviving
  // detector's job. This is deliberately NOT the Markov paths ("Likely to get
  // stuck in X->Y", "Historical pattern suggests failure path") — those are
  // predictive stuck/failure-risk signals, not same-tool repetition, and they
  // keep delivering below.
  const isLoopDetectorPath =
    dreamAdvice.prediction === "stuck" && dreamAdvice.message.includes("Tool loop detected");
  if (isLoopDetectorPath) {
    recordAdvice("dreamer", dreamAdvice.prediction || "unknown", gs.currentTurn);
    log.debug(
      `[dreamer] Tool-loop whisper folded into enforcement tool-loop detector: ${dreamAdvice.message.slice(0, 80)}`,
    );
    return;
  }

  // Dedup: turn-outcome is the critical loop detector. If it already
  // claimed the "loop" category for this turn, the dreamer's advisory
  // adds no new information and is suppressed.
  if (!tryClaim("dreamer", "loop")) return;
  sendTrackedMessage(
    pi,
    {
      customType: "context",
      display: true,
      content: [{ type: "text", text: dreamAdvice.message }],
    },
    { delivery: "live", deliverAs: "steer" },
    { type: "enforcement", source: "enforcement/dreamer" },
  );
  recordAdvice("dreamer", dreamAdvice.prediction || "unknown", gs.currentTurn);
}
