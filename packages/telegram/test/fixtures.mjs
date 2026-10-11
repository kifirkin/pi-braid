/**
 * Shared recorded-fixture helpers for packages/telegram tests.
 *
 * All fixtures follow the real Telegram Bot API response shapes but are served
 * by an in-memory fake fetch — NO real network calls ever happen in tests.
 */

// Stable test identities
export const OWNER_ID = 111222333;
export const OWNER_CHAT_ID = 999888777;
export const FOREIGN_ID = 444555666;
export const BOT_TOKEN = "123456:TEST-TOKEN-ABCDEF";

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Build a fake fetch that records every call and answers via `handler`.
 * `handler(url, init) => Response`. Recorded calls are on `fetchFn.calls`.
 */
export function makeFakeFetch(handler) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      body: init.body ?? null,
      headers: init.headers ?? {},
    });
    return handler(String(url), init);
  };
  fetchFn.calls = calls;
  return fetchFn;
}

export function parseQuery(url) {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

// ── Telegram response shapes (recorded fixtures) ─────────────────────────────

export function sendMessageResult(messageId, extra = {}) {
  return {
    ok: true,
    result: {
      message_id: messageId,
      from: { id: 555555, is_bot: true, username: "braid_test_bot" },
      chat: { id: OWNER_CHAT_ID, type: "private", username: "owner" },
      date: 1700000000,
      text: "ok",
      ...extra,
    },
  };
}

export function getUpdatesResult(updates) {
  return { ok: true, result: updates };
}

export function getMeResult(
  bot = {
    id: 555555,
    is_bot: true,
    first_name: "braid",
    username: "braid_test_bot",
  },
) {
  return { ok: true, result: bot };
}

/**
 * Build an update with a message. Pass `messageOverrides` to override any
 * message field (from.id, chat.type, text, ...), or `dropMessage` to produce
 * a non-message update (e.g. edited_message).
 */
export function makeUpdate(
  updateId,
  messageOverrides = {},
  dropMessage = false,
) {
  const message = dropMessage
    ? undefined
    : {
        message_id: updateId + 1000,
        from: {
          id: OWNER_ID,
          is_bot: false,
          first_name: "Owner",
          username: "owner",
        },
        chat: { id: OWNER_CHAT_ID, type: "private", username: "owner" },
        date: 1700000000,
        text: "hello from owner",
        ...messageOverrides,
      };
  return { update_id: updateId, message };
}

/**
 * Build a callback_query update (inline-keyboard tap, pause/resume control or
 * a decision button). Pass `{ fromId, dropMessage, text, replyMarkup }`
 * overrides; `data` is the callback_data. `replyMarkup` (when given) lands on
 * the tapped message so decision-label recovery can be exercised.
 */
export function makeCallbackUpdate(updateId, data, overrides = {}) {
  const message = overrides.dropMessage
    ? undefined
    : {
        message_id: updateId + 5000,
        chat: { id: OWNER_CHAT_ID, type: "private" },
        text: overrides.text ?? "control",
        ...(overrides.replyMarkup
          ? { reply_markup: overrides.replyMarkup }
          : {}),
      };
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: {
        id: overrides.fromId ?? OWNER_ID,
        is_bot: false,
        first_name: "Owner",
        username: "owner",
      },
      message,
      data,
    },
  };
}

/** Stateful fake getUpdates server: returns all queued updates >= offset. */
export function makeUpdatesServer(updates) {
  const queue = [...updates];
  const handler = async (url) => {
    const q = parseQuery(url);
    const offset = Number(q.offset ?? 0);
    const available = queue
      .filter((u) => u.update_id >= offset)
      .sort((a, b) => a.update_id - b.update_id);
    return jsonResponse(getUpdatesResult(available));
  };
  handler.queue = queue;
  return handler;
}
