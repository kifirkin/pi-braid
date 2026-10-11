/**
 * collision-aware.test.mjs — inbound delivery in both session states (owner
 * report): owner messages steer by policy. ONE call shape
 * (sendUserMessage(..., { deliverAs: "steer" })) is correct whether the
 * session is idle or busy, so both states join the same coalescing window and
 * it closes into one steer delivery (BRAID_TG_COALESCE_WINDOW_MS, injected
 * small here). The old collision (a new owner request queued extension-side
 * until the next idle boundary) is gone; the hold survives only for a handoff
 * that fails.
 *
 * The idle answer comes from the ExtensionContext (`ctx.isIdle()`), captured
 * by the lifecycle handlers; the poller callbacks have no context of their own.
 *
 * Driven through the real poller (BRAID_TG_POLL_ENABLED=1 + fake fetch) with a
 * fake pi exposing the shipped extension-API shape (no isIdle member) and a
 * fake agent_settled emitter carrying a controllable context.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import telegramExtension, {
  ENV_TOKEN,
  ENV_CHAT_ID,
  ENV_ALLOWED_USERS,
  ENV_POLL_ENABLED,
  ENV_POLL_DISABLED,
  ENV_STATE_FILE,
  ENV_POLL_INTERVAL_MS,
  ENV_COALESCE_WINDOW_MS,
} from "../dist/index.js";
import {
  BOT_TOKEN,
  OWNER_ID,
  OWNER_CHAT_ID,
  makeUpdate,
  getUpdatesResult,
  jsonResponse,
  makeFakeFetch,
} from "./fixtures.mjs";
import { sleep, waitFor } from "./helpers/poll.mjs";

/** Set process.env for the duration of fn, restoring every prior value after. */
function withEnv(pairs, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(pairs)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  let result;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  // Sync closure: close the window synchronously (legacy contract). Async
  // closure (the async extension factory): keep the env open until it settles.
  if (result && typeof result.then === "function") {
    return result.finally(restore);
  }
  restore();
  return result;
}

