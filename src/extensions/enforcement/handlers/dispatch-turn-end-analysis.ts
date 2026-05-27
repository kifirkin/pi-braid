/**
 * dispatch-turn-end-analysis — Drift detection, BPE, MARS, dreamer, reflection gap.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SessionEntry, SessionManager } from "../../../lib/session-manager.js";
import { getCachedSessionManager } from "../../../lib/extension-state.js";
import { sendTrackedMessage } from "../../../lib/injection-tracker.js";
import {
  emitSignal,
  getNextRecommendation,
  reportRecommendationOutcome,
  inferBeliefs,
} from "../../../lib/belief-policy-engine.js";
import { recordAdvice, evaluatePendingAdvice } from "../../../lib/advice-tracker.js";
import { shouldAdvise } from "../../../lib/mars-reflector.js";
import { dream } from "../../../lib/dreamer.js";
import { getState } from "../state.js";

export async function dispatchTurnEndAnalysis(
  pi: any,
  _event: any,
  ctx: ExtensionContext,
  prevRecType: string | null = null,
): Promise<string | null> {
  const gs = getState(ctx);
  if (!gs.enforcementActive || !gs.driftDetector) return null;

  const sm = getCachedSessionManager(ctx) as SessionManager | undefined;
  const entries: SessionEntry[] = sm?.getBranch?.() ?? [];
  const recentMsgs: Array<{ role?: string; content?: unknown }> = [];
  for (let i = entries.length - 1; i >= 0 && recentMsgs.length < 4; i--) {
    const entry = entries[i];
    if (entry.type === "message" && entry.message) {
      recentMsgs.unshift({ role: entry.message.role, content: entry.message.content });
    }
  }
  for (let i = recentMsgs.length - 1; i >= 0; i--) {
    const msg = recentMsgs[i];
    const text = extractTextContent(msg);
    if (msg?.role === "user" && text.length > 10) {
      gs.driftDetector.addTurn(text);
      break;
    }
  }
  const driftCheck = gs.driftDetector.check();
  if (driftCheck.drifted) {
    const whisper = gs.driftDetector.generateWhisper(driftCheck);
    if (whisper) {
      sendTrackedMessage(
        pi,
        {
          customType: "context",
          display: true,
          content: [{ type: "text", text: `[enforcement] ${whisper}` }],
        },
        { deliverAs: "steer", triggerTurn: false },
        { type: "enforcement", source: "enforcement/drift" },
      );
    }
    emitSignal(
      ctx,
      "topic-drift",
      "detected",
      driftCheck.severity === "strong" ? "warn" : "info",
      false,
      { severity: driftCheck.severity },
    );
  }

  if (prevRecType) {
    const madeProgress = gs.totalToolCalls > (gs.toolCallsAtLastRecommendation ?? 0);
    reportRecommendationOutcome(ctx, prevRecType, madeProgress);
  }

  let bpeRecType: string | null = null;
  const bpeRec = getNextRecommendation(ctx);
  if (bpeRec) {
    bpeRecType = bpeRec.type;
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
  }

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

  const dreamAdvice = dream(ctx, gs.toolLog);
  if (dreamAdvice) {
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

  inferBeliefs(ctx);

  evaluatePendingAdvice({
    currentTurn: gs.currentTurn,
    consecutiveErrorTurns: gs.consecutiveErrorTurns,
    toolLog: gs.toolLog,
    uniqueToolsCount: gs.uniqueToolsUsed.size,
  });

  if (gs.toolsSinceReflection >= 8) {
    emitSignal(ctx, "reflection", "absent", "info", false, {
      toolsSince: gs.toolsSinceReflection,
    });
  }

  return bpeRecType;
}

function extractTextContent(msg: any): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c: any) => (c.type === "text" ? c.text : c.type === "toolCall" ? `tool:${c.name}` : ""))
      .join(" ");
  }
  return "";
}

function _extractToolFromMarsMessage(msg: string): string | undefined {
  const match = msg.match(/\[mars\]\s+(\w+)/);
  return match?.[1];
}
