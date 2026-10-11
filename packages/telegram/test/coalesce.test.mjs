/**
 * coalesce.test.mjs — an owner burst arrives as ONE user message.
 *
 * One burst of six Telegram messages used to arrive as six separate user
 * turns. The delivery gate now batches. Every arrival, idle or busy, joins a
 * coalescing window (BRAID_TG_COALESCE_WINDOW_MS, anchored at the first
 * arrival, so a lone message is bounded by one window and a burst spanning
 * poll cycles still coalesces); the window closes into ONE steer delivery,
 * which reaches the running turn when busy and starts a turn when idle. Every
 * delivery hands the WHOLE held batch over as one sendUserMessage carrying
 * the parts in arrival order, each with its own sender/chat line and send-time
 * clock.
 *
 * Driven through the real poller (BRAID_TG_POLL_ENABLED=1 + a feedable fake
 * fetch) with a fake pi exposing the shipped extension-API shape (no isIdle
 * member) and a fake context carrying the idle answer.
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
  formatInboundBatch,
  formatInboundMessage,
} from "../dist/index.js";
import {
  TRACKED_DONE_TEXT,
  TRACKED_START_TEXT,
} from "../dist/lib/notify/live-update.js";
import { loadInboundQueue } from "../dist/lib/inbound-queue.js";
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

/** Fake pi with the SHIPPED extension API shape: no isIdle member. */
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
    registerTool: (tool) => pi.tools.push(tool),
    registerCommand: () => {},
    sendUserMessage: (...args) => messages.push(args),
    appendEntry: (customType, data) => appended.push({ customType, data }),
    on: (event, fn) =>
      handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    emit: (event, ...args) => {
      for (const fn of handlers.get(event) ?? []) fn(...args);
    },
  };
  return pi;
}

/** Context whose idle answer (and session identity) the test controls. */
function makeCtx(idle, sessionId) {
  return {
    ui: { notify() {} },
    isIdle: () => idle,
    ...(sessionId !== undefined
      ? { sessionManager: { getSessionId: () => sessionId } }
      : {}),
  };
}

/** getUpdates server the test feeds: pushed updates land in a later poll cycle. */
function makeFeedFetch() {
  const pending = [];
  let servedUpdates = 0;
  const fetchFn = makeFakeFetch(async (url) => {
    if (url.includes("getUpdates")) {
      const batch = pending.splice(0, pending.length);
      servedUpdates += batch.length;
      return jsonResponse(getUpdatesResult(batch));
    }
    return jsonResponse(getUpdatesResult([]));
  });
  fetchFn.feed = (...updates) => pending.push(...updates);
  fetchFn.servedUpdates = () => servedUpdates;
  return fetchFn;
}

/** Feedable getUpdates + recorded sendMessage/editMessageText (live-update path). */
function makeLiveFetch() {
  const pending = [];
  let servedUpdates = 0;
  const sent = [];
  const edited = [];
  let seq = 7000;
  const fetchFn = makeFakeFetch(async (url, init) => {
    if (url.includes("sendMessage")) {
      sent.push(JSON.parse(init.body));
      return jsonResponse(sendMessageResult(++seq));
    }
    if (url.includes("editMessageText")) {
      const body = JSON.parse(init.body);
      edited.push(body);
      return jsonResponse({
        ok: true,
        result: { message_id: body.message_id },
      });
    }
    const batch = pending.splice(0, pending.length);
    servedUpdates += batch.length;
    return jsonResponse(getUpdatesResult(batch));
  });
  fetchFn.feed = (...updates) => pending.push(...updates);
  fetchFn.servedUpdates = () => servedUpdates;
  fetchFn.sent = sent;
  fetchFn.edited = edited;
  return fetchFn;
}

