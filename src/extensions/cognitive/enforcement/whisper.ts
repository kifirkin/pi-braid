import { createLogger } from "../../../lib/logger.js";
import { eventBus } from "../../../lib/event-bus.js";

const log = createLogger("enforcement");
/**
 * Enforcement whisper - Queue and send enforcement messages
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// Whisper System

import { getExtensionState } from "../../../lib/extension-state.js";
import { sendTrackedMessage } from "../../../lib/injection-tracker.js";
import { recordNudgeSent } from "../../heartbeat/analytics/shared.js";

interface WhisperState {
  pendingWhisper: string | null;
  pendingBlockAction: { toolName: string; reason: string } | null;
}

function getWhisperState(ctx?: ExtensionContext): WhisperState {
  if (ctx)
    return getExtensionState(ctx, "enforcement-whisper", () => ({
      pendingWhisper: null,
      pendingBlockAction: null,
    }));
  return _default;
}
const _default: WhisperState = { pendingWhisper: null, pendingBlockAction: null };

/**
 * Send an enforcement whisper immediately using sendTrackedMessage().
 * This injects the whisper right away instead of waiting for before_agent_start,
 * which only fires when user sends a message (causing whisper accumulation).
 * 
 * @param pi - ExtensionAPI for sending messages
 * @param ctx - ExtensionContext for tracking nudge stats
 * @param message - The nudge message to send
 */
export function sendEnforcementWhisper(pi: ExtensionAPI, ctx: ExtensionContext, message: string): void {
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
      severity: "medium",
    });
  } catch {}

  // Tag all enforcement whispers as [enforcement] so the agent knows these are
  // system-generated signals, not human messages.
  sendTrackedMessage(
    pi,
    {
      customType: "enforcement",
      content: [{ type: "text" as const, text: `[enforcement] ${message}` }],
      display: true,
    },
    { triggerTurn: true },
    { type: "enforcement", source: "enforcement/whisper" },
  );
}

/**
 * Queue an enforcement whisper to be injected on the next agent turn.
 * DEPRECATED: Now sends immediately via sendEnforcementWhisper.
 * Kept for backward compatibility with block actions.
 */
export function queueEnforcementWhisper(message: string): void {
  // No longer append - just store single message for block actions
  const s = getWhisperState();
  if (s.pendingWhisper) {
    s.pendingWhisper = `${s.pendingWhisper}\n\n${message}`;
  } else {
    s.pendingWhisper = message;
  }
}

/**
 * Queue a blocking action - the tool will be blocked AND the agent
 * will receive a whisper explaining why.
 */
export function queueBlockAction(toolName: string, reason: string): void {
  const s = getWhisperState();
  s.pendingBlockAction = { toolName, reason };
  queueEnforcementWhisper(`BLOCKED: ${reason}\n\nConsider addressing this before continuing.`);
}

/**
 * Get the pending block action (called from index.ts event handlers).
 */
export function getPendingBlockAction(): { toolName: string; reason: string } | null {
  return getWhisperState().pendingBlockAction;
}

/**
 * Clear the pending block action after it's been sent.
 */
export function clearPendingBlockAction(): void {
  getWhisperState().pendingBlockAction = null;
}
