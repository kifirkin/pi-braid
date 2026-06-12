/**
 * Tool Constants - Shared definitions for tool categorization.
 *
 * Centralizes hardcoded tool-name lists that were previously duplicated
 * across turn-outcome, tool-safety, and enforcement extensions.
 */

/** Tools that directly modify files on disk. */
export const FILE_CHURN_TOOLS: readonly string[] = ["edit", "write", "delete"] as const;

/** Tools that can cause destructive or irreversible system changes. */
export const DESTRUCTIVE_TOOLS: readonly string[] = [...FILE_CHURN_TOOLS, "bash"] as const;

// ── Malformed Tool Call Detection (shared across enforcement + reasoning) ────

/**
 * Regex to detect XML-like tool tags emitted as plain text instead of
 * proper function-calling format. Used by extensions/enforcement/detection/malformed.ts.
 */
export const MALFORMED_TOOL_CALL_RE =
  /<(function|write|edit|read|bash|grep|find|ls|think|plan|scratchpad)[^>]*>[\s\S]*?<\/(function|write|edit|read|bash|grep|find|ls|think|plan|scratchpad)>/gi;

/** Extract the tool name from a malformed tool tag opening. */
export const MALFORMED_TOOL_NAME_RE =
  /<(function|write|edit|read|bash|grep|find|ls|think|plan|scratchpad)/i;
