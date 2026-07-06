/**
 * Enforcement Whisper - direct message delivery.
 *
 * REMOVED: queueEnforcementWhisper / queueBlockAction / getPendingBlockAction /
 * clearPendingBlockAction - all dead code. queueEnforcementWhisper accumulated
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
 * BUGFIX 2026-07-06: Decoupled `critical` (event emission) from
 *   `triggerTurn` (turn creation). Previously `critical=true` always
 *   set `triggerTurn: true`, which caused pi-core to start a new LD
 *   turn for tool-loop and error-burst whispers. When the cascade
 *   continued, each enforcement whisper created a new turn, inflating
 *   the turn count and flooding the session. Now tool-loop whispers
 *   emit the violation event but pass `{ triggerTurn: false }` so
 *   they don't force a new turn. Error-bursts still default to
 *   triggerTurn:true since they genuinely need immediate response.
 *
 * Parameters:
 *   critical     - If true, emits an `enforcement_violation` event
 *                  so MARS/analytics/auto-recovery can react.
 *   options.triggerTurn - Explicit override. When set, controls
 *                  whether pi.sendMessage starts a new turn. When
 *                  omitted (undefined), defaults to `critical`
 *                  (true → triggerTurn:true, false → triggerTurn:false)
 *                  for backward compatibility.
 *
 * Nudges are suppressed when braid.suppressNudges=true in settings.json.
 */
export function sendEnforcementWhisper(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  message: string,
  critical: boolean = false,
  options?: { triggerTurn?: boolean },
): void {
  // Cognitive nudge suppression - separate from confirm dialogs
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

  // Emit via event bus. ROADMAP P0-6 / EW-7.1: only emit as a violation
  // when actually critical. Advisory nudges were propagating as `tool_error`
  // events (via register-session-start), which then triggered MARS
  // error-recurrence and auto-recovery on the next turn -- amplifying a
  // benign advisory into an error burst.
  if (critical) {
    try {
      eventBus.emit({
        type: "enforcement_violation",
        rule: "enforcement",
        description: message,
        severity: "high",
      });
    } catch (err) {
      log.warn("Failed to emit enforcement event:", err);
    }
  }

  // Tag all enforcement whispers with customType="enforcement" so the agent
  // knows these are system-generated signals, not human messages.
  // The universal "[braid-whisper - enforcement]" envelope is applied by
  // `sendTrackedMessage` (the trunk) so this wrapper just passes the raw
  // message through. See `lib/utils/whisper-format.ts` for the full design.
  //
  // BUGFIX 2026-07-06: triggerTurn is now decoupled from critical via the
  // optional options.triggerTurn parameter. When explicitly set, it overrides
  // the default mapping (critical → triggerTurn:true). This prevents tool-loop
  // and other diagnostic whispers from creating cascading new turns.
  const triggerTurn = options?.triggerTurn !== undefined ? options.triggerTurn : critical;
  sendTrackedMessage(
    pi,
    {
      customType: "enforcement",
      content: [{ type: "text" as const, text: message }],
      display: true,
    },
    { deliverAs: "steer", triggerTurn },
    { type: "enforcement", source: "enforcement/whisper" },
  );
}
