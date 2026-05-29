/**
 * Enforcement Whisper — direct message delivery.
 *
 * REMOVED: queueEnforcementWhisper / queueBlockAction / getPendingBlockAction /
 * clearPendingBlockAction — all dead code. queueEnforcementWhisper accumulated
 * messages in a process-global _default object that was never flushed.
 * queueBlockAction had zero callers. Callers now use sendEnforcementWhisper
 * directly.
 *
 * See git tag before-fixes for the removed code.
 */

import { createLogger } from "../../lib/core/logger.js";
import { eventBus } from "../../lib/events/event-bus.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sendTrackedMessage } from "../../lib/utils/injection-tracker.js";
import { recordNudgeSent } from "../../lib/reasoning/nudge-analytics.js";
import { areCognitiveNudgesDisabled } from "../../lib/config/braid-settings.js";

const log = createLogger("enforcement");

/**
 * Send an enforcement whisper immediately using sendTrackedMessage().
 *
 * Whisper types:
 * - followUp: advisory signals, tool misuse, memory suggestions
 *             visible in TUI, no forced turn (non-critical)
 * - steer:    critical signals (blocks, error bursts, overflow)
 *             triggerTurn: true ensures agent processes immediately
 *
 * Nudges are suppressed when braid.suppressNudges=true in settings.json.
 */
export function sendEnforcementWhisper(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  message: string,
  critical: boolean = false,
): void {
  // Cognitive nudge suppression — separate from confirm dialogs
  if (areCognitiveNudgesDisabled()) {
    log.debug("[whisper] Cognitive nudges suppressed via braid.suppressNudges=true");
    return;
  }

  // Track nudge sent for A/B variant analytics (BR3)
  try {
    recordNudgeSent(ctx);
  } catch (err) {
    log.warn("Failed to record nudge sent:", err);
  }

  // Emit via event bus
  try {
    eventBus.emit({
      type: "enforcement_violation",
      rule: "enforcement",
      description: message,
      severity: critical ? "high" : "medium",
    });
  } catch (err) {
    log.warn("Failed to emit enforcement event:", err);
  }

  // Tag all enforcement whispers with customType="enforcement" so the agent
  // knows these are system-generated signals, not human messages.
  // The content intentionally has no [enforcement] prefix — customType metadata
  // is sufficient. The prefix was removed in Phase 2.4.
  sendTrackedMessage(
    pi,
    {
      customType: "enforcement",
      content: [{ type: "text" as const, text: `[enforcement] ${message}` }],
      display: true,
    },
    critical
      ? { deliverAs: "steer", triggerTurn: true }
      : { deliverAs: "steer", triggerTurn: false },
    { type: "enforcement", source: "enforcement/whisper" },
  );
}
