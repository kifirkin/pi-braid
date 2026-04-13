/**
 * Thorough Work Verification
 *
 * Detects missing verification after code changes.
 */

import { queueEnforcementWhisper } from "../whisper.js";

let pendingCodeChanges = false;
let lastCodeChangeTurn = -100;
export const VERIFICATION_REMINDER_THRESHOLD = 12; // turns

export function detectMissingVerification(_pi: never, currentTurn: number): void {
	const turnsSinceCodeChange = currentTurn - lastCodeChangeTurn;

	// If there were code changes but no bash command within threshold turns, nudge
	if (pendingCodeChanges && turnsSinceCodeChange >= VERIFICATION_REMINDER_THRESHOLD) {
		queueEnforcementWhisper(
			"VERIFICATION MISSING: You modified code but haven't verified the changes work. " +
				"Run tests or commands to confirm your implementation is correct.\n\n" +
				"IMPORTANT: Always verify code changes before declaring the task complete.",
		);
		pendingCodeChanges = false; // Only remind once per change session
	}
}

export function recordCodeChange(turn: number): void {
	lastCodeChangeTurn = turn;
	pendingCodeChanges = true;
}

/**
 * Queue a memory tool execution nudge as a whisper.
 */
export function queueMemoryNudge(toolName: string, toolArgs: Record<string, unknown>): void {
	const argsStr = JSON.stringify(toolArgs);
	const content = `[MEMORY] Consider executing:\n\n${toolName} ${argsStr}`;
	queueEnforcementWhisper(content);
}
