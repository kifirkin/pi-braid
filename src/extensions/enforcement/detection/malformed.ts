import { createLogger } from "../../../lib/logger.js";

const log = createLogger("enforcement");
/**
 * Malformed Tool Call Detection
 *
 * Detects when the agent outputs XML-like tool tags as plain text
 * instead of using proper function calling format.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { sendEnforcementWhisper } from "../whisper.js";

const MALFORMED_REGEX =
  /<(function|write|edit|read|bash|grep|find|ls|think|plan|scratchpad)[^>]*>[\s\S]*?<\/(function|write|edit|read|bash|grep|find|ls|think|plan|scratchpad)>/gi;

export function detectMalformedToolCalls(text: string, pi: ExtensionAPI, ctx: any): void {
  MALFORMED_REGEX.lastIndex = 0;
  const match = MALFORMED_REGEX.exec(text);
  MALFORMED_REGEX.lastIndex = 0;

  if (match) {
    const toolNameMatch = text.match(
      /<(function|write|edit|read|bash|grep|find|ls|think|plan|scratchpad)/i,
    );
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
