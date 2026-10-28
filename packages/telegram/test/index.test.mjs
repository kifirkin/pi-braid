/**
 * index.test.mjs — extension surface that doesn't need a live pi runtime:
 * the if-has-token guard predicate, the env alias shim (BRAID_TG_* canonical,
 * TELEGRAM_* owner-side fallback), inbound message formatting, and the
 * BRAID_TG_POLL_DISABLED inbound-poller opt-out.
 * (Tool registration details require a pi ExtensionAPI; we drive the factory
 * with a minimal fake `pi` + recorded-fixture fetch so the opt-out behavior —
 * poller NOT started when the flag is set, poller STILL started when absent —
 * is exercised end-to-end with no token leaked to the network.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import telegramExtension, {
  env,
  formatInboundMessage,
  isTelegramEnabled,
  log,
  setLogSink,
  ENV_TOKEN,
  ENV_CHAT_ID,
  ENV_POLL_DISABLED,
  ENV_POLL_ENABLED,
  ENV_VERBOSE,
  ENV_NOTIFY_ENABLED,
  ENV_NOTIFY_MODEL,
  ENV_NOTIFY_MAX_PER_MIN,
  ENV_LIVE_UPDATE_ENABLED,
  ENV_LIVE_UPDATE_MAX_PER_MIN,
  ENV_LIVE_UPDATE_STATE_FILE,
  ENV_STT_MODE,
} from "../dist/index.js";
import {
  BOT_TOKEN,
  OWNER_CHAT_ID,
  OWNER_ID,
  FOREIGN_ID,
  getUpdatesResult,
  jsonResponse,
  makeCallbackUpdate,
  makeFakeFetch,
  makeUpdate,
  makeUpdatesServer,
  sendMessageResult,
} from "./fixtures.mjs";
import { sleep, waitFor, waitForJson } from "./helpers/poll.mjs";
import {
  TRACKED_START_TEXT,
  TRACKED_DONE_TEXT,
  TRACKED_TERMINAL_TEXT,
} from "../dist/lib/notify/live-update.js";
import {
  CONTROL_RUNNING_TEXT,
  CONTROL_PAUSED_TEXT,
} from "../dist/lib/pause-control.js";

/**
 * Pin the machine-wide braid tree for the WHOLE file.
 *
 * The extension's poller resolves the tree — the root (BRAID_HOME), the
 * ownership lock, and the session role — and more than a dozen cases here
 * start it. One pin set for the file rather than a per-case window, because
 * the reads keep happening: the pause flag on every poll cycle, the lock path
 * again at the shutdown release, the role on every start attempt. These cases
 * assert and shut the session down outside their factory window, so a per-case
 * pin would hand those reads the live tree, where another pi process's lock
 * refuses the start, a paused owner holds every delivery, and a worker marker
 * refuses the poller outright. The runner pins the same three for the children
 * it spawns (child-env.mjs); a file run on its own inherits them instead.
 * Cases that need a different root still set their own BRAID_HOME via withEnv.
 */
const PINNED_BRAID_HOME = mkdtempSync(join(tmpdir(), "tg-index-pin-"));
process.env.BRAID_HOME = PINNED_BRAID_HOME;
process.env.BRAID_TG_POLLER_LOCK_FILE = join(
  PINNED_BRAID_HOME,
  "telegram-poller.lock",
);
delete process.env.TELEGRAM_POLLER_LOCK_FILE;
delete process.env.BRAID_SESSION_ROLE;
// The file-scoped pin dir holds the lock every case shares; it goes when the
// last case finishes, so a run leaves tmp as it found it.
after(() => rmSync(PINNED_BRAID_HOME, { recursive: true, force: true }));

/**
 * Wait for an effect the running poller produces, naming a refused start.
 *
 * A refused start is invisible from a delivery wait: the extension reports it
 * through the notify sink, which nothing binds before the first session_start,
 * so the world looks exactly like a slow window. The check runs only on
 * timeout, so wrapping a wait never shifts when the case runs.
 */
async function waitForPollerEffect(what, predicate, timeoutMs) {
  try {
    await waitFor(predicate, timeoutMs);
  } catch (error) {
    throw new Error(
      `${what}: a refused poller start looks the same — a live pid holds the ` +
        "machine-wide ownership lock, the session role is worker, or no braid " +
        "root resolves",
      { cause: error },
    );
  }
}

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

test("isTelegramEnabled: false when neither BRAID_TG nor TELEGRAM token is set, true with BRAID_TG_BOT_TOKEN", () => {
  withEnv(
    { BRAID_TG_BOT_TOKEN: undefined, TELEGRAM_BOT_TOKEN: undefined },
    () => {
      assert.equal(isTelegramEnabled(), false);

      process.env.BRAID_TG_BOT_TOKEN = " 123456:ABC-DEF ";
      assert.equal(isTelegramEnabled(), true); // trimmed non-empty
    },
  );
});

test("env alias: only TELEGRAM_BOT_TOKEN set => enabled + token resolved from the alias", () => {
  withEnv(
    { BRAID_TG_BOT_TOKEN: undefined, TELEGRAM_BOT_TOKEN: " 456:DEF " },
    () => {
      assert.equal(isTelegramEnabled(), true);
      assert.equal(env(ENV_TOKEN), "456:DEF"); // trimmed fallback used
    },
  );
});

test("env alias: both set => BRAID_TG_BOT_TOKEN wins", () => {
  withEnv(
    { BRAID_TG_BOT_TOKEN: "222:CANONICAL", TELEGRAM_BOT_TOKEN: "111:ALIAS" },
    () => {
      assert.equal(isTelegramEnabled(), true);
      assert.equal(env(ENV_TOKEN), "222:CANONICAL");
    },
  );
});

test("env alias: chat id resolution honors the same order (BRAID_TG first, TELEGRAM fallback)", () => {
  withEnv({ BRAID_TG_CHAT_ID: undefined, TELEGRAM_CHAT_ID: "111" }, () => {
    assert.equal(env(ENV_CHAT_ID), "111"); // alias fallback
  });
  withEnv({ BRAID_TG_CHAT_ID: "222", TELEGRAM_CHAT_ID: "111" }, () => {
    assert.equal(env(ENV_CHAT_ID), "222"); // canonical wins
  });
});

test("formatInboundMessage: braid-whisper envelope with sender provenance, send-time header, end marker", () => {
  // T3/TG-inbound: the header carries the message's SEND time as `@ HH:MM TZ`
  // (from TelegramUpdate.date via receivedAt, owner TZ Europe/Moscow). Epoch
  // 2026-09-03T14:05:00Z renders as 17:05 MSK (UTC+3).
  const sentAt = Date.parse("2026-09-03T14:05:00Z");
  const out = formatInboundMessage({
    updateId: 1,
    messageId: 2,
    fromId: 111222333,
    username: "kifir",
    firstName: "Owner",
    chatId: 999888777,
    chatType: "private",
    text: "  please summarize  ",
    receivedAt: sentAt,
  });
  // Full braid-whisper envelope: prefix + body + [braid-whisper-end]
  assert.ok(
    out.startsWith(
      "[braid-whisper - telegram @ 17:05 MSK]\nfrom @kifir (Owner) in chat 999888777/private\n\n",
    ),
    `header must carry the send-time clock: ${out.split("\n")[0]}`,
  );
  assert.ok(out.includes("please summarize"));
  assert.ok(out.endsWith("\n[braid-whisper-end]"));
});

test("formatInboundMessage: falls back to id when no username, no firstName noise", () => {
  const out = formatInboundMessage({
    updateId: 1,
    messageId: 2,
    fromId: 555,
    chatId: 1,
    chatType: "private",
    text: "hi",
    receivedAt: Date.parse("2026-09-03T14:05:00Z"),
  });
  assert.ok(
    out.startsWith(
      "[braid-whisper - telegram @ 17:05 MSK]\nfrom id 555 in chat 1/private\n\n",
    ),
  );
  assert.ok(out.endsWith("\n[braid-whisper-end]"));
});

test("formatInboundMessage: non-finite receivedAt omits the send-time clock (header still valid)", () => {
  const out = formatInboundMessage({
    updateId: 1,
    messageId: 2,
    fromId: 555,
    chatId: 1,
    chatType: "private",
    text: "hi",
    receivedAt: NaN,
  });
  assert.ok(
    out.startsWith(
      "[braid-whisper - telegram]\nfrom id 555 in chat 1/private\n\n",
    ),
  );
  assert.ok(out.endsWith("\n[braid-whisper-end]"));
});

// ── BRAID_TG_POLL_DISABLED inbound opt-out ──────────────────────────────────

/** Minimal pi-like surface the factory touches
 *  (registerTool/registerCommand/on/sendUserMessage; multiple handlers per event
 *  like pi-core's loader — the factory now registers both a session_start sink
 *  binder and session_shutdown sink clearer + poller cleanup). */
function makeFakePi() {
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

/** Fake fetch answering every request with an empty getUpdates result (records calls). */
function emptyUpdatesFetch() {
  return makeFakeFetch(async () => jsonResponse(getUpdatesResult([])));
}

function tmpStateFile(prefix) {
  return join(
    tmpdir(),
    `tg-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    "telegram-state.json",
  );
}

/**
 * A throwaway directory for a test that would otherwise resolve a braid
 * default into the live tree (media downloads, live-update state).
 */
function tmpDir(prefix) {
  return join(
    tmpdir(),
    `tg-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

test("env alias: TELEGRAM_POLL_DISABLED resolves; BRAID_TG_POLL_DISABLED wins when both set", () => {
  withEnv(
    { BRAID_TG_POLL_DISABLED: undefined, TELEGRAM_POLL_DISABLED: "1" },
    () => {
      assert.equal(env(ENV_POLL_DISABLED), "1"); // alias fallback
    },
  );
  withEnv(
    { BRAID_TG_POLL_DISABLED: "1", TELEGRAM_POLL_DISABLED: undefined },
    () => {
      assert.equal(env(ENV_POLL_DISABLED), "1"); // canonical
    },
  );
  withEnv(
    { BRAID_TG_POLL_DISABLED: "true", TELEGRAM_POLL_DISABLED: "1" },
    () => {
      assert.equal(env(ENV_POLL_DISABLED), "true"); // canonical trumps alias
    },
  );
  withEnv(
    { BRAID_TG_POLL_DISABLED: undefined, TELEGRAM_POLL_DISABLED: undefined },
    () => {
      assert.equal(env(ENV_POLL_DISABLED), undefined); // neither set
    },
  );
});

test("env alias: TELEGRAM_POLL_ENABLED resolves; BRAID_TG_POLL_ENABLED wins when both set", () => {
  withEnv(
    { BRAID_TG_POLL_ENABLED: undefined, TELEGRAM_POLL_ENABLED: "1" },
    () => {
      assert.equal(env(ENV_POLL_ENABLED), "1"); // alias fallback
    },
  );
  withEnv(
    { BRAID_TG_POLL_ENABLED: "1", TELEGRAM_POLL_ENABLED: undefined },
    () => {
      assert.equal(env(ENV_POLL_ENABLED), "1"); // canonical
    },
  );
  withEnv({ BRAID_TG_POLL_ENABLED: "true", TELEGRAM_POLL_ENABLED: "1" }, () => {
    assert.equal(env(ENV_POLL_ENABLED), "true"); // canonical trumps alias
  });
  withEnv(
    { BRAID_TG_POLL_ENABLED: undefined, TELEGRAM_POLL_ENABLED: undefined },
    () => {
      assert.equal(env(ENV_POLL_ENABLED), undefined); // neither set
    },
  );
});

test("env alias: notify flags resolve (BRAID_TG_NOTIFY_* canonical, TELEGRAM_NOTIFY_* fallback)", () => {
  withEnv(
    { BRAID_TG_NOTIFY_ENABLED: undefined, TELEGRAM_NOTIFY_ENABLED: "1" },
    () => {
      assert.equal(env(ENV_NOTIFY_ENABLED), "1");
    },
  );
  withEnv(
    { BRAID_TG_NOTIFY_ENABLED: "1", TELEGRAM_NOTIFY_ENABLED: undefined },
    () => {
      assert.equal(env(ENV_NOTIFY_ENABLED), "1");
    },
  );
  withEnv(
    { BRAID_TG_NOTIFY_ENABLED: undefined, TELEGRAM_NOTIFY_ENABLED: undefined },
    () => {
      assert.equal(env(ENV_NOTIFY_ENABLED), undefined);
    },
  );
  withEnv(
    {
      BRAID_TG_NOTIFY_MODEL: undefined,
      TELEGRAM_NOTIFY_MODEL: "openrouter/mini",
    },
    () => {
      assert.equal(env(ENV_NOTIFY_MODEL), "openrouter/mini");
    },
  );
  withEnv(
    { BRAID_TG_NOTIFY_MAX_PER_MIN: "2", TELEGRAM_NOTIFY_MAX_PER_MIN: "9" },
    () => {
      assert.equal(env(ENV_NOTIFY_MAX_PER_MIN), "2");
    },
  );
});

test("factory: turn_end auto-notify listener registered ONLY when BRAID_TG_NOTIFY_ENABLED=1", async () => {
  const pi = makeFakePi();
  const fetchFn = emptyUpdatesFetch();
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_CHAT_ID: String(OWNER_CHAT_ID),
      TELEGRAM_CHAT_ID: undefined,
      BRAID_TG_POLL_DISABLED: "1",
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_NOTIFY_ENABLED: undefined,
      TELEGRAM_NOTIFY_ENABLED: undefined,
      BRAID_TG_LIVE_UPDATE_ENABLED: "0",
      TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );
  assert.equal(
    pi.handlers.has("turn_end"),
    false,
    "notify is opt-in — no listener when disabled (live-update also off)",
  );

  const pi2 = makeFakePi();
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_CHAT_ID: String(OWNER_CHAT_ID),
      TELEGRAM_CHAT_ID: undefined,
      BRAID_TG_POLL_DISABLED: "1",
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_NOTIFY_ENABLED: "1",
      TELEGRAM_NOTIFY_ENABLED: undefined,
      BRAID_TG_LIVE_UPDATE_ENABLED: "0",
      TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
    },
    async () => {
      await telegramExtension(pi2, { fetch: emptyUpdatesFetch() });
    },
  );
  assert.equal(
    pi2.handlers.has("turn_end"),
    true,
    "notify listener registered when enabled",
  );
});

