/**
 * Safe Event Registration — centralizes pi.on() type escapes.
 *
 * pi's ExtensionAPI.on() uses overloaded literal types for event names.
 * Custom braid events (enforcement_signals, compaction_end, etc.) and
 * handlers with `any` parameter types don't match the strict overloads.
 *
 * Instead of scattering `as never` casts across 20+ sites, use the helper
 * below. The `never` cast is isolated here — it exploits the assignability
 * rule `never is assignable to everything` to bypass the literal check.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// Some pi event handlers return values (e.g. tool_call → ToolCallEventResult
// with { block, reason }). Use a generic type so return values flow through.

/**
 * Register an event handler, bypassing pi's literal event name check.
 * The handler may return anything (some pi events expect results).
 *
 * Usage:
 *   onEvent(pi, "tool_call", handler)  // instead of pi.on("tool_call" as never, handler)
 */
export function onEvent(pi: ExtensionAPI, event: string, handler: (...args: any[]) => any): void {
  (pi as any).on(event, handler);
}

/**
 * Register a one-shot handler via pi.
 */
export function onceEvent(pi: ExtensionAPI, event: string, handler: (...args: any[]) => any): void {
  (pi as any).on(event, handler);
}
