/**
 * watchdog-tunnel.test.mjs — cross-package tunnel bridge (telegram side).
 *
 * Verifies publishWatchdogTunnel writes to the shared process-global hub at
 * WATCHDOG_TUNNEL_KEY, notifies subscribers on every transition, unsubscribe
 * stops delivery, and get-or-create is idempotent (a later publish never
 * replaces the hub core's watchdog subscribed to). NO network, pure local.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WATCHDOG_TUNNEL_KEY,
  publishWatchdogTunnel,
} from "../dist/lib/watchdog-tunnel.js";

function hubFromGlobal(key = WATCHDOG_TUNNEL_KEY) {
  return globalThis[key];
}

test("publishWatchdogTunnel records the transition at the shared global slot", () => {
  delete globalThis[WATCHDOG_TUNNEL_KEY];
  publishWatchdogTunnel({
    status: "down",
    failures: 3,
    lastError: "Conflict: terminated",
    message:
      "Telegram tunnel DOWN: 3 consecutive getUpdates failures (Conflict: terminated).",
  });

  const hub = hubFromGlobal();
  assert.ok(hub, "hub is published at WATCHDOG_TUNNEL_KEY");
  assert.equal(hub.status, "down");
  assert.equal(hub.failures, 3);
  assert.equal(hub.lastError, "Conflict: terminated");
});

test("subscribers receive every transition; unsubscribe stops delivery", () => {
  delete globalThis[WATCHDOG_TUNNEL_KEY];
  // Prime the hub exactly like the core watchdog's subscribe path would.
  publishWatchdogTunnel({ status: "up", failures: 0, message: "init" });
  const hub = hubFromGlobal();
  const received = [];
  const unsub = hub.subscribe((e) => received.push(e));

  publishWatchdogTunnel({ status: "down", failures: 3, message: "down!" });
  publishWatchdogTunnel({ status: "up", failures: 0, message: "up!" });

  assert.equal(hub.status, "up", "latest status wins");
  assert.equal(received.length, 2);
  assert.equal(received[0].status, "down");
  assert.equal(received[0].failures, 3);
  assert.equal(received[1].status, "up");

  unsub();
  publishWatchdogTunnel({
    status: "down",
    failures: 4,
    message: "down again!",
  });
  assert.equal(received.length, 2, "unsubscribed listener stopped receiving");
  assert.equal(hub.status, "down", "status still updates after unsub");
});

test("get-or-create is idempotent: a later publish never replaces the hub", () => {
  delete globalThis[WATCHDOG_TUNNEL_KEY];
  publishWatchdogTunnel({ status: "up", failures: 0, message: "a" });
  const hubBefore = hubFromGlobal();
  publishWatchdogTunnel({ status: "down", failures: 3, message: "b" });
  assert.equal(
    hubFromGlobal(),
    hubBefore,
    "same hub instance across publishes",
  );
});

test("a subscriber throwing does not break the bus for other subscribers", () => {
  delete globalThis[WATCHDOG_TUNNEL_KEY];
  publishWatchdogTunnel({ status: "up", failures: 0, message: "init" });
  const hub = hubFromGlobal();
  const received = [];
  hub.subscribe(() => {
    throw new Error("subscriber boom");
  });
  hub.subscribe((e) => received.push(e));
  publishWatchdogTunnel({ status: "down", failures: 3, message: "x" });
  assert.equal(received.length, 1, "failing subscriber is isolated");
});
