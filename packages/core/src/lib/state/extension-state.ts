/**
 * Extension State - Session-Scoped State Management
 *
 * [warn] This is the ONLY sanctioned state holder for extension runtime data.
 *    The `AGENTS.md` contract forbids module-level `let` mutable state
 *    because it leaks across sessions when pi runs multiple sessions in
 *    one process. If you need a per-extension state object, use
 *    `getExtensionState(ctx, "key", factory)`.
 *
 * Problem: module-level `const state = {}` is process-global. If pi ever runs
 * multiple sessions in one process, state bleeds between sessions.
 *
 * Solution: extract a stable session identifier from ctx (e.g.
 * sessionManager.getSessionFile()) and key a regular Map on it. This survives
 * ctx object recreation between tool calls.
 *
 * Fallback: if no stable session id is available, fall back to the ctx
 * WeakMap (legacy behavior).
 *
 * Exceptions (process-globals that are explicitly OK here): see the four
 * module-level holders declared below (`_sessionState`, `_stateBuckets`,
 * `_lastSessionKey`, `_cachedSessionManagers`). They are bookkeeping for
 * the state system itself, not extension state. New module-level mutable
 * bindings elsewhere in `lib/` need to be audited against this rule.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../core/logger.js";

const log = createLogger("extension-state");

const _sessionState = new Map<string, Map<string, unknown>>();

const _stateBuckets = new WeakMap<ExtensionContext, Map<string, unknown>>();

// Last known session key - used as fallback when ctx is stale (after compaction).
// This prevents state loss across event handlers when pi-core replaces ctx.
let _lastSessionKey: string | undefined;

function getSessionKey(ctx: ExtensionContext): string | undefined {
  // Prefer sessionManager's file path - stable across the whole session.
  // Wrapping entire access in try/catch because ctx.sessionManager is a
  // getter that calls ExtensionRunner.assertActive() - throws when the ctx
  // is stale after session replacement or reload (observed in turn_end).
  try {
    const sm = ctx.sessionManager;
    if (sm) {
      const file = sm.getSessionFile?.() ?? sm.getSessionId?.();
      if (file) {
        _lastSessionKey = String(file);
        return _lastSessionKey;
      }
    }
  } catch {
    // ctx is stale or sessionManager not available.
    // Fall back to the last known session key to prevent state loss.
    if (_lastSessionKey) {
      return _lastSessionKey;
    }
  }

  return undefined;
}

/**
 * Get (or create) a session-scoped state bucket for this extension.
 *
 * @param ctx       - The ExtensionContext from the tool handler
 * @param key       - Unique name for this extension's state (e.g. "enforcement")
 * @param factory   - Creates the initial state if not yet created
 * @returns The state object (same reference every call for same session+key)
 */
export function getExtensionState<T extends object>(
  ctx: ExtensionContext,
  key: string,
  factory: () => T,
): T {
  const sessionKey = getSessionKey(ctx);

  if (sessionKey) {
    if (!_sessionState.has(sessionKey)) {
      _sessionState.set(sessionKey, new Map());
    }
    const bucket = _sessionState.get(sessionKey)!;
    if (!bucket.has(key)) {
      bucket.set(key, factory());
    }
    return bucket.get(key) as T;
  }

  // Legacy fallback: WeakMap keyed on ctx object reference
  if (!_stateBuckets.has(ctx)) {
    _stateBuckets.set(ctx, new Map());
  }
  const bucket = _stateBuckets.get(ctx)!;
  if (!bucket.has(key)) {
    bucket.set(key, factory());
  }
  return bucket.get(key) as T;
}

/**
 * Check if state exists for this session+key without creating it.
 */
export function hasExtensionState(ctx: ExtensionContext, key: string): boolean {
  const sessionKey = getSessionKey(ctx);
  if (sessionKey) {
    const bucket = _sessionState.get(sessionKey);
    return bucket ? bucket.has(key) : false;
  }
  const bucket = _stateBuckets.get(ctx);
  return bucket ? bucket.has(key) : false;
}

/**
 * Read another extension's state bucket WITHOUT creating it. Returns
 * undefined when the bucket does not exist for this session. Read-only
 * surfaces (inspect tools) use this so a missing bucket stays missing.
 */
export function readExtensionState<T>(ctx: ExtensionContext, key: string): T | undefined {
  if (!hasExtensionState(ctx, key)) return undefined;
  return getExtensionState<T & object>(ctx, key, () => ({}) as T & object) as T;
}

/**
 * Clear state for this session+key. Useful for testing.
 */
export function clearExtensionState(ctx: ExtensionContext, key: string): void {
  const sessionKey = getSessionKey(ctx);
  if (sessionKey) {
    const bucket = _sessionState.get(sessionKey);
    if (bucket) bucket.delete(key);
    return;
  }
  const bucket = _stateBuckets.get(ctx);
  if (bucket) bucket.delete(key);
}

/**
 * Clear ALL state for this session. Useful for session teardown.
 */
