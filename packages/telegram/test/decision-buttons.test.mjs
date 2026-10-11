/**
 * decision-buttons.test.mjs — the `dec:<token>:<value>` protocol and its two
 * halves: the send-side build (prepareDecisionOptions -> inline_keyboard,
 * 64-byte callback_data cap, token rules), the receive-side parse/label/format,
 * the tap handler against a stubbed client (single-use taps: the first tap of
 * a token delivers and strips the keyboard, every later tap is acknowledged
 * only), and the telegram_send `options` wiring (markup on the wire, token
 * echoed in the outcome, malformed rows refusing the send). NO network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_CALLBACK_DATA_BYTES,
  decisionCallbackData,
  prepareDecisionOptions,
  parseDecisionCallbackData,
  findDecisionOptionLabel,
  formatDecisionAnswerText,
  handleDecisionCallbackQuery,
} from "../dist/lib/decision-buttons.js";
import { runTelegramSend } from "../dist/lib/tool-logic.js";

import { BOT_TOKEN, OWNER_CHAT_ID, OWNER_ID } from "./fixtures.mjs";

/**
 * Stub client recording answerCallbackQuery + editMessageReplyMarkup +
 * sendMessage calls and their order. `editRejects` makes the keyboard edit
 * reject (a thrown failure, not an ok:false) so the handler's tolerance of
 * both failure shapes is pinned.
 */
function fakeClient({
  answerOk = true,
  editOk = true,
  editRejects = false,
} = {}) {
  const calls = {
    answerCallbackQuery: [],
    editMessageReplyMarkup: [],
    sendMessage: [],
    order: [],
  };
  const client = {
    answerCallbackQuery: async (token, id, options) => {
      calls.order.push("answer");
      calls.answerCallbackQuery.push({ token, id, options });
      return answerOk ? { ok: true } : { ok: false, error: "injected" };
    },
    editMessageReplyMarkup: async (token, chatId, messageId, options) => {
      calls.order.push("edit");
      calls.editMessageReplyMarkup.push({ token, chatId, messageId, options });
      if (editRejects) throw new Error("injected rejection");
      return editOk ? { ok: true } : { ok: false, error: "injected" };
    },
    sendMessage: async (token, chatId, text, options) => {
      calls.sendMessage.push({ token, chatId, text, options });
      return { ok: true, messageId: 42 };
    },
    sendVoiceNote: async () => ({ ok: true, messageId: 77 }),
  };
  return { client, calls };
}

/** Build a callback_query update, optionally carrying the tapped message + markup. */
function callbackUpdate({
  data,
  id = "cq-1",
  updateId = 7,
  withMessage = true,
  replyMarkup,
} = {}) {
  return {
    update_id: updateId,
    callback_query: {
      id,
      from: { id: OWNER_ID, username: "owner", first_name: "Owner" },
      message: withMessage
        ? {
            message_id: 5001,
            chat: { id: OWNER_CHAT_ID, type: "private" },
            date: 1700000000,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          }
        : undefined,
      data,
    },
  };
}

// ── send half: prepareDecisionOptions ───────────────────────────────────────

test("prepareDecisionOptions: rows become inline_keyboard with dec:<token>:<value> callback_data", () => {
  const prepared = prepareDecisionOptions(
    [
      [
        { label: "Option A", value: "a" },
        { label: "Option B", value: "b" },
      ],
      [{ label: "Other", value: "other" }],
    ],
    "tok1",
  );
  assert.equal(prepared.ok, true);
  assert.equal(prepared.token, "tok1");
  assert.deepEqual(prepared.keyboard, {
    inline_keyboard: [
      [
        { text: "Option A", callback_data: "dec:tok1:a" },
        { text: "Option B", callback_data: "dec:tok1:b" },
      ],
      [{ text: "Other", callback_data: "dec:tok1:other" }],
    ],
  });
});

