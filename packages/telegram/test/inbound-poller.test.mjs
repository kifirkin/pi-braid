/**
 * inbound-poller.test.mjs — allow-list filtering, bootstrap, confirm-on-read
 * offset persistence, retry-on-injection-failure. Driven through a fake
 * getUpdates server. NO network, no real timers (pollOnce only).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyUpdate,
  createInboundPoller,
  createThrottledLogger,
  formatTunnelDownMessage,
  formatTunnelRecoveryMessage,
  PAUSED_INBOUND_ACK_TEXT,
} from "../dist/lib/inbound-poller.js";

import {
  BOT_TOKEN,
  FOREIGN_ID,
  OWNER_CHAT_ID,
  OWNER_ID,
  jsonResponse,
  makeFakeFetch,
  makeUpdate,
  makeCallbackUpdate,
  makeUpdatesServer,
} from "./fixtures.mjs";

let stateFile;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "tg-poller-"));
  stateFile = join(dir, "state.json");
});

function makePoller({ fetchFn, allowedUsers = [], bootstrap = true } = {}) {
  const injected = [];
  const failRemaining = new Map(); // updateId -> remaining failures
  return {
    injected,
    /** Make the next `times` injections of this updateId throw. */
    setFailures({ updateId, times }) {
      failRemaining.set(updateId, times);
    },
    poller: createInboundPoller({
      token: BOT_TOKEN,
      allowedUsers,
      stateFile,
      fetchFn,
      bootstrap,
      onOwnerMessage: async (msg) => {
        const rem = failRemaining.get(msg.updateId) ?? 0;
        if (rem > 0) {
          failRemaining.set(msg.updateId, rem - 1);
          throw new Error("injection boom");
        }
        injected.push(msg);
      },
      onError: () => {},
    }),
  };
}

function readState() {
  return JSON.parse(readFileSync(stateFile, "utf8"));
}

/** Record every log call so tests can assert per-level counts. */
function spyLog() {
  const calls = [];
  const log = (level, message, ..._rest) => calls.push({ level, message });
  log.calls = calls;
  return log;
}

/** Simple fake clock so throttle-window tests need no real waits. */
function makeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

test("classifyUpdate: pure verdicts for owner / foreign / bootstrap / policy filters", () => {
  const owner = makeUpdate(1);
  const foreign = makeUpdate(2, {
    from: { id: FOREIGN_ID, is_bot: false },
    chat: { id: 9, type: "private" },
  });
  const group = makeUpdate(3, { chat: { id: 9, type: "group" } });
  const edited = { update_id: 4, edited_message: {} };
  const noText = makeUpdate(5, { text: "   " });

  assert.equal(classifyUpdate(owner, [111222333], false), "owner");
  assert.equal(classifyUpdate(foreign, [111222333], false), "foreign");
  assert.equal(classifyUpdate(owner, [], true), "bootstrap");
  assert.equal(classifyUpdate(group, [111222333], false), "non_private");
  assert.equal(classifyUpdate(edited, [111222333], false), "non_message");
  assert.equal(classifyUpdate(noText, [111222333], false), "non_text");
});

test("isAllowed matches numeric id, @username, and bare username forms", async () => {
  const { isAllowed } = await import("../dist/lib/inbound-poller.js");
  const from = { id: 123, username: "kifir" };
  assert.equal(isAllowed(from, [123]), true);
  assert.equal(isAllowed(from, ["@kifir"]), true);
  assert.equal(isAllowed(from, ["kifir"]), true);
  assert.equal(isAllowed(from, ["@someone_else", 999]), false);
});

test("pollOnce: accepts owner text, injects it, advances and persists offset", async () => {
  const updates = [makeUpdate(1), makeUpdate(2), makeUpdate(3)];
  const fetchFn = makeFakeFetch(makeUpdatesServer(updates));
  const h = makePoller({ fetchFn, allowedUsers: [111222333] });

  const r = await h.poller.pollOnce();

  assert.equal(r.ok, true);
  assert.equal(r.fetched, 3);
  assert.equal(r.accepted, 3);
  assert.equal(r.rejected, 0);
  assert.equal(h.injected.length, 3);
  assert.equal(h.injected[0].text, "hello from owner");
  assert.equal(h.injected[0].fromId, 111222333);
  assert.equal(r.offset, 4); // confirm-on-read: max update_id + 1
  assert.equal(existsSync(stateFile), true);
  assert.equal(readState().offset, 4);

  // Second poll with the same server returns nothing -> offset unchanged.
  const r2 = await h.poller.pollOnce();
  assert.equal(r2.fetched, 0);
  assert.equal(r2.offset, 4);
});

