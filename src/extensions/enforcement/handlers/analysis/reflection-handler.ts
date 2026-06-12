/**
 * reflection-handler - Reflection gap detection on turn_end.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emitSignal } from "../../../../lib/reasoning/belief-policy-engine.js";
import { getState } from "../../state.js";

export async function reflectionHandler(
  _pi: any,
  _event: any,
  ctx: ExtensionContext,
): Promise<void> {
  const gs = getState(ctx);
  if (!gs.enforcementActive) return;

  if (gs.toolsSinceReflection >= 8) {
    emitSignal(ctx, "reflection", "absent", "info", false, {
      toolsSince: gs.toolsSinceReflection,
    });
  }
}