test("prepareDecisionOptions: labels/values are trimmed before building", () => {
  const prepared = prepareDecisionOptions(
    [[{ label: "  Yes  ", value: "  y " }]],
    "t",
  );
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.keyboard.inline_keyboard[0][0], {
    text: "Yes",
    callback_data: "dec:t:y",
  });
});

test("prepareDecisionOptions: a token is generated when none is passed and used on every button", () => {
  const one = prepareDecisionOptions([[{ label: "A", value: "a" }]]);
  assert.equal(one.ok, true);
  assert.match(one.token, /^[a-z0-9]{1,16}$/);
  assert.equal(
    one.keyboard.inline_keyboard[0][0].callback_data,
    `dec:${one.token}:a`,
  );
  // Two independent calls must not collide in practice (generator smoke).
  const two = prepareDecisionOptions([[{ label: "A", value: "a" }]]);
  assert.equal(two.ok, true);
  assert.match(two.token, /^[a-z0-9]{1,16}$/);
});

test("prepareDecisionOptions: malformed rows are refused (nothing is sent)", () => {
  const bad = [
    undefined,
    [],
    [[], []],
    [
      [{ label: "a", value: "a" }],
      [{ label: "b", value: "b" }],
      [{ label: "c", value: "c" }],
    ],
    [
      [
        { label: "a", value: "a" },
        { label: "b", value: "b" },
        { label: "c", value: "c" },
        { label: "d", value: "d" },
        { label: "e", value: "e" },
      ],
    ],
    [{ label: "", value: "a" }],
    [{ label: "  ", value: "a" }],
    [{ label: "a", value: "" }],
    [{ label: "a" }],
    [{ label: 1, value: "a" }],
    [{ label: "a", value: 2 }],
    ["not-a-button"],
  ];
  for (const options of bad) {
    const prepared = prepareDecisionOptions(options, "t");
    assert.equal(prepared.ok, false, JSON.stringify(options));
    assert.match(prepared.error, /options/);
  }
});

test("prepareDecisionOptions: tokens must be 1-16 chars of A-Za-z0-9_- (no colons)", () => {
  const options = [[{ label: "A", value: "a" }]];
  for (const token of ["", "with:colon", "x".repeat(17), 7, "ä".repeat(4)]) {
    const prepared = prepareDecisionOptions(options, token);
    assert.equal(prepared.ok, false, JSON.stringify(token));
    assert.match(prepared.error, /decisionToken/);
  }
});

test("prepareDecisionOptions: decisionToken without options is refused", () => {
  const prepared = prepareDecisionOptions(undefined, "tok1");
  assert.equal(prepared.ok, false);
  assert.match(prepared.error, /requires `options`/);
});

test("prepareDecisionOptions: callback_data is capped at Telegram's 64 bytes", () => {
  const token = "abcdefgh"; // 8 chars; "dec:" + token + ":" = 13 bytes fixed
  const fits = prepareDecisionOptions(
    [[{ label: "A", value: "x".repeat(51) }]],
    token,
  );
  assert.equal(fits.ok, true);
  assert.equal(
    Buffer.byteLength(
      fits.keyboard.inline_keyboard[0][0].callback_data,
      "utf8",
    ),
    MAX_CALLBACK_DATA_BYTES,
  );
  const over = prepareDecisionOptions(
    [[{ label: "A", value: "x".repeat(52) }]],
    token,
  );
  assert.equal(over.ok, false);
  assert.match(over.error, /64-byte limit/);
  // Bytes, not chars: a 26-char two-byte value is already 52 bytes.
  const multibyte = prepareDecisionOptions(
    [[{ label: "A", value: "ä".repeat(26) }]],
    token,
  );
  assert.equal(multibyte.ok, false);
  assert.match(multibyte.error, /64-byte limit/);
});

// ── receive half: parse / label / format ────────────────────────────────────

test("parseDecisionCallbackData: round-trips token + value (value may contain colons)", () => {
  assert.deepEqual(
    parseDecisionCallbackData(decisionCallbackData("t1", "a:b")),
    {
      token: "t1",
      value: "a:b",
    },
  );
});