test("pollOnce: foreign senders are ignored but dropped (offset still advances)", async () => {
  const updates = [
    makeUpdate(1),
    makeUpdate(2, { from: { id: FOREIGN_ID, is_bot: false } }),
  ];
  const fetchFn = makeFakeFetch(makeUpdatesServer(updates));
  const h = makePoller({ fetchFn, allowedUsers: [111222333] });

  const r = await h.poller.pollOnce();

  assert.equal(r.accepted, 1);
  assert.equal(r.rejected, 1);
  assert.equal(h.injected.length, 1);
  assert.equal(h.injected[0].fromId, 111222333);
  assert.equal(r.offset, 3); // foreign update confirmed (dropped)
});

test("pollOnce: filters group/non-text/non-message updates without injection", async () => {
  const updates = [
    makeUpdate(1, { chat: { id: 9, type: "group" } }),
    makeUpdate(2, { text: "" }),
    { update_id: 3, edited_message: { message_id: 9 } },
    makeUpdate(4), // valid owner text
  ];
  const fetchFn = makeFakeFetch(makeUpdatesServer(updates));
  const h = makePoller({ fetchFn, allowedUsers: [111222333] });

  const r = await h.poller.pollOnce();

  assert.equal(r.accepted, 1);
  assert.equal(r.rejected, 3);
  assert.equal(h.injected.length, 1);
  assert.equal(r.offset, 5);
});

test("pollOnce: first-message bootstrap auto-allows the first private text sender", async () => {
  const updates = [
    makeUpdate(1, {
      from: { id: 777, is_bot: false },
      chat: { id: 11, type: "private" },
    }),
    makeUpdate(2, {
      from: { id: FOREIGN_ID, is_bot: false },
      chat: { id: 22, type: "private" },
    }),
  ];
  const fetchFn = makeFakeFetch(makeUpdatesServer(updates));
  const h = makePoller({ fetchFn, allowedUsers: [], bootstrap: true });

  const r = await h.poller.pollOnce();

  assert.deepEqual(r.bootstrapped, [777]);
  assert.equal(r.accepted, 1); // 777 allowed + injected
  assert.equal(r.rejected, 1); // 444555666 now foreign (allow-list no longer empty)
  assert.equal(h.injected.length, 1);
  assert.equal(h.injected[0].fromId, 777);
});

test("pollOnce: bootstrap=false with empty allow-list rejects everyone", async () => {
  const updates = [makeUpdate(1), makeUpdate(2)];
  const fetchFn = makeFakeFetch(makeUpdatesServer(updates));
  const h = makePoller({ fetchFn, allowedUsers: [], bootstrap: false });

  const r = await h.poller.pollOnce();
  assert.equal(r.accepted, 0);
  assert.equal(r.rejected, 2);
  assert.equal(h.injected.length, 0);
});

test("confirm-on-read: failed injection is requeued locally and retried next cycle", async () => {
  const updates = [makeUpdate(1, { text: "must not be lost" })];
  const fetchFn = makeFakeFetch(makeUpdatesServer(updates));
  const h = makePoller({ fetchFn, allowedUsers: [111222333] });
  h.setFailures({ updateId: 1, times: 1 }); // first injection fails once

  const r1 = await h.poller.pollOnce();
  assert.equal(r1.accepted, 0);
  assert.equal(r1.requeued, 1);
  assert.equal(r1.offset, 2); // Telegram offset still advanced (monotonic)

  // Offset advanced -> Telegram returns nothing, but the local retry buffer
  // delivers the failed message on the next cycle.
  const r2 = await h.poller.pollOnce();
  assert.equal(r2.fetched, 0);
  assert.equal(r2.retried, 1);
  assert.equal(h.injected.length, 1);
  assert.equal(h.injected[0].text, "must not be lost");
});

test("pollOnce: getUpdates API error returns ok:false and does not crash", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse({ ok: false, description: "Conflict: terminated" }, 409),
  );
  let errors = 0;
  const poller = createInboundPoller({
    token: BOT_TOKEN,
    allowedUsers: [111222333],
    stateFile,
    fetchFn,
    onOwnerMessage: async () => {},
    onError: () => {
      errors++;
    },
  });

  const r = await poller.pollOnce();
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(errors, 1);
});

