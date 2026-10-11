/**
 * Watchdog Tunnel Bridge — cross-package seam (telegram → core).
 *
 * Telegram cannot import pi-braid core (standalone package, no core dep) and
 * core cannot import telegram, so tunnel liveness crosses packages through a
 * deliberately narrow process-global slot — the same seam pattern as the
 * providers key-ring feedback (KEY_RING_FEEDBACK_KEY, packages/providers/
 * ring-lifecycle.ts ↔ packages/core/src/lib/state/global-state.ts).
 *
 * WATCHDOG_TUNNEL_KEY MUST stay in sync with core's
 * packages/core/src/lib/state/global-state.ts (same literal), and the hub
 * protocol below MUST match core's WatchdogTunnelHub exactly: both sides
 * get-or-create the hub at the same slot, telegram publishes, core
 * subscribes. If the key literal or the protocol drifts, tunnel-down/up
 * signals silently stop reaching the watchdog — keep them in sync, like the
 * KEY_RING_FEEDBACK_KEY comment demands.
 *
 * One emitter per event: only inbound-poller.ts (via the poller's injectable
 * `onTunnelStatusChange`, wired by telegram/index.ts) calls publishWatchdogTunnel.
 * Core's watchdog is the single consumer that surfaces the two whispers.
 */

import type { WatchdogTunnelStatusEvent } from "./inbound-poller.js";

/** Process-global slot key — MUST match core's WATCHDOG_TUNNEL_KEY literal. */
export const WATCHDOG_TUNNEL_KEY = "__braid_watchdog_tunnel";

export type WatchdogTunnelStatus = "up" | "down" | "unknown";

/**
 * Hub protocol mirrored verbatim by core (global-state.ts). The hub object
 * lives at globalThis[WATCHDOG_TUNNEL_KEY]; whichever side runs first
 * (telegram publish or core subscribe) get-or-creates it with this shape.
 */
export interface WatchdogTunnelHub {
  /** Latest published status ("unknown" until the first publish). */
  status: WatchdogTunnelStatus;
  /** Consecutive-failure count of the latest transition (0 when up/unknown). */
  failures: number;
  /** Last getUpdates error text seen (present after a down transition). */
  lastError?: string;
  /** Record a transition and notify every subscriber (synchronous). */
  publish(event: WatchdogTunnelStatusEvent): void;
  /** Register a listener; returns an unsubscribe function. */
  subscribe(fn: (event: WatchdogTunnelStatusEvent) => void): () => void;
}

/** Build the hub object (get-or-create at the global slot). */
function getOrCreateTunnelHub(): WatchdogTunnelHub {
  const g = globalThis as Record<string, unknown>;
  const existing = g[WATCHDOG_TUNNEL_KEY] as WatchdogTunnelHub | undefined;
  if (existing && typeof existing?.publish === "function") return existing;

  const subs = new Set<(event: WatchdogTunnelStatusEvent) => void>();
  let status: WatchdogTunnelStatus = "unknown";
  let failures = 0;
  let lastError: string | undefined;

  const hub: WatchdogTunnelHub = {
    get status() {
      return status;
    },
    get failures() {
      return failures;
    },
    get lastError() {
      return lastError;
    },
    publish(event) {
      status = event.status;
      failures = event.failures;
      if (event.lastError !== undefined) lastError = event.lastError;
      for (const fn of [...subs]) {
        try {
          fn(event);
        } catch {
          // A subscriber must never break the bus — the canary keeps running.
        }
      }
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
  g[WATCHDOG_TUNNEL_KEY] = hub;
  return hub;
}

/**
 * Publish a tunnel liveness transition into the shared watchdog hub.
 * Get-or-create so a first publish before core's watchdog subscribes is never
 * lost for later subscribers (they receive the current status on subscribe —
 * subscribers are called on every subsequent publish; the core watchdog reads
 * the latest status on session_start via getWatchdogTunnelStatus).
 */
export function publishWatchdogTunnel(event: WatchdogTunnelStatusEvent): void {
  const hub = getOrCreateTunnelHub();
  hub.publish(event);
}