export function clearAllExtensionState(ctx: ExtensionContext): void {
  const sessionKey = getSessionKey(ctx);
  if (sessionKey) {
    _sessionState.delete(sessionKey);
    return;
  }
  _stateBuckets.delete(ctx);
}

/**
 * Register automatic session cleanup on the `session_shutdown` event.
 *
 * Call this once during extension registration:
 *   pi.on("session_shutdown", registerSessionCleanup());
 * Or simply import and call from your main extension.
 */
export function registerSessionCleanup(): (event: any, ctx: ExtensionContext) => void {
  return (_event: any, ctx: ExtensionContext) => {
    clearAllExtensionState(ctx);
  };
}

/**
 * Force-clear all state for all sessions. Nuclear option for tests.
 */
/**
 * Safely access ctx.sessionManager, returning undefined on stale ctx.
 *
 * ctx.sessionManager is a getter that calls ExtensionRunner.assertActive() -
 * throws when the ctx is stale after session replacement or reload.
 * Optional chaining (ctx.sessionManager?.method()) does NOT protect against
 * this because the getter itself throws before the `?.` operand is evaluated.
 *
 * Use this in event handlers when reading session data is best-effort.
 */
export function safeSessionManager(ctx: ExtensionContext): unknown {
  try {
    return ctx.sessionManager;
  } catch {
    log.warn(
      "Stale ExtensionContext - sessionManager getter threw. Data-dependent subsystems (BPE, drift, memory) will operate on empty data.",
    );
    return undefined;
  }
}

/**
 * Like safeSessionManager, but returns the typed SessionManager
 * (with getSessionFile and other convenience methods). Use this in
 * extension code that needs to call getSessionFile or other
 * convenience methods without re-declaring an SmWithSessionFile
 * local interface for every callsite. Replaces the pattern
 * `safeSessionManager(ctx) as unknown as SmWithSessionFile` that
 * appeared in 5+ files.
 */
export function safeSessionManagerTyped(
  ctx: ExtensionContext,
): import("./session-manager.js").SessionManager | undefined {
  const sm = safeSessionManager(ctx);
  if (!sm) return undefined;
  return sm as import("./session-manager.js").SessionManager;
}

// ctx.sessionManager is a getter that throws when ctx is stale. Cache the
// reference at session_start (where ctx is guaranteed fresh) and use the
// cached copy in turn_end handlers to avoid stale-ctx crashes.

const _cachedSessionManagers = new Map<string, unknown>();

/**
 * Cache a sessionManager reference for later use. Call at session_start
 * when the ExtensionContext is guaranteed fresh.
 */
export function cacheSessionManager(ctx: ExtensionContext): void {
  const sessionKey = getSessionKey(ctx);
  if (!sessionKey) return;
  try {
    const sm = ctx.sessionManager;
    if (sm) {
      _cachedSessionManagers.set(sessionKey, sm);
    }
  } catch {
    // ctx sessionManager threw even at session_start - skip caching
  }
}

/**
 * Get the cached sessionManager reference, falling back to safeSessionManager.
 * Use in turn_end and mid-turn handlers to avoid stale-ctx crashes.
 */
export function getCachedSessionManager(ctx: ExtensionContext): unknown {
  const sessionKey = getSessionKey(ctx);
  if (sessionKey) {
    const cached = _cachedSessionManagers.get(sessionKey);
    if (cached) return cached;
  }
  // Fallback to safe access if no cache hit
  return safeSessionManager(ctx);
}

/**
 * Get a stable session ID with safe fallback. Returns "?" if the
 * context is stale or no sessionManager is available. This is the
 * canonical helper for handlers that need a session identifier
 * (e.g. for logging, scoping timers, indexing per-session data).
 *
 * Replaces the pattern:
 *   (ctx as unknown as CtxWithSession).sessionManager?.getSessionId?.() ?? "?"
 * which was duplicated across many files.
 */
export function getSessionIdSafe(ctx: ExtensionContext | undefined): string {
  if (!ctx) return "?";
  const sm = getCachedSessionManager(ctx) as
    | { getSessionId?: () => string | undefined }
    | undefined
    | null;
  try {
    return sm?.getSessionId?.() ?? "?";
  } catch {
    return "?";
  }
}

/**
 * Get a stable leaf ID with safe fallback. Returns "?" if the
 * context is stale or no sessionManager is available. See
 * `getSessionIdSafe` for the rationale and the pattern this
 * replaces.
 */
export function getLeafIdSafe(ctx: ExtensionContext | undefined): string {
  if (!ctx) return "?";
  const sm = getCachedSessionManager(ctx) as
    | { getLeafId?: () => string | undefined }
    | undefined
    | null;
  try {
    return sm?.getLeafId?.() ?? "?";
  } catch {
    return "?";
  }
}