test("offset survives restarts: a new poller resumes from the persisted offset", async () => {
  // First poller consumes updates 1..2 and persists offset=3.
  const updates = [makeUpdate(1), makeUpdate(2)];
  const server = makeUpdatesServer(updates);
  const h1 = makePoller({
    fetchFn: makeFakeFetch(server),
    allowedUsers: [111222333],
  });
  await h1.poller.pollOnce();
  assert.equal(readState().offset, 3);

  // New poller (simulated restart) points at the same state file. The fake
  // server still holds the same updates, but the restarted poller must start
  // at offset 3 and therefore skip them.
  const h2 = makePoller({
    fetchFn: makeFakeFetch(server),
    allowedUsers: [111222333],
  });
  await h2.poller.waitReady();
  assert.equal(h2.poller.getState().offset, 3);
  const r = await h2.poller.pollOnce();
  assert.equal(r.fetched, 0);
  assert.equal(r.offset, 3);
  assert.equal(h2.injected.length, 0);
});

test("start/stop lifecycle toggles isRunning without overlap", async () => {
  const fetchFn = makeFakeFetch(makeUpdatesServer([]));
  const h = makePoller({
    fetchFn,
    allowedUsers: [111222333],
    bootstrap: false,
  });
  assert.equal(h.poller.isRunning(), false);
  h.poller.start();
  assert.equal(h.poller.isRunning(), true);
  h.poller.stop();
  assert.equal(h.poller.isRunning(), false);
  h.poller.stop(); // idempotent
  assert.equal(h.poller.isRunning(), false);
});

test("createThrottledLogger: first occurrence loud, repeats emit ZERO output until the window re-promotes (16d)", () => {
  const clock = makeClock();
  const log = spyLog();
  const t = createThrottledLogger(log, 5 * 60 * 1000, clock.now);

  // First occurrence -> loud warn with full detail.
  assert.equal(
    t.occurrence("warn", "getUpdates failed (offset 0): Conflict"),
    true,
  );
  assert.deepEqual(
    log.calls.map((c) => c.level),
    ["warn"],
  );
  assert.match(
    log.calls[0].message,
    /getUpdates failed \(offset 0\): Conflict/,
  );

  // Consecutive repeats inside the window -> ZERO log calls at all: no debug,
  // no counter line (nothing may render per cycle).
  assert.equal(
    t.occurrence("warn", "getUpdates failed (offset 0): Conflict"),
    false,
  );
  assert.equal(
    t.occurrence("warn", "getUpdates failed (offset 0): Conflict"),
    false,
  );
  assert.equal(
    t.occurrence("warn", "getUpdates failed (offset 0): Conflict"),
    false,
  );
  assert.equal(log.calls.length, 1, "no log call after the first warn");

  // A full window elapses -> re-promotes to warn exactly once (still the same burst).
  clock.advance(5 * 60 * 1000);
  assert.equal(
    t.occurrence("warn", "getUpdates failed (offset 0): Conflict"),
    true,
  );
  assert.deepEqual(
    log.calls.map((c) => c.level),
    ["warn", "warn"],
  );

  // Back to complete silence within the newly opened window.
  assert.equal(
    t.occurrence("warn", "getUpdates failed (offset 0): Conflict"),
    false,
  );
  assert.equal(
    t.occurrence("warn", "getUpdates failed (offset 0): Conflict"),
    false,
  );
  assert.deepEqual(
    log.calls.map((c) => c.level),
    ["warn", "warn"],
  );
});

test("createThrottledLogger: a burst that ages out resets so the next burst is loud again", () => {
  const clock = makeClock();
  const log = spyLog();
  const t = createThrottledLogger(log, 5 * 60 * 1000, clock.now);

  t.occurrence("warn", "boom"); // loud
  t.occurrence("warn", "boom"); // silent repeat (16d: zero output)
  clock.advance(6 * 60 * 1000); // no occurrence for > a full window
  assert.equal(t.occurrence("warn", "boom"), true); // next burst loud again
  assert.equal(t.occurrence("warn", "boom"), false); // silent again
  assert.equal(log.calls.length, 2, "only the two loud warms; no silent lines");
  assert.equal(log.calls[1].message, "boom"); // loud: raw full-detail message, no throttle suffix
  assert.ok(!log.calls[1].message.includes("throttled"));
});

