/**
 * bpe-handler - Belief Policy Engine recommendation dispatch on turn_end.
 *
 * Reports previous recommendation outcome, gets next recommendation, sends
 * tracked message. The `lastRecommendationType` field lives on the
 * per-session tool-tracking state (was previously a module-level `let`).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sendTrackedMessage } from "../../../../lib/utils/injection-tracker.js";
import {
  getNextRecommendation,
  reportRecommendationOutcome,
} from "../../../../lib/reasoning/belief-policy-engine.js";
import { tryClaim } from "../../../../lib/enforcement/turn-dedup.js";
import { getState } from "../../state.js";

export function setLastRecommendationType(val: string | null): void {
  // No-op: kept for backward compatibility. The state is now
  // session-scoped via tool-tracking-state.lastRecommendationType.
  // Callers should mutate `getState(ctx).lastRecommendationType`
  // directly. This shim is a one-line pass-through to make
  // existing callers a no-op rather than a runtime error.
  void val;
}

export async function bpeHandler(
  pi: any,
  _event: any,
  ctx: ExtensionContext,
): Promise<string | null> {
  const gs = getState(ctx);
  if (!gs.enforcementActive) return null;

  if (gs.lastRecommendationType) {
    const madeProgress = gs.totalToolCalls > (gs.toolCallsAtLastRecommendation ?? 0);
    reportRecommendationOutcome(ctx, gs.lastRecommendationType, madeProgress);
  }

  const bpeRec = getNextRecommendation(ctx);
  if (bpeRec) {
    gs.lastRecommendationType = bpeRec.type;
    gs.toolCallsAtLastRecommendation = gs.totalToolCalls;
    // Dedup: if another advisory already fired this turn, suppress.
    if (!tryClaim("bpe", "advisory")) {
      return bpeRec.type;
    }
    sendTrackedMessage(
      pi,
      {
        customType: "context",
        display: true,
        content: [{ type: "text", text: `[policy] ${bpeRec.message}` }],
      },
      { deliverAs: "steer", triggerTurn: false },
      { type: "enforcement", source: "enforcement/policy" },
    );
    return bpeRec.type;
  }

  return null;
}
