/**
 * register-tool-result-formatting — Structured Output Catalyst
 *
 * Wraps tool outputs for read/grep/find/ls in a consistent structured format
 * to improve transformer processing. Uses the tool_result event's middleware
 * chaining to modify content before delivery to the agent.
 *
 * Research backing: MDA (2601.21996) — repetitive structural data catalyzes
 * induction head formation in transformer models.
 *
 * Opt-in: Set structuredToolOutput=true in pi settings.json to enable
 * (read through pi.getSettings(); the key is braid-owned and not part of
 * pi's typed settings schema). Disabled by default to preserve existing
 * behavior.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { formatToolResult, TOOLS_TO_FORMAT } from "../../../lib/utils/format-tool-result.js";

type PermissiveAPI = ExtensionAPI & { on(event: string, handler: (...args: any[]) => any): void };

const log = createLogger("enforcement:tool-result-formatting");

/**
 * Braid-owned opt-in flag in pi's settings.json. pi's `Settings` schema does
 * not declare it, so it is read through a narrowed view of the object
 * `pi.getSettings()` returns; pi preserves unknown top-level keys across its
 * own writes, and a file without the key keeps the feature off.
 */
interface FormattingSettings {
  structuredToolOutput?: boolean;
}

/**
 * Check if structured output formatting is enabled for this session.
 * Reads the effective settings through the extension API accessor.
 */
function isFormattingEnabled(pi: ExtensionAPI): boolean {
  try {
    const settings = pi.getSettings() as FormattingSettings;
    return settings?.structuredToolOutput === true;
  } catch {
    return false;
  }
}

export function registerToolResultFormatting(pi: ExtensionAPI): void {
  (pi as PermissiveAPI).on("tool_result", async (event: any) => {
    // Only format the tools we care about
    const toolName = event?.toolName || "";
    if (!TOOLS_TO_FORMAT.has(toolName)) return;

    // Opt-in gate
    if (!isFormattingEnabled(pi)) return;

    if (!event.content || !Array.isArray(event.content) || event.content.length === 0) {
      return;
    }

    try {
      const formatted = formatToolResult(toolName, event.content, !!event.isError);
      log.debug(
        `Formatted ${toolName} output (${event.content.length} blocks → ${formatted.length} blocks)`,
      );
      return { content: formatted };
    } catch (err) {
      log.error(`Failed to format tool result for ${toolName}: ${err}`);
      // Don't block the tool result — return undefined to passthrough
      return;
    }
  });
}
