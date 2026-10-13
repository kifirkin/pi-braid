/**
 * Centralized event name constants.
 *
 * Every pi.on("event_name") call in the codebase should use these constants
 * instead of raw strings to prevent drift. The single-ownership enforcer
 * (test/runtime/test-single-ownership.mjs) verifies compliance.
 */

// ── Session Lifecycle ───────────────────────────────────────────────────────

export const SESSION_START = "session_start" as const;
export const SESSION_BEFORE_COMPACT = "session_before_compact" as const;
export const SESSION_COMPACT = "session_compact" as const;
export const SESSION_COMPACT_FAILED = "session_compact_failed" as const;
export const SESSION_SHUTDOWN = "session_shutdown" as const;

// ── Turn & Message Lifecycle ───────────────────────────────────────────────

export const TURN_END = "turn_end" as const;
export const AGENT_END = "agent_end" as const;
export const TOOL_CALL = "tool_call" as const;
export const MESSAGE_START = "message_start" as const;
export const MESSAGE_END = "message_end" as const;
export const TOOL_EXECUTION_START = "tool_execution_start" as const;
export const TOOL_EXECUTION_END = "tool_execution_end" as const;
export const AGENT_SETTLED = "agent_settled" as const;

// ── Extension Communication ─────────────────────────────────────────────────

export const INPUT = "input" as const;
export const RESOURCES_DISCOVER = "resources_discover" as const;