test("parseDecisionCallbackData: null for other prefixes and malformed dec payloads", () => {
  for (const data of [
    "pause",
    "resume",
    "status",
    "nonsense",
    "",
    "dec:",
    "dec:tok",
    "dec:tok:",
    "dec::x",
    "dec:with:colon:ok", // valid actually — token "with" is fine
  ]) {
    const parsed = parseDecisionCallbackData(data);
    if (data === "dec:with:colon:ok") {
      assert.deepEqual(parsed, { token: "with", value: "colon:ok" });
    } else {
      assert.equal(parsed, null, JSON.stringify(data));
    }
  }
  assert.equal(parseDecisionCallbackData(undefined), null);
  assert.equal(parseDecisionCallbackData(42), null);
});

test("findDecisionOptionLabel: matching button text is recovered, trimmed, tolerant of missing markup", () => {
  const markup = {
    inline_keyboard: [
      [{ text: "  Option A ", callback_data: "dec:t:a" }],
      [{ text: "Option B", callback_data: "dec:t:b" }],
    ],
  };
  const update = callbackUpdate({ data: "dec:t:a", replyMarkup: markup });
  assert.equal(findDecisionOptionLabel(update, "dec:t:a"), "Option A");
  assert.equal(findDecisionOptionLabel(update, "dec:t:missing"), undefined);
  assert.equal(
    findDecisionOptionLabel(callbackUpdate({ data: "dec:t:a" }), "dec:t:a"),
    undefined,
  );
});

test("formatDecisionAnswerText: label + value, value-only, and no duplicate when label === value", () => {
  assert.equal(
    formatDecisionAnswerText("t1", "a", "Option A"),
    "[decision] t1 → Option A (a)",
  );
  assert.equal(formatDecisionAnswerText("t1", "a"), "[decision] t1 → a");
  assert.equal(formatDecisionAnswerText("t1", "a", "a"), "[decision] t1 → a");
});

// ── tap handler ─────────────────────────────────────────────────────────────

test("handleDecisionCallbackQuery: a dec: tap is acknowledged (✓ label) and returns the formatted delivery", async () => {
  const { client, calls } = fakeClient();
  const markup = {
    inline_keyboard: [[{ text: "Option A", callback_data: "dec:t1:a" }]],
  };
  const update = callbackUpdate({ data: "dec:t1:a", replyMarkup: markup });
  const outcome = await handleDecisionCallbackQuery(
    { client, token: BOT_TOKEN },
    update,
  );
  assert.equal(outcome.handled, true);
  assert.equal(outcome.answered, true);
  assert.equal(outcome.delivery.text, "[decision] t1 → Option A (a)");
  assert.equal(outcome.delivery.updateId, 7);
  assert.equal(outcome.delivery.messageId, 5001);
  assert.equal(outcome.delivery.fromId, OWNER_ID);
  assert.equal(outcome.delivery.chatId, OWNER_CHAT_ID);
  assert.equal(outcome.delivery.chatType, "private");
  assert.equal(outcome.delivery.receivedAt, 1700000000 * 1000);
  assert.equal(calls.answerCallbackQuery.length, 1);
  assert.equal(calls.answerCallbackQuery[0].id, "cq-1");
  assert.equal(calls.answerCallbackQuery[0].options.text, "✓ Option A");
});

test("handleDecisionCallbackQuery: label falls back to the raw value when markup is unavailable", async () => {
  const { client, calls } = fakeClient();
  const outcome = await handleDecisionCallbackQuery(
    { client, token: BOT_TOKEN },
    callbackUpdate({ data: "dec:t2:a" }),
  );
  assert.equal(outcome.handled, true);
  assert.equal(outcome.delivery.text, "[decision] t2 → a");
  assert.equal(calls.answerCallbackQuery[0].options.text, "✓ a");
});