test("poller default-off: BRAID_TG_POLL_DISABLED set + token present => poller NOT started, all 3 tools still registered", async () => {
  const stateFile = tmpStateFile("disabled");
  const fetchFn = emptyUpdatesFetch();
  const pi = makeFakePi();
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_POLL_DISABLED: "1",
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: stateFile,
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_POLL_INTERVAL_MS: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  // All 3 tools registered: telegram_send, telegram_inbox, telegram_poller.
  assert.equal(pi.tools.length, 3);
  const names = pi.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "telegram_inbox",
    "telegram_poller",
    "telegram_send",
  ]);

  // Give any wrongly-started poller a chance to fire — there must be none.
  await sleep(120);
  assert.equal(fetchFn.calls.length, 0, "no getUpdates / no network calls");
  assert.equal(existsSync(stateFile), false, "no state file created");
  assert.ok(
    (pi.handlers.get("session_shutdown") ?? []).length >= 2,
    "shutdown has sink clearer + poller cleanup handlers",
  );
});

test("poller default-off: no flags + token present => poller NOT started (default-off), all 3 tools registered", async () => {
  const stateFile = tmpStateFile("default");
  const fetchFn = emptyUpdatesFetch();
  const pi = makeFakePi();
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_POLL_DISABLED: undefined,
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_POLL_ENABLED: undefined,
      TELEGRAM_POLL_ENABLED: undefined,
      BRAID_TG_STATE_FILE: stateFile,
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_POLL_INTERVAL_MS: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  assert.equal(pi.tools.length, 3);
  const names = pi.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "telegram_inbox",
    "telegram_poller",
    "telegram_send",
  ]);

  // Default-off: poller must NOT auto-start.
  await sleep(120);
  assert.equal(
    fetchFn.calls.length,
    0,
    "no getUpdates / default-off poller never fires",
  );
  assert.equal(
    existsSync(stateFile),
    false,
    "no state file created without a poll",
  );
});

test("poller opt-in: BRAID_TG_POLL_ENABLED=1 + token present => poller starts (explicit opt-in restores legacy behavior)", async () => {
  const fetchFn = emptyUpdatesFetch();
  const pi = makeFakePi();
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_POLL_ENABLED: "1",
      TELEGRAM_POLL_ENABLED: undefined,
      BRAID_TG_POLL_DISABLED: undefined,
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: undefined,
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_POLL_INTERVAL_MS: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  assert.equal(pi.tools.length, 3);
  assert.ok(pi.tools.some((t) => t.name === "telegram_send"));

  // Poller starts with explicit opt-in.
  await waitForPollerEffect(
    "the poller issued no getUpdates",
    () => fetchFn.calls.some((c) => c.url.includes("getUpdates")),
    2000,
  );
  assert.ok(
    fetchFn.calls.some((c) => c.url.includes("getUpdates")),
    "inbound long-poll engaged via explicit opt-in",
  );

  // Stop the loop so no lingering timer keeps the test process alive.
  pi.emit("session_shutdown");
  await sleep(50);
});

test("poller opt-in: TELEGRAM_POLL_ENABLED alias also starts the poller", async () => {
  const fetchFn = emptyUpdatesFetch();
  const pi = makeFakePi();
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_POLL_ENABLED: undefined,
      TELEGRAM_POLL_ENABLED: "1",
      BRAID_TG_POLL_DISABLED: undefined,
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: undefined,
      TELEGRAM_STATE_FILE: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  assert.equal(pi.tools.length, 3);
  await waitForPollerEffect(
    "the poller issued no getUpdates",
    () => fetchFn.calls.some((c) => c.url.includes("getUpdates")),
    2000,
  );
  assert.ok(fetchFn.calls.some((c) => c.url.includes("getUpdates")));
  pi.emit("session_shutdown");
  await sleep(50);
});

// ── Control-keyboard placement at the poller-start seam ────────────────────
// sendControlKeyboard is wired into the lifecycle: every poller start (env
// auto-start at boot, /telegram enable, telegram_poller enable) reads the
// pause flag and places the ⏸/▶️/📊 control in the owner chat. When the owner
// chat is unknown at start (no chat-id env, no allow-list — pure first-message
// bootstrap) placement is DEFERRED to the first owner message (one-shot).
// These tests prove the seam actually fires with the correct chatId + a
// keyboard whose state reflects the persisted pause flag.

