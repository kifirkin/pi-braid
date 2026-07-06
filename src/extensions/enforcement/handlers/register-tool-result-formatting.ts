/**
 * register-tool-result-formatting — Structured Output Catalyst (MI-3)
 *
 * Wraps tool outputs for read/grep/find/ls in a consistent structured format
 * to improve transformer processing. Uses the tool_result event's middleware
 * chaining to modify content before delivery to the agent.
 *
 * Research backing: MDA (2601.21996) — repetitive structural data catalyzes
 * induction head formation in transformer models.
 *
 * Opt-in: Set structuredToolOutput=true in pi settings.json to enable.
 * Disabled by default to preserve existing behavior.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { formatToolResult, TOOLS_TO_FORMAT } from "../../../lib/utils/format-tool-result.js";

type PermissiveAPI = ExtensionAPI & { on(event: string, handler: (...args: any[]) => any): void };

const log = createLogger("enforcement:tool-result-formatting");

/**
 * Check if structured output formatting is enabled for this session.
 * Reads from extension settings (set via structuredToolOutput flag).
 */
function isFormattingEnabled(ctx: ExtensionContext): boolean {
  try {
    // Check for a settings flag on the context
    const settings = (ctx as any).settings;
    return settings?.structuredToolOutput === true;
  } catch {
    return false;
  }
}

export function registerToolResultFormatting(pi: ExtensionAPI): void {
  (pi as PermissiveAPI).on("tool_result", async (event: any, ctx: ExtensionContext) => {
    // Only format the tools we care about
    const toolName = event?.toolName || "";
    if (!TOOLS_TO_FORMAT.has(toolName)) return;

    // Opt-in gate
    if (!isFormattingEnabled(ctx)) return;

    // Skip empty results
    if (!event.content || !Array.isArray(event.content) || event.content.length === 0) {
      return;
    }

    try {
      const formatted = formatToolResult(toolName, event.content, !!event.isError);
      log.debug(`Formatted ${toolName} output (${event.content.length} blocks → ${formatted.length} blocks)`);
      return { content: formatted };
    } catch (err) {
      log.error(`Failed to format tool result for ${toolName}: ${err}`);
      // Don't block the tool result — return undefined to passthrough
      return;
    }
  });
}