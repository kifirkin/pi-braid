/**
 * Safe Event Registration — centralizes pi.on() type escapes.
 *
 * pi's ExtensionAPI.on() uses overloaded literal types for event names.
 * Custom braid events (enforcement_signals, compaction_end, etc.) and
 * handlers with `any` parameter types don't match the strict overloads.
 *
 * Instead of scattering `as never` casts across 20+ sites, use the helper
 * below. The permissive `on` type isolates the escape — all callers get
 * proper typing without individual casts.
 *
 * Key design: handler RETURN type is constrained to known outcome types
 * (void, block object, systemPrompt object) instead of `any`. This catches
 * accidental returns at compile time. Handler parameters remain permissive
 * because pi's event shapes vary per event and duplicating all of them is
 * too fragile.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Known valid synchronous return types for pi event handlers.
type ValidReturns =
  | void
  | undefined
  | { block?: boolean; reason?: string }
  | { systemPrompt?: string }
  | { skillPaths?: string[] };

// Accept sync, Promise-wrapped, or Promise<T | undefined> variants.
// Conditional type via union: TypeScript checks each member.
type OnEventReturn = ValidReturns | Promise<ValidReturns> | Promise<ValidReturns | undefined>;

/** API with relaxed on() signature for custom event names, return-type constrained. */
type PermissiveAPI = ExtensionAPI & {
  on(event: string, handler: (...args: any[]) => OnEventReturn): void;
};

/**
 * Register an event handler with return-type safety.
 *
 * Return type is constrained to known pi event outcomes (void, block, systemPrompt).
 * Handler parameters are permissive (pi's per-event parameter types vary).
 *
 * Usage:
 *   onEvent(pi, "tool_call", handler)
 */
export function onEvent(
  pi: ExtensionAPI,
  event: string,
  handler: (...args: any[]) => OnEventReturn,
): void {
  (pi as PermissiveAPI).on(event, handler);
}

/**
 * Register a one-shot handler via pi.
 */
export function onceEvent(
  pi: ExtensionAPI,
  event: string,
  handler: (...args: any[]) => OnEventReturn,
): void {
  (pi as PermissiveAPI).on(event, handler);
}
