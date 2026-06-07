/**
 * register-session-compact — Hygiene reset after context compaction.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onEvent } from "../../../lib/events/event-types.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { getState } from "../state.js";
import { enforcementSignals, determineContrastMode } from "../signals.js";
import { createLogger } from "../../../lib/core/logger.js";

const log = createLogger("enforcement:session-compact");

export function registerSessionCompactHandler(pi: ExtensionAPI): void {
  onEvent(pi, "session_compact", async (event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) return;

    const compactTurn = getState(ctx).currentTurn;

    // Cancel any stale resume timer from a previous compaction cycle.
    // The compaction-resume and auto-compaction-resume tags are scheduled by
    // the context_compress tool and the context-lifecycle auto-compact path
    // respectively. They were never cancelled when a new compaction began,
    // which produced a misplaced [timer] whisper during the next TURN_END.
    try {
      const { cancelTimersByTag } = await import("../../tools/timer/index.js");
      const cancelled = cancelTimersByTag("compaction-resume") + cancelTimersByTag("auto-compaction-resume");
      if (cancelled > 0) {
        log.debug(`Cancelled ${cancelled} stale compaction resume timer(s)`);
      }
    } catch {
      // Non-fatal — timer module unavailable
    }

    try {
      const scratchpadResult = await (
        ctx as unknown as { tools?: { scratchpad?(params: { action: string }): Promise<unknown> } }
      ).tools?.scratchpad?.({ action: "read" });
      const details = (
        scratchpadResult as
          | { details?: { key_learnings?: Array<{ persisted?: boolean }> } }
          | undefined
      )?.details;
      const learnings = details?.key_learnings ?? [];
      const unpersisted = learnings.filter((l) => !l.persisted);

      if (unpersisted.length > 0) {
        sendEnforcementWhisper(
          pi,
          ctx,
          `Context compacted at turn ${compactTurn}. ` +
            `${unpersisted.length} key learning(s) not yet persisted:\n\n` +
            unpersisted
              .map(
                (l: any) =>
                  `- memory_store(content="${l.content}", memoryType="insight", tags=["${l.category}", "session"])`,
              )
              .join("\n") +
            `\n\nPersist them now.`,
        );
        enforcementSignals["unpersisted_learnings"] = {
          turn: getState(ctx).currentTurn,
          text: `${unpersisted.length} key learning(s) not yet persisted`,
          acted: false,
        };
        pi.events.emit("enforcement_signals", {
          contrastMode: determineContrastMode(ctx),
        });
      }

      // Always send re-orientation whisper after compaction so the agent
      // knows to recover context from persisted surfaces (scratchpad, task tool).
      // This is the "prompt invariant" in action — the scratchpad survives
      // compaction because it's tool-backed, not conversation-backed.
      sendEnforcementWhisper(
        pi,
        ctx,
        `Context compacted at turn ${compactTurn}. ` +
          `Re-orient: read scratchpad for goal/plan/learnings, then check next pending task. ` +
          `These surfaces survive compaction — continue from there.`,
      );

      getState(ctx).contextNudgeSent = false;
      getState(ctx).lastContextCheckTurn = getState(ctx).currentTurn;
      getState(ctx).lastCompactionTurn = compactTurn;
      getState(ctx).lastScratchpadNudgeTurn = getState(ctx).currentTurn;
      getState(ctx).overflowRecently = getState(ctx).currentTurn;
      getState(ctx).hasCodeChanges = false;
      getState(ctx).lastCodeChangeTurn = 0;
      getState(ctx).memoryNudgeSent = false;
      getState(ctx).turnsSinceMemory = 0;
    } catch {
      log.debug("session_compact handler: enforcement state access failed (stale ctx?)");
    }
  });
}