function tmpStateFile(prefix) {
  return join(
    tmpdir(),
    `tg-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    "telegram-state.json",
  );
}

/**
 * Fake pi for the collision tests: the factory's full surface (tools,
 * commands, on/emit, sendUserMessage) and NO isIdle member — the shipped
 * ExtensionAPI has none, and the idle answer comes from the context instead.
 * `emit` forwards the context a lifecycle handler would receive.
 */
function makeCollisionPi() {
  const handlers = new Map();
  const messages = [];
  const commands = [];
  const pi = {
    tools: [],
    handlers,
    messages,
    commands,
    registerTool: (tool) => pi.tools.push(tool),
    registerCommand: (name, options) => pi.commands.push({ name, ...options }),
    sendUserMessage: (...args) => messages.push(args),
    on: (event, fn) =>
      handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    emit: (event, ...args) => {
      for (const fn of handlers.get(event) ?? []) fn(...args);
    },
  };
  return pi;
}

/** Context whose idle answer the test controls (the supported surface). */
function makeCtx(idle) {
  return {
    ui: { notify() {} },
    isIdle: () => idle,
  };
}

/**
 * Fake fetch serving `updates` on the FIRST getUpdates call, then empty.
 * `served()` reports whether the owner batch has been handed to the poller.
 */
function makeOwnerFetch(updates) {
  let served = false;
  const fetchFn = makeFakeFetch(async (url) => {
    if (url.includes("getUpdates")) {
      if (!served) {
        served = true;
        return jsonResponse(getUpdatesResult(updates));
      }
      return jsonResponse(getUpdatesResult([]));
    }
    return jsonResponse(getUpdatesResult([]));
  });
  fetchFn.served = () => served;
  return fetchFn;
}

/** Env for every collision test: poller opt-in, owner allow-list, fake token. */
function collisionEnv() {
  return {
    [ENV_TOKEN]: BOT_TOKEN,
    TELEGRAM_BOT_TOKEN: undefined,
    [ENV_CHAT_ID]: String(OWNER_CHAT_ID),
    TELEGRAM_CHAT_ID: undefined,
    [ENV_ALLOWED_USERS]: String(OWNER_ID),
    TELEGRAM_ALLOWED_USERS: undefined,
    [ENV_POLL_ENABLED]: "1",
    TELEGRAM_POLL_ENABLED: undefined,
    [ENV_POLL_DISABLED]: undefined,
    TELEGRAM_POLL_DISABLED: undefined,
    [ENV_STATE_FILE]: tmpStateFile("collision"),
    TELEGRAM_STATE_FILE: undefined,
    [ENV_POLL_INTERVAL_MS]: "200",
    TELEGRAM_POLL_INTERVAL_MS: undefined,
    [ENV_COALESCE_WINDOW_MS]: "50",
    TELEGRAM_COALESCE_WINDOW_MS: undefined,
  };
}

test("collision-aware: idle → delivered at the window close with steer envelope", async () => {
  const pi = makeCollisionPi();
  const fetchFn = makeOwnerFetch([makeUpdate(201, { text: "idle ping" })]);
  await withEnv(collisionEnv(), async () => {
    await telegramExtension(pi, { fetch: fetchFn });
  });

  try {
    pi.emit(
      "session_start",
      { type: "session_start", reason: "new" },
      makeCtx(true),
    );
    await waitFor(() => pi.messages.length >= 1, 3000);
    assert.equal(pi.messages.length, 1, "idle → delivered (window closed)");
    const [content, options] = pi.messages[0];
    assert.equal(options?.deliverAs, "steer", "steer into the current turn");
    // Envelope prefix with the T3 send-time clock (`@ HH:MM TZ`).
    assert.match(
      content,
      /^\[braid-whisper - telegram @ \d{2}:\d{2} [^\]]+\]/,
      "whisper envelope with send-time clock preserved",
    );
    assert.ok(
      content.includes("idle ping"),
      "formatted whisper body carries the owner text",
    );
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("collision-aware: busy → delivered at window close as a steer into the running turn", async () => {
  const pi = makeCollisionPi();
  const fetchFn = makeOwnerFetch([makeUpdate(202, { text: "busy ping" })]);
  await withEnv(collisionEnv(), async () => {
    await telegramExtension(pi, { fetch: fetchFn });
  });

  try {
    pi.emit(
      "session_start",
      { type: "session_start", reason: "new" },
      makeCtx(false),
    );
    await waitFor(() => pi.messages.length >= 1, 3000);
    assert.equal(
      pi.messages.length,
      1,
      "busy → the steer leaves at window close, no settle needed",
    );
    const [content, options] = pi.messages[0];
    assert.equal(options?.deliverAs, "steer");
    assert.ok(
      content.includes("busy ping"),
      "the owner message, not a stale one",
    );

    // The settle boundary has nothing left to hand over.
    pi.emit("agent_settled", { type: "agent_settled" }, makeCtx(true));
    assert.equal(pi.messages.length, 1, "nothing re-delivered at settle");
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("collision-aware: a busy burst leaves as ONE combined steer, in arrival order", async () => {
  const pi = makeCollisionPi();
  const fetchFn = makeOwnerFetch([
    makeUpdate(203, { text: "first" }),
    makeUpdate(204, { text: "second" }),
  ]);
  await withEnv(collisionEnv(), async () => {
    await telegramExtension(pi, { fetch: fetchFn });
  });

  try {
    pi.emit(
      "session_start",
      { type: "session_start", reason: "new" },
      makeCtx(false),
    );
    await waitFor(() => pi.messages.length >= 1, 3000);
    await sleep(100); // past the window: no second delivery may follow
    assert.equal(
      pi.messages.length,
      1,
      "ONE combined message at the window boundary (no activeRun race)",
    );
    assert.ok(pi.messages[0][0].includes("first"), "arrival order: first");
    assert.ok(pi.messages[0][0].includes("second"), "arrival order: second");
    assert.ok(
      pi.messages[0][0].indexOf("first") < pi.messages[0][0].indexOf("second"),
      "both parts carried by the one delivery, in arrival order",
    );

    pi.emit("agent_settled", { type: "agent_settled" }, makeCtx(true));
    assert.equal(
      pi.messages.length,
      1,
      "the batch was handed over whole; nothing left to flush",
    );
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("collision-aware: busy delivery does not throw — the steer reaches the running turn", async () => {
  const pi = makeCollisionPi();
  const fetchFn = makeOwnerFetch([makeUpdate(205, { text: "no throw" })]);
  await withEnv(collisionEnv(), async () => {
    await telegramExtension(pi, { fetch: fetchFn });
  });

  try {
    pi.emit(
      "session_start",
      { type: "session_start", reason: "new" },
      makeCtx(false),
    );
    await waitFor(() => pi.messages.length >= 1, 3000);
    assert.equal(
      pi.messages.length,
      1,
      "busy → the steer is delivered, nothing thrown",
    );

    // A settle emission with an empty hold must not deliver or throw.
    assert.doesNotThrow(() =>
      pi.emit("agent_settled", { type: "agent_settled" }, makeCtx(false)),
    );
    assert.equal(pi.messages.length, 1, "nothing left to flush");
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});