test("handleDecisionCallbackQuery: non-dec data falls through unhandled and unanswered (control path owns it)", async () => {
  const { client, calls } = fakeClient();
  for (const data of ["pause", "resume", "status", "nonsense", "dec:tok"]) {
    const outcome = await handleDecisionCallbackQuery(
      { client, token: BOT_TOKEN },
      callbackUpdate({ data }),
    );
    assert.equal(outcome.handled, false, data);
    assert.equal(outcome.answered, false, data);
    assert.equal(outcome.delivery, undefined, data);
  }
  assert.equal(calls.answerCallbackQuery.length, 0);
});

test("handleDecisionCallbackQuery: a tap with no message context is acknowledged but not delivered", async () => {
  const { client, calls } = fakeClient();
  const logs = [];
  const outcome = await handleDecisionCallbackQuery(
    { client, token: BOT_TOKEN, log: (...args) => logs.push(args) },
    callbackUpdate({ data: "dec:t3:a", withMessage: false }),
  );
  assert.equal(outcome.handled, true);
  assert.equal(outcome.answered, true);
  assert.equal(outcome.delivery, undefined);
  assert.match(outcome.error, /message context/);
  assert.equal(calls.answerCallbackQuery.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], "warn");
});

test("handleDecisionCallbackQuery: an answerCallbackQuery failure still yields the delivery", async () => {
  const { client } = fakeClient({ answerOk: false });
  const outcome = await handleDecisionCallbackQuery(
    { client, token: BOT_TOKEN },
    callbackUpdate({ data: "dec:t4:a" }),
  );
  assert.equal(outcome.handled, true);
  assert.equal(outcome.answered, false);
  assert.equal(outcome.delivery.text, "[decision] t4 → a");
});

// ── single-use tap semantics ────────────────────────────────────────────────

test("single-use: the first tap delivers and strips the keyboard (answer before edit)", async () => {
  const { client, calls } = fakeClient();
  const markup = {
    inline_keyboard: [[{ text: "Option A", callback_data: "dec:n1:a" }]],
  };
  const outcome = await handleDecisionCallbackQuery(
    { client, token: BOT_TOKEN },
    callbackUpdate({ data: "dec:n1:a", id: "cq-n1", replyMarkup: markup }),
  );
  assert.equal(outcome.handled, true);
  assert.equal(outcome.answered, true);
  assert.equal(outcome.delivery.text, "[decision] n1 → Option A (a)");
  assert.deepEqual(calls.order, ["answer", "edit"]);
  assert.equal(calls.editMessageReplyMarkup.length, 1);
  assert.deepEqual(calls.editMessageReplyMarkup[0], {
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    messageId: 5001,
    options: { replyMarkup: { inline_keyboard: [] } },
  });
});

test("single-use: a second tap of the same token is answered but never delivered", async () => {
  const { client, calls } = fakeClient();
  const markup = {
    inline_keyboard: [[{ text: "Option A", callback_data: "dec:n2:a" }]],
  };
  const first = await handleDecisionCallbackQuery(
    { client, token: BOT_TOKEN },
    callbackUpdate({ data: "dec:n2:a", id: "cq-n2-1", replyMarkup: markup }),
  );
  assert.equal(first.delivery.text, "[decision] n2 → Option A (a)");
  const second = await handleDecisionCallbackQuery(
    { client, token: BOT_TOKEN },
    callbackUpdate({ data: "dec:n2:a", id: "cq-n2-2", replyMarkup: markup }),
  );
  assert.equal(second.handled, true);
  assert.equal(second.answered, true);
  assert.equal(second.delivery, undefined);
  assert.equal(calls.answerCallbackQuery.length, 2);
  assert.equal(calls.answerCallbackQuery[1].id, "cq-n2-2");
  assert.equal(
    calls.answerCallbackQuery[1].options.text,
    "already answered: Option A",
  );
  // The repeat re-strips the keyboard the tapped message still carries.
  assert.equal(calls.editMessageReplyMarkup.length, 2);
  assert.deepEqual(calls.editMessageReplyMarkup[1].options, {
    replyMarkup: { inline_keyboard: [] },
  });
});

