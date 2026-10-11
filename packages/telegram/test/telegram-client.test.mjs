/**
 * telegram-client.test.mjs — low-level client extracted against recorded
 * Telegram Bot API fixtures through an injectable fake fetch. NO network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sendMessage,
  editMessageText,
  editMessageReplyMarkup,
  answerCallbackQuery,
  sendChatAction,
  sendVoiceNote,
  getUpdates,
  getFile,
  downloadFile,
  getMe,
  testToken,
  createTelegramClient,
} from "../dist/lib/telegram-client.js";

import {
  BOT_TOKEN,
  OWNER_CHAT_ID,
  jsonResponse,
  makeFakeFetch,
  parseQuery,
  sendMessageResult,
  getUpdatesResult,
  getMeResult,
} from "./fixtures.mjs";

const SUPER = "https://api.telegram.org";

test("sendMessage: posts to /bot<token>/sendMessage with JSON body and extracts message_id", async () => {
  const fetchFn = makeFakeFetch(async (_url) =>
    jsonResponse(sendMessageResult(42)),
  );
  const res = await sendMessage(BOT_TOKEN, OWNER_CHAT_ID, "hello", {
    fetch: fetchFn,
  });

  assert.equal(fetchFn.calls.length, 1);
  assert.equal(fetchFn.calls[0].url, `${SUPER}/bot${BOT_TOKEN}/sendMessage`);
  assert.equal(fetchFn.calls[0].method, "POST");
  assert.equal(fetchFn.calls[0].headers["Content-Type"], "application/json");
  const body = JSON.parse(fetchFn.calls[0].body);
  assert.deepEqual(body, { chat_id: OWNER_CHAT_ID, text: "hello" });

  assert.equal(res.ok, true);
  assert.equal(res.messageId, 42);
});

test("sendMessage: returns { ok:false, error } on Telegram API error", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse(
      { ok: false, description: "Unauthorized: bot token invalid" },
      401,
    ),
  );
  const res = await sendMessage(BOT_TOKEN, OWNER_CHAT_ID, "hi", {
    fetch: fetchFn,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /bot token invalid/i);
});

test("sendMessage: returns error on network failure (no throw)", async () => {
  const fetchFn = makeFakeFetch(async () => {
    throw new Error("ECONNREFUSED");
  });
  const res = await sendMessage(BOT_TOKEN, OWNER_CHAT_ID, "hi", {
    fetch: fetchFn,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /ECONNREFUSED/);
});

// ── item 31: parse_mode, editMessageText, sendChatAction ───────────────────

test("sendMessage: honors parse_mode HTML|Markdown in the JSON body (rich, item 31)", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse(sendMessageResult(43)),
  );
  const res = await sendMessage(BOT_TOKEN, OWNER_CHAT_ID, "<b>hi</b>", {
    fetch: fetchFn,
    parseMode: "HTML",
  });
  assert.equal(res.ok, true);
  const body = JSON.parse(fetchFn.calls[0].body);
  assert.deepEqual(body, {
    chat_id: OWNER_CHAT_ID,
    text: "<b>hi</b>",
    parse_mode: "HTML",
  });

  const fetchFn2 = makeFakeFetch(async () =>
    jsonResponse(sendMessageResult(44)),
  );
  await sendMessage(BOT_TOKEN, OWNER_CHAT_ID, "**bold**", {
    fetch: fetchFn2,
    parseMode: "Markdown",
  });
  assert.equal(JSON.parse(fetchFn2.calls[0].body).parse_mode, "Markdown");
});

test("sendMessage: no parse_mode key in the body when unset (backward compatible)", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse(sendMessageResult(44)),
  );
  await sendMessage(BOT_TOKEN, OWNER_CHAT_ID, "plain", { fetch: fetchFn });
  const body = JSON.parse(fetchFn.calls[0].body);
  assert.deepEqual(body, { chat_id: OWNER_CHAT_ID, text: "plain" });
  assert.equal(body.parse_mode, undefined);
});

test("editMessageText: posts chat_id+message_id+text and extracts message_id (item 31)", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse(sendMessageResult(42)),
  );
  const res = await editMessageText(BOT_TOKEN, OWNER_CHAT_ID, 42, "edited", {
    fetch: fetchFn,
  });

  assert.equal(fetchFn.calls.length, 1);
  assert.equal(
    fetchFn.calls[0].url,
    `${SUPER}/bot${BOT_TOKEN}/editMessageText`,
  );
  assert.equal(fetchFn.calls[0].method, "POST");
  assert.equal(fetchFn.calls[0].headers["Content-Type"], "application/json");
  const body = JSON.parse(fetchFn.calls[0].body);
  assert.deepEqual(body, {
    chat_id: OWNER_CHAT_ID,
    message_id: 42,
    text: "edited",
  });

  assert.equal(res.ok, true);
  assert.equal(res.messageId, 42);
});

test("editMessageText: accepts result `true` (unchanged body) as ok without a message_id", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse({ ok: true, result: true }),
  );
  const res = await editMessageText(BOT_TOKEN, OWNER_CHAT_ID, 42, "same text", {
    fetch: fetchFn,
  });
  assert.equal(res.ok, true);
  assert.equal(res.messageId, undefined);
});

test("editMessageText: passes parse_mode through and returns error on API failure", async () => {
  const okFetch = makeFakeFetch(async () => jsonResponse(sendMessageResult(9)));
  await editMessageText(BOT_TOKEN, OWNER_CHAT_ID, 9, "**done**", {
    fetch: okFetch,
    parseMode: "Markdown",
  });
  assert.equal(JSON.parse(okFetch.calls[0].body).parse_mode, "Markdown");

  const badFetch = makeFakeFetch(async () =>
    jsonResponse({ ok: false, description: "message to edit not found" }, 400),
  );
  const res = await editMessageText(BOT_TOKEN, OWNER_CHAT_ID, 42, "x", {
    fetch: badFetch,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /message to edit not found/);
});

test("editMessageReplyMarkup: posts chat_id+message_id+reply_markup and extracts message_id", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse(sendMessageResult(42)),
  );
  const res = await editMessageReplyMarkup(BOT_TOKEN, OWNER_CHAT_ID, 42, {
    fetch: fetchFn,
    replyMarkup: { inline_keyboard: [] },
  });

  assert.equal(fetchFn.calls.length, 1);
  assert.equal(
    fetchFn.calls[0].url,
    `${SUPER}/bot${BOT_TOKEN}/editMessageReplyMarkup`,
  );
  assert.equal(fetchFn.calls[0].method, "POST");
  assert.equal(fetchFn.calls[0].headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(fetchFn.calls[0].body), {
    chat_id: OWNER_CHAT_ID,
    message_id: 42,
    reply_markup: { inline_keyboard: [] },
  });
  assert.equal(res.ok, true);
  assert.equal(res.messageId, 42);
});

test("editMessageReplyMarkup: result `true` and 'message is not modified' are both ok no-ops", async () => {
  const trueFetch = makeFakeFetch(async () =>
    jsonResponse({ ok: true, result: true }),
  );
  const trueRes = await editMessageReplyMarkup(BOT_TOKEN, OWNER_CHAT_ID, 42, {
    fetch: trueFetch,
    replyMarkup: { inline_keyboard: [] },
  });
  assert.equal(trueRes.ok, true);
  assert.equal(trueRes.messageId, undefined);

  const noopFetch = makeFakeFetch(async () =>
    jsonResponse(
      { ok: false, description: "Bad Request: message is not modified" },
      400,
    ),
  );
  const noopRes = await editMessageReplyMarkup(BOT_TOKEN, OWNER_CHAT_ID, 42, {
    fetch: noopFetch,
    replyMarkup: { inline_keyboard: [] },
  });
  assert.equal(noopRes.ok, true);
  assert.equal(noopRes.raw, undefined);
});

test("sendChatAction: posts chat_id + action (default typing) and returns ok", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse({ ok: true, result: true }),
  );
  const res = await sendChatAction(BOT_TOKEN, OWNER_CHAT_ID, undefined, {
    fetch: fetchFn,
  });
  assert.equal(fetchFn.calls[0].url, `${SUPER}/bot${BOT_TOKEN}/sendChatAction`);
  assert.equal(fetchFn.calls[0].method, "POST");
  assert.deepEqual(JSON.parse(fetchFn.calls[0].body), {
    chat_id: OWNER_CHAT_ID,
    action: "typing",
  });
  assert.equal(res.ok, true);
});

test("sendChatAction: honors a custom action and returns error on failure (no throw)", async () => {
  const okFetch = makeFakeFetch(async () =>
    jsonResponse({ ok: true, result: true }),
  );
  await sendChatAction(BOT_TOKEN, OWNER_CHAT_ID, "upload_document", {
    fetch: okFetch,
  });
  assert.equal(JSON.parse(okFetch.calls[0].body).action, "upload_document");

  const badFetch = makeFakeFetch(async () =>
    jsonResponse({ ok: false, description: "chat not found" }, 400),
  );
  const res = await sendChatAction(BOT_TOKEN, OWNER_CHAT_ID, "typing", {
    fetch: badFetch,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /chat not found/);
});

test("createTelegramClient: factory binds editMessageText/sendChatAction to the injectable fetch", async () => {
  const fetchFn = makeFakeFetch(async (url) => {
    if (url.includes("editMessageText"))
      return jsonResponse({ ok: true, result: { message_id: 7 } });
    if (url.includes("sendChatAction"))
      return jsonResponse({ ok: true, result: true });
    return jsonResponse(sendMessageResult(9));
  });
  const client = createTelegramClient({ fetch: fetchFn });
  const edited = await client.editMessageText(
    BOT_TOKEN,
    OWNER_CHAT_ID,
    7,
    "new",
  );
  const action = await client.sendChatAction(BOT_TOKEN, OWNER_CHAT_ID);
  assert.equal(edited.ok, true);
  assert.equal(edited.messageId, 7);
  assert.equal(action.ok, true);
  assert.equal(
    fetchFn.calls.filter((c) => c.url.includes("editMessageText")).length,
    1,
  );
  assert.equal(
    fetchFn.calls.filter((c) => c.url.includes("sendChatAction")).length,
    1,
  );
});

test("getUpdates: sends offset+timeout+limit query and returns parsed updates", async () => {
  const updates = [
    {
      update_id: 5,
      message: { message_id: 1, chat: { id: 1, type: "private" } },
    },
    {
      update_id: 6,
      message: { message_id: 2, chat: { id: 1, type: "private" } },
    },
  ];
  const fetchFn = makeFakeFetch(async (_url) =>
    jsonResponse(getUpdatesResult(updates)),
  );
  const res = await getUpdates(BOT_TOKEN, 3, 30, { fetch: fetchFn });

  assert.equal(fetchFn.calls[0].method, "GET");
  const q = parseQuery(fetchFn.calls[0].url);
  assert.equal(q.offset, "3");
  assert.equal(q.timeout, "30");
  assert.equal(q.limit, "100");
  assert.equal(
    fetchFn.calls[0].url,
    `${SUPER}/bot${BOT_TOKEN}/getUpdates?offset=3&timeout=30&limit=100`,
  );

  assert.equal(res.ok, true);
  assert.equal(res.updates.length, 2);
  assert.equal(res.updates[0].update_id, 5);
});

test("getUpdates: long-poll timeout yields empty result, not an error", async () => {
  const fetchFn = makeFakeFetch(async () => jsonResponse(getUpdatesResult([])));
  const res = await getUpdates(BOT_TOKEN, 12, 30, { fetch: fetchFn });
  assert.equal(res.ok, true);
  assert.deepEqual(res.updates, []);
});

test("getUpdates: api error is returned as { ok:false, error }", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse(
      {
        ok: false,
        description: "Conflict: terminated by other getUpdates request",
      },
      409,
    ),
  );
  const res = await getUpdates(BOT_TOKEN, 1, 0, { fetch: fetchFn });
  assert.equal(res.ok, false);
  assert.match(res.error, /terminated by other getUpdates/i);
});

test("getMe: validates token and returns bot identity", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse({
      ok: true,
      result: { id: 555555, is_bot: true, username: "braid_test_bot" },
    }),
  );
  const res = await getMe(BOT_TOKEN, { fetch: fetchFn });
  assert.equal(res.ok, true);
  assert.equal(res.bot.id, 555555);
  assert.equal(res.bot.username, "braid_test_bot");
});

test("testToken: returns { ok:true } for a valid token (mirrors agent-zero api/test_connection)", async () => {
  const fetchFn = makeFakeFetch(async () => jsonResponse(getMeResult()));
  const res = await testToken(BOT_TOKEN, { fetch: fetchFn });
  assert.equal(res.ok, true);
  assert.equal(res.httpStatus, 200);
  assert.equal(res.bot.username, "braid_test_bot");
});

test("testToken: returns { ok:false, error, httpStatus } for invalid token, never throws", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse({ ok: false, description: "Not Found: 404" }, 404),
  );
  const res = await testToken(BOT_TOKEN, { fetch: fetchFn });
  assert.equal(res.ok, false);
  assert.equal(res.httpStatus, 404);
  assert.ok(res.error);
});

test("sendVoiceNote: multipart form with chat_id/caption/voice.ogg, returns message_id", async () => {
  const ogg = Buffer.from([0x4f, 0x67, 0x67, 0x53]); // OggS magic
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse(sendMessageResult(77, { voice: {} })),
  );

  const res = await sendVoiceNote(
    BOT_TOKEN,
    OWNER_CHAT_ID,
    ogg,
    "brief caption",
    { fetch: fetchFn },
  );

  assert.equal(fetchFn.calls[0].url, `${SUPER}/bot${BOT_TOKEN}/sendVoice`);
  assert.equal(fetchFn.calls[0].method, "POST");
  const form = fetchFn.calls[0].body;
  assert.ok(
    form instanceof FormData,
    "body should be a FormData multipart upload",
  );
  assert.equal(form.get("chat_id"), String(OWNER_CHAT_ID));
  assert.equal(form.get("caption"), "brief caption");
  const voice = form.get("voice");
  assert.ok(voice, "voice field present");
  assert.equal(voice.name ?? voice, "voice.ogg");

  assert.equal(res.ok, true);
  assert.equal(res.messageId, 77);
});

test("sendVoiceNote: uploads from a file path (OGG/Opus on disk)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-test-"));
  const oggPath = join(dir, "note.ogg");
  writeFileSync(oggPath, Buffer.from([0x4f, 0x67, 0x67, 0x53]));
  try {
    const fetchFn = makeFakeFetch(async () =>
      jsonResponse(sendMessageResult(88)),
    );
    const res = await sendVoiceNote(
      BOT_TOKEN,
      OWNER_CHAT_ID,
      oggPath,
      undefined,
      { fetch: fetchFn },
    );
    assert.equal(res.ok, true);
    assert.equal(res.messageId, 88);
    const form = fetchFn.calls[0].body;
    assert.ok(form instanceof FormData);
    const voice = form.get("voice");
    assert.equal(voice.name ?? voice, "voice.ogg");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getFile: resolves file_id to file_path via /bot<token>/getFile (photo inbound)", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse({
      ok: true,
      result: {
        file_id: "abc",
        file_unique_id: "u",
        file_size: 10,
        file_path: "photos/f.jpg",
      },
    }),
  );
  const res = await getFile(BOT_TOKEN, "abc", { fetch: fetchFn });

  assert.equal(
    fetchFn.calls[0].url,
    `${SUPER}/bot${BOT_TOKEN}/getFile?file_id=abc`,
  );
  assert.equal(fetchFn.calls[0].method, "GET");
  assert.equal(res.ok, true);
  assert.equal(res.file.file_path, "photos/f.jpg");
});

test("getFile: api error returns { ok:false, error } (never throws)", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse(
      { ok: false, description: "Bad Request: file is too big" },
      400,
    ),
  );
  const res = await getFile(BOT_TOKEN, "abc", { fetch: fetchFn });
  assert.equal(res.ok, false);
  assert.match(res.error, /file is too big/i);
});

test("downloadFile: fetches bytes from /file/bot<token>/<file_path>", async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const fetchFn = makeFakeFetch(
    async () => new Response(bytes, { status: 200 }),
  );
  const res = await downloadFile(BOT_TOKEN, "photos/f.jpg", { fetch: fetchFn });

  assert.equal(
    fetchFn.calls[0].url,
    `${SUPER}/file/bot${BOT_TOKEN}/photos/f.jpg`,
  );
  assert.equal(fetchFn.calls[0].method, "GET");
  assert.equal(res.ok, true);
  assert.deepEqual(res.bytes, bytes);
});

test("downloadFile: non-ok status returns { ok:false, error } (never throws)", async () => {
  const fetchFn = makeFakeFetch(
    async () => new Response("nope", { status: 404 }),
  );
  const res = await downloadFile(BOT_TOKEN, "photos/f.jpg", { fetch: fetchFn });
  assert.equal(res.ok, false);
  assert.match(res.error, /404/);
});

test("createTelegramClient: factory binds one injectable fetch to every method", async () => {
  const fetchFn = makeFakeFetch(async (url) => {
    if (url.includes("getMe")) return jsonResponse(getMeResult());
    if (url.includes("getUpdates")) return jsonResponse(getUpdatesResult([]));
    return jsonResponse(sendMessageResult(9));
  });
  const client = createTelegramClient({ fetch: fetchFn });

  const me = await client.getMe(BOT_TOKEN);
  const sent = await client.sendMessage(
    BOT_TOKEN,
    OWNER_CHAT_ID,
    "via factory",
  );
  const up = await client.getUpdates(BOT_TOKEN);

  assert.equal(me.ok, true);
  assert.equal(sent.messageId, 9);
  assert.equal(up.ok, true);
  assert.equal(fetchFn.calls.filter((c) => c.url.includes("getMe")).length, 1);
  assert.equal(
    fetchFn.calls.filter((c) => c.url.includes("sendMessage")).length,
    1,
  );
});

// ── reply_markup + answerCallbackQuery ─────────────────────────────────────

test("sendMessage: attaches reply_markup inline_keyboard when replyMarkup is set", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse(sendMessageResult(45)),
  );
  const markup = {
    inline_keyboard: [
      [
        { text: "⏸ Pause", callback_data: "pause" },
        { text: "📊 Status", callback_data: "status" },
      ],
    ],
  };
  const res = await sendMessage(BOT_TOKEN, OWNER_CHAT_ID, "control", {
    fetch: fetchFn,
    replyMarkup: markup,
  });
  assert.equal(res.ok, true);
  const body = JSON.parse(fetchFn.calls[0].body);
  assert.deepEqual(body.reply_markup, markup);
  assert.equal(
    body.parse_mode,
    undefined,
    "no parse_mode added for a plain send with markup",
  );
});

test("editMessageText: passes reply_markup through to refresh the keyboard", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse(sendMessageResult(42)),
  );
  const markup = {
    inline_keyboard: [[{ text: "▶ Resume", callback_data: "resume" }]],
  };
  const res = await editMessageText(BOT_TOKEN, OWNER_CHAT_ID, 42, "⏸ paused", {
    fetch: fetchFn,
    replyMarkup: markup,
  });
  assert.equal(res.ok, true);
  const body = JSON.parse(fetchFn.calls[0].body);
  assert.deepEqual(body.reply_markup, markup);
});

test("answerCallbackQuery: posts callback_query_id + optional text/show_alert", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse({ ok: true, result: true }),
  );
  const res = await answerCallbackQuery(BOT_TOKEN, "cq-123", {
    text: "⏸ Agent paused",
    fetch: fetchFn,
  });

  assert.equal(
    fetchFn.calls[0].url,
    `${SUPER}/bot${BOT_TOKEN}/answerCallbackQuery`,
  );
  assert.equal(fetchFn.calls[0].method, "POST");
  const body = JSON.parse(fetchFn.calls[0].body);
  assert.deepEqual(body, {
    callback_query_id: "cq-123",
    text: "⏸ Agent paused",
  });
  assert.equal(res.ok, true);
});

test("answerCallbackQuery: show_alert is sent only when explicitly set; failures return ok:false", async () => {
  const alertFetch = makeFakeFetch(async () =>
    jsonResponse({ ok: true, result: true }),
  );
  await answerCallbackQuery(BOT_TOKEN, "cq-1", {
    text: "boom",
    showAlert: true,
    fetch: alertFetch,
  });
  assert.deepEqual(JSON.parse(alertFetch.calls[0].body), {
    callback_query_id: "cq-1",
    text: "boom",
    show_alert: true,
  });

  const badFetch = makeFakeFetch(async () =>
    jsonResponse({ ok: false, description: "query is too old" }, 400),
  );
  const res = await answerCallbackQuery(BOT_TOKEN, "cq-2", {
    text: "x",
    fetch: badFetch,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /query is too old/);
});

test("createTelegramClient: factory merges per-call replyMarkup with bound options", async () => {
  const fetchFn = makeFakeFetch(async (url) => {
    if (url.includes("editMessageText"))
      return jsonResponse({ ok: true, result: { message_id: 7 } });
    if (url.includes("answerCallbackQuery"))
      return jsonResponse({ ok: true, result: true });
    return jsonResponse(sendMessageResult(9));
  });
  const client = createTelegramClient({ fetch: fetchFn });
  const markup = {
    inline_keyboard: [[{ text: "▶ Resume", callback_data: "resume" }]],
  };
  const edited = await client.editMessageText(
    BOT_TOKEN,
    OWNER_CHAT_ID,
    7,
    "new",
    { replyMarkup: markup },
  );
  const answered = await client.answerCallbackQuery(BOT_TOKEN, "cq-9", {
    text: "ok",
  });
  assert.equal(edited.ok, true);
  const editBody = JSON.parse(
    fetchFn.calls.find((c) => c.url.includes("editMessageText")).body,
  );
  assert.deepEqual(editBody.reply_markup, markup);
  assert.ok(answered.ok);
});

test("editMessageText: 'message is not modified' 400 is treated as idempotent success", async () => {
  const fetchFn = makeFakeFetch(async () =>
    jsonResponse(
      {
        ok: false,
        error_code: 400,
        description:
          "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      },
      400,
    ),
  );
  const res = await editMessageText(BOT_TOKEN, OWNER_CHAT_ID, 7, "same", {
    fetch: fetchFn,
  });
  assert.equal(res.ok, true);
  assert.equal(res.messageId, undefined);
});
