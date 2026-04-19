/**
 * Extension State — Session-Scoped State Management
 *
 * Problem: module-level `const state = {}` is process-global. If pi ever runs
 * multiple sessions in one process (or if extensions need session isolation),
 * state bleeds between sessions.
 *
 * Solution: attach state to the ExtensionContext using a private WeakMap.
 * Each session gets its own ctx instance → own state bucket.
 *
 * Usage:
 * ```ts
 * import { getExtensionState } from "./extension-state.js";
 *
 * function getState(ctx: ExtensionContext) {
 *   return getExtensionState(ctx, "my-extension", () => ({
 *     count: 0,
 *     history: [] as string[],
 *   }));
 * }
 *
 * // In tool handler:
 * async execute(params, signal, onUpdate, ctx) {
 *   const state = getState(ctx);
 *   state.count++;
 * }
 * ```
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Private WeakMap storage ──────────────────────────────────────────────────
const _stateBuckets = new WeakMap<ExtensionContext, Map<string, unknown>>();

/**
 * Get (or create) a session-scoped state bucket for this extension.
 *
 * @param ctx       - The ExtensionContext from the tool handler
 * @param key       - Unique name for this extension's state (e.g. "enforcement")
 * @param factory   - Creates the initial state if not yet created
 * @returns The state object (same reference every call for same ctx+key)
 */
export function getExtensionState<T extends object>(
	ctx: ExtensionContext,
	key: string,
	factory: () => T,
): T {
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
 * Check if state exists for this ctx+key without creating it.
 */
export function hasExtensionState(
	ctx: ExtensionContext,
	key: string,
): boolean {
	const bucket = _stateBuckets.get(ctx);
	return bucket ? bucket.has(key) : false;
}

/**
 * Clear state for this ctx+key. Useful for testing.
 */
export function clearExtensionState(
	ctx: ExtensionContext,
	key: string,
): void {
	const bucket = _stateBuckets.get(ctx);
	if (bucket) bucket.delete(key);
}

/**
 * Clear ALL state for this ctx. Useful for session teardown.
 */
export function clearAllExtensionState(ctx: ExtensionContext): void {
	_stateBuckets.delete(ctx);
}
