/**
 * Centralized event name constants.
 *
 * Every pi.on("event_name") call in the codebase should use these constants
 * instead of raw strings to prevent drift. The single-ownership enforcer
 * (test/test-single-ownership.mjs) verifies compliance.
 */

// ── Session Lifecycle ───────────────────────────────────────────────────────

export const SESSION_START = "session_start" as const;
export const SESSION_END = "session_end" as const;

// ── Turn Lifecycle ──────────────────────────────────────────────────────────

export const TURN_END = "turn_end" as const;
export const TURN_COMPLETE = "turn_complete" as const;
export const TOOL_CALL = "tool_call" as const;

// ── Memory & Context ────────────────────────────────────────────────────────

export const MEMORY_STORE = "memory_store" as const;
export const MEMORY_RECALL = "memory_recall" as const;

// ── Extension Communication ─────────────────────────────────────────────────

export const EXTENSION_UI_REQUEST = "extension_ui_request" as const;
export const SESSION_TREE = "session_tree" as const;

// ── Nudge / Enforcement ─────────────────────────────────────────────────────

export const NUDGE = "nudge" as const;
export const SIGNAL = "signal" as const;

// ── Analytics ───────────────────────────────────────────────────────────────

export const TURN_ANALYTICS = "turn_analytics" as const;

// ── All Constants Map (for test verification) ───────────────────────────────

export const ALL_EVENT_NAMES = new Set([
  SESSION_START,
  SESSION_END,
  TURN_END,
  TURN_COMPLETE,
  TOOL_CALL,
  MEMORY_STORE,
  MEMORY_RECALL,
  EXTENSION_UI_REQUEST,
  SESSION_TREE,
  NUDGE,
  SIGNAL,
  TURN_ANALYTICS,
]);