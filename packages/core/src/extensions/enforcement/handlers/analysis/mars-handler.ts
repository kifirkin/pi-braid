/**
 * mars-handler - MARS reflection dispatch on turn_end.
 *
 * Two responsibilities:
 *   1. Tool-overuse detection (tool-usage-analyzer)
 *   2. Task-completion reflection (MARS principle+procedure reflection)
 *
 * Task-completion reflection fires when:
 *   - finalize is called in the current turn (explicit task completion)
 *   - Significant work was done (5+ tool calls, 3+ turns) without finalize
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sendTrackedMessage } from "../../../../lib/utils/injection-tracker.js";
import { emitSignal } from "../../../../lib/reasoning/belief-policy-engine.js";
import { shouldAdvise } from "../../../../lib/reasoning/tool-usage-analyzer.js";
import {
  reflectOnTaskCompletion,
  type SessionSnapshot,
} from "../../../cognitive/mars-reflector/index.js";
import { recordAdvice } from "../../../../lib/reasoning/advice-tracker.js";
import { tryClaim } from "../../../../lib/enforcement/turn-dedup.js";
import { getState } from "../../state.js";
import { createLogger } from "../../../../lib/core/logger.js";

const log = createLogger("enforcement:mars");

function _extractToolFromMarsMessage(msg: string): string | undefined {
  const match = msg.match(/\[mars\]\s+(\w+)/);
  return match?.[1];
}

/**
 * Build a SessionSnapshot from the current enforcement state and event data.
 */
function buildSessionSnapshot(ctx: ExtensionContext, event: any): SessionSnapshot {
  const gs = getState(ctx);

  const actualTools: string[] = (event.toolResults || [])
    .map((r: any) => r.toolName)
    .filter((name: string) => name && name.trim().length > 0);

  const toolLog = gs.toolLog || [];
  const thinkCalls = toolLog.filter((t: string) => t === "think").length;
  const scratchpadCalls = toolLog.filter((t: string) => t === "scratchpad").length;
  const verifyCalls = toolLog.filter((t: string) => ["verify", "verify_claim"].includes(t)).length;
  const editCalls = toolLog.filter((t: string) => t === "edit").length;
  const writeCalls = toolLog.filter((t: string) => t === "write").length;
  const finalizeCalled = actualTools.includes("finalize");

  return {
    toolsUsed: toolLog,
    uniqueToolCount: new Set(toolLog).size,
    totalToolCalls: toolLog.length,
    errorCount: gs.consecutiveErrorTurns || 0,
    thinkCalls,
    scratchpadCalls,
    verifyCalls,
    editCalls,
    writeCalls,
    finalizeCalled,
    turnCount: gs.currentTurn || 0,
  };
}

export async function marsHandler(pi: any, event: any, ctx: ExtensionContext): Promise<void> {
  const gs = getState(ctx);
  if (!gs.enforcementActive) return;

  // Part 1: tool-overuse detection (tool-usage-analyzer)
  const marsAdvice = shouldAdvise(ctx);
  if (marsAdvice) {
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
    // Dedup: share the "advisory" slot with bpe/drift - first claim wins.
    if (tryClaim("mars", "advisory")) {
      sendTrackedMessage(
        pi,
        {
          customType: "context",
          display: true,
          content: [{ type: "text", text: marsAdvice.message }],
        },
        { delivery: "live", deliverAs: "steer" },
        { type: "enforcement", source: "enforcement/mars" },
      );
      const marsTool = _extractToolFromMarsMessage(marsAdvice.message);
      recordAdvice("mars", marsAdvice.type, gs.currentTurn, marsTool);
    }
  }

  // Part 2: task-completion reflection (MARS)
  const session = buildSessionSnapshot(ctx, event);

  const shouldReflect =
    session.finalizeCalled ||
    (session.totalToolCalls >= 5 && session.turnCount >= 3 && session.turnCount % 10 === 0); // Also reflect every 10 turns as a checkpoint

  if (!shouldReflect) return;

  const reflections = reflectOnTaskCompletion(ctx, session);
  if (reflections.length > 0) {
    log.info(`MARS reflection: ${reflections.length} reflections produced`);
  }
}
