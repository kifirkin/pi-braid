/**
 * Extension State - Session-Scoped State Management
 *
 * ⚠️ This is the ONLY sanctioned state holder for extension runtime data.
 *    The `AGENTS.md` contract forbids module-level `let` mutable state
 *    because it leaks across sessions when pi runs multiple sessions in
 *    one process. If you need a per-extension state object, use
 *    `getExtensionState(ctx, "key", factory)`. See
 *    `docs/CODE-QUALITY-REMEDIATION-PLAN.md` TASK-2.1 for the audit
 *    of violations and the migration plan.
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

// ── Session-scoped storage (stable across ctx recreation) ───────────────────
const _sessionState = new Map<string, Map<string, unknown>>();

// ── Legacy WeakMap fallback (for ctx without sessionManager) ────────────────
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
 * Get all active session keys (for debugging / monitoring).
 */
export function getActiveSessionKeys(): string[] {
  return Array.from(_sessionState.keys());
}

/**
 * Get count of active sessions (for debugging / monitoring).
 */
export function getActiveSessionCount(): number {
  return _sessionState.size;
}

/**
 * Register automatic session cleanup on the `session_end` event.
 *
 * Call this once during extension registration:
 *   pi.on("session_end", registerSessionCleanup());
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
export function safeSessionManagerTyped(ctx: ExtensionContext): import("./session-manager.js").SessionManager | undefined {
  const sm = safeSessionManager(ctx);
  if (!sm) return undefined;
  return sm as import("./session-manager.js").SessionManager;
}

export function clearAllSessions(): void {
  _sessionState.clear();
  _cachedSessionManagers.clear();
}

// ── Cached SessionManager References ─────────────────────────────────────────
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

// ── Type-narrowing helpers for event/message/ctx ──────────────────────────────────
//
// pi's public types are deliberately narrow (e.g. AssistantMessage has
// `{role, content}` but not `stopReason` in all shapes). Extension
// handlers need to read internal fields like `stopReason`, `ctx`,
// `tools.scratchpad`, etc. The conventional pattern was:
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
export function getMessageContent(
  message: unknown,
): Array<{ type: string; text?: string }> {
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content as Array<{ type: string; text?: string }>;
}

/**
 * Get the session_start task/prompt string with type-narrowing.
 * pi's `session_start` event payload can be shaped as either
 * `{task: string}` (old) or `{prompt: string}` (new). Replaces
 * the pattern `(event as unknown as { task?: string; prompt?: string })`
 * in register-session-start.ts:26-27.
 */
export function getSessionStartTask(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const e = event as { task?: unknown; prompt?: unknown };
  return (typeof e.task === "string" ? e.task : "") ||
    (typeof e.prompt === "string" ? e.prompt : "");
}

/**
 * Get the optional `ctx` field from a turn_end or similar event,
 * returning it typed as a function-bearing object. Replaces the
 * pattern `event as unknown as { ctx?: { getContextUsage?() } }`
 * in turn-end-handler.ts:279.
 */
export function getContextUsageFromEvent(
  event: unknown,
): { percent?: number; tokens?: number } | undefined {
  if (!event || typeof event !== "object") return undefined;
  const ctx = (event as { ctx?: unknown }).ctx;
  if (!ctx || typeof ctx !== "object") return undefined;
  const fn = (ctx as { getContextUsage?: () => unknown }).getContextUsage;
  if (typeof fn !== "function") return undefined;
  try {
    return fn.call(ctx) as { percent?: number; tokens?: number } | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Type for the result of calling ctx.tools.scratchpad(...).
 * Only the fields used by extension code are typed; other fields
 * pass through as `unknown`.
 */
export type ScratchpadToolResult = {
  details?: {
    goal?: string;
    plan?: unknown[];
    decisions?: unknown[];
    key_learnings?: Array<{ persisted?: boolean }>;
  };
};

/**
 * Call `ctx.tools.scratchpad` with type-narrowing. Returns undefined
 * if the tool is not registered (e.g. when scratchpad extension is
 * disabled). Replaces the pattern
 *   `(ctx as unknown as { tools?: { scratchpad? } }).tools?.scratchpad?.(...)`
 * which appeared in register-session-compact.ts and
 * workspace-snapshot.ts.
 */
export async function callScratchpadTool(
  ctx: ExtensionContext,
  params: { action: string },
): Promise<ScratchpadToolResult | undefined> {
  if (!ctx || typeof ctx !== "object") return undefined;
  const tools = (ctx as { tools?: unknown }).tools;
  if (!tools || typeof tools !== "object") return undefined;
  const fn = (tools as { scratchpad?: (p: { action: string }) => Promise<unknown> }).scratchpad;
  if (typeof fn !== "function") return undefined;
  try {
    return (await fn.call(tools, params)) as ScratchpadToolResult | undefined;
  } catch {
    return undefined;
  }
}