test("createThrottledLogger: streak counts consecutive errors and reset clears for recovery", () => {
  const clock = makeClock();
  const log = spyLog();
  const t = createThrottledLogger(log, 5 * 60 * 1000, clock.now);

  assert.equal(t.streak(), 0, "clean before any occurrence");
  t.occurrence("warn", "boom"); // loud
  t.occurrence("warn", "boom"); // silent repeat (16d: zero output)
  t.occurrence("warn", "boom"); // silent repeat
  assert.equal(t.streak(), 3);
  assert.equal(log.calls.length, 1, "one loud warn, then silence");

  // Sustain the burst: advance by 180s (< 300s window) between occurrences, so
  // the burst never ages out but a full window since the last loud emission
  // elapses -> the error re-warns once while the streak keeps growing.
  clock.advance(3 * 60 * 1000); // 180s since last occurrence
  t.occurrence("warn", "boom"); // still quiet: only 180s since loud
  assert.equal(t.streak(), 4);
  clock.advance(3 * 60 * 1000); // 360s since last loud -> re-loud once
  assert.equal(t.occurrence("warn", "boom"), true);
  assert.equal(t.streak(), 5, "streak grows across a window re-promotion");
  assert.equal(
    log.calls.length,
    2,
    "exactly two loud warms, zero silent lines",
  );
  assert.equal(log.calls[1].level, "warn");

  // Sustained error cleared -> reset() clears the streak (recovery path).
  t.reset();
  assert.equal(t.streak(), 0);
  assert.equal(
    t.occurrence("warn", "boom"),
    true,
    "post-recovery burst is loud again",
  );
  assert.equal(t.streak(), 1);
});

test("watchdog tunnel: 3 consecutive failures trip one down event; recovery emits one up event", async () => {
  let failing = true;
  const fetchFn = makeFakeFetch(async () =>
    failing
      ? jsonResponse({ ok: false, description: "Conflict: terminated" }, 409)
      : jsonResponse({ ok: true, result: [] }, 200),
  );
  const events = [];
  const poller = createInboundPoller({
    token: BOT_TOKEN,
    allowedUsers: [111222333],
    stateFile,
    fetchFn,
    onOwnerMessage: async () => {},
    onError: () => {},
    onTunnelStatusChange: (e) => events.push(e),
  });

  // Unknown before the first poll attempt.
  assert.deepEqual(poller.getTunnelStatus(), {
    status: "unknown",
    failures: 0,
  });

  // One and two failures stay healthy (below the default threshold of 3).
  await poller.pollOnce();
  assert.deepEqual(poller.getTunnelStatus(), { status: "up", failures: 0 });
  await poller.pollOnce();
  assert.equal(events.length, 0, "no down event below the threshold");

  // Third consecutive failure trips exactly one down event with the details.
  await poller.pollOnce();
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "down");
  assert.equal(events[0].failures, 3);
  assert.match(
    events[0].message,
    /Telegram tunnel DOWN: 3 consecutive getUpdates failures \(Conflict: terminated\)/,
  );
  assert.deepEqual(poller.getTunnelStatus(), { status: "down", failures: 3 });

  // Sustained failures do NOT re-emit the down event (one event per outage).
  await poller.pollOnce();
  await poller.pollOnce();
  assert.equal(events.length, 1);

  // First successful poll after the outage emits exactly one up (recovery).
  failing = false;
  await poller.pollOnce();
  assert.equal(events.length, 2);
  assert.equal(events[1].status, "up");
  assert.equal(events[1].failures, 0);
  assert.match(
    events[1].message,
    /Telegram tunnel recovered after 5 consecutive getUpdates failures/,
  );
  assert.deepEqual(poller.getTunnelStatus(), { status: "up", failures: 0 });

  // Healthy polls stay silent (recovery fired exactly once).
  await poller.pollOnce();
  assert.equal(events.length, 2);
});

test("watchdog tunnel: configurable threshold trips down at that count only", async () => {
  let failing = true;
  const fetchFn = makeFakeFetch(async () =>
    failing
      ? jsonResponse({ ok: false, description: "boom" }, 500)
      : jsonResponse({ ok: true, result: [] }, 200),
  );
  const events = [];
  const poller = createInboundPoller({
    token: BOT_TOKEN,
    allowedUsers: [111222333],
    stateFile,
    fetchFn,
    tunnelFailureThreshold: 2,
    onOwnerMessage: async () => {},
    onError: () => {},
    onTunnelStatusChange: (e) => events.push(e),
  });

  await poller.pollOnce(); // failure 1 — below threshold 2
  assert.equal(events.length, 0);
  await poller.pollOnce(); // failure 2 — trips down
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "down");
  assert.equal(events[0].failures, 2);
});

