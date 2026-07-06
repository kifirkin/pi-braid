/**
 * Structured Output Catalyst — formatToolResult
 *
 * Wraps tool output in a consistent structured format to catalyze induction
 * head formation, per MDA research (2601.21996). Repetitive structural data
 * (LaTeX, XML, structured headers) improves transformer processing of tool
 * outputs by providing consistent positional anchors.
 *
 * Usage:
 *   import { formatToolResult, TOOLS_TO_FORMAT } from "./format-tool-result.js";
 *   const formatted = formatToolResult("read", [{ type: "text", text: "..." }], false);
 *
 * Opt-in: Set structuredToolOutput=true in settings or pass through the
 * tool_result handler's return value. The handler is registered in
 * register-tool-result-formatting.ts.
 */

import { createLogger } from "../core/logger.js";

const log = createLogger("utils:format-tool-result");

// ── Tools that produce structured data worth formatting ─────────────────────
// These are the tools the agent uses most frequently for information gathering.
// Their output is inherently structured (file contents, search results, directory
// listings) and benefits most from a consistent header format.
export const TOOLS_TO_FORMAT = new Set(["read", "grep", "find", "ls"]);

// ── Opt-in flag ─────────────────────────────────────────────────────────────
// When true, tool outputs for TOOLS_TO_FORMAT get the structured header.
// Can be set via settings.json or environment variable.
// Default: false (opt-in only) to preserve existing behavior.
export const STRUCTURED_OUTPUT_ENABLED = false;

// ── Content block types ─────────────────────────────────────────────────────
export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

// ── Formatting ──────────────────────────────────────────────────────────────

/**
 * Extract a one-line summary from the tool output. Takes the first non-empty
 * line of content and truncates to 80 chars.
 */
export function extractSummary(content: ContentBlock[]): string {
  for (const block of content) {
    if (block.type === "text" && block.text) {
      const firstLine = block.text.split("\n").find((line) => line.trim().length > 0);
      if (firstLine) {
        const trimmed = firstLine.trim();
        return trimmed.length > 80 ? trimmed.slice(0, 77) + "..." : trimmed;
      }
    }
  }
  return "(empty)";
}

/**
 * Format tool output with a structured header.
 *
 * Input:
 *   [{ type: "text", text: "file contents here..." }]
 *
 * Output:
 *   TOOL: read
 *   STATUS: success
 *   RESULT: # My Project
 *   ---
 *   file contents here...
 *
 * The header is designed to be:
 * 1. Machine-parseable (key: value pairs, delimiter line)
 * 2. Positionally consistent (same structure regardless of tool)
 * 3. Compatible with existing text processing (appended, not replaced)
 */
export function formatToolResult(
  toolName: string,
  content: ContentBlock[],
  isError: boolean,
): ContentBlock[] {
  if (!TOOLS_TO_FORMAT.has(toolName)) {
    return content;
  }

  const summary = extractSummary(content);
  const status = isError ? "error" : "success";

  const header = `TOOL: ${toolName}\nSTATUS: ${status}\nRESULT: ${summary}\n---`;

  // Prepend the header to the first text block
  const result: ContentBlock[] = [];
  let headerAdded = false;

  for (const block of content) {
    if (!headerAdded && block.type === "text") {
      result.push({
        ...block,
        text: `${header}\n${block.text || ""}`,
      });
      headerAdded = true;
    } else {
      result.push(block);
    }
  }

  // If no text block was found, create one with just the header
  if (!headerAdded) {
    result.push({ type: "text", text: header });
  }

  log.debug(`Formatted tool result for ${toolName}: ${summary}`);
  return result;
}

/**
 * Check if structured output formatting should be applied for a given tool.
 * Uses the opt-in flag (STRUCTURED_OUTPUT_ENABLED) which can be set via
 * settings.json or environment variable.
 */
export function shouldFormatTool(toolName: string): boolean {
  return STRUCTURED_OUTPUT_ENABLED && TOOLS_TO_FORMAT.has(toolName);
}