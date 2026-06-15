


/**
 * Malformed Tool Call Detection
 *
 * Detects when the agent outputs XML-like tool tags as plain text
 * instead of using proper function calling format.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sendEnforcementWhisper } from "../whisper.js";
import { MALFORMED_TOOL_CALL_RE, MALFORMED_TOOL_NAME_RE } from "../../../lib/constants/tool-constants.js";

export function detectMalformedToolCalls(text: string, pi: ExtensionAPI, ctx: any): void {
  MALFORMED_TOOL_CALL_RE.lastIndex = 0;
  const match = MALFORMED_TOOL_CALL_RE.exec(text);
  MALFORMED_TOOL_CALL_RE.lastIndex = 0;

  if (match) {
    const toolNameMatch = text.match(MALFORMED_TOOL_NAME_RE);
    const detectedTool = toolNameMatch ? toolNameMatch[1].toLowerCase() : "unknown";

    sendEnforcementWhisper(
      pi,
      ctx,
      "Malformed tool call detected: <" +
        detectedTool +
        "> as TEXT. Use proper function calling format - do NOT output XML tags as plain text.",
    );
  }
}