test("watchdog tunnel: getUpdates conflict with healthy getMe is NOT a tunnel failure", async () => {
  // Sibling-consumer scenario: a
  // second getUpdates consumer holds the singleton long-poll slot, so every
  // getUpdates cycle fails with 409 Conflict — but the API itself is up,
  // proven by the getMe liveness probe (which never takes the getUpdates
  // slot). The canary must not bark.
  const fetchFn = makeFakeFetch(async (url) => {
    if (String(url).includes("/getUpdates")) {
      return jsonResponse(
        {
          ok: false,
          description: "Conflict: terminated by other getUpdates request",
        },
        409,
      );
    }
    return jsonResponse(
      {
        ok: true,
        result: {
          id: 555555,
          is_bot: true,
          first_name: "braid",
          username: "braid_test_bot",
        },
      },
      200,
    );
  });
  const events = [];
  const poller = createInboundPoller({
    token: BOT_TOKEN,
    allowedUsers: [111222333],
    stateFile,
    fetchFn,
    onOwnerMessage: async () => {},
    onError: () => {},
    onTunnelStatusChange: (e) => events.push(e),
  });

  // Sustained conflict storm: liveness is proven up every cycle, so no
  // failure accumulates and no down event ever trips.
  for (let i = 0; i < 6; i++) await poller.pollOnce();
  assert.equal(
    events.length,
    0,
    "no tunnel-down while getMe proves the tunnel up",
  );
  assert.deepEqual(poller.getTunnelStatus(), { status: "up", failures: 0 });
  assert.ok(
    fetchFn.calls.some((c) => c.url.includes("/getMe")),
    "liveness probed via getMe on the failure path",
  );
});

test("watchdog tunnel: getMe liveness recovers an open down state without a successful getUpdates", async () => {
  // Phase 1: genuine outage (getUpdates AND getMe both fail) trips down.
  // Phase 2: API recovers (getMe ok) while getUpdates stays conflicted —
  // the open down state recovers exactly once, from the liveness probe.
  let apiUp = false;
  const fetchFn = makeFakeFetch(async (url) => {
    if (apiUp && !String(url).includes("/getUpdates")) {
      return jsonResponse(
        { ok: true, result: { id: 555555, is_bot: true } },
        200,
      );
    }
    return jsonResponse({ ok: false, description: "boom" }, 500);
  });
  const events = [];
  const poller = createInboundPoller({
    token: BOT_TOKEN,
    allowedUsers: [111222333],
    stateFile,
    fetchFn,
    tunnelFailureThreshold: 2,
    onOwnerMessage: async () => {},
    onError: () => {},
    onTunnelStatusChange: (e) => events.push(e),
  });

  await poller.pollOnce(); // failure 1
  await poller.pollOnce(); // failure 2 — trips down
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "down");

  // API comes back (getMe ok) while getUpdates stays failing: recovery.
  apiUp = true;
  await poller.pollOnce();
  assert.equal(events.length, 2);
  assert.equal(events[1].status, "up");
  assert.equal(events[1].failures, 0);
  assert.deepEqual(poller.getTunnelStatus(), { status: "up", failures: 0 });

  // Still-conflicted cycles stay silent (no re-emission, no re-counting).
  await poller.pollOnce();
  assert.equal(events.length, 2);
  assert.deepEqual(poller.getTunnelStatus(), { status: "up", failures: 0 });
});

test("watchdog tunnel: message formatters are deterministic", () => {
  assert.match(
    formatTunnelDownMessage(3, "Conflict"),
    /Telegram tunnel DOWN: 3 consecutive getUpdates failures \(Conflict\)/,
  );
  assert.match(formatTunnelDownMessage(3), /unknown error/);
  assert.match(
    formatTunnelRecoveryMessage(3),
    /Telegram tunnel recovered after 3 consecutive getUpdates failures/,
  );
  assert.match(
    formatTunnelRecoveryMessage(1),
    /after 1 consecutive getUpdates failure/,
  );
});

test("pollOnce: repeated getUpdates failures log ONE warn then zero further calls; recovery emits one info", async () => {
  // Persistent conflicting-consumer failure (owner-reported scenario): the fake
  // getUpdates always answers 409 Conflict until we flip `failing` off — at
  // which point the sustained error clears and ops expects one recovery line.
  let failing = true;
  const fetchFn = makeFakeFetch(async () =>
    failing
      ? jsonResponse(
          {
            ok: false,
            description: "Conflict: terminated by another getUpdates request",
          },
          409,
        )
      : jsonResponse({ ok: true, result: [] }, 200),
  );
  const log = spyLog();
  let errors = 0;
  const poller = createInboundPoller({
    token: BOT_TOKEN,
    allowedUsers: [111222333],
    stateFile,
    fetchFn,
    onOwnerMessage: async () => {},
    onError: () => {
      errors++;
    },
    log,
  });

  // 5 consecutive identical failures within the throttle window.
  for (let i = 0; i < 5; i++) {
    const r = await poller.pollOnce();
    assert.equal(r.ok, false);
  }

  assert.equal(errors, 1, "onError is gated on the loud occurrence only");
  assert.equal(
    log.calls.length,
    1,
    "exactly ONE warn for five failures, zero per-cycle lines (16d)",
  );
  assert.equal(log.calls[0].level, "warn");
  assert.match(
    log.calls[0].message,
    /getUpdates failed \(offset 0\): Conflict/,
  );

  // Sustained error clears -> ONE info recovery line, then silence.
  failing = false;
  const r = await poller.pollOnce();
  assert.equal(r.ok, true);
  assert.equal(log.calls.length, 2);
  assert.equal(log.calls[1].level, "info");
  assert.match(
    log.calls[1].message,
    /telegram getUpdates recovered after 5 errors/,
  );

  // Subsequent healthy polls stay silent (recovery fired exactly once).
  await poller.pollOnce();
  assert.equal(log.calls.length, 2);
});