function coalesceEnv(
  stateFile,
  { windowMs = "60", intervalMs = "150", liveStateFile } = {},
) {
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
    // Live-update is off by default here: the tracked-message path has its own
    // test below, and the other tests want only the inbound delivery surface.
    [ENV_LIVE_UPDATE_ENABLED]: liveStateFile ? "1" : "0",
    TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
    [ENV_LIVE_UPDATE_STATE_FILE]: liveStateFile,
    TELEGRAM_LIVE_UPDATE_STATE_FILE: undefined,
  };
}

// ── formatInboundBatch ──────────────────────────────────────────────────────

const SENT_1 = Date.parse("2026-09-03T14:05:00Z"); // 17:05 MSK
const SENT_2 = Date.parse("2026-09-03T14:06:00Z"); // 17:06 MSK

function msg(updateId, text, receivedAt = SENT_1) {
  return {
    updateId,
    messageId: updateId + 1000,
    fromId: 111222333,
    username: "kifir",
    firstName: "Owner",
    chatId: 999888777,
    chatType: "private",
    text,
    receivedAt,
  };
}

test("formatInboundBatch: N parts in arrival order, each with its own sender/chat/send-time line", () => {
  const out = formatInboundBatch([msg(1, "first"), msg(2, "second", SENT_2)]);
  const headerLines = out.split("\n");
  assert.equal(
    headerLines[0],
    "[braid-whisper - telegram]",
    "opening tag line carries nothing after ]",
  );
  assert.equal(
    headerLines[1],
    "2 coalesced owner messages",
    "header states this is ONE delivery of N, on its own line",
  );
  assert.ok(out.endsWith("\n[braid-whisper-end]"), "end marker intact");
  assert.ok(
    out.includes(
      "[1/2 @ 17:05 MSK] from @kifir (Owner) in chat 999888777/private",
    ),
    "part 1 keeps its sender, chat and send time",
  );
  assert.ok(
    out.includes(
      "[2/2 @ 17:06 MSK] from @kifir (Owner) in chat 999888777/private",
    ),
    "part 2 keeps its OWN send time",
  );
  assert.ok(
    out.indexOf("first") < out.indexOf("second"),
    "arrival order preserved",
  );
});

test("formatInboundBatch: a lone message keeps the plain envelope (no batch shape)", () => {
  const lone = msg(3, "  solo  ");
  assert.equal(formatInboundBatch([lone]), formatInboundMessage(lone));
});

// ── delivery through the real poller ────────────────────────────────────────

