/**
 * busy-steer.test.mjs — owner messages steer into a busy session.
 *
 * The collision-aware hold that queued a new owner request until the next
 * idle boundary is gone: pi.sendUserMessage forwards deliverAs "steer" as
 * prompt()'s streamingBehavior, so ONE call shape is legal in both session
 * states (pi-core queues the message into the running turn while busy; the
 * same call starts a turn while idle). Every arrival, idle or busy, joins the
 * coalescing window, and the window's close hands the whole batch over with
 * steer semantics.
 *
 * The hold survives only as the failure fallback: a handoff pi refused
 * (compaction) re-queues the batch and re-arms the window, and a hold
 * accepted for a foreign session is dropped and reported, never delivered.
 *
 * Driven through the real poller (BRAID_TG_POLL_ENABLED=1 + a feedable fake
 * fetch) with a fake pi exposing the shipped extension-API shape (no isIdle
 * member) and a fake context carrying the idle answer and session id.
 *
 * Run: npm test -w packages/telegram  (from the repo root)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import telegramExtension, {
  ENV_TOKEN,
  ENV_CHAT_ID,
  ENV_ALLOWED_USERS,
  ENV_POLL_ENABLED,
  ENV_POLL_DISABLED,
  ENV_STATE_FILE,
  ENV_POLL_INTERVAL_MS,
  ENV_COALESCE_WINDOW_MS,
  ENV_LIVE_UPDATE_ENABLED,
  ENV_LIVE_UPDATE_STATE_FILE,
} from "../dist/index.js";
import {
  loadInboundQueue,
  saveInboundQueue,
} from "../dist/lib/inbound-queue.js";
import {
  BOT_TOKEN,
  OWNER_ID,
  OWNER_CHAT_ID,
  makeUpdate,
  getUpdatesResult,
  jsonResponse,
  makeFakeFetch,
  sendMessageResult,
} from "./fixtures.mjs";
import { sleep, waitFor } from "./helpers/poll.mjs";

const SESSION_A = "session-a";
const SESSION_B = "session-b";

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

/** The hold lives beside the poller state file, named after its stem. */
function queueFileFor(stateFile) {
  return join(dirname(stateFile), "telegram-state-inbound-queue.json");
}

/**
 * Fake pi with the SHIPPED extension API shape: no isIdle member (that lives
 * on the context), a controllable sendUserMessage so a refused handoff can be
 * exercised, and appendEntry recorded for the drop report.
 */
function makeRealShapePi() {
  const handlers = new Map();
  const messages = [];
  const notifications = [];
  const appended = [];
  const pi = {
    tools: [],
    handlers,
    messages,
    notifications,
    appended,
    failAlways: false,
    failNextSend: undefined,
    registerTool: (tool) => pi.tools.push(tool),
    registerCommand: () => {},
    sendUserMessage: (...args) => {
      if (pi.failAlways) {
        throw new Error(
          "Cannot submit a prompt while compaction is in progress",
        );
      }
      if (pi.failNextSend !== undefined) {
        const reason = pi.failNextSend;
        pi.failNextSend = undefined;
        throw new Error(reason);
      }
      messages.push(args);
    },
    appendEntry: (customType, data) => appended.push({ customType, data }),
    on: (event, fn) =>
      handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    emit: (event, ...args) => {
      for (const fn of handlers.get(event) ?? []) fn(...args);
    },
  };
  return pi;
}

/** Context whose idle answer and session identity the test controls. */
function makeCtx(idle, sessionId, notifications = []) {
  return {
    ui: { notify: (message, type) => notifications.push({ message, type }) },
    isIdle: () => idle,
    sessionManager: { getSessionId: () => sessionId },
  };
}

/**
 * getUpdates server the test feeds: pushed updates land in a later poll cycle.
 * Non-getUpdates requests (the poller-start control keyboard) get a valid
 * sendMessage-shaped answer and NEVER consume the feed.
 */
function makeFeedFetch() {
  const pending = [];
  let servedUpdates = 0;
  const fetchFn = makeFakeFetch(async (url) => {
    if (!url.includes("getUpdates")) {
      return url.includes("sendMessage")
        ? jsonResponse(sendMessageResult(1))
        : jsonResponse({ ok: true, result: {} });
    }
    const batch = pending.splice(0, pending.length);
    servedUpdates += batch.length;
    return jsonResponse(getUpdatesResult(batch));
  });
  fetchFn.feed = (...updates) => pending.push(...updates);
  fetchFn.servedUpdates = () => servedUpdates;
  return fetchFn;
}

