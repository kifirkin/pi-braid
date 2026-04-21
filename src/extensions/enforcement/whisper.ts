import { createLogger } from "../../lib/logger.js";

const log = createLogger("enforcement");
/**
 * Enforcement whisper - Queue and send enforcement messages
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Whisper System

let pendingWhisper: string | null = null;
let pendingBlockAction: { toolName: string; reason: string } | null = null;

/**
 * Send an enforcement whisper immediately using pi.sendMessage().
 * This injects the whisper right away instead of waiting for before_agent_start,
 * which only fires when user sends a message (causing whisper accumulation).
 */
export function sendEnforcementWhisper(pi: ExtensionAPI, message: string): void {
	// Tag all enforcement whispers as [auto] so the agent knows these are
	// system-generated signals, not human messages.
	pi.sendMessage(
		{
			customType: "enforcement",
			content: [{ type: "text" as const, text: `[auto] ${message}` }],
			display: true,
		},
		{ triggerTurn: true },
	);
}

/**
 * Queue an enforcement whisper to be injected on the next agent turn.
 * DEPRECATED: Now sends immediately via sendEnforcementWhisper.
 * Kept for backward compatibility with block actions.
 */
export function queueEnforcementWhisper(message: string): void {
	// No longer append - just store single message for block actions
	if (pendingWhisper) {
		pendingWhisper = `${pendingWhisper}\n\n${message}`;
	} else {
		pendingWhisper = message;
	}
}

/**
 * Queue a blocking action - the tool will be blocked AND the agent
 * will receive a whisper explaining why.
 */
export function queueBlockAction(toolName: string, reason: string): void {
	pendingBlockAction = { toolName, reason };
	queueEnforcementWhisper(`BLOCKED: ${reason}\n\nYou must address this issue before proceeding.`);
}

/**
 * Get the pending block action (called from index.ts event handlers).
 */
export function getPendingBlockAction(): { toolName: string; reason: string } | null {
	return pendingBlockAction;
}

/**
 * Clear the pending block action after it's been sent.
 */
export function clearPendingBlockAction(): void {
	pendingBlockAction = null;
}
