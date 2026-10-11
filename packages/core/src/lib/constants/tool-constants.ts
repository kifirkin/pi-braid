/**
 * Tool Constants - Shared definitions used across enforcement and reasoning.
 */

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
