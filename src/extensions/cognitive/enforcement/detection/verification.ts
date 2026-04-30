import { createLogger } from "../../../../lib/logger.js";

const log = createLogger("enforcement");
/**
 * Thorough Work Verification
 *
 * Detects missing verification after code changes.
 */

import { queueEnforcementWhisper } from "../whisper.js";
import { getExtensionState } from "../../../../lib/extension-state.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

interface VerificationState {
  pendingCodeChanges: boolean;
  lastCodeChangeTurn: number;
}

function getVerificationState(ctx?: ExtensionContext): VerificationState {
  if (ctx)
    return getExtensionState(ctx, "enforcement-verification", () => ({
      pendingCodeChanges: false,
      lastCodeChangeTurn: -100,
    }));
  return _default;
}
const _default: VerificationState = { pendingCodeChanges: false, lastCodeChangeTurn: -100 };
export const VERIFICATION_REMINDER_THRESHOLD = 12; // turns

export function detectMissingVerification(_pi: never, currentTurn: number): void {
  const s = getVerificationState();
  const turnsSinceCodeChange = currentTurn - s.lastCodeChangeTurn;

  // If there were code changes but no bash command within threshold turns, nudge
  if (s.pendingCodeChanges && turnsSinceCodeChange >= VERIFICATION_REMINDER_THRESHOLD) {
    queueEnforcementWhisper(
      "You modified code but haven't verified it works. " +
        "Run tests or commands to confirm your implementation is correct.\n\n" +
        "You verify code changes before declaring the task complete.",
    );
    s.pendingCodeChanges = false; // Only remind once per change session
  }
}

export function recordCodeChange(turn: number): void {
  const s = getVerificationState();
  s.lastCodeChangeTurn = turn;
  s.pendingCodeChanges = true;
}

/**
 * Queue a memory tool execution nudge as a whisper.
 */
export function queueMemoryNudge(toolName: string, toolArgs: Record<string, unknown>): void {
  const argsStr = JSON.stringify(toolArgs);
  const content = `[MEMORY] Consider executing:\n\n${toolName} ${argsStr}`;
  queueEnforcementWhisper(content);
}
