/**
 * Turn-End Coordinator — centralized dispatch for post-turn analysis.
 *
 * Problem: Enforcement owned the turn_end slot exclusively. Every new
 * post-turn concern had to be added to enforcement's handler chain,
 * creating a 3000-line god module.
 *
 * Solution: A lightweight coordinator that extensions can register against.
 * Each handler gets a name and priority. Handlers run in priority order
 * and are independently testable.
 *
 * Usage:
 *   import { registerTurnEndHandler, dispatchTurnEnd } from "../../lib/events/turn-end-coordinator.js";
 *
 *   // In extension factory:
 *   registerTurnEndHandler("claim-tracker", 80, async (event, ctx) => { ... });
 *
 *   // In the single pi.on("turn_end") registration:
 *   pi.on("turn_end", (event, ctx) => dispatchTurnEnd(event, ctx));
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../core/logger.js";

const log = createLogger("turn-end");

export type TurnEndHandler = (event: any, ctx: ExtensionContext) => void | Promise<void>;

interface HandlerEntry {
  name: string;
  priority: number;
  handler: TurnEndHandler;
}

const _handlers: HandlerEntry[] = [];

/**
 * Register a handler to run on turn_end.
 * Handlers run in descending priority order (higher = first).
 * Handlers with the same name are deduplicated (last registration wins).
 */
export function registerTurnEndHandler(
  name: string,
  priority: number,
  handler: TurnEndHandler,
): void {
  // Deduplicate by name
  const existing = _handlers.findIndex((h) => h.name === name);
  if (existing >= 0) {
    _handlers[existing] = { name, priority, handler };
  } else {
    _handlers.push({ name, priority, handler });
  }
  _handlers.sort((a, b) => b.priority - a.priority);
}

/**
 * Unregister a previously registered handler.
 * Safe to call even if the handler wasn't registered.
 */
export function unregisterTurnEndHandler(name: string): void {
  const idx = _handlers.findIndex((h) => h.name === name);
  if (idx >= 0) {
    _handlers.splice(idx, 1);
  }
}

/**
 * Run all registered turn_end handlers in priority order.
 * Each handler is wrapped in try/catch so a failure in one
 * doesn't prevent others from running.
 */
export async function dispatchTurnEnd(event: any, ctx: ExtensionContext): Promise<void> {
  if (_handlers.length === 0) return;

  for (const entry of _handlers) {
    try {
      await entry.handler(event, ctx);
    } catch (err) {
      log.error(`turn_end handler "${entry.name}" failed:`, err);
    }
  }
}

/**
 * Get the list of registered handler names (for debugging).
 */
export function getRegisteredHandlers(): string[] {
  return _handlers.map((h) => `${h.name} (priority ${h.priority})`);
}

/**
 * Clear all registered handlers. Used in tests and session teardown.
 */
export function clearHandlers(): void {
  _handlers.length = 0;
}

/**
 * Get the count of registered handlers.
 */
export function handlerCount(): number {
  return _handlers.length;
}