// ── Callback_query routing ──────────────────────────────────────────────────

test("pollOnce: allow-listed callback_query routes to onCallbackQuery (never onOwnerMessage)", async () => {
  const updates = [
    makeUpdate(1, { text: "normal message" }),
    makeCallbackUpdate(2, "pause"),
  ];
  const fetchFn = makeFakeFetch(makeUpdatesServer(updates));
  const injected = [];
  const callbacks = [];
  const poller = createInboundPoller({
    token: BOT_TOKEN,
    allowedUsers: [111222333],
    stateFile,
    fetchFn,
    onOwnerMessage: async (msg) => injected.push(msg),
    onCallbackQuery: async (update) => callbacks.push(update.callback_query),
    onError: () => {},
  });

  const r = await poller.pollOnce();

  assert.equal(r.ok, true);
  assert.equal(r.accepted, 1);
  assert.equal(r.callbacks, 1);
  assert.equal(r.callbackRejected, 0);
  assert.equal(r.rejected, 0);
  assert.equal(injected.length, 1, "message went to onOwnerMessage");
  assert.equal(callbacks.length, 1, "tap went to onCallbackQuery");
  assert.equal(callbacks[0].id, "cq-2");
  assert.equal(callbacks[0].data, "pause");
  assert.equal(r.offset, 3); // both updates confirmed
});

test("pollOnce: foreign callback_query is dropped, never reaches the handler", async () => {
  const updates = [
    makeCallbackUpdate(1, "pause", { fromId: FOREIGN_ID }),
    makeCallbackUpdate(2, "status"),
  ];
  const fetchFn = makeFakeFetch(makeUpdatesServer(updates));
  const callbacks = [];
  const poller = createInboundPoller({
    token: BOT_TOKEN,
    allowedUsers: [111222333],
    stateFile,
    fetchFn,
    onOwnerMessage: async () => {},
    onCallbackQuery: async (update) => callbacks.push(update.callback_query),
    onError: () => {},
  });

  const r = await poller.pollOnce();

  assert.equal(r.callbacks, 1, "only the owner's tap handled");
  assert.equal(r.callbackRejected, 1, "foreign tap dropped");
  assert.equal(r.offset, 3);
});

test("pollOnce: no onCallbackQuery handler → taps are dropped, not a turn", async () => {
  const updates = [makeCallbackUpdate(1, "pause")];
  const fetchFn = makeFakeFetch(makeUpdatesServer(updates));
  const h = makePoller({ fetchFn, allowedUsers: [111222333] });

  const r = await h.poller.pollOnce();

  assert.equal(r.callbacks, 0);
  assert.equal(r.callbackRejected, 1);
  assert.equal(h.injected.length, 0);
  assert.equal(r.offset, 2);
});

test("callback failure is requeued and retried next cycle (kind-aware retry buffer)", async () => {
  const updates = [makeCallbackUpdate(1, "pause")];
  const fetchFn = makeFakeFetch(makeUpdatesServer(updates));
  const callbacks = [];
  let attempts = 0;
  const poller = createInboundPoller({
    token: BOT_TOKEN,
    allowedUsers: [111222333],
    stateFile,
    fetchFn,
    onOwnerMessage: async () => {},
    onCallbackQuery: async (update) => {
      attempts++;
      if (attempts === 1) throw new Error("callback burst");
      callbacks.push(update.callback_query);
    },
    onError: () => {},
  });

  const r1 = await poller.pollOnce();
  assert.equal(r1.callbacks, 0);
  assert.equal(r1.requeued, 1);
  assert.equal(r1.offset, 2);

  const r2 = await poller.pollOnce();
  assert.equal(r2.retried, 1);
  assert.equal(
    r2.callbacks,
    0,
    "retried via the callback path, counted as retried",
  );
  assert.equal(callbacks.length, 1, "the failed tap was delivered on retry");
  assert.equal(callbacks[0].data, "pause");
});