test("single-use: a second tap with a DIFFERENT value on the same token is still suppressed", async () => {
  const { client, calls } = fakeClient();
  const markup = {
    inline_keyboard: [[{ text: "Option A", callback_data: "dec:n3:a" }]],
  };
  await handleDecisionCallbackQuery(
    { client, token: BOT_TOKEN },
    callbackUpdate({ data: "dec:n3:a", id: "cq-n3-1", replyMarkup: markup }),
  );
  const second = await handleDecisionCallbackQuery(
    { client, token: BOT_TOKEN },
    callbackUpdate({ data: "dec:n3:b", id: "cq-n3-2", replyMarkup: markup }),
  );
  assert.equal(second.handled, true);
  assert.equal(second.answered, true);
  assert.equal(second.delivery, undefined);
  // The toast names the FIRST answer, not the one just tapped.
  assert.equal(
    calls.answerCallbackQuery[1].options.text,
    "already answered: Option A",
  );
  assert.equal(calls.editMessageReplyMarkup.length, 2);
});

test("single-use: an editMessageReplyMarkup failure blocks neither the first delivery nor the suppression", async () => {
  for (const mode of ["rejected", "ok-false"]) {
    const { client } = fakeClient(
      mode === "rejected" ? { editRejects: true } : { editOk: false },
    );
    const token = mode === "rejected" ? "n4" : "n5";
    const markup = {
      inline_keyboard: [
        [{ text: "Option A", callback_data: `dec:${token}:a` }],
      ],
    };
    const logs = [];
    const first = await handleDecisionCallbackQuery(
      { client, token: BOT_TOKEN, log: (...args) => logs.push(args) },
      callbackUpdate({
        data: `dec:${token}:a`,
        id: `cq-${token}-1`,
        replyMarkup: markup,
      }),
    );
    assert.equal(first.delivery.text, `[decision] ${token} → Option A (a)`);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], "warn");
    const second = await handleDecisionCallbackQuery(
      { client, token: BOT_TOKEN, log: (...args) => logs.push(args) },
      callbackUpdate({
        data: `dec:${token}:a`,
        id: `cq-${token}-2`,
        replyMarkup: markup,
      }),
    );
    assert.equal(second.answered, true);
    assert.equal(second.delivery, undefined);
  }
});

test("single-use: different tokens are independent (both first taps deliver)", async () => {
  const { client } = fakeClient();
  const first = await handleDecisionCallbackQuery(
    { client, token: BOT_TOKEN },
    callbackUpdate({ data: "dec:n6:a", id: "cq-n6" }),
  );
  const other = await handleDecisionCallbackQuery(
    { client, token: BOT_TOKEN },
    callbackUpdate({ data: "dec:n7:b", id: "cq-n7" }),
  );
  assert.equal(first.delivery.text, "[decision] n6 → a");
  assert.equal(other.delivery.text, "[decision] n7 → b");
});

test("single-use: the answered set is bounded at 64 tokens; the oldest is evicted", async () => {
  const { client } = fakeClient();
  for (let i = 0; i < 65; i++) {
    const outcome = await handleDecisionCallbackQuery(
      { client, token: BOT_TOKEN },
      callbackUpdate({ data: `dec:b${i}:v`, id: `cq-b${i}` }),
    );
    assert.equal(outcome.delivery.text, `[decision] b${i} → v`);
  }
  // The most recent answer is still remembered...
  const recent = await handleDecisionCallbackQuery(
    { client, token: BOT_TOKEN },
    callbackUpdate({ data: "dec:b64:v", id: "cq-b64-again" }),
  );
  assert.equal(recent.delivery, undefined);
  // ...while the oldest (b0) was evicted and answers again.
  const evicted = await handleDecisionCallbackQuery(
    { client, token: BOT_TOKEN },
    callbackUpdate({ data: "dec:b0:v", id: "cq-b0-again" }),
  );
  assert.equal(evicted.delivery.text, "[decision] b0 → v");
});