test("poller auto-start: control keyboard placed in the owner chat at boot (correct chatId + pause state)", async () => {
  const pi = makeFakePi();
  const sent = [];
  const fetchFn = makeFakeFetch(async (url, init) => {
    if (url.includes("sendMessage")) {
      sent.push(JSON.parse(init.body));
      return jsonResponse(sendMessageResult(600));
    }
    return jsonResponse(getUpdatesResult([]));
  });
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_CHAT_ID: String(OWNER_CHAT_ID),
      TELEGRAM_CHAT_ID: undefined,
      BRAID_TG_POLL_ENABLED: "1",
      TELEGRAM_POLL_ENABLED: undefined,
      BRAID_TG_POLL_DISABLED: undefined,
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_LIVE_UPDATE_ENABLED: "0",
      TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("ctrlkb-boot"),
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_NOTIFY_ENABLED: undefined,
      TELEGRAM_NOTIFY_ENABLED: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  try {
    // Boot placement fires as part of the poller start — exactly one sendMessage
    // with the control keyboard (live-update off: nothing else sends).
    await waitForPollerEffect(
      "the control keyboard was never placed",
      () => sent.length >= 1,
      2000,
    );
    assert.equal(sent.length, 1, "exactly one control keyboard placed at boot");
    const body = sent[0];
    // BRAID_TG_CHAT_ID is an env string, so the placed chat_id arrives as a string.
    assert.equal(
      String(body.chat_id),
      String(OWNER_CHAT_ID),
      "control keyboard goes to the owner chat",
    );
    assert.ok(
      body.text === CONTROL_RUNNING_TEXT || body.text === CONTROL_PAUSED_TEXT,
      `status line reflects the persisted pause flag, got: ${JSON.stringify(body.text)}`,
    );
    assert.ok(
      body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data,
      "keyboard with a control button attached",
    );
    assert.ok(
      ["pause", "resume"].includes(
        body.reply_markup.inline_keyboard[0][0].callback_data,
      ),
      "primary button is the state-changing action (⏸ Pause or ▶ Resume)",
    );
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("/telegram enable ALSO places the control keyboard (the poller-start seam is shared)", async () => {
  const pi = makeFakePi();
  const sent = [];
  const fetchFn = makeFakeFetch(async (url, init) => {
    if (url.includes("sendMessage")) {
      sent.push(JSON.parse(init.body));
      return jsonResponse(sendMessageResult(601));
    }
    return jsonResponse(getUpdatesResult([]));
  });
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_CHAT_ID: String(OWNER_CHAT_ID),
      TELEGRAM_CHAT_ID: undefined,
      BRAID_TG_POLL_DISABLED: undefined,
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_POLL_ENABLED: undefined,
      TELEGRAM_POLL_ENABLED: undefined,
      BRAID_TG_LIVE_UPDATE_ENABLED: "0",
      TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("ctrlkb-enable"),
      TELEGRAM_STATE_FILE: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  try {
    // Default-off: no poller, no placement yet.
    await sleep(120);
    assert.equal(sent.length, 0, "no placement before the poller starts");

    const notifyCalls = [];
    const ctx = { ui: { notify: (m, t) => notifyCalls.push({ m, t }) } };
    await pi.commands[0].handler("enable", ctx);

    await waitForPollerEffect(
      "the control keyboard was never placed",
      () => sent.length >= 1,
      2000,
    );
    assert.equal(
      sent.length,
      1,
      "/telegram enable places the control keyboard once",
    );
    assert.equal(String(sent[0].chat_id), String(OWNER_CHAT_ID));
    assert.ok(
      sent[0].reply_markup,
      "keyboard attached on the /telegram enable placement",
    );

    // Singleton: second enable does NOT re-place (no new poller started).
    const before = sent.length;
    await pi.commands[0].handler("enable", ctx);
    await sleep(50);
    assert.equal(
      sent.length,
      before,
      "no duplicate placement for a no-op re-enable",
    );
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("poller start with unknown owner chat defers the control keyboard to the first owner message (bootstrap, one-shot)", async () => {
  const pi = makeFakePi();
  // No BRAID_TG_CHAT_ID and no allow-list ⇒ resolveChatId() is 0 at start → the
  // placement is deferred; the first owner message captures the chat and fires it.
  // Start EMPTY so the boot-defer assertion is deterministic (no owner message
  // can race in during the initial window); the owner message is pushed later.
  const updatesHandler = makeUpdatesServer([]);
  const sent = [];
  const fetchFn = makeFakeFetch(async (url, init) => {
    if (url.includes("sendMessage")) {
      sent.push(JSON.parse(init.body));
      return jsonResponse(sendMessageResult(602));
    }
    return updatesHandler(url);
  });
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_CHAT_ID: undefined,
      TELEGRAM_CHAT_ID: undefined,
      BRAID_TG_ALLOWED_USERS: undefined,
      TELEGRAM_ALLOWED_USERS: undefined,
      BRAID_TG_POLL_ENABLED: "1",
      TELEGRAM_POLL_ENABLED: undefined,
      BRAID_TG_COALESCE_WINDOW_MS: "30",
      TELEGRAM_COALESCE_WINDOW_MS: undefined,
      BRAID_TG_POLL_DISABLED: undefined,
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_LIVE_UPDATE_ENABLED: "0",
      TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("ctrlkb-defer"),
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_POLL_INTERVAL_MS: "200",
      TELEGRAM_POLL_INTERVAL_MS: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  try {
    // Boot: the poller started with an UNKNOWN owner chat → deferred, nothing sent.
    await sleep(120); // let several poll cycles run with an empty queue
    assert.equal(
      sent.length,
      0,
      "deferred at boot — nothing sent before the owner chat is known",
    );

    // First owner message → ownerChatId captured → deferred placement fires.
    updatesHandler.queue.push(makeUpdate(200, { text: "first dm" }));
    await waitForPollerEffect(
      "the first owner message was never delivered",
      () => pi.messages.length >= 1 && sent.length >= 1,
      3000,
    );
    assert.equal(
      sent.length,
      1,
      "deferred control keyboard placed on the first owner message",
    );
    // The bootstrapped chat id comes from message.chatId (a number).
    assert.equal(
      String(sent[0].chat_id),
      String(OWNER_CHAT_ID),
      "placed into the bootstrapped owner chat",
    );
    assert.ok(
      sent[0].text === CONTROL_RUNNING_TEXT ||
        sent[0].text === CONTROL_PAUSED_TEXT,
      "deferred placement reflects the persisted pause flag",
    );
    assert.ok(
      sent[0].reply_markup,
      "keyboard attached on the deferred placement",
    );

    // Second owner message → NOT re-placed (one-shot guard).
    updatesHandler.queue.push(makeUpdate(201, { text: "second dm" }));
    await waitForPollerEffect(
      "the second owner message was never delivered",
      () => pi.messages.length >= 2,
      3000,
    );
    await sleep(80);
    assert.equal(
      sent.length,
      1,
      "no duplicate keyboard after the first owner message",
    );
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

// ── TUI-safe logging gate ───────────────────────────────────────────────────
// The extension's log() helper must emit ZERO console output for every level —
// any extension stdout write lands in the interactive TUI input field and
// corrupts it. warn/error route through the setLogSink(ctx.ui.notify) sink
// (16f); with no sink bound they are SILENT (never console). debug/info stay
// silent by default; BRAID_TG_VERBOSE=1 (alias TELEGRAM_VERBOSE) routes them
// to the sink as info toasts, still never console.

/** Swap the console methods with recorders for the duration of fn, returning the recorded calls. */
function withConsole(fn) {
  const calls = [];
  const record =
    (method) =>
    (...args) =>
      calls.push({ method, args });
  const saved = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.debug = record("debug");
  console.info = record("info");
  console.warn = record("warn");
  console.error = record("error");
  try {
    const result = fn();
    return result && typeof result.then === "function"
      ? result.then(() => calls)
      : calls;
  } finally {
    console.debug = saved.debug;
    console.info = saved.info;
    console.warn = saved.warn;
    console.error = saved.error;
  }
}

/** Run fn with a recording notify sink bound; restores (clears) the sink after. */
function withSink(fn) {
  const calls = [];
  setLogSink((message, type) => calls.push({ message, type }));
  try {
    fn();
    return calls;
  } finally {
    setLogSink(undefined);
  }
}

test("log: NO console.* from any level — with no sink even warn+error are silent (16f)", async () => {
  withEnv({ BRAID_TG_VERBOSE: undefined, TELEGRAM_VERBOSE: undefined }, () => {
    setLogSink(undefined);
    const calls = withConsole(() => {
      log("warn", "inbound poll error: boom");
      log("error", "telegram poll crash: bad");
      log("debug", "telegram: retried update 42");
      log("info", "telegram inbound poller started");
    });
    assert.equal(
      calls.length,
      0,
      "no sink => zero console output at every level",
    );
  });
});

test("log: warn + error route to the notify sink with warning/error level (never console)", async () => {
  withEnv({ BRAID_TG_VERBOSE: undefined, TELEGRAM_VERBOSE: undefined }, () => {
    const consoleCalls = withConsole(() => {
      const sinkCalls = withSink(() => {
        log("warn", "inbound poll error: boom");
        log("error", "telegram poll crash: bad");
      });
      assert.equal(sinkCalls.length, 2);
      assert.equal(sinkCalls[0].type, "warning");
      assert.equal(sinkCalls[0].message, "[telegram] inbound poll error: boom");
      assert.equal(sinkCalls[1].type, "error");
      assert.equal(sinkCalls[1].message, "[telegram] telegram poll crash: bad");
    });
    assert.equal(
      consoleCalls.length,
      0,
      "never console.* — the TUI is not polluted",
    );
  });
});

test("log: debug + info emit NOTHING by default — no sink call, no console call", async () => {
  withEnv({ BRAID_TG_VERBOSE: undefined, TELEGRAM_VERBOSE: undefined }, () => {
    const consoleCalls = withConsole(() => {
      const sinkCalls = withSink(() => {
        log("debug", "telegram: retried update 42");
        log("info", "telegram inbound poller started");
        log("info", "telegram getUpdates recovered after 3 errors");
      });
      assert.equal(
        sinkCalls.length,
        0,
        "per-cycle chatter never reaches the sink by default",
      );
    });
    assert.equal(consoleCalls.length, 0);
  });
});

test("log: BRAID_TG_VERBOSE=1 routes debug + info to the sink as info (still never console)", async () => {
  withEnv({ BRAID_TG_VERBOSE: "1", TELEGRAM_VERBOSE: undefined }, () => {
    const consoleCalls = withConsole(() => {
      const sinkCalls = withSink(() => {
        log("debug", "telegram: retried update 42");
        log("info", "telegram inbound poller started");
        log("info", "telegram getUpdates recovered after 1 error");
        log("warn", "inbound poll error: boom");
      });
      assert.deepEqual(
        sinkCalls.map((c) => c.type),
        ["info", "info", "info", "warning"],
      );
      assert.equal(
        sinkCalls[0].message,
        "[telegram] telegram: retried update 42",
      );
      assert.equal(
        sinkCalls[1].message,
        "[telegram] telegram inbound poller started",
      );
      assert.equal(
        sinkCalls[2].message,
        "[telegram] telegram getUpdates recovered after 1 error",
      );
      assert.equal(sinkCalls[3].message, "[telegram] inbound poll error: boom");
    });
    assert.equal(
      consoleCalls.length,
      0,
      "verbose still goes through the sink, never console",
    );
  });
});

test("log: TELEGRAM_VERBOSE alias alone re-enables debug/info to the sink (canonical still wins)", () => {
  withEnv({ BRAID_TG_VERBOSE: undefined, TELEGRAM_VERBOSE: "1" }, () => {
    const sinkCalls = withSink(() =>
      log("info", "telegram inbound poller started"),
    );
    assert.equal(sinkCalls.length, 1);
    assert.equal(sinkCalls[0].type, "info");
  });
  withEnv({ BRAID_TG_VERBOSE: "", TELEGRAM_VERBOSE: "1" }, () => {
    const sinkCalls = withSink(() =>
      log("info", "telegram inbound poller stopped"),
    );
    assert.equal(
      sinkCalls.length,
      1,
      "empty canonical falls through to the alias like every other key",
    );
  });
});

test("env alias: TELEGRAM_VERBOSE resolves; BRAID_TG_VERBOSE wins when both set", () => {
  withEnv({ BRAID_TG_VERBOSE: "1", TELEGRAM_VERBOSE: "0" }, () => {
    assert.equal(env(ENV_VERBOSE), "1"); // canonical trumps alias
  });
  withEnv({ BRAID_TG_VERBOSE: undefined, TELEGRAM_VERBOSE: "1" }, () => {
    assert.equal(env(ENV_VERBOSE), "1"); // alias fallback
  });
  withEnv({ BRAID_TG_VERBOSE: undefined, TELEGRAM_VERBOSE: undefined }, () => {
    assert.equal(env(ENV_VERBOSE), undefined); // neither set
  });
});

test("log: extra args fold into the notify message (Error becomes its message)", () => {
  withEnv({ BRAID_TG_VERBOSE: "1", TELEGRAM_VERBOSE: undefined }, () => {
    const sinkCalls = withSink(() => {
      log("warn", "inbound poll error", new Error("ECONNRESET"));
    });
    assert.equal(sinkCalls[0].type, "warning");
    assert.equal(
      sinkCalls[0].message,
      "[telegram] inbound poll error ECONNRESET",
    );
  });
});

test("factory: session_start binds the sink to ctx.ui.notify; session_shutdown clears it", async () => {
  const notifyCalls = [];
  const fakeCtx = {
    ui: { notify: (message, type) => notifyCalls.push({ message, type }) },
  };
  const pi = makeFakePi();
  const fetchFn = emptyUpdatesFetch();
  // HERMETIC: fake token + fake fetch + poll disabled — the factory must never
  // read the ambient real TELEGRAM_BOT_TOKEN or start a real long-poll (the
  // live bot is single-consumer; a stray poller steals owner messages).
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_POLL_DISABLED: "1",
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_VERBOSE: undefined,
      TELEGRAM_VERBOSE: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  const start = (pi.handlers.get("session_start") ?? [])[0];
  const shutdown = (pi.handlers.get("session_shutdown") ?? [])[0];
  assert.equal(
    typeof start,
    "function",
    "sink binder registered on session_start",
  );
  assert.equal(
    typeof shutdown,
    "function",
    "sink clearer registered on session_shutdown",
  );

  // A live session context (as pi-core's runner provides) binds the notify sink.
  start(undefined, fakeCtx);
  log("error", "telegram poll crash: boom");
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].type, "error");
  assert.equal(notifyCalls[0].message, "[telegram] telegram poll crash: boom");

  // Even with a sink bound, nothing ever goes to console.
  const consoleCalls = await withConsole(() =>
    log("warn", "inbound poll error: boom"),
  );
  assert.equal(consoleCalls.length, 0, "sink route never touches console.*");

  // Shutdown clears the sink — warn/error go silent again.
  shutdown(undefined, fakeCtx);
  const notifyBeforeShutdown = notifyCalls.length;
  log("warn", "inbound poll error: boom");
  assert.equal(
    notifyCalls.length,
    notifyBeforeShutdown,
    "sink cleared on session_shutdown — silent again",
  );
  setLogSink(undefined);
});

test("src: no console.* call sites anywhere in packages/telegram/src (TUI can never be polluted)", () => {
  function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
  }
  const srcDir = join(process.cwd(), "src");
  const offenders = [];
  for (const rel of walk(srcDir)) {
    // Strip comments so doc prose/prose mentioning console is ignored.
    const stripped = readFileSync(rel, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    stripped.split("\n").forEach((line, i) => {
      if (/console\.(log|warn|error|info|debug)\s*\(/.test(line)) {
        offenders.push(`${rel}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [], "no active console.* call in telegram src");
});

test("factory: token present + default env => ZERO console output at startup (all lifecycle info gated)", async () => {
  const fetchFn = emptyUpdatesFetch();
  const pi = makeFakePi();
  const calls = await withConsole(async () => {
    await withEnv(
      {
        BRAID_TG_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_BOT_TOKEN: undefined,
        BRAID_TG_POLL_DISABLED: undefined,
        TELEGRAM_POLL_DISABLED: undefined,
        BRAID_TG_POLL_ENABLED: undefined,
        TELEGRAM_POLL_ENABLED: undefined,
        BRAID_TG_STATE_FILE: tmpStateFile("silent"),
        TELEGRAM_STATE_FILE: undefined,
        BRAID_TG_POLL_INTERVAL_MS: undefined,
        BRAID_TG_VERBOSE: undefined,
        TELEGRAM_VERBOSE: undefined,
      },
      async () => {
        await telegramExtension(pi, { fetch: fetchFn });
      },
    );
  });
  // 3 tools registered (default-off; no poller auto-started).
  assert.equal(pi.tools.length, 3);
  assert.ok(pi.tools.some((t) => t.name === "telegram_send"));
  assert.equal(
    calls.length,
    0,
    "startup sees no stdout from the extension (all lifecycle info gated)",
  );

  // No poller auto-started by default — no lingering timer.
  pi.emit("session_shutdown");
  await sleep(50);
});

// ── Item 17 v4 surface: /telegram command + agentic tools ───────────────────

test("factory: registers the /telegram slash command with enable/send/disable/status verbs", async () => {
  const pi = makeFakePi();
  const fetchFn = emptyUpdatesFetch();
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_POLL_DISABLED: "1",
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("cmd"),
      TELEGRAM_STATE_FILE: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  assert.equal(pi.commands.length, 1);
  assert.equal(pi.commands[0].name, "telegram");
  assert.equal(typeof pi.commands[0].handler, "function");
  assert.match(pi.commands[0].description, /enable|send/);
});

test("factory: no /telegram command when token absent (if-has-token guard)", async () => {
  const pi = makeFakePi();
  const fetchFn = emptyUpdatesFetch();
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: undefined,
      TELEGRAM_BOT_TOKEN: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );
  assert.equal(pi.tools.length, 0);
  assert.equal(pi.commands.length, 0);
});

test("/telegram send: delivers plain text verbatim — no [tg-end] marker on outbound", async () => {
  const pi = makeFakePi();
  const sent = [];
  const fetchFn = makeFakeFetch(async (url, init) => {
    if (url.includes("sendMessage")) {
      const body = JSON.parse(init.body);
      sent.push(body.text);
      return jsonResponse({ ok: true, result: { message_id: 101 } });
    }
    return jsonResponse(getUpdatesResult([]));
  });
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_CHAT_ID: String(OWNER_CHAT_ID),
      TELEGRAM_CHAT_ID: undefined,
      BRAID_TG_POLL_DISABLED: "1",
      TELEGRAM_POLL_DISABLED: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  const notifyCalls = [];
  const ctx = { ui: { notify: (m, t) => notifyCalls.push({ m, t }) } };
  await pi.commands[0].handler("send hello owner", ctx);

  assert.equal(sent.length, 1);
  assert.equal(
    sent[0],
    "hello owner",
    "outbound must be the raw trimmed text, verbatim",
  );
  assert.ok(
    !sent[0].includes("[tg-end]"),
    `outbound must NOT carry the inbound-only [tg-end] marker, got: ${JSON.stringify(sent[0])}`,
  );
  assert.equal(notifyCalls.length, 1);
  assert.match(notifyCalls[0].m, /Sent to Telegram/);
});

test("/telegram enable: starts the singleton poller (getUpdates fires)", async () => {
  const pi = makeFakePi();
  const fetchFn = emptyUpdatesFetch();
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_POLL_DISABLED: undefined,
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("enable"),
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_POLL_INTERVAL_MS: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  // Default-off: nothing yet.
  assert.equal(fetchFn.calls.length, 0);

  const notifyCalls = [];
  const ctx = { ui: { notify: (m, t) => notifyCalls.push({ m, t }) } };
  await pi.commands[0].handler("enable", ctx);

  await waitForPollerEffect(
    "the poller issued no getUpdates",
    () => fetchFn.calls.some((c) => c.url.includes("getUpdates")),
    2000,
  );
  assert.ok(
    fetchFn.calls.some((c) => c.url.includes("getUpdates")),
    "/telegram enable starts the poller",
  );
  assert.equal(notifyCalls.length, 1);
  assert.match(notifyCalls[0].m, /enabled/);

  // Singleton: a second enable is a no-op (no extra poller).
  const before = fetchFn.calls.filter((c) =>
    c.url.includes("getUpdates"),
  ).length;
  await pi.commands[0].handler("enable", ctx);
  await sleep(50);
  const after = fetchFn.calls.filter((c) =>
    c.url.includes("getUpdates"),
  ).length;
  assert.equal(after, before, "second enable must not start a second poller");

  pi.emit("session_shutdown");
  await sleep(50);
});

test("telegram_inbox tool: registered and returns pending messages via fetchInbox", async () => {
  const pi = makeFakePi();
  const updates = [
    makeUpdate(1, { text: "owner ping" }),
    makeUpdate(2, {
      from: { id: FOREIGN_ID, is_bot: false },
      text: "foreign ping",
    }),
  ];
  const fetchFn = makeFakeFetch(makeUpdatesServer(updates));
  let result;
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_ALLOWED_USERS: String(OWNER_ID),
      TELEGRAM_ALLOWED_USERS: undefined,
      BRAID_TG_POLL_DISABLED: "1",
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("inbox"),
      TELEGRAM_STATE_FILE: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
      const inboxTool = pi.tools.find((t) => t.name === "telegram_inbox");
      assert.ok(inboxTool, "telegram_inbox tool registered");
      result = await inboxTool.execute("id", {}, undefined, undefined);
    },
  );
  const text = result.content[0].text;
  assert.match(text, /telegram_inbox: 2 message\(s\)/);
  assert.match(
    text,
    /\[braid-whisper - telegram( @ [^\]]+)?\]/,
    "envelope (with send-time clock) present",
  );
  // Envelope shows provenance; the fromOwner gate lives in the structured details.
  assert.ok(JSON.stringify(result.details).includes('"fromOwner":true'));
  assert.ok(JSON.stringify(result.details).includes('"fromOwner":false'));
});

test("telegram_poller tool: enable starts poller, disable stops it, unknown action errors", async () => {
  const pi = makeFakePi();
  const fetchFn = emptyUpdatesFetch();
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_POLL_DISABLED: undefined,
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("poller-tool"),
      TELEGRAM_STATE_FILE: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  const pollerTool = pi.tools.find((t) => t.name === "telegram_poller");
  assert.ok(pollerTool, "telegram_poller tool registered");

  // Default: not running.
  assert.equal(fetchFn.calls.length, 0);

  // Enable -> poller starts.
  const r1 = await pollerTool.execute(
    "id",
    { action: "enable" },
    undefined,
    undefined,
  );
  assert.equal(r1.details.running, true, r1.details.error ?? "poller state");
  await waitForPollerEffect(
    "the poller issued no getUpdates",
    () => fetchFn.calls.some((c) => c.url.includes("getUpdates")),
    2000,
  );
  assert.ok(fetchFn.calls.some((c) => c.url.includes("getUpdates")));

  // Singleton: enable again is a no-op.
  const r2 = await pollerTool.execute(
    "id",
    { action: "enable" },
    undefined,
    undefined,
  );
  assert.equal(r2.details.running, true, r2.details.error ?? "poller state");

  // Disable -> poller stops.
  const r3 = await pollerTool.execute(
    "id",
    { action: "disable" },
    undefined,
    undefined,
  );
  assert.equal(r3.details.running, false, r3.details.error ?? "poller state");
  assert.equal(r3.details.wasRunning, true);

  // Unknown action -> error.
  const r4 = await pollerTool.execute(
    "id",
    { action: "bogus" },
    undefined,
    undefined,
  );
  assert.equal(r4.details.ok, false);
  assert.match(r4.details.error, /unknown action/);
});

test("telegram_poller tool: owner-message delivery uses deliverAs 'steer'", async () => {
  const pi = makeFakePi();
  // Stateful getUpdates server that hands the real poller ONE owner message.
  const fetchFn = makeFakeFetch(makeUpdatesServer([makeUpdate(101)]));
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_ALLOWED_USERS: String(OWNER_ID),
      TELEGRAM_ALLOWED_USERS: undefined,
      BRAID_TG_POLL_DISABLED: undefined,
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("steer"),
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_POLL_INTERVAL_MS: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  const pollerTool = pi.tools.find((t) => t.name === "telegram_poller");
  assert.ok(pollerTool, "telegram_poller tool registered");

  // Enable -> poller starts. The owner message must reach pi.sendUserMessage
  // with deliverAs "steer" (immediate current-turn injection), never the
  // next-task "followUp" (the old ~4-min inbound-lag path).
  const r1 = await pollerTool.execute(
    "id",
    { action: "enable" },
    undefined,
    undefined,
  );
  assert.equal(r1.details.running, true, r1.details.error ?? "poller state");

  await waitFor(() => pi.messages.length >= 1, 3000);
  assert.equal(pi.messages.length, 1, "exactly one owner message delivered");

  const [content, options] = pi.messages[0];
  assert.equal(
    options?.deliverAs,
    "steer",
    "inbound owner message must be delivered as steer, not followUp",
  );
  assert.equal(typeof content, "string");
  assert.match(
    content,
    /^\[braid-whisper - telegram( @ [^\]]+)?\]/,
    "whisper envelope (with send-time clock) preserved",
  );
  assert.ok(
    content.includes("hello from owner"),
    "formatted whisper body carries the owner text",
  );

  pi.emit("session_shutdown");
  await sleep(50);
});

// ── STT: Venice chat/input_audio default + AGENT_ZERO_API_KEY fallback ──────

test("env alias: ENV_STT_MODE resolves (BRAID_TG_STT_MODE canonical, TELEGRAM_STT_MODE fallback)", () => {
  withEnv(
    { BRAID_TG_STT_MODE: undefined, TELEGRAM_STT_MODE: "transcriptions" },
    () => {
      assert.equal(env(ENV_STT_MODE), "transcriptions"); // alias fallback
    },
  );
  withEnv(
    { BRAID_TG_STT_MODE: "chat", TELEGRAM_STT_MODE: "transcriptions" },
    () => {
      assert.equal(env(ENV_STT_MODE), "chat"); // canonical wins
    },
  );
  withEnv(
    { BRAID_TG_STT_MODE: undefined, TELEGRAM_STT_MODE: undefined },
    () => {
      assert.equal(env(ENV_STT_MODE), undefined); // neither set
    },
  );
});

/** Voice update for the STT factory tests (mirrors voice-inbound fixtures). */
function makeSttVoiceUpdate(updateId) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 1000,
      from: {
        id: OWNER_ID,
        is_bot: false,
        first_name: "Owner",
        username: "owner",
      },
      chat: { id: OWNER_CHAT_ID, type: "private", username: "owner" },
      date: 1700000000,
      voice: {
        file_id: "voice_file_id",
        file_unique_id: "vu",
        duration: 3,
        mime_type: "audio/ogg",
        file_size: 1200,
      },
    },
  };
}

/** Fake fetch serving getUpdates + getFile + download + the STT route; records STT calls. */
function makeSttServer({ updates, sttRoute, sttBody }) {
  const sttCalls = [];
  const bytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53]); // "OggS"
  const handler = async (url, init = {}) => {
    if (url.includes("getUpdates"))
      return jsonResponse(getUpdatesResult(updates));
    if (url.includes("getFile")) {
      return jsonResponse({
        ok: true,
        result: { file_id: "voice_file_id", file_path: "voice/file_1.ogg" },
      });
    }
    if (url.includes("/file/bot")) {
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    }
    if (url.includes(sttRoute)) {
      sttCalls.push(init);
      return jsonResponse(sttBody);
    }
    throw new Error(`unexpected url: ${url}`);
  };
  handler.sttCalls = sttCalls;
  return handler;
}

test("factory: STT defaults to Venice chat/input_audio on AGENT_ZERO_API_KEY (no BRAID_TG_STT_API_KEY) — inbox voice transcribed via /chat/completions", async () => {
  const pi = makeFakePi();
  const server = makeSttServer({
    updates: [makeSttVoiceUpdate(31)],
    sttRoute: "/chat/completions",
    sttBody: { choices: [{ message: { content: "привет мир" } }] },
  });
  const fetchFn = makeFakeFetch(server);
  let result;
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_ALLOWED_USERS: String(OWNER_ID),
      TELEGRAM_ALLOWED_USERS: undefined,
      BRAID_TG_POLL_DISABLED: "1",
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("stt-chat"),
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_MEDIA_DIR: tmpDir("stt-chat-media"),
      TELEGRAM_MEDIA_DIR: undefined,
      BRAID_HOME: tmpDir("stt-chat-braid"),
      BRAID_TG_STT_API_KEY: undefined,
      TELEGRAM_STT_API_KEY: undefined,
      AGENT_ZERO_API_KEY: "venice-key",
      BRAID_TG_STT_MODE: undefined,
      TELEGRAM_STT_MODE: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
      const inboxTool = pi.tools.find((t) => t.name === "telegram_inbox");
      result = await inboxTool.execute("id", {}, undefined, undefined);
    },
  );

  assert.equal(
    server.sttCalls.length,
    1,
    "STT called once (mode default chat)",
  );
  const sttInit = server.sttCalls[0];
  assert.equal(
    sttInit.headers.Authorization,
    "Bearer venice-key",
    "apiKey falls back to AGENT_ZERO_API_KEY",
  );
  const body = JSON.parse(sttInit.body);
  assert.equal(body.messages[0].content[0].type, "input_audio");
  assert.equal(body.messages[0].content[0].input_audio.format, "ogg");
  assert.equal(
    body.messages[0].content[0].input_audio.data,
    Buffer.from([0x4f, 0x67, 0x67, 0x53]).toString("base64"),
    "input_audio.data is base64 of the downloaded bytes",
  );
  assert.match(
    result.content[0].text,
    /привет мир/,
    "transcript delivered in the inbox message",
  );
});

test("factory: BRAID_TG_STT_MODE=transcriptions opts back to the OpenAI /audio/transcriptions route", async () => {
  const pi = makeFakePi();
  const server = makeSttServer({
    updates: [makeSttVoiceUpdate(32)],
    sttRoute: "/audio/transcriptions",
    sttBody: { text: "hello" },
  });
  const fetchFn = makeFakeFetch(server);
  let result;
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_ALLOWED_USERS: String(OWNER_ID),
      TELEGRAM_ALLOWED_USERS: undefined,
      BRAID_TG_POLL_DISABLED: "1",
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("stt-transcriptions"),
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_MEDIA_DIR: tmpDir("stt-transcriptions-media"),
      TELEGRAM_MEDIA_DIR: undefined,
      BRAID_HOME: tmpDir("stt-transcriptions-braid"),
      BRAID_TG_STT_API_KEY: "sk-test",
      TELEGRAM_STT_API_KEY: undefined,
      BRAID_TG_STT_MODE: "transcriptions",
      TELEGRAM_STT_MODE: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
      const inboxTool = pi.tools.find((t) => t.name === "telegram_inbox");
      result = await inboxTool.execute("id", {}, undefined, undefined);
    },
  );

  assert.equal(
    server.sttCalls.length,
    1,
    "STT called once (mode transcriptions)",
  );
  const sttInit = server.sttCalls[0];
  assert.equal(sttInit.headers.Authorization, "Bearer sk-test");
  assert.ok(
    sttInit.body instanceof FormData,
    "multipart form on the transcriptions path",
  );
  assert.match(
    result.content[0].text,
    /hello/,
    "transcript delivered in the inbox message",
  );
});

test("factory: mode=transcriptions with NO explicit key does NOT leak the Venice key to the OpenAI endpoint", async () => {
  const pi = makeFakePi();
  const server = makeSttServer({
    updates: [makeSttVoiceUpdate(33)],
    sttRoute: "/audio/transcriptions",
    sttBody: { text: "hello" },
  });
  const fetchFn = makeFakeFetch(server);
  let result;
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_ALLOWED_USERS: String(OWNER_ID),
      TELEGRAM_ALLOWED_USERS: undefined,
      BRAID_TG_POLL_DISABLED: "1",
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("stt-modegate"),
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_MEDIA_DIR: tmpDir("stt-modegate-media"),
      TELEGRAM_MEDIA_DIR: undefined,
      BRAID_HOME: tmpDir("stt-modegate-braid"),
      BRAID_TG_STT_API_KEY: undefined,
      TELEGRAM_STT_API_KEY: undefined,
      AGENT_ZERO_API_KEY: "venice-key",
      BRAID_TG_STT_MODE: "transcriptions",
      TELEGRAM_STT_MODE: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
      const inboxTool = pi.tools.find((t) => t.name === "telegram_inbox");
      result = await inboxTool.execute("id", {}, undefined, undefined);
    },
  );

  assert.equal(
    server.sttCalls.length,
    0,
    "no STT call: the Venice key must never reach the OpenAI /audio/transcriptions endpoint",
  );
  assert.match(
    result.content[0].text,
    /transcript: unavailable/,
    "voice still delivered with the unavailable note (no key configured for this mode)",
  );
});

// ── Live-update tracked message ─────────────────────────────────────────────

test("env alias: live-update flags resolve (BRAID_TG_LIVE_UPDATE_* canonical, TELEGRAM_* fallback)", () => {
  withEnv(
    {
      BRAID_TG_LIVE_UPDATE_ENABLED: undefined,
      TELEGRAM_LIVE_UPDATE_ENABLED: "1",
    },
    () => {
      assert.equal(env(ENV_LIVE_UPDATE_ENABLED), "1"); // alias fallback
    },
  );
  withEnv(
    {
      BRAID_TG_LIVE_UPDATE_ENABLED: "1",
      TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
    },
    () => {
      assert.equal(env(ENV_LIVE_UPDATE_ENABLED), "1");
    },
  );
  withEnv(
    { BRAID_TG_LIVE_UPDATE_ENABLED: "true", TELEGRAM_LIVE_UPDATE_ENABLED: "1" },
    () => {
      assert.equal(env(ENV_LIVE_UPDATE_ENABLED), "true"); // canonical trumps alias
    },
  );
  withEnv(
    {
      BRAID_TG_LIVE_UPDATE_ENABLED: undefined,
      TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
    },
    () => {
      assert.equal(env(ENV_LIVE_UPDATE_ENABLED), undefined);
    },
  );
  withEnv(
    {
      BRAID_TG_LIVE_UPDATE_MAX_PER_MIN: "2",
      TELEGRAM_LIVE_UPDATE_MAX_PER_MIN: "9",
    },
    () => {
      assert.equal(env(ENV_LIVE_UPDATE_MAX_PER_MIN), "2");
    },
  );
  withEnv(
    {
      BRAID_TG_LIVE_UPDATE_MAX_PER_MIN: undefined,
      TELEGRAM_LIVE_UPDATE_MAX_PER_MIN: "9",
    },
    () => {
      assert.equal(env(ENV_LIVE_UPDATE_MAX_PER_MIN), "9");
    },
  );
  withEnv(
    {
      BRAID_TG_LIVE_UPDATE_STATE_FILE: "/tmp/x.json",
      TELEGRAM_LIVE_UPDATE_STATE_FILE: undefined,
    },
    () => {
      assert.equal(env(ENV_LIVE_UPDATE_STATE_FILE), "/tmp/x.json");
    },
  );
});

test("factory: BRAID_TG_LIVE_UPDATE_ENABLED=0 disables live-update — no turn_end finish listener, inbound owner messages do NOT pin a tracked message", async () => {
  const pi = makeFakePi();
  const updates = [makeUpdate(12, { text: "do the thing" })];
  const updatesHandler = makeUpdatesServer(updates);
  const sent = [];
  const fetchFn = makeFakeFetch(async (url, init) => {
    if (url.includes("sendMessage")) {
      sent.push(JSON.parse(init.body));
      return jsonResponse(sendMessageResult(1));
    }
    return updatesHandler(url);
  });
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_CHAT_ID: String(OWNER_CHAT_ID),
      TELEGRAM_CHAT_ID: undefined,
      BRAID_TG_ALLOWED_USERS: String(OWNER_ID),
      TELEGRAM_ALLOWED_USERS: undefined,
      BRAID_TG_POLL_ENABLED: "1",
      TELEGRAM_POLL_ENABLED: undefined,
      BRAID_TG_COALESCE_WINDOW_MS: "30",
      TELEGRAM_COALESCE_WINDOW_MS: undefined,
      BRAID_TG_POLL_DISABLED: undefined,
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("live-off"),
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_LIVE_UPDATE_ENABLED: "0",
      TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
      BRAID_TG_NOTIFY_ENABLED: undefined,
      TELEGRAM_NOTIFY_ENABLED: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  try {
    await waitForPollerEffect(
      "the owner message was never delivered",
      () => pi.messages.length >= 1,
      3000,
    );
    assert.equal(
      pi.messages.length,
      1,
      "owner message still delivered normally",
    );
    // Live-update off: the ONLY outbound is the boot control-keyboard placement
    // (poller-start seam) — there must be no tracked Working… send.
    assert.equal(
      sent.length,
      1,
      "one send — the boot control keyboard, nothing else",
    );
    assert.ok(
      sent[0].reply_markup,
      "that send carries the control keyboard (reply_markup)",
    );
    assert.notEqual(
      sent[0].text,
      TRACKED_START_TEXT,
      "no tracked message when live-update is disabled (=0)",
    );
    assert.equal(
      pi.handlers.has("turn_end"),
      false,
      "no turn_end listener (live-update off + notify off)",
    );
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("factory: live-update default-ON — no flags => turn_end finish listener registered + inbound owner message pins a tracked message", async () => {
  const pi = makeFakePi();
  const liveStateFile = tmpStateFile("live-default-on");
  const updates = [makeUpdate(19, { text: "default on" })];
  const updatesHandler = makeUpdatesServer(updates);
  const sent = [];
  const fetchFn = makeFakeFetch(async (url, init) => {
    if (url.includes("sendMessage")) {
      const body = JSON.parse(init.body);
      sent.push(body);
      return jsonResponse(sendMessageResult(9001));
    }
    return updatesHandler(url);
  });
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_CHAT_ID: String(OWNER_CHAT_ID),
      TELEGRAM_CHAT_ID: undefined,
      BRAID_TG_ALLOWED_USERS: String(OWNER_ID),
      TELEGRAM_ALLOWED_USERS: undefined,
      BRAID_TG_POLL_ENABLED: "1",
      TELEGRAM_POLL_ENABLED: undefined,
      BRAID_TG_COALESCE_WINDOW_MS: "30",
      TELEGRAM_COALESCE_WINDOW_MS: undefined,
      BRAID_TG_POLL_DISABLED: undefined,
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("live-default-on-offset"),
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_LIVE_UPDATE_ENABLED: undefined,
      TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
      BRAID_TG_LIVE_UPDATE_STATE_FILE: liveStateFile,
      TELEGRAM_LIVE_UPDATE_STATE_FILE: undefined,
      BRAID_TG_NOTIFY_ENABLED: undefined,
      TELEGRAM_NOTIFY_ENABLED: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  try {
    // Default-on: the live-update turn_end finish listener is registered even
    // with NO env flags (notify stays off — this listener is live-update's).
    assert.equal(
      pi.handlers.has("turn_end"),
      true,
      "live-update default-on registers the turn_end finish listener",
    );

    // Inbound owner message → live-update start() sends the tracked message.
    // sent[0] is the boot control-keyboard placement (poller-start seam);
    // sent[1] is the tracked Working… message pinned by live-update.
    await waitForPollerEffect(
      "the tracked message or the delivery never appeared",
      () => sent.length >= 2 && pi.messages.length >= 1,
      3000,
    );
    assert.equal(
      sent.length,
      2,
      "boot control keyboard + exactly one tracked Working… message",
    );
    assert.ok(
      sent[0].reply_markup,
      "sent[0] is the control keyboard (reply_markup attached)",
    );
    assert.equal(sent[1].text, TRACKED_START_TEXT);
    assert.equal(sent[1].chat_id, String(OWNER_CHAT_ID));
    // start() persists the tracked id asynchronously after the send lands;
    // poll the file rather than read it once (a mid-write read throws).
    const persisted = await waitForJson(
      liveStateFile,
      (state) => state.messageId === 9001,
      3000,
    );
    assert.equal(
      persisted.messageId,
      9001,
      "tracked message persisted by default",
    );
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("factory: BRAID_TG_LIVE_UPDATE_ENABLED=1 pins a Working… tracked message on inbound, then finish() edits to Done + sends a final summary", async () => {
  const pi = makeFakePi();
  const liveStateFile = tmpStateFile("live-on");
  const updates = [makeUpdate(13, { text: "run the report" })];
  const updatesHandler = makeUpdatesServer(updates);
  const sent = [];
  const edited = [];
  const fetchFn = makeFakeFetch(async (url, init) => {
    if (url.includes("sendMessage")) {
      const body = JSON.parse(init.body);
      sent.push(body);
      return jsonResponse(sendMessageResult(5000));
    }
    if (url.includes("editMessageText")) {
      const body = JSON.parse(init.body);
      edited.push(body);
      return jsonResponse({
        ok: true,
        result: { message_id: body.message_id },
      });
    }
    return updatesHandler(url);
  });
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_CHAT_ID: String(OWNER_CHAT_ID),
      TELEGRAM_CHAT_ID: undefined,
      BRAID_TG_ALLOWED_USERS: String(OWNER_ID),
      TELEGRAM_ALLOWED_USERS: undefined,
      BRAID_TG_POLL_ENABLED: "1",
      TELEGRAM_POLL_ENABLED: undefined,
      BRAID_TG_COALESCE_WINDOW_MS: "30",
      TELEGRAM_COALESCE_WINDOW_MS: undefined,
      BRAID_TG_POLL_DISABLED: undefined,
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("live-on-offset"),
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_LIVE_UPDATE_ENABLED: "1",
      TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
      BRAID_TG_LIVE_UPDATE_STATE_FILE: liveStateFile,
      TELEGRAM_LIVE_UPDATE_STATE_FILE: undefined,
      BRAID_TG_NOTIFY_ENABLED: undefined,
      TELEGRAM_NOTIFY_ENABLED: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  try {
    // Live-update finish listener registered (notify is off — this is live-update's).
    assert.equal(
      pi.handlers.has("turn_end"),
      true,
      "live-update registers the turn_end finish listener",
    );

    // Inbound owner message → live-update start() sends the tracked message.
    // sent[0] is the boot control keyboard (poller-start seam); sent[1] is the
    // tracked Working… message pinned by live-update.
    await waitForPollerEffect(
      "the tracked message or the delivery never appeared",
      () => sent.length >= 2 && pi.messages.length >= 1,
      3000,
    );
    assert.equal(
      sent.length,
      2,
      "boot control keyboard + tracked Working… message",
    );
    assert.ok(
      sent[0].reply_markup,
      "sent[0] is the control keyboard (reply_markup)",
    );
    assert.equal(sent[1].chat_id, String(OWNER_CHAT_ID));
    assert.equal(sent[1].text, TRACKED_START_TEXT);

    // Steer delivery still intact.
    const [, options] = pi.messages[0];
    assert.equal(options?.deliverAs, "steer");

    // turn_end with a completed answer → finish(): edit tracked → Done, then summary.
    const doneEvent = {
      type: "turn_end",
      turnIndex: 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The report is ready." }],
        stopReason: "stop",
      },
      toolResults: [],
    };
    for (const fn of pi.handlers.get("turn_end") ?? [])
      await fn(doneEvent, undefined);

    assert.equal(edited.length, 1, "tracked message edited once (to Done)");
    assert.equal(edited[0].message_id, 5000);
    assert.equal(edited[0].text, TRACKED_DONE_TEXT);
    assert.equal(sent.length, 3, "control keyboard + Working… + final summary");
    assert.equal(
      sent[2].text,
      "The report is ready.",
      "raw final answer sent (no craft ctx in test)",
    );
    assert.equal(sent[2].chat_id, String(OWNER_CHAT_ID));

    // Tracked message is done — the state file is cleared after finish.
    assert.deepEqual(JSON.parse(readFileSync(liveStateFile, "utf8")), {
      messageId: 0,
      chatId: 0,
      startedAt: 0,
    });
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("factory: live-update finish does NOT fire on a trailing-tool-call turn (keeps the tracked message open)", async () => {
  const pi = makeFakePi();
  const liveStateFile = tmpStateFile("live-trailing");
  const updates = [makeUpdate(14, { text: "start investigating" })];
  const updatesHandler = makeUpdatesServer(updates);
  const sent = [];
  const edited = [];
  const fetchFn = makeFakeFetch(async (url, init) => {
    if (url.includes("sendMessage")) {
      sent.push(JSON.parse(init.body));
      return jsonResponse(sendMessageResult(5001));
    }
    if (url.includes("editMessageText")) {
      edited.push(JSON.parse(init.body));
      return jsonResponse({ ok: true, result: { message_id: 5001 } });
    }
    return updatesHandler(url);
  });
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_CHAT_ID: String(OWNER_CHAT_ID),
      TELEGRAM_CHAT_ID: undefined,
      BRAID_TG_ALLOWED_USERS: String(OWNER_ID),
      TELEGRAM_ALLOWED_USERS: undefined,
      BRAID_TG_POLL_ENABLED: "1",
      TELEGRAM_POLL_ENABLED: undefined,
      BRAID_TG_COALESCE_WINDOW_MS: "30",
      TELEGRAM_COALESCE_WINDOW_MS: undefined,
      BRAID_TG_POLL_DISABLED: undefined,
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("live-trailing-offset"),
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_LIVE_UPDATE_ENABLED: "1",
      TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
      BRAID_TG_LIVE_UPDATE_STATE_FILE: liveStateFile,
      TELEGRAM_LIVE_UPDATE_STATE_FILE: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  try {
    // sent[0] = boot control keyboard (poller-start seam); sent[1] = tracked Working….
    await waitForPollerEffect(
      "the control message + tracked indicator never appeared",
      () => sent.length >= 2,
      3000,
    );
    assert.equal(
      sent.length,
      2,
      "boot control keyboard + tracked message pinned",
    );
    assert.equal(sent[1].text, TRACKED_START_TEXT);

    const trailingEvent = {
      type: "turn_end",
      turnIndex: 2,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check the logs." },
          { type: "toolCall", id: "t1", name: "grep", arguments: {} },
        ],
        stopReason: "toolUse",
      },
      toolResults: [],
    };
    for (const fn of pi.handlers.get("turn_end") ?? [])
      await fn(trailingEvent, undefined);

    assert.equal(
      edited.length,
      0,
      "trailing-tool turn does NOT finish the tracked message",
    );
    assert.equal(
      sent.length,
      2,
      "no summary sent (only control keyboard + Working…)",
    );
    // The persisted id comes from start()'s async write; poll for it.
    const persisted = await waitForJson(
      liveStateFile,
      (state) => state.messageId === 5001,
      3000,
    );
    assert.equal(
      persisted.messageId,
      5001,
      "tracked state intact after a toolUse turn → indicator STAYS active (§5b-2)",
    );
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

// ── §5b-2: abort/error turns TERMINATE the live-update indicator ───────────
// Canonical terminal detection (context-manager handlers/events.ts): the last
// assistant stopReason is "error" or "aborted" (or there is no assistant
// report at all) → the task is OVER without a report, so the tracked message
// must be edited to "⏹️ Turn ended without a report" and the persisted state
// cleared. toolUse (and other non-terminal) turns keep it active.

test("factory: §5b-2 — abort turn releases the indicator (terminal edit, state cleared, no summary)", async () => {
  const pi = makeFakePi();
  const liveStateFile = tmpStateFile("live-5b2-abort");
  const updates = [makeUpdate(15, { text: "start the task" })];
  const updatesHandler = makeUpdatesServer(updates);
  const sent = [];
  const edited = [];
  const fetchFn = makeFakeFetch(async (url, init) => {
    if (url.includes("sendMessage")) {
      const body = JSON.parse(init.body);
      sent.push(body);
      return jsonResponse(sendMessageResult(7001));
    }
    if (url.includes("editMessageText")) {
      const body = JSON.parse(init.body);
      edited.push(body);
      return jsonResponse({
        ok: true,
        result: { message_id: body.message_id },
      });
    }
    return updatesHandler(url);
  });
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_CHAT_ID: String(OWNER_CHAT_ID),
      TELEGRAM_CHAT_ID: undefined,
      BRAID_TG_ALLOWED_USERS: String(OWNER_ID),
      TELEGRAM_ALLOWED_USERS: undefined,
      BRAID_TG_POLL_ENABLED: "1",
      TELEGRAM_POLL_ENABLED: undefined,
      BRAID_TG_COALESCE_WINDOW_MS: "30",
      TELEGRAM_COALESCE_WINDOW_MS: undefined,
      BRAID_TG_POLL_DISABLED: undefined,
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("live-5b2-abort-offset"),
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_LIVE_UPDATE_ENABLED: "1",
      TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
      BRAID_TG_LIVE_UPDATE_STATE_FILE: liveStateFile,
      TELEGRAM_LIVE_UPDATE_STATE_FILE: undefined,
      BRAID_TG_NOTIFY_ENABLED: undefined,
      TELEGRAM_NOTIFY_ENABLED: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  try {
    // sent[0] = boot control keyboard (poller-start seam); sent[1] = tracked Working….
    await waitForPollerEffect(
      "the control message + tracked indicator never appeared",
      () => sent.length >= 2,
      3000,
    );
    assert.equal(
      sent.length,
      2,
      "boot control keyboard + tracked Working… pinned",
    );
    assert.ok(sent[0].reply_markup, "sent[0] is the control keyboard");
    assert.equal(sent[1].text, TRACKED_START_TEXT);

    // Abort with NO assistant content — shouldNotifyTurnEnd was false; the
    // indicator must still be released on the terminal path.
    const abortEvent = {
      type: "turn_end",
      turnIndex: 1,
      message: { role: "assistant", content: [], stopReason: "aborted" },
      toolResults: [],
    };
    for (const fn of pi.handlers.get("turn_end") ?? [])
      await fn(abortEvent, undefined);

    assert.equal(edited.length, 1, "abort turn edits the tracked message once");
    assert.equal(edited[0].message_id, 7001);
    assert.equal(
      edited[0].text,
      TRACKED_TERMINAL_TEXT,
      "terminal edit text, distinct from Done",
    );
    assert.notEqual(edited[0].text, TRACKED_DONE_TEXT);
    assert.equal(
      sent.length,
      2,
      "NO summary on an aborted turn (control keyboard + Working… only)",
    );
    assert.deepEqual(
      JSON.parse(readFileSync(liveStateFile, "utf8")),
      { messageId: 0, chatId: 0, startedAt: 0 },
      "state file cleared → indicator released (§5b-2)",
    );
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("factory: §5b-2 — error turn with partial text terminates, never '✅ Done' + summary", async () => {
  const pi = makeFakePi();
  const liveStateFile = tmpStateFile("live-5b2-error");
  const updates = [makeUpdate(16, { text: "run the report" })];
  const updatesHandler = makeUpdatesServer(updates);
  const sent = [];
  const edited = [];
  const fetchFn = makeFakeFetch(async (url, init) => {
    if (url.includes("sendMessage")) {
      const body = JSON.parse(init.body);
      sent.push(body);
      return jsonResponse(sendMessageResult(7002));
    }
    if (url.includes("editMessageText")) {
      const body = JSON.parse(init.body);
      edited.push(body);
      return jsonResponse({
        ok: true,
        result: { message_id: body.message_id },
      });
    }
    return updatesHandler(url);
  });
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_CHAT_ID: String(OWNER_CHAT_ID),
      TELEGRAM_CHAT_ID: undefined,
      BRAID_TG_ALLOWED_USERS: String(OWNER_ID),
      TELEGRAM_ALLOWED_USERS: undefined,
      BRAID_TG_POLL_ENABLED: "1",
      TELEGRAM_POLL_ENABLED: undefined,
      BRAID_TG_COALESCE_WINDOW_MS: "30",
      TELEGRAM_COALESCE_WINDOW_MS: undefined,
      BRAID_TG_POLL_DISABLED: undefined,
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("live-5b2-error-offset"),
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_LIVE_UPDATE_ENABLED: "1",
      TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
      BRAID_TG_LIVE_UPDATE_STATE_FILE: liveStateFile,
      TELEGRAM_LIVE_UPDATE_STATE_FILE: undefined,
      BRAID_TG_NOTIFY_ENABLED: undefined,
      TELEGRAM_NOTIFY_ENABLED: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  try {
    // sent[0] = boot control keyboard (poller-start seam); sent[1] = tracked Working….
    await waitForPollerEffect(
      "the control message + tracked indicator never appeared",
      () => sent.length >= 2,
      3000,
    );
    assert.equal(
      sent.length,
      2,
      "boot control keyboard + tracked Working… pinned",
    );
    assert.equal(sent[1].text, TRACKED_START_TEXT);

    // Error with STALE partial text: the old finish() path would have treated
    // this as a completed answer ("✅ Done" + summary). §5b-2 says error is
    // terminal — the indicator must terminate, never fake completion.
    const errorEvent = {
      type: "turn_end",
      turnIndex: 100,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial output before the failure" }],
        stopReason: "error",
      },
      toolResults: [],
    };
    for (const fn of pi.handlers.get("turn_end") ?? [])
      await fn(errorEvent, undefined);

    assert.equal(edited.length, 1, "error turn edits the tracked message once");
    assert.equal(
      edited[0].text,
      TRACKED_TERMINAL_TEXT,
      "error → terminal edit, NOT ✅ Done",
    );
    assert.equal(
      sent.length,
      2,
      "error turn sends NO summary (control keyboard + Working… only)",
    );
    assert.deepEqual(
      JSON.parse(readFileSync(liveStateFile, "utf8")),
      { messageId: 0, chatId: 0, startedAt: 0 },
      "state file cleared on error → indicator released",
    );
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("factory: §5b-2 — a completed turn still finishes '✅ Done' after a prior abort released the indicator", async () => {
  const pi = makeFakePi();
  const liveStateFile = tmpStateFile("live-5b2-coexist");
  // Deterministic inbound sequencing: the second owner message is gated behind
  // a flag flipped only AFTER the abort has released the first tracked message
  // — no reliance on poller timing.
  let releaseSecondInbound = false;
  const sent = [];
  const edited = [];
  let messageSeq = 8000;
  const firstTask = makeUpdate(17, { text: "first task" });
  const fetchFn = makeFakeFetch(async (url, init) => {
    if (url.includes("sendMessage")) {
      const body = JSON.parse(init.body);
      sent.push(body);
      return jsonResponse(sendMessageResult(++messageSeq));
    }
    if (url.includes("editMessageText")) {
      const body = JSON.parse(init.body);
      edited.push(body);
      return jsonResponse({
        ok: true,
        result: { message_id: body.message_id },
      });
    }
    // getUpdates: owner message 17, then 18 once the flag is released.
    // Offset-aware (mirrors makeUpdatesServer) so 17 is never redelivered.
    const batch = [firstTask];
    if (releaseSecondInbound)
      batch.push(makeUpdate(18, { text: "second task" }));
    const offset = Number(new URL(url).searchParams.get("offset") ?? 0);
    const available = batch
      .filter((u) => u.update_id >= offset)
      .sort((a, b) => a.update_id - b.update_id);
    return jsonResponse(getUpdatesResult(available));
  });
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_CHAT_ID: String(OWNER_CHAT_ID),
      TELEGRAM_CHAT_ID: undefined,
      BRAID_TG_ALLOWED_USERS: String(OWNER_ID),
      TELEGRAM_ALLOWED_USERS: undefined,
      BRAID_TG_POLL_ENABLED: "1",
      TELEGRAM_POLL_ENABLED: undefined,
      BRAID_TG_COALESCE_WINDOW_MS: "30",
      TELEGRAM_COALESCE_WINDOW_MS: undefined,
      BRAID_TG_POLL_DISABLED: undefined,
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("live-5b2-coexist-offset"),
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_LIVE_UPDATE_ENABLED: "1",
      TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
      BRAID_TG_LIVE_UPDATE_STATE_FILE: liveStateFile,
      TELEGRAM_LIVE_UPDATE_STATE_FILE: undefined,
      BRAID_TG_NOTIFY_ENABLED: undefined,
      TELEGRAM_NOTIFY_ENABLED: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  try {
    // sent[0] = boot control keyboard (poller-start seam); sent[1] = first Working….
    await waitForPollerEffect(
      "the control message + tracked indicator never appeared",
      () => sent.length >= 2,
      3000,
    );
    assert.equal(
      sent.length,
      2,
      "boot control keyboard + first tracked message pinned",
    );
    assert.equal(sent[1].text, TRACKED_START_TEXT);

    // Abort → terminate (edited to the terminal state, no summary, state cleared).
    const abortEvent = {
      type: "turn_end",
      turnIndex: 1,
      message: { role: "assistant", content: [], stopReason: "aborted" },
      toolResults: [],
    };
    for (const fn of pi.handlers.get("turn_end") ?? [])
      await fn(abortEvent, undefined);
    assert.equal(edited.length, 1);
    assert.equal(edited[0].text, TRACKED_TERMINAL_TEXT);
    assert.deepEqual(
      JSON.parse(readFileSync(liveStateFile, "utf8")),
      { messageId: 0, chatId: 0, startedAt: 0 },
      "released after abort",
    );

    // Second inbound → a FRESH tracked message (8003) — the boot control
    // keyboard took 8001 and the first tracked took 8002, so the fresh one is
    // 8003; released state, no reuse.
    releaseSecondInbound = true;
    await waitFor(
      () => JSON.parse(readFileSync(liveStateFile, "utf8")).messageId === 8003,
      3000,
    );
    assert.equal(
      sent.length,
      3,
      "fresh tracked message pinned for the second task (control keyboard + 2× Working…)",
    );

    // Completed turn → still finishes exactly as today (✅ Done + summary).
    const doneEvent = {
      type: "turn_end",
      turnIndex: 2,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Second task done." }],
        stopReason: "stop",
      },
      toolResults: [],
    };
    for (const fn of pi.handlers.get("turn_end") ?? [])
      await fn(doneEvent, undefined);

    assert.equal(
      edited.length,
      2,
      "abort terminal-edit + completion done-edit",
    );
    assert.equal(edited[0].text, TRACKED_TERMINAL_TEXT);
    assert.equal(
      edited[1].text,
      TRACKED_DONE_TEXT,
      "completion finishes as today (§5b-2 (c))",
    );
    assert.equal(
      sent.length,
      4,
      "control keyboard + Working… + Working… + final summary",
    );
    assert.equal(sent[3].text, "Second task done.");
    assert.deepEqual(
      JSON.parse(readFileSync(liveStateFile, "utf8")),
      { messageId: 0, chatId: 0, startedAt: 0 },
      "state file cleared after the final completion too",
    );
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

// ── NEVER-freeze safety-net (owner report: "⚙️ Working…" froze) ─────────────
// The indicator is gated on an ACTIVE-WORK refcount and, when the run settles
// idle with the indicator still pinned (the agent ended its turn WITHOUT a
// clean completion mapping / finalize path), the agent_settled boundary force-
// resolves it to an honest terminal state. Prove the freeze: pre-fix, the
// agent_settled handler only flushes queued inbound — a pinned Working… after
// a toolUse turn-end is never completed.

test("factory: indicator NEVER freezes — inbound pinned, no completion event, agent_settled forces ✅ Done (owner report)", async () => {
  const pi = makeFakePi();
  const liveStateFile = tmpStateFile("live-settle");
  const updates = [makeUpdate(30, { text: "do the long thing" })];
  const updatesHandler = makeUpdatesServer(updates);
  const sent = [];
  const edited = [];
  const fetchFn = makeFakeFetch(async (url, init) => {
    if (url.includes("sendMessage")) {
      sent.push(JSON.parse(init.body));
      return jsonResponse(sendMessageResult(9002));
    }
    if (url.includes("editMessageText")) {
      const body = JSON.parse(init.body);
      edited.push(body);
      return jsonResponse({
        ok: true,
        result: { message_id: body.message_id },
      });
    }
    return updatesHandler(url);
  });
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_CHAT_ID: String(OWNER_CHAT_ID),
      TELEGRAM_CHAT_ID: undefined,
      BRAID_TG_ALLOWED_USERS: String(OWNER_ID),
      TELEGRAM_ALLOWED_USERS: undefined,
      BRAID_TG_POLL_ENABLED: "1",
      TELEGRAM_POLL_ENABLED: undefined,
      BRAID_TG_COALESCE_WINDOW_MS: "30",
      TELEGRAM_COALESCE_WINDOW_MS: undefined,
      BRAID_TG_POLL_DISABLED: undefined,
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("live-settle-offset"),
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_LIVE_UPDATE_ENABLED: "1",
      TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
      BRAID_TG_LIVE_UPDATE_STATE_FILE: liveStateFile,
      TELEGRAM_LIVE_UPDATE_STATE_FILE: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  try {
    // sent[0] = boot control keyboard (poller-start seam); sent[1] = tracked Working….
    await waitForPollerEffect(
      "the control message + tracked indicator never appeared",
      () => sent.length >= 2,
      3000,
    );
    assert.equal(
      sent.length,
      2,
      "boot control keyboard + tracked Working… pinned",
    );
    assert.ok(sent[0].reply_markup, "sent[0] is the control keyboard");
    assert.equal(sent[1].text, TRACKED_START_TEXT);

    // The agent's turn ends WITHOUT a clean completion mapping: a toolUse turn
    // (work would continue) is the last event, no completed-answer turn_end
    // ever fires. Pre-fix: the indicator is frozen at Working….
    const trailingEvent = {
      type: "turn_end",
      turnIndex: 1,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "toolCall", id: "t1", name: "grep", arguments: {} },
        ],
        stopReason: "toolUse",
      },
      toolResults: [],
    };
    for (const fn of pi.handlers.get("turn_end") ?? [])
      await fn(trailingEvent, undefined);
    assert.equal(
      edited.length,
      0,
      "pre-fix: toolUse alone never completes the indicator",
    );
    // start()'s write may still be in flight — poll for the pinned id.
    const pinnedState = await waitForJson(
      liveStateFile,
      (state) => state.messageId === 9002,
      3000,
    );
    assert.equal(
      pinnedState.messageId,
      9002,
      "pre-fix: pinned message still active (frozen at Working…)",
    );

    // The run settles idle (no queued inbound, no continuation) — the
    // safety-net must force the honest completion.
    for (const fn of pi.handlers.get("agent_settled") ?? []) fn();
    await waitFor(() => edited.length >= 1, 3000);

    assert.equal(
      edited.length,
      1,
      "settled boundary forced the done-edit — NEVER freezes",
    );
    assert.equal(edited[0].message_id, 9002);
    assert.equal(
      edited[0].text,
      TRACKED_DONE_TEXT,
      "forced to ✅ Done, not left at Working…",
    );
    // settle()'s forced resolve edits first, then clears the state file —
    // poll until the clear lands instead of reading between the two.
    const clearedState = await waitForJson(
      liveStateFile,
      (state) =>
        state.messageId === 0 && state.chatId === 0 && state.startedAt === 0,
      3000,
    );
    assert.deepEqual(
      clearedState,
      { messageId: 0, chatId: 0, startedAt: 0 },
      "state cleared after the forced resolve — no resurrectable Working…",
    );
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("factory: two inbound messages → ONE Working tracked message, resolved only after BOTH units complete (refcount)", async () => {
  const pi = makeFakePi();
  const liveStateFile = tmpStateFile("live-refcount");
  let releaseSecond = false;
  const sent = [];
  const edited = [];
  let seq = 6000;
  const firstMsg = makeUpdate(40, { text: "first task" });
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
    // getUpdates: message 40, then 41 once released (offset-aware).
    const batch = [firstMsg];
    if (releaseSecond) batch.push(makeUpdate(41, { text: "second task" }));
    const offset = Number(new URL(url).searchParams.get("offset") ?? 0);
    const available = batch
      .filter((u) => u.update_id >= offset)
      .sort((a, b) => a.update_id - b.update_id);
    return jsonResponse(getUpdatesResult(available));
  });
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_CHAT_ID: String(OWNER_CHAT_ID),
      TELEGRAM_CHAT_ID: undefined,
      BRAID_TG_ALLOWED_USERS: String(OWNER_ID),
      TELEGRAM_ALLOWED_USERS: undefined,
      BRAID_TG_POLL_ENABLED: "1",
      TELEGRAM_POLL_ENABLED: undefined,
      BRAID_TG_COALESCE_WINDOW_MS: "30",
      TELEGRAM_COALESCE_WINDOW_MS: undefined,
      BRAID_TG_POLL_DISABLED: undefined,
      TELEGRAM_POLL_DISABLED: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("live-refcount-offset"),
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_LIVE_UPDATE_ENABLED: "1",
      TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
      BRAID_TG_LIVE_UPDATE_STATE_FILE: liveStateFile,
      TELEGRAM_LIVE_UPDATE_STATE_FILE: undefined,
      BRAID_TG_POLL_INTERVAL_MS: "200",
      TELEGRAM_POLL_INTERVAL_MS: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  try {
    // sent[0] = boot control keyboard (poller-start seam); sent[1] = the single Working….
    await waitForPollerEffect(
      "the control message + tracked indicator never appeared",
      () => sent.length >= 2,
      3000,
    );
    assert.equal(
      sent.length,
      2,
      "boot control keyboard + ONE Working… pinned for the first inbound",
    );
    assert.ok(sent[0].reply_markup, "sent[0] is the control keyboard");
    assert.equal(sent[1].text, TRACKED_START_TEXT);
    // start() persists the tracked id asynchronously after the send lands.
    const persisted = await waitForJson(
      liveStateFile,
      (state) => state.messageId === 6002,
      3000,
    );
    assert.equal(persisted.messageId, 6002);

    // Second inbound arrives while the first is still active → it reuses the
    // SAME pinned message (no duplicate Working…); the refcount is now 2.
    releaseSecond = true;
    await waitForPollerEffect(
      "the second owner message was never delivered",
      () => pi.messages.length >= 2,
      3000,
    );
    await sleep(50); // let the reuse-path begin() settle through the poller

    // First unit completes → one of two down — the indicator MUST stay active.
    const doneEvent1 = {
      type: "turn_end",
      turnIndex: 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first done" }],
        stopReason: "stop",
      },
      toolResults: [],
    };
    for (const fn of pi.handlers.get("turn_end") ?? [])
      await fn(doneEvent1, undefined);
    assert.equal(
      edited.length,
      0,
      "one of two units still active → indicator stays Working…",
    );
    assert.equal(
      JSON.parse(readFileSync(liveStateFile, "utf8")).messageId,
      6002,
      "not resolved while a second unit is in flight",
    );

    // Second unit completes → last one → 1→0 resolves to ✅ Done + summary.
    const doneEvent2 = {
      type: "turn_end",
      turnIndex: 2,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "second done" }],
        stopReason: "stop",
      },
      toolResults: [],
    };
    for (const fn of pi.handlers.get("turn_end") ?? [])
      await fn(doneEvent2, undefined);

    assert.equal(edited.length, 1, "resolved only after BOTH units complete");
    assert.equal(edited[0].text, TRACKED_DONE_TEXT);
    assert.equal(
      sent.length,
      3,
      "control keyboard + Working… (1 send) + final summary — no duplicate Working…",
    );
    assert.equal(
      sent[2].text,
      "second done",
      "last completed unit's answer is the summary",
    );
    assert.deepEqual(
      JSON.parse(readFileSync(liveStateFile, "utf8")),
      { messageId: 0, chatId: 0, startedAt: 0 },
      "state cleared after the refcount reached 0",
    );
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

// ── Decision-button tap routing (callback_query through the real poller) ────
// A `dec:` tap is acknowledged and delivered to the agent through the SAME
// inbound path as a text message; control taps and unknown data keep the
// pause handler's path. These drive the real singleton poller (enabled via
// telegram_poller), so the routing seam in handleCallbackQuery is exercised
// end to end, not just unit-stubbed.

test("callback routing: a dec: tap is answered and delivered as a [decision] whisper message", async () => {
  const pi = makeFakePi();
  const answered = [];
  const decisionData = "dec:tok1:a";
  const replyMarkup = {
    inline_keyboard: [[{ text: "Option A", callback_data: decisionData }]],
  };
  const updates = makeUpdatesServer([
    makeCallbackUpdate(201, decisionData, { replyMarkup }),
  ]);
  const fetchFn = makeFakeFetch(async (url, init) => {
    if (url.includes("getUpdates")) return updates(url, init);
    if (url.includes("answerCallbackQuery")) {
      answered.push(JSON.parse(init.body));
      return jsonResponse({ ok: true, result: true });
    }
    return jsonResponse(sendMessageResult(700));
  });
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_ALLOWED_USERS: String(OWNER_ID),
      TELEGRAM_ALLOWED_USERS: undefined,
      BRAID_TG_CHAT_ID: undefined,
      TELEGRAM_CHAT_ID: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("dec-routing"),
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_POLL_INTERVAL_MS: undefined,
      BRAID_TG_COALESCE_WINDOW_MS: "0",
      TELEGRAM_COALESCE_WINDOW_MS: undefined,
      BRAID_TG_LIVE_UPDATE_ENABLED: "0",
      TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  try {
    const pollerTool = pi.tools.find((t) => t.name === "telegram_poller");
    const r = await pollerTool.execute(
      "id",
      { action: "enable" },
      undefined,
      undefined,
    );
    assert.equal(r.details.running, true, r.details.error ?? "poller state");

    await waitForPollerEffect(
      "the decision message was never delivered",
      () => pi.messages.length >= 1,
      4000,
    );
    const [content, options] = pi.messages[0];
    assert.equal(options?.deliverAs, "steer");
    assert.match(content, /^\[braid-whisper - telegram/);
    assert.ok(
      content.includes("[decision] tok1 → Option A (a)"),
      `decision body expected, got: ${content}`,
    );

    await waitForPollerEffect(
      "the tap was never answered",
      () => answered.length >= 1,
      2000,
    );
    assert.equal(answered[0].callback_query_id, "cq-201");
    assert.equal(answered[0].text, "✓ Option A");
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("callback routing: a pause tap still hits the pause handler (state persisted, no turn)", async () => {
  const pi = makeFakePi();
  const home = join(
    tmpdir(),
    `tg-pause-home-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const pauseStateFile = join(
    home,
    ".pi",
    "agent",
    "braid",
    "telegram",
    "pause-state.json",
  );
  const answered = [];
  const updates = makeUpdatesServer([makeCallbackUpdate(211, "pause")]);
  const fetchFn = makeFakeFetch(async (url, init) => {
    if (url.includes("getUpdates")) return updates(url, init);
    if (url.includes("answerCallbackQuery")) {
      answered.push(JSON.parse(init.body));
      return jsonResponse({ ok: true, result: true });
    }
    return jsonResponse(sendMessageResult(701));
  });
  await withEnv(
    {
      HOME: home,
      BRAID_HOME: undefined,
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_ALLOWED_USERS: String(OWNER_ID),
      TELEGRAM_ALLOWED_USERS: undefined,
      BRAID_TG_CHAT_ID: undefined,
      TELEGRAM_CHAT_ID: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("pause-tap"),
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_POLL_INTERVAL_MS: undefined,
      BRAID_TG_COALESCE_WINDOW_MS: "0",
      TELEGRAM_COALESCE_WINDOW_MS: undefined,
      BRAID_TG_LIVE_UPDATE_ENABLED: "0",
      TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  try {
    const pollerTool = pi.tools.find((t) => t.name === "telegram_poller");
    const r = await pollerTool.execute(
      "id",
      { action: "enable" },
      undefined,
      undefined,
    );
    assert.equal(r.details.running, true, r.details.error ?? "poller state");

    // The pause handler persists the flag under the braid root (BRAID_HOME
    // unset → the HOME-scoped braid home) and answers the tap; a control tap
    // never becomes a user message.
    const state = await waitForJson(
      pauseStateFile,
      (parsed) => parsed.paused === true,
      4000,
    );
    assert.equal(state.paused, true);
    await waitForPollerEffect(
      "the tap was never answered",
      () => answered.length >= 1,
      2000,
    );
    assert.match(answered[0].text, /paused/i);
    assert.equal(pi.messages.length, 0, "a control tap must not start a turn");
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});

test("callback routing: unknown callback data is answered by the control handler and does not crash", async () => {
  const pi = makeFakePi();
  const answered = [];
  const updates = makeUpdatesServer([makeCallbackUpdate(221, "nonsense")]);
  const fetchFn = makeFakeFetch(async (url, init) => {
    if (url.includes("getUpdates")) return updates(url, init);
    if (url.includes("answerCallbackQuery")) {
      answered.push(JSON.parse(init.body));
      return jsonResponse({ ok: true, result: true });
    }
    return jsonResponse(sendMessageResult(702));
  });
  await withEnv(
    {
      BRAID_TG_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: undefined,
      BRAID_TG_ALLOWED_USERS: String(OWNER_ID),
      TELEGRAM_ALLOWED_USERS: undefined,
      BRAID_TG_CHAT_ID: undefined,
      TELEGRAM_CHAT_ID: undefined,
      BRAID_TG_STATE_FILE: tmpStateFile("unknown-tap"),
      TELEGRAM_STATE_FILE: undefined,
      BRAID_TG_POLL_INTERVAL_MS: undefined,
      BRAID_TG_COALESCE_WINDOW_MS: "0",
      TELEGRAM_COALESCE_WINDOW_MS: undefined,
      BRAID_TG_LIVE_UPDATE_ENABLED: "0",
      TELEGRAM_LIVE_UPDATE_ENABLED: undefined,
    },
    async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    },
  );

  try {
    const pollerTool = pi.tools.find((t) => t.name === "telegram_poller");
    const r = await pollerTool.execute(
      "id",
      { action: "enable" },
      undefined,
      undefined,
    );
    assert.equal(r.details.running, true, r.details.error ?? "poller state");

    await waitForPollerEffect(
      "the tap was never answered",
      () => answered.length >= 1,
      4000,
    );
    assert.match(answered[0].text, /Unknown action: nonsense/);
    assert.equal(
      pi.messages.length,
      0,
      "an unknown tap must not become a user message",
    );
  } finally {
    pi.emit("session_shutdown");
    await sleep(50);
  }
});