// ── Pause gate ──────────────────────────────────────────────────────────────
// Non-callback owner messages are held while paused (acked «⏸ пауза» ONCE per
// paused period, never injected); callback taps are never gated (resume path).

/**
 * Fake fetch for pause-gate tests: delegates getUpdates to a makeUpdatesServer
 * (returns `queue` >= offset; mutate `fetchFn.queue` to feed more updates) and
 * records every sendMessage call, answering an ok result (or failing when
 * `opts.failAck`).
 */
function makePauseServe(initialUpdates, opts = {}) {
  const getUpdatesHandler = makeUpdatesServer(initialUpdates);
  const queue = getUpdatesHandler.queue;
  const sends = [];
  const fetchFn = async (url, init = {}) => {
    const s = String(url);
    if (s.includes("/sendMessage")) {
      sends.push({
        url: s,
        body: typeof init.body === "string" ? init.body : null,
      });
      if (opts.failAck)
        return jsonResponse({ ok: false, description: "ack boom" }, 500);
      return jsonResponse({ ok: true, result: { message_id: 900 } });
    }
    return getUpdatesHandler(s, init);
  };
  fetchFn.sends = sends;
  fetchFn.queue = queue;
  return fetchFn;
}

test("pause gate: a message while paused is held — «⏸ пауза» ack sent, onOwnerMessage never called", async () => {
  const fetchFn = makePauseServe([
    makeUpdate(1, { text: "do this while paused" }),
  ]);
  const injected = [];
  const poller = createInboundPoller({
    token: BOT_TOKEN,
    allowedUsers: [OWNER_ID],
    stateFile,
    fetchFn,
    getPauseState: async () => ({ paused: true, updatedAt: 100 }),
    onOwnerMessage: async (msg) => injected.push(msg),
    onError: () => {},
  });

  const r = await poller.pollOnce();

  assert.equal(r.ok, true);
  assert.equal(r.accepted, 0);
  assert.equal(r.paused, 1);
  assert.equal(r.rejected, 0);
  assert.equal(
    injected.length,
    0,
    "paused message must NOT reach any onOwnerMessage (→ no sendUserMessage turn)",
  );
  assert.equal(fetchFn.sends.length, 1, "exactly one pause-ack send");
  const body = JSON.parse(fetchFn.sends[0].body);
  assert.equal(body.chat_id, OWNER_CHAT_ID, "ack goes to the owner chat");
  assert.ok(body.text.includes("⏸ пауза"), "ack carries the «⏸ пауза» marker");
  assert.ok(body.text.includes("▶️ Resume"), "ack hints at the ▶️ Resume path");
});

test("pause gate: second message in the same paused period → no duplicate ack (reply-storm guard, in-batch + cross-cycle)", async () => {
  const fetchFn = makePauseServe([
    makeUpdate(1, { text: "first" }),
    makeUpdate(2, { text: "second" }),
    makeUpdate(3, { text: "third" }),
  ]);
  const injected = [];
  const poller = createInboundPoller({
    token: BOT_TOKEN,
    allowedUsers: [OWNER_ID],
    stateFile,
    fetchFn,
    getPauseState: async () => ({ paused: true, updatedAt: 42 }), // same period
    onOwnerMessage: async (msg) => injected.push(msg),
    onError: () => {},
  });

  const r1 = await poller.pollOnce();
  assert.equal(r1.paused, 3, "all three messages held, still acked once");
  assert.equal(injected.length, 0);
  assert.equal(
    fetchFn.sends.length,
    1,
    "ONE ack for the whole batch — no reply-storm",
  );
  assert.equal(
    r1.offset,
    4,
    "held messages are still confirmed (offset advances)",
  );

  // A 4th message arriving on the NEXT cycle, pause still on (same period).
  fetchFn.queue.push(makeUpdate(4, { text: "fourth" }));
  const r2 = await poller.pollOnce();
  assert.equal(r2.paused, 1);
  assert.equal(r2.accepted, 0);
  assert.equal(
    fetchFn.sends.length,
    1,
    "still ONE ack across cycles while the paused period persists",
  );
});

