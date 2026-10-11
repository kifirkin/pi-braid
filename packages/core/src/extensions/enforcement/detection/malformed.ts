/**
 * Malformed Tool Call Detection
 *
 * Detects when the agent outputs XML-like tool tags as plain text
 * instead of using proper function calling format.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sendEnforcementWhisper } from "../whisper.js";
import { getNudgeManager } from "../nudge-manager.js";
import {
  MALFORMED_TOOL_CALL_RE,
  MALFORMED_TOOL_NAME_RE,
} from "../../../lib/constants/tool-constants.js";

export function detectMalformedToolCalls(
  text: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  MALFORMED_TOOL_CALL_RE.lastIndex = 0;
  const match = MALFORMED_TOOL_CALL_RE.exec(text);
  MALFORMED_TOOL_CALL_RE.lastIndex = 0;

  if (match) {
    const toolNameMatch = text.match(MALFORMED_TOOL_NAME_RE);
    const detectedTool = toolNameMatch ? toolNameMatch[1].toLowerCase() : "unknown";

    // Rate-limit via NudgeManager: the 10s cooldown with no-dedup
    // config is the right shape for a malformed-tool flood: a single
    // malformed call is enough to fire, but repeat fires within 10s are
    // suppressed so the agent isn't hammered while iterating on the fix.
    const message =
      "Malformed tool call detected: <" +
      detectedTool +
      "> as TEXT. Use proper function calling format - do NOT output XML tags as plain text.";
    const { shouldSend } = getNudgeManager(ctx).shouldSendNudge("malformed", message);
    if (shouldSend) {
      sendEnforcementWhisper(pi, ctx, message);
    }
  }
}
