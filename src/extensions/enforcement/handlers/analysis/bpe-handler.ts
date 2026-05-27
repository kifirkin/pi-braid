/**
 * bpe-handler — Belief Policy Engine recommendation dispatch on turn_end.
 *
 * Reports previous recommendation outcome, gets next recommendation, sends
 * tracked message. Shared _lastRecommendationType state is module-level here
 * (only the BPE handlers read/write it).
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { sendTrackedMessage } from "../../../../lib/injection-tracker.js";
import {
  getNextRecommendation,
  reportRecommendationOutcome,
} from "../../../../lib/belief-policy-engine.js";
import { getState } from "../../state.js";

let _lastRecommendationType: string | null = null;

export function getLastRecommendationType(): string | null {
  return _lastRecommendationType;
}

export function setLastRecommendationType(val: string | null): void {
  _lastRecommendationType = val;
}

export async function bpeHandler(
  pi: any,
  _event: any,
  ctx: ExtensionContext,
): Promise<string | null> {
  const gs = getState(ctx);
  if (!gs.enforcementActive) return null;

  if (_lastRecommendationType) {
    const madeProgress = gs.totalToolCalls > (gs.toolCallsAtLastRecommendation ?? 0);
    reportRecommendationOutcome(ctx, _lastRecommendationType, madeProgress);
  }

  const bpeRec = getNextRecommendation(ctx);
  if (bpeRec) {
    _lastRecommendationType = bpeRec.type;
    gs.toolCallsAtLastRecommendation = gs.totalToolCalls;
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