test("pause gate: resume callback is never gated — handled while paused, next message delivered normally", async () => {
  let pause = { paused: true, updatedAt: 1 };
  const fetchFn = makePauseServe([
    makeUpdate(1, { text: "held while paused" }),
    makeCallbackUpdate(2, "resume"),
    makeUpdate(3, { text: "delivered after resume" }),
  ]);
  const injected = [];
  const callbacks = [];
  const poller = createInboundPoller({
    token: BOT_TOKEN,
    allowedUsers: [OWNER_ID],
    stateFile,
    fetchFn,
    getPauseState: async () => pause,
    onOwnerMessage: async (msg) => injected.push(msg),
    // Orchestrator-side callback handler persists resume; the fake reader
    // reflects the flipped file (paused=false, updatedAt advanced).
    onCallbackQuery: async (update) => {
      callbacks.push(update.callback_query);
      if (update.callback_query?.data === "resume") {
        pause = { paused: false, updatedAt: 2 };
      }
    },
    onError: () => {},
  });

  const r = await poller.pollOnce();

  assert.equal(r.ok, true);
  assert.equal(
    r.callbacks,
    1,
    "resume tap routed to the callback handler even while paused",
  );
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].data, "resume");
  assert.equal(r.paused, 1, "only the pre-resume message was held");
  assert.equal(r.accepted, 1, "message after resume delivered normally");
  assert.equal(injected.length, 1);
  assert.equal(injected[0].text, "delivered after resume");
  assert.equal(
    fetchFn.sends.length,
    1,
    "one ack for the held message, no ack on the delivered one",
  );
});

test("pause gate: while not paused inbound flows exactly as before (normal delivery, no ack)", async () => {
  const fetchFn = makePauseServe([
    makeUpdate(1, { text: "normal when running" }),
  ]);
  const injected = [];
  const poller = createInboundPoller({
    token: BOT_TOKEN,
    allowedUsers: [OWNER_ID],
    stateFile,
    fetchFn,
    getPauseState: async () => ({ paused: false, updatedAt: 0 }),
    onOwnerMessage: async (msg) => injected.push(msg),
    onError: () => {},
  });

  const r = await poller.pollOnce();

  assert.equal(r.accepted, 1);
  assert.equal(r.paused, 0);
  assert.equal(r.callbacks, 0);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].text, "normal when running");
  assert.equal(fetchFn.sends.length, 0, "no pause-ack while running");
});

test("pause gate: a NEW paused period (resume then re-pause) acks exactly once again (re-arm)", async () => {
  let pause = { paused: true, updatedAt: 1 };
  const fetchFn = makePauseServe([makeUpdate(1, { text: "first period" })]);
  const injected = [];
  const poller = createInboundPoller({
    token: BOT_TOKEN,
    allowedUsers: [OWNER_ID],
    stateFile,
    fetchFn,
    getPauseState: async () => pause,
    onOwnerMessage: async (m) => injected.push(m),
    onError: () => {},
  });

  const r1 = await poller.pollOnce(); // paused period A (updatedAt 1)
  assert.equal(r1.paused, 1);
  assert.equal(fetchFn.sends.length, 1, "period A acked once");
  assert.ok(
    PAUSED_INBOUND_ACK_TEXT.includes("⏸ пауза"),
    "default ack text is the required «⏸ пауза»",
  );

  // Resume → re-pause (each transitions updatedAt), then a fresh period-B message.
  pause = { paused: false, updatedAt: 2 };
  pause = { paused: true, updatedAt: 3 };
  fetchFn.queue.push(makeUpdate(2, { text: "second period" }));
  const r2 = await poller.pollOnce();
  assert.equal(r2.paused, 1);
  assert.equal(
    fetchFn.sends.length,
    2,
    "period B re-acks exactly once (resume re-armed the gate)",
  );
  assert.equal(injected.length, 0);
});

test("pause gate: ack send failure is non-fatal — message still held (never injected), state armed", async () => {
  const fetchFn = makePauseServe([makeUpdate(1, { text: "held" })], {
    failAck: true,
  });
  const injected = [];
  const poller = createInboundPoller({
    token: BOT_TOKEN,
    allowedUsers: [OWNER_ID],
    stateFile,
    fetchFn,
    getPauseState: async () => ({ paused: true, updatedAt: 7 }),
    onOwnerMessage: async (msg) => injected.push(msg),
    onError: () => {},
  });

  const r = await poller.pollOnce();

  assert.equal(r.ok, true, "poll cycle never crashes on an ack-send failure");
  assert.equal(r.paused, 1);
  assert.equal(
    injected.length,
    0,
    "the message is still held even when the ack fails",
  );
  assert.equal(fetchFn.sends.length, 1);

  // Second message, same period: no retry-storm — the period is already armed.
  fetchFn.queue.push(makeUpdate(2, { text: "held too" }));
  await poller.pollOnce();
  assert.equal(
    fetchFn.sends.length,
    1,
    "failed ack is not re-sent every cycle (no side-effect storm)",
  );
});
