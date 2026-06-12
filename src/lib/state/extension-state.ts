/**
 * Extension State - Session-Scoped State Management
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