test("coalescing: an idle burst is delivered as ONE message carrying every part", async () => {
  const pi = makeRealShapePi();
  const fetchFn = makeFeedFetch();
  await withEnv(coalesceEnv(tmpStateFile("coalesce-idle")), async () => {
    await telegramExtension(pi, { fetch: fetchFn });
  });

  try {
    pi.emit(
      "session_start",
      { type: "session_start", reason: "new" },
      makeCtx(true),
    );
    fetchFn.feed(
      makeUpdate(901, { text: "first part" }),
      makeUpdate(902, { text: "second part" }),
    );
    await waitFor(() => pi.messages.length >= 1, 3000);
    await sleep(150); // past the window: no second delivery may follow
    assert.equal(pi.messages.length, 1, "one burst → one user message");
    const [content, options] = pi.messages[0];
    assert.equal(options?.deliverAs, "steer");
    assert.ok(
      content.includes("first part") && content.includes("second part"),
      "every part is carried",
    );
    assert.ok(
      content.indexOf("first part") < content.indexOf("second part"),
      "parts keep arrival order",
    );
    const headerLines = content.split("\n");
    assert.equal(headerLines[0], "[braid-whisper - telegram]");
    assert.equal(headerLines[1], "2 coalesced owner messages");
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("coalescing: a burst spanning two poll cycles still lands as ONE message", async () => {
  const pi = makeRealShapePi();
  const fetchFn = makeFeedFetch();
  await withEnv(
    coalesceEnv(tmpStateFile("coalesce-cycles"), {
      windowMs: "400",
      intervalMs: "120",
    }),
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  try {
    pi.emit(
      "session_start",
      { type: "session_start", reason: "new" },
      makeCtx(true),
    );
    fetchFn.feed(makeUpdate(903, { text: "early part" }));
    await waitFor(() => fetchFn.servedUpdates() === 1, 3000); // window armed
    fetchFn.feed(makeUpdate(904, { text: "late part" })); // next cycle, inside the window
    await waitFor(() => pi.messages.length >= 1, 3000);
    await sleep(450); // past the window
    assert.equal(pi.messages.length, 1, "across-cycle burst → ONE message");
    const content = pi.messages[0][0];
    assert.ok(content.includes("early part") && content.includes("late part"));
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("coalescing: a busy burst leaves as ONE combined steer at window close", async () => {
  const pi = makeRealShapePi();
  const fetchFn = makeFeedFetch();
  await withEnv(coalesceEnv(tmpStateFile("coalesce-busy")), async () => {
    await telegramExtension(pi, { fetch: fetchFn });
  });

  try {
    pi.emit(
      "session_start",
      { type: "session_start", reason: "new" },
      makeCtx(false),
    );
    fetchFn.feed(
      makeUpdate(905, { text: "queued one" }),
      makeUpdate(906, { text: "queued two" }),
    );
    await waitFor(() => pi.messages.length >= 1, 3000);
    await sleep(150); // past the window: no second delivery may follow
    assert.equal(
      pi.messages.length,
      1,
      "the whole busy burst leaves as ONE combined steer",
    );
    const [content, options] = pi.messages[0];
    assert.equal(options?.deliverAs, "steer", "it reaches the running turn");
    assert.ok(
      content.includes("queued one") && content.includes("queued two"),
      "both parts are carried",
    );
    assert.ok(
      content.indexOf("queued one") < content.indexOf("queued two"),
      "arrival order preserved",
    );
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("coalescing: a lone message is delivered once, in the plain envelope", async () => {
  const pi = makeRealShapePi();
  const fetchFn = makeFeedFetch();
  await withEnv(coalesceEnv(tmpStateFile("coalesce-lone")), async () => {
    await telegramExtension(pi, { fetch: fetchFn });
  });

  try {
    pi.emit(
      "session_start",
      { type: "session_start", reason: "new" },
      makeCtx(true),
    );
    fetchFn.feed(makeUpdate(907, { text: "solo" }));
    await waitFor(() => pi.messages.length >= 1, 3000);
    await sleep(150);
    assert.equal(pi.messages.length, 1, "one message → one delivery");
    const content = pi.messages[0][0];
    assert.match(content, /^\[braid-whisper - telegram( @ [^\]]+)?\]/);
    assert.ok(
      !content.includes("coalesced"),
      "a lone message is not shaped like a batch",
    );
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("coalescing: session_shutdown cancels the window; the entry stays on disk", async () => {
  const stateFile = tmpStateFile("coalesce-shutdown");
  const queueFile = queueFileFor(stateFile);
  const pi = makeRealShapePi();
  const fetchFn = makeFeedFetch();
  await withEnv(coalesceEnv(stateFile, { windowMs: "200" }), async () => {
    await telegramExtension(pi, { fetch: fetchFn });
  });

  pi.emit(
    "session_start",
    { type: "session_start", reason: "new" },
    makeCtx(true),
  );
  fetchFn.feed(makeUpdate(908, { text: "mid-window" }));
  await waitFor(() => fetchFn.servedUpdates() === 1, 3000);

  pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  await sleep(300); // past the window the shutdown cancelled
  assert.equal(pi.messages.length, 0, "the window died with the session");
  const held = await loadInboundQueue(queueFile);
  assert.equal(held.length, 1, "the entry is durable across the shutdown");
  assert.equal(held[0].message.updateId, 908);
});

test("coalescing: a reload mid-window loses nothing and duplicates nothing", async () => {
  const stateFile = tmpStateFile("coalesce-reload");
  const queueFile = queueFileFor(stateFile);

  // ── First process: the message arrives while idle; the reload lands before
  //    the window closes. ────────────────────────────────────────────────────
  const pi1 = makeRealShapePi();
  const fetch1 = makeFeedFetch();
  await withEnv(coalesceEnv(stateFile, { windowMs: "400" }), async () => {
    await telegramExtension(pi1, { fetch: fetch1 });
  });
  try {
    pi1.emit(
      "session_start",
      { type: "session_start", reason: "startup" },
      makeCtx(true, "session-a"),
    );
    fetch1.feed(makeUpdate(909, { text: "mid-reload" }));
    await waitFor(() => fetch1.servedUpdates() === 1, 3000);
    const held = await loadInboundQueue(queueFile);
    assert.equal(
      held.length,
      1,
      "the entry is on disk before the window closes",
    );

    pi1.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "reload",
    });
    await sleep(100);
    assert.equal(pi1.messages.length, 0, "the old closure delivered nothing");
  } finally {
    pi1.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  }

  // ── Second process (factory re-run): the rehydrated entry is delivered once.
  const pi2 = makeRealShapePi();
  const fetch2 = makeFeedFetch();
  await withEnv(coalesceEnv(stateFile, { windowMs: "60" }), async () => {
    await telegramExtension(pi2, { fetch: fetch2 });
  });
  try {
    pi2.emit(
      "session_start",
      { type: "session_start", reason: "reload" },
      makeCtx(true, "session-a"),
    );
    await waitFor(() => pi2.messages.length >= 1, 3000);
    await sleep(150);
    assert.equal(
      pi2.messages.length,
      1,
      "exactly one delivery after the reload",
    );
    assert.ok(pi2.messages[0][0].includes("mid-reload"));
    await waitFor(
      async () => (await loadInboundQueue(queueFile)).length === 0,
      3000,
    );
  } finally {
    pi2.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    await sleep(50);
  }
});

test("coalescing: one combined batch pins ONE Working indicator (one begin per batch)", async () => {
  const pi = makeRealShapePi();
  const liveStateFile = tmpStateFile("coalesce-live-tracked");
  const fetchFn = makeLiveFetch();
  await withEnv(
    coalesceEnv(tmpStateFile("coalesce-live-offset"), {
      windowMs: "60",
      liveStateFile,
    }),
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  try {
    pi.emit(
      "session_start",
      { type: "session_start", reason: "new" },
      makeCtx(true),
    );
    fetchFn.feed(
      makeUpdate(910, { text: "part A" }),
      makeUpdate(911, { text: "part B" }),
    );
    await waitFor(
      () => pi.messages.length >= 1 && fetchFn.sent.length >= 2,
      3000,
    );
    assert.equal(pi.messages.length, 1, "the burst is ONE delivered message");
    assert.ok(fetchFn.sent[0].reply_markup, "sent[0] is the control keyboard");
    assert.equal(
      fetchFn.sent[1].text,
      TRACKED_START_TEXT,
      "the delivered batch pinned the tracked message",
    );

    // One completed turn must resolve the indicator: the batch is ONE unit of
    // work, so exactly one begin() ran for it. Per-arrival begins would leave
    // the refcount at 1 and produce no ✅ Done edit.
    const doneEvent = {
      type: "turn_end",
      turnIndex: 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "both parts handled." }],
        stopReason: "stop",
      },
      toolResults: [],
    };
    for (const fn of pi.handlers.get("turn_end") ?? []) {
      await fn(doneEvent, undefined);
    }
    assert.equal(
      fetchFn.edited.length,
      1,
      "the one begin resolved on the one turn_end",
    );
    assert.equal(fetchFn.edited[0].text, TRACKED_DONE_TEXT);
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});
