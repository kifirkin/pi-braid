/**
 * drift-handler - Topic drift detection on turn_end.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionManager } from "../../../../lib/state/session-manager.js";
import { getCachedSessionManager } from "../../../../lib/state/extension-state.js";
import { sendTrackedMessage } from "../../../../lib/utils/injection-tracker.js";
import { emitSignal } from "../../../../lib/reasoning/belief-policy-engine.js";
import { tryClaim } from "../../../../lib/enforcement/turn-dedup.js";
import { getState } from "../../state.js";
import { setCriticCtx } from "../../../../lib/detection/topic-drift-detector.js";

function extractTextContent(msg: any): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c: any) => (c.type === "text" ? c.text : c.type === "toolCall" ? `tool:${c.name}` : ""))
      .join(" ");
  }
  return "";
}

export async function driftHandler(pi: any, _event: any, ctx: ExtensionContext): Promise<void> {
  const gs = getState(ctx);
  if (!gs.enforcementActive || !gs.driftDetector) return;

  // Provide ctx for triple-critic classify() calls
  setCriticCtx(ctx);

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

  const driftCheck = await gs.driftDetector.check();

  // The detector now reports classifierDown separately from the
  // "no drift detected" verdict. When the classifier is offline, we
  // still want to whisper so the agent knows the monitor is down -
  // not silently treat the absence of signal as "all good".
  if (driftCheck.drifted || driftCheck.classifierDown) {
    const whisper = gs.driftDetector.generateWhisper(driftCheck);
    if (whisper) {
      // Dedup: share the "advisory" slot with bpe/mars - first claim wins.
      if (!tryClaim("drift", "advisory")) {
        emitSignal(
          ctx,
          "topic-drift",
          driftCheck.classifierDown ? "classifier_down" : "detected",
          driftCheck.classifierDown ? "warn" : (driftCheck.severity === "strong" ? "warn" : "info"),
          false,
          { severity: driftCheck.severity, classifierDown: driftCheck.classifierDown ?? false },
        );
        return;
      }
      sendTrackedMessage(
        pi,
        {
          customType: "context",
          display: true,
          content: [{ type: "text", text: `[enforcement] ${whisper}` }],
        },
        { deliverAs: "steer", triggerTurn: false },
        { type: "enforcement", source: driftCheck.classifierDown ? "enforcement/drift/offline" : "enforcement/drift" },
      );
    }
    emitSignal(
      ctx,
      "topic-drift",
      driftCheck.classifierDown ? "classifier_down" : "detected",
      driftCheck.classifierDown ? "warn" : (driftCheck.severity === "strong" ? "warn" : "info"),
      false,
      { severity: driftCheck.severity, classifierDown: driftCheck.classifierDown ?? false },
    );
  }
}