test("single-use: two racing taps of one token deliver exactly once", async () => {
  const { client } = fakeClient();
  const [a, b] = await Promise.all([
    handleDecisionCallbackQuery(
      { client, token: BOT_TOKEN },
      callbackUpdate({ data: "dec:n8:a", id: "cq-n8-1" }),
    ),
    handleDecisionCallbackQuery(
      { client, token: BOT_TOKEN },
      callbackUpdate({ data: "dec:n8:a", id: "cq-n8-2" }),
    ),
  ]);
  const delivered = [a, b].filter((outcome) => outcome.delivery !== undefined);
  assert.equal(delivered.length, 1);
});

// ── telegram_send wiring ────────────────────────────────────────────────────

test("telegram_send options: the plain path carries the keyboard and echoes the token", async () => {
  const { client, calls } = fakeClient();
  const outcome = await runTelegramSend(
    {
      text: "Pick one",
      options: [[{ label: "Option A", value: "a" }]],
      decisionToken: "tok1",
    },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.decisionToken, "tok1");
  assert.equal(calls.sendMessage.length, 1);
  assert.equal(calls.sendMessage[0].text, "Pick one");
  assert.deepEqual(calls.sendMessage[0].options.replyMarkup, {
    inline_keyboard: [[{ text: "Option A", callback_data: "dec:tok1:a" }]],
  });
});

test("telegram_send options: a generated token is echoed in the outcome and on the buttons", async () => {
  const { client, calls } = fakeClient();
  const outcome = await runTelegramSend(
    { text: "Pick one", options: [[{ label: "A", value: "a" }]] },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, true);
  assert.match(outcome.decisionToken, /^[a-z0-9]{1,16}$/);
  assert.equal(
    calls.sendMessage[0].options.replyMarkup.inline_keyboard[0][0]
      .callback_data,
    `dec:${outcome.decisionToken}:a`,
  );
});

test("telegram_send options: malformed rows refuse the send (nothing delivered)", async () => {
  const { client, calls } = fakeClient();
  for (const options of [
    [],
    [[], []],
    [[{ label: "", value: "a" }]],
    [[{ label: "a", value: "x".repeat(52) }]],
  ]) {
    const outcome = await runTelegramSend(
      { text: "Pick one", options, decisionToken: "abcdefgh" },
      { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
    );
    assert.equal(outcome.ok, false, JSON.stringify(options));
    assert.match(outcome.error, /telegram_send/);
  }
  assert.equal(calls.sendMessage.length, 0);
});

test("telegram_send options: the voice path refuses buttons (no silent drop)", async () => {
  const { client, calls } = fakeClient();
  const outcome = await runTelegramSend(
    {
      text: "Pick one",
      voice: true,
      options: [[{ label: "A", value: "a" }]],
    },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /voice path/);
  assert.equal(calls.sendMessage.length, 0);
});

test("telegram_send options + rich: the keyboard rides the LAST chunk only", async () => {
  const { client, calls } = fakeClient();
  const outcome = await runTelegramSend(
    {
      text: "x".repeat(5000),
      rich: true,
      options: [[{ label: "A", value: "a" }]],
      decisionToken: "tok1",
    },
    { client, token: BOT_TOKEN, chatId: OWNER_CHAT_ID },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.chunks, 2);
  assert.equal(outcome.decisionToken, "tok1");
  assert.equal(calls.sendMessage.length, 2);
  assert.equal(
    calls.sendMessage[0].options?.replyMarkup,
    undefined,
    "first chunk carries no keyboard",
  );
  assert.deepEqual(calls.sendMessage[1].options.replyMarkup, {
    inline_keyboard: [[{ text: "A", callback_data: "dec:tok1:a" }]],
  });
});
