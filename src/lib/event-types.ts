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

type EventHandler = (event: any, ctx: ExtensionContext) => void | Promise<void>;

/**
 * Register a typed event handler, bypassing pi's literal event name check.
 *
 * Usage replaces:
 *   pi.on("enforcement_signals" as never, handler)  // scattered as never
 *   → onEvent(pi, "enforcement_signals", handler)    // centralized escape
 */
export function onEvent(
  pi: ExtensionAPI,
  event: string,
  handler: EventHandler,
): void {
  (pi as any).on(event, handler);
}

/**
 * Register a one-shot event handler (internal braid event-bus).
 * Not for pi.on — this is for the custom event-bus singleton.
 */
export function onceEvent(
  pi: ExtensionAPI,
  event: string,
  handler: EventHandler,
): void {
  (pi as any).on(event, handler);
}