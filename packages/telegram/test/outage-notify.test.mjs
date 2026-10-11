/**
 * outage-notify.test.mjs — the provider-outage notify seam.
 *
 * The providers outage watchdog holds no telegram import; it reads a
 * process-global sender slot at transition time (same seam pattern as the
 * watchdog tg-signal). These tests drive the real factory with a fake pi and
 * a recorded fetch and assert: the slot is published only when the channel
 * has a token, the sender resolves the configured chat, the line goes out
 * verbatim through the same client path every telegram tool uses, a send
 * failure reports false (the watcher releases its dedupe claim), and an
 * unknown chat reports false instead of sending to chat id 0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import telegramExtension, {
  PROVIDER_OUTAGE_NOTIFY_KEY,
  ENV_TOKEN,
  ENV_CHAT_ID,
  ENV_POLL_DISABLED,
} from "../dist/index.js";
import {
  BOT_TOKEN,
  OWNER_CHAT_ID,
  jsonResponse,
  makeFakeFetch,
  sendMessageResult,
} from "./fixtures.mjs";

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
  try {
    const out = fn();
    if (out instanceof Promise) return out.finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

/** Minimal pi-like surface the factory touches. */
function makeFakePi() {
  const handlers = new Map();
  return {
    handlers,
    tools: [],
    commands: [],
    registerTool: (_tool) => undefined,
    registerCommand: () => undefined,
    sendUserMessage: () => undefined,
    on: (event, fn) =>
      handlers.set(event, [...(handlers.get(event) ?? []), fn]),
  };
}

function baseEnv(extra = {}) {
  return {
    [ENV_TOKEN]: BOT_TOKEN,
    TELEGRAM_BOT_TOKEN: undefined,
    [ENV_CHAT_ID]: String(OWNER_CHAT_ID),
    TELEGRAM_CHAT_ID: undefined,
    [ENV_POLL_DISABLED]: "1",
    TELEGRAM_POLL_DISABLED: undefined,
    ...extra,
  };
}

test("factory publishes the outage sender; it sends through the configured chat", async () => {
  delete globalThis[PROVIDER_OUTAGE_NOTIFY_KEY];
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse(sendMessageResult(42)),
  );
  await withEnv(baseEnv(), async () => {
    await telegramExtension(makeFakePi(), { fetch: fetchFn });
    const sender = globalThis[PROVIDER_OUTAGE_NOTIFY_KEY];
    assert.equal(typeof sender, "function", "slot must carry a sender");
    const ok = await sender(
      '[braid] Provider route "agent-zero" DOWN since 15:40:12',
    );
    assert.equal(ok, true);
    const sendCall = fetchFn.calls.find((c) => c.url.includes("/sendMessage"));
    assert.ok(sendCall, "a /sendMessage request must have been made");
    const body = JSON.parse(sendCall.body);
    assert.equal(body.chat_id, String(OWNER_CHAT_ID));
    assert.equal(
      body.text,
      '[braid] Provider route "agent-zero" DOWN since 15:40:12',
    );
  });
  delete globalThis[PROVIDER_OUTAGE_NOTIFY_KEY];
});

test("a failed send reports false so the watcher releases its claim", async () => {
  delete globalThis[PROVIDER_OUTAGE_NOTIFY_KEY];
  const fetchFn = makeFakeFetch(async () => jsonResponse({ ok: false }, 500));
  await withEnv(baseEnv(), async () => {
    await telegramExtension(makeFakePi(), { fetch: fetchFn });
    const sender = globalThis[PROVIDER_OUTAGE_NOTIFY_KEY];
    assert.equal(typeof sender, "function");
    const ok = await sender("[braid] line");
    assert.equal(ok, false);
  });
  delete globalThis[PROVIDER_OUTAGE_NOTIFY_KEY];
});

test("no token: the slot is never published", async () => {
  delete globalThis[PROVIDER_OUTAGE_NOTIFY_KEY];
  await withEnv(
    baseEnv({ [ENV_TOKEN]: undefined, TELEGRAM_BOT_TOKEN: undefined }),
    async () => {
      await telegramExtension(makeFakePi(), {
        fetch: makeFakeFetch(async () => jsonResponse(sendMessageResult(1))),
      });
      assert.equal(globalThis[PROVIDER_OUTAGE_NOTIFY_KEY], undefined);
    },
  );
});

test("unknown chat: the sender refuses instead of sending to chat 0", async () => {
  delete globalThis[PROVIDER_OUTAGE_NOTIFY_KEY];
  const fetchFn = makeFakeFetch(async () => jsonResponse(sendMessageResult(1)));
  await withEnv(
    baseEnv({
      [ENV_CHAT_ID]: undefined,
      TELEGRAM_CHAT_ID: undefined,
      BRAID_TG_ALLOWED_USERS: undefined,
      TELEGRAM_ALLOWED_USERS: undefined,
    }),
    async () => {
      await telegramExtension(makeFakePi(), { fetch: fetchFn });
      const sender = globalThis[PROVIDER_OUTAGE_NOTIFY_KEY];
      assert.equal(typeof sender, "function");
      const ok = await sender("[braid] line");
      assert.equal(ok, false);
      assert.equal(
        fetchFn.calls.filter((c) => c.url.includes("/sendMessage")).length,
        0,
      );
    },
  );
  delete globalThis[PROVIDER_OUTAGE_NOTIFY_KEY];
});
