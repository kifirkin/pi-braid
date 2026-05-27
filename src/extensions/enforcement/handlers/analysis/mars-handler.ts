/**
 * mars-handler — MARS overuse reflection advice dispatch on turn_end.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { sendTrackedMessage } from "../../../../lib/injection-tracker.js";
import { emitSignal } from "../../../../lib/belief-policy-engine.js";
import { shouldAdvise } from "../../../../lib/mars-reflector.js";
import { recordAdvice } from "../../../../lib/advice-tracker.js";
import { getState } from "../../state.js";

function _extractToolFromMarsMessage(msg: string): string | undefined {
  const match = msg.match(/\[mars\]\s+(\w+)/);
  return match?.[1];
}

export async function marsHandler(
  pi: any,
  _event: any,
  ctx: ExtensionContext,
): Promise<void> {
  const gs = getState(ctx);
  if (!gs.enforcementActive) return;

  const marsAdvice = shouldAdvise(ctx);
  if (!marsAdvice) return;

  const signalType: any =
    marsAdvice.type === "tool_overuse"
      ? "tool-use"
      : marsAdvice.type === "error_recurrence"
        ? "error"
        : marsAdvice.type === "confidence_decline"
          ? "reasoning"
          : "stability";
  const signalValue =
    marsAdvice.type === "tool_overuse"
      ? "overuse"
      : marsAdvice.type === "error_recurrence"
        ? "recurrence"
        : "decline";
  emitSignal(ctx, signalType, signalValue, marsAdvice.severity, false, {
    type: marsAdvice.type,
    message: marsAdvice.message.slice(0, 200),
  });
  sendTrackedMessage(
    pi,
    {
      customType: "context",
      display: true,
      content: [{ type: "text", text: `[enforcement] ${marsAdvice.message}` }],
    },
    { deliverAs: "steer", triggerTurn: false },
    { type: "enforcement", source: "enforcement/mars" },
  );
  const marsTool = _extractToolFromMarsMessage(marsAdvice.message);
  recordAdvice("mars", marsAdvice.type, gs.currentTurn, marsTool);
}
