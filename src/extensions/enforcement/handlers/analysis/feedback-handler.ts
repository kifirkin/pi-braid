/**
 * feedback-handler — Belief inference + advice evaluation on turn_end.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { inferBeliefs } from "../../../../lib/belief-policy-engine.js";
import { evaluatePendingAdvice } from "../../../../lib/advice-tracker.js";
import { getState } from "../../state.js";

export async function feedbackHandler(
  _pi: any,
  _event: any,
  ctx: ExtensionContext,
): Promise<void> {
  const gs = getState(ctx);
  if (!gs.enforcementActive) return;

  inferBeliefs(ctx);

  evaluatePendingAdvice({
    currentTurn: gs.currentTurn,
    consecutiveErrorTurns: gs.consecutiveErrorTurns,
    toolLog: gs.toolLog,
    uniqueToolsCount: gs.uniqueToolsUsed.size,
  });
}