/** Env for the busy-steer tests: poller on, live-update off, fake token. */
function steerEnv(stateFile, { windowMs = "60", intervalMs = "150" } = {}) {
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
    [ENV_STATE_FILE]: stateFile,
    TELEGRAM_STATE_FILE: undefined,
    [ENV_POLL_INTERVAL_MS]: intervalMs,
    TELEGRAM_POLL_INTERVAL_MS: undefined,
    [ENV_COALESCE_WINDOW_MS]: windowMs,
    TELEGRAM_COALESCE_WINDOW_MS: undefined,
    [ENV_LIVE_UPDATE_ENABLED]: "0",
    TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
    [ENV_LIVE_UPDATE_STATE_FILE]: undefined,
    TELEGRAM_LIVE_UPDATE_STATE_FILE: undefined,
  };
}

function handoffWarnings(pi) {
  return pi.notifications.filter(
    (note) => note.type === "warning" && note.message.includes("handoff"),
  );
}

test("busy-steer: a busy arrival is delivered as a steer at window close, the hold drained", async () => {
  const stateFile = tmpStateFile("busy-steer-busy");
  const queueFile = queueFileFor(stateFile);
  const pi = makeRealShapePi();
  const fetchFn = makeFeedFetch();
  await withEnv(steerEnv(stateFile), async () => {
    await telegramExtension(pi, { fetch: fetchFn });
  });

  try {
    pi.emit(
      "session_start",
      { type: "session_start", reason: "startup" },
      makeCtx(false, SESSION_A, pi.notifications),
    );
    fetchFn.feed(makeUpdate(1001, { text: "steer into the run" }));

    // The run is active; the message still leaves at the window's close.
    await waitFor(() => pi.messages.length >= 1, 3000);
    const [content, options] = pi.messages[0];
    assert.equal(
      options?.deliverAs,
      "steer",
      "a busy session gets a steer, not a next-task followUp",
    );
    assert.ok(
      content.includes("steer into the run"),
      "the owner text reaches the running turn",
    );
    await sleep(150);
    assert.equal(pi.messages.length, 1, "exactly one delivery");
    await waitFor(
      async () => (await loadInboundQueue(queueFile)).length === 0,
      3000,
    );
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("busy-steer: an idle arrival is delivered at window close with the same steer shape", async () => {
  const stateFile = tmpStateFile("busy-steer-idle");
  const pi = makeRealShapePi();
  const fetchFn = makeFeedFetch();
  await withEnv(
    steerEnv(stateFile, { windowMs: "400", intervalMs: "120" }),
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  try {
    pi.emit(
      "session_start",
      { type: "session_start", reason: "startup" },
      makeCtx(true, SESSION_A, pi.notifications),
    );
    fetchFn.feed(makeUpdate(1002, { text: "idle arrival" }));
    await waitFor(() => fetchFn.servedUpdates() === 1, 3000);
    assert.equal(
      pi.messages.length,
      0,
      "the coalescing window is still open: nothing delivered yet",
    );

    await waitFor(() => pi.messages.length >= 1, 3000);
    const [content, options] = pi.messages[0];
    assert.equal(options?.deliverAs, "steer", "same call shape while idle");
    assert.ok(content.includes("idle arrival"));
    await sleep(150);
    assert.equal(pi.messages.length, 1, "one arrival, one delivery");
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("busy-steer: a busy burst leaves as ONE steer carrying every part in arrival order", async () => {
  const stateFile = tmpStateFile("busy-steer-burst");
  const pi = makeRealShapePi();
  const fetchFn = makeFeedFetch();
  await withEnv(steerEnv(stateFile), async () => {
    await telegramExtension(pi, { fetch: fetchFn });
  });

  try {
    pi.emit(
      "session_start",
      { type: "session_start", reason: "startup" },
      makeCtx(false, SESSION_A, pi.notifications),
    );
    fetchFn.feed(
      makeUpdate(1003, { text: "first part" }),
      makeUpdate(1004, { text: "second part" }),
    );

    await waitFor(() => pi.messages.length >= 1, 3000);
    await sleep(150); // past the window: no second delivery may follow
    assert.equal(
      pi.messages.length,
      1,
      "the whole busy burst is ONE sendUserMessage",
    );
    const [content, options] = pi.messages[0];
    assert.equal(options?.deliverAs, "steer");
    assert.ok(
      content.indexOf("first part") < content.indexOf("second part"),
      "parts keep arrival order",
    );
    const headerLines = content.split("\n");
    assert.equal(headerLines[1], "2 coalesced owner messages");
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("busy-steer: a handoff pi refuses is re-queued in order, the window re-arms, the refusal is logged", async () => {
  const stateFile = tmpStateFile("busy-steer-refused");
  const queueFile = queueFileFor(stateFile);
  const pi = makeRealShapePi();
  const fetchFn = makeFeedFetch();
  await withEnv(steerEnv(stateFile), async () => {
    await telegramExtension(pi, { fetch: fetchFn });
  });

  try {
    pi.emit(
      "session_start",
      { type: "session_start", reason: "startup" },
      makeCtx(false, SESSION_A, pi.notifications),
    );
    pi.failAlways = true; // every handoff refused, as during compaction
    fetchFn.feed(
      makeUpdate(1005, { text: "retry first" }),
      makeUpdate(1006, { text: "retry second" }),
    );

    await waitFor(() => handoffWarnings(pi).length >= 1, 3000);
    assert.equal(pi.messages.length, 0, "a refused handoff hands nothing over");
    const held = await loadInboundQueue(queueFile);
    assert.deepEqual(
      held.map((entry) => entry.message.updateId),
      [1005, 1006],
      "the whole batch is re-queued, still in arrival order",
    );
    assert.ok(
      held.every((entry) => entry.sessionId === SESSION_A),
      "re-queued entries keep the session they were accepted for",
    );

    // The window re-armed: the next close refuses again.
    await waitFor(() => handoffWarnings(pi).length >= 2, 3000);

    // pi accepts again: the next re-armed window hands the batch over whole.
    pi.failAlways = false;
    await waitFor(() => pi.messages.length >= 1, 3000);
    await sleep(120);
    assert.equal(
      pi.messages.length,
      1,
      "the retried batch leaves as one steer",
    );
    const [content, options] = pi.messages[0];
    assert.equal(options?.deliverAs, "steer");
    assert.ok(
      content.indexOf("retry first") < content.indexOf("retry second"),
      "order survives the refusal",
    );
    await waitFor(
      async () => (await loadInboundQueue(queueFile)).length === 0,
      3000,
    );
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("busy-steer: a hold accepted for a foreign session is dropped and reported", async () => {
  const stateFile = tmpStateFile("busy-steer-foreign");
  const queueFile = queueFileFor(stateFile);
  await saveInboundQueue(queueFile, [
    {
      message: {
        updateId: 1007,
        messageId: 2007,
        fromId: OWNER_ID,
        username: "owner",
        firstName: "Owner",
        chatId: OWNER_CHAT_ID,
        chatType: "private",
        text: "foreign ping",
        receivedAt: Date.parse("2026-09-03T14:05:00Z"),
      },
      sessionId: SESSION_B,
      queuedAt: Date.now(),
    },
  ]);

  const pi = makeRealShapePi();
  const fetchFn = makeFeedFetch();
  await withEnv(steerEnv(stateFile), async () => {
    await telegramExtension(pi, { fetch: fetchFn });
  });

  try {
    pi.emit(
      "session_start",
      { type: "session_start", reason: "startup" },
      makeCtx(true, SESSION_A, pi.notifications),
    );
    await waitFor(
      () =>
        pi.appended.some(
          (entry) => entry.customType === "telegram_inbound_dropped",
        ),
      3000,
    );
    await sleep(150);
    assert.equal(
      pi.messages.length,
      0,
      "an entry accepted for another named session is never delivered",
    );
    const note = pi.notifications.find((n) => n.message.includes("dropped 1"));
    assert.ok(note, "the drop is a visible notify line");
    assert.equal(note.type, "warning");
    assert.ok(
      note.message.includes(SESSION_B),
      "the report names the session the message was accepted for",
    );
    assert.ok(
      note.message.includes("1007"),
      "the report names the dropped update",
    );
    const record = pi.appended.find(
      (entry) => entry.customType === "telegram_inbound_dropped",
    );
    assert.equal(record.data.acceptedFor, SESSION_B);
    assert.equal(record.data.currentSessionId, SESSION_A);
    await waitFor(
      async () => (await loadInboundQueue(queueFile)).length === 0,
      3000,
    );
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});