//
// The message union extension handlers receive (`AgentMessage`: the pi-ai
// `Message` union plus extension-defined custom messages) does not expose
// every member's fields. pi-ai's `AssistantMessage` DOES declare
// `stopReason`; reading it off the union is a narrowing problem, not a
// missing type. The conventional pattern was:
//   (event as unknown as { stopReason?: string }).stopReason
// which appeared in 5+ files. These helpers encapsulate the narrowing
// so the cast lives in exactly one place per field.

/**
 * Read `stopReason` from a message-shaped object without inlining
 * the type cast. Returns undefined if not present. Replaces the
 * pattern `event.message as unknown as { stopReason?: string }`
 * which appeared 3+ times in turn-end-handler.ts.
 */
export function getStopReason(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const sr = (message as { stopReason?: unknown }).stopReason;
  return typeof sr === "string" ? sr : undefined;
}

/**
 * Read `content` from a message-shaped object. Returns an empty
 * array if not present or not an array. Replaces the pattern
 * `event.message as unknown as { content?: Array<...> }` in
 * turn-end-handler.ts:73.
 */
export function getMessageContent(message: unknown): Array<{ type: string; text?: string }> {
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content as Array<{ type: string; text?: string }>;
}

/**
 * The scratchpad's session state, as consumers read it.
 * Only the fields used by extension code are typed; other fields pass
 * through as `unknown`.
 */
export type ScratchpadState = {
  goal?: string;
  plan?: unknown[];
  decisions?: unknown[];
  key_learnings?: Array<{ persisted?: boolean }>;
};

/**
 * Read the scratchpad's session state (goal / plan / decisions / learnings).
 *
 * The scratchpad extension owns the `scratchpad-cache` bucket and keeps it in
 * step with every tool call; reading it is the sanctioned in-process surface
 * (finalize.ts reads the same bucket). Returns undefined when no pad has been
 * loaded in this session.
 *
 * This is deliberately not a tool invocation: `ctx.tools` is a nameless array
 * on tool contexts and absent on event contexts, and the scratchpad tool's
 * result details carry counts (`{action, prior_goal, plan: <n>, save_error}`)
 * rather than the fields these callers need.
 */
export function readScratchpadState(ctx: ExtensionContext): ScratchpadState | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const cache = readExtensionState<{ pad?: ScratchpadState | null }>(ctx, "scratchpad-cache");
  const pad = cache?.pad;
  if (!pad || typeof pad !== "object") return undefined;
  return {
    goal: pad.goal,
    plan: pad.plan,
    decisions: pad.decisions,
    key_learnings: pad.key_learnings,
  };
}

/**
 * Get `ctx.sessionManager` (the `appendMessage`-capable form) with
 * type-narrowing, falling back to the cached reference. Returns
 * undefined if no sessionManager is available. Replaces the pattern
 *   `(ctx as unknown as { sessionManager?: FullSessionManager }).sessionManager`
 * which appeared in compaction.ts:470 and 178.
 */
export function getFullSessionManager(
  ctx: ExtensionContext,
): { appendMessage(msg: unknown): string; getSessionId(): string } | undefined {
  const sm = getCachedSessionManager(ctx) as
    | { appendMessage?: (msg: unknown) => string; getSessionId?: () => string }
    | undefined
    | null;
  if (!sm || typeof sm.appendMessage !== "function" || typeof sm.getSessionId !== "function") {
    return undefined;
  }
  return sm as { appendMessage(msg: unknown): string; getSessionId(): string };
}

/**
 * Get `ctx.sessionManager.getLeafId()` with safe fallback. Returns
 * undefined if no sessionManager is available. Replaces the pattern
 *   `(ctx as unknown as { sessionManager?: { getLeafId(): string } }).sessionManager?.getLeafId()`
 * which appeared in workspace-snapshot.ts:224.
 */
export function getSessionLeafIdSafe(ctx: ExtensionContext | undefined): string | undefined {
  if (!ctx) return undefined;
  const sm = getCachedSessionManager(ctx) as
    | { getLeafId?: () => string | undefined }
    | undefined
    | null;
  if (!sm || typeof sm.getLeafId !== "function") return undefined;
  try {
    return sm.getLeafId();
  } catch {
    return undefined;
  }
}

/**
 * Get the label of a session leaf by ID with safe fallback. Returns
 * undefined if no sessionManager is available or the leaf has no label.
 * Replaces the pattern
 *   `(ctx as unknown as { sessionManager?: { getLabel(id): string | undefined } }).sessionManager?.getLabel(id)`
 * which appeared in workspace-snapshot.ts:226.
 */
export function getSessionLabelSafe(
  ctx: ExtensionContext | undefined,
  leafId: string,
): string | undefined {
  if (!ctx) return undefined;
  const sm = getCachedSessionManager(ctx) as
    | { getLabel?: (id: string) => string | undefined }
    | undefined
    | null;
  if (!sm || typeof sm.getLabel !== "function") return undefined;
  try {
    return sm.getLabel(leafId);
  } catch {
    return undefined;
  }
}
