/**
 * Low-level Telegram Bot API client built on Node 22's global fetch.
 *
 * Zero npm dependencies. Every method takes an injectable fetch (defaults to
 * `globalThis.fetch`) so tests can substitute a recorded-fixture fake without
 * touching the network.
 *
 * Mirrors the agent-zero `_telegram_integration` plugin's `helpers/telegram_client.py`
 * against `https://api.telegram.org/bot<token>/<method>` using plain fetch
 * instead of aiogram.
 */

export type TelegramFetch = typeof fetch;

export const DEFAULT_BASE_URL = "https://api.telegram.org";

/** Telegram parse_mode for formatted text (HTML | Markdown). */
export type ParseMode = "HTML" | "Markdown";

/** Inline keyboard (reply_markup) — pause/resume control. */
export interface TelegramReplyMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

/** Options accepted by every client call; `fetch` is injectable for tests. */
export interface TelegramClientOptions {
  /** Fetch implementation to use. Defaults to globalThis.fetch. */
  fetch?: TelegramFetch;
  /** API base url override (tests / mirrors). Defaults to https://api.telegram.org. */
  baseUrl?: string;
  /**
   * parse_mode for sendMessage/editMessageText (HTML | Markdown) — rich
   * formatted responses. Optional; when absent the message is
   * delivered as plain text.
   */
  parseMode?: ParseMode;
}

/**
 * Per-call options for sendMessage/editMessageText: the shared client
 * options plus an optional inline keyboard (reply_markup) attached to the
 * message. `createTelegramClient` merges its bound options
 * with these per-call ones.
 */
export interface TelegramSendOptions extends TelegramClientOptions {
  /** Inline keyboard (reply_markup) to attach to the message/edited message. */
  replyMarkup?: TelegramReplyMarkup;
}

// Wire types (Telegram Bot API shapes relevant to this channel)

export interface TelegramFrom {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  username?: string;
  first_name?: string;
  last_name?: string;
  title?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramFrom;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  voice?: unknown;
  chat_type?: string;
  [key: string]: unknown;
}

/** Inline-keyboard tap — `data` carries the button's callback_data. */
export interface TelegramCallbackQuery {
  id: string;
  from?: TelegramFrom;
  /** The message the button was attached to (absent when the tap is inline-mode). */
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  [key: string]: unknown;
}

// Result shapes returned to callers (never throw for API/network errors)

export interface TelegramSendResult {
  ok: boolean;
  messageId?: number;
  error?: string;
  raw?: unknown;
}

export interface TelegramGetUpdatesResult {
  ok: boolean;
  updates: TelegramUpdate[];
  error?: string;
}

export interface TelegramGetMeResult {
  ok: boolean;
  bot?: {
    id: number;
    is_bot?: boolean;
    username?: string;
    first_name?: string;
  };
  error?: string;
}

export interface TelegramTestTokenResult extends TelegramGetMeResult {
  httpStatus?: number;
}

/** Result of a bare action call (e.g. sendChatAction) that returns ok:true only. */
export interface TelegramActionResult {
  ok: boolean;
  error?: string;
}

// Errors

export class TelegramApiError extends Error {
  readonly status: number | undefined;
  readonly raw: unknown;
  constructor(message: string, status?: number, raw?: unknown) {
    super(message);
    this.name = "TelegramApiError";
    this.status = status;
    this.raw = raw;
  }
}

function apiUrl(baseUrl: string, token: string, method: string): string {
  return `${baseUrl.replace(/\/$/, "")}/bot${token}/${method}`;
}

async function parseJsonOk(response: Response): Promise<any> {
  const status = response.status;
  let json: any = null;
  try {
    json = await response.json();
  } catch {
    // non-JSON error body (e.g. 404 from a wrong token route)
  }
  if (!response.ok || json == null || json.ok !== true) {
    const description =
      json?.description ?? json?.error ?? json?.message ?? `HTTP ${status}`;
    throw new TelegramApiError(String(description), status, json ?? undefined);
  }
  return json;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// Outbound: text

/**
 * Send a text message. Returns the delivered `message_id` via `result.messageId`.
 * Honors `options.parseMode` (HTML | Markdown) ��� rich formatted responses.
 * See sendMessage request shape: https://core.telegram.org/bots/api#sendmessage
 */
export async function sendMessage(
  token: string,
  chatId: number | string,
  text: string,
  options: TelegramSendOptions = {},
): Promise<TelegramSendResult> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  try {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (options.parseMode) body.parse_mode = options.parseMode;
    if (options.replyMarkup) body.reply_markup = options.replyMarkup;
    const res = await fetchFn(apiUrl(baseUrl, token, "sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await parseJsonOk(res);
    return {
      ok: true,
      messageId: json?.result?.message_id as number | undefined,
      raw: json?.result ?? undefined,
    };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

// Outbound: edit / chat action (live-update)

/**
 * Edit a previously-sent message in place (live-update tracked message).
 * Mirrors sendMessage's result contract: returns the (possibly unchanged)
 * `message_id` on success. Telegram returns `result: Message | true` — when
 * the body is identical it replies `true` (no message_id), which is still a
 * success ({ ok:true }). See editMessageText:
 * https://core.telegram.org/bots/api#editmessagetext
 */
export async function editMessageText(
  token: string,
  chatId: number | string,
  messageId: number,
  text: string,
  options: TelegramSendOptions = {},
): Promise<TelegramSendResult> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };
    if (options.parseMode) body.parse_mode = options.parseMode;
    if (options.replyMarkup) body.reply_markup = options.replyMarkup;
    const res = await fetchFn(apiUrl(baseUrl, token, "editMessageText"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await parseJsonOk(res);
    const result = json?.result;
    return {
      ok: true,
      // result may be the boolean `true` (unchanged body) — no message_id then.
      messageId:
        result && typeof result === "object"
          ? (result as { message_id?: number }).message_id
          : undefined,
      raw: result ?? undefined,
    };
  } catch (error) {
    // Telegram rejects an edit that changes nothing with 400
    // "message is not modified" (e.g. re-tapping a control button). That is
    // an idempotent no-op, not a failure — report ok:true so callers don't
    // log spurious warnings (pause-control status taps). parseJsonOk throws
    // TelegramApiError before any body check runs, so inspect it here.
    if (
      error instanceof TelegramApiError &&
      String(error.message).includes("message is not modified")
    ) {
      return { ok: true, raw: undefined };
    }
    return { ok: false, error: toErrorMessage(error) };
  }
}

/**
 * Replace or remove the inline keyboard attached to a message — an empty
 * `{ inline_keyboard: [] }` removes it (the decision-button single-use path
 * strips the keyboard after the first tap). Same result contract as
 * editMessageText: Telegram answers `result: Message | true`, and an
 * identical body comes back as `true` (no-op, still ok). See
 * editMessageReplyMarkup:
 * https://core.telegram.org/bots/api#editmessagereplymarkup
 */
export async function editMessageReplyMarkup(
  token: string,
  chatId: number | string,
  messageId: number,
  options: TelegramSendOptions = {},
): Promise<TelegramSendResult> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
    };
    if (options.replyMarkup) body.reply_markup = options.replyMarkup;
    const res = await fetchFn(
      apiUrl(baseUrl, token, "editMessageReplyMarkup"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const json = await parseJsonOk(res);
    const result = json?.result;
    return {
      ok: true,
      messageId:
        result && typeof result === "object"
          ? (result as { message_id?: number }).message_id
          : undefined,
      raw: result ?? undefined,
    };
  } catch (error) {
    // Re-editing with identical markup is an idempotent no-op (Telegram
    // replies 400 "message is not modified") — report ok:true like
    // editMessageText does so callers don't log spurious warnings.
    if (
      error instanceof TelegramApiError &&
      String(error.message).includes("message is not modified")
    ) {
      return { ok: true, raw: undefined };
    }
    return { ok: false, error: toErrorMessage(error) };
  }
}

/**
 * Answer an inline-keyboard callback_query. The button tap
 * shows a brief loading spinner on the client until this is answered;
 * `text` shows as a toast (unless `showAlert: true`, which pops an alert).
 * Bare `ok:true` result (Telegram returns no message).
 * See answerCallbackQuery: https://core.telegram.org/bots/api#answercallbackquery
 */
export interface AnswerCallbackQueryOptions {
  /** Toast/alert text shown to the user who tapped the button. */
  text?: string;
  /** true → show an alert dialog instead of a toast. Default false. */
  showAlert?: boolean;
  fetch?: TelegramFetch;
  baseUrl?: string;
}

export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  options: AnswerCallbackQueryOptions = {},
): Promise<TelegramActionResult> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  try {
    const body: Record<string, unknown> = {
      callback_query_id: callbackQueryId,
    };
    if (options.text) body.text = options.text;
    if (options.showAlert !== undefined) body.show_alert = options.showAlert;
    const res = await fetchFn(apiUrl(baseUrl, token, "answerCallbackQuery"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await parseJsonOk(res);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/**
 * Send a chat action (typing indicator, etc.) to keep the UI alive — used
 * before the mid-turn live-update edits so the owner sees the bot is working.
 * Bare `ok:true` result (Telegram returns no message).
 * See sendChatAction: https://core.telegram.org/bots/api#sendchataction
 */
export async function sendChatAction(
  token: string,
  chatId: number | string,
  action: string = "typing",
  options: TelegramClientOptions = {},
): Promise<TelegramActionResult> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  try {
    const body = { chat_id: chatId, action };
    const res = await fetchFn(apiUrl(baseUrl, token, "sendChatAction"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await parseJsonOk(res);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

// Outbound: voice note (OGG/Opus)

/**
 * Send a voice note via sendVoice (OGG/Opus), mirroring agent-zero's send_voice path.
 * `oggPathOrBuffer` is either a filesystem path to an .ogg file or a Buffer of
 * OGG/Opus bytes (multipart/form-data upload, filename voice.ogg).
 */
export async function sendVoiceNote(
  token: string,
  chatId: number | string,
  oggPathOrBuffer: string | Buffer | Uint8Array,
  caption?: string,
  options: TelegramClientOptions = {},
): Promise<TelegramSendResult> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  try {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption && caption.trim()) form.append("caption", caption.trim());
    const audio = await oggToBlob(oggPathOrBuffer);
    form.append("voice", audio, "voice.ogg");
    const res = await fetchFn(apiUrl(baseUrl, token, "sendVoice"), {
      method: "POST",
      body: form,
    });
    const json = await parseJsonOk(res);
    return {
      ok: true,
      messageId: json?.result?.message_id as number | undefined,
      raw: json?.result ?? undefined,
    };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

async function oggToBlob(
  oggPathOrBuffer: string | Buffer | Uint8Array,
): Promise<Blob> {
  let bytes: Uint8Array;
  if (typeof oggPathOrBuffer === "string") {
    const { readFile } = await import("node:fs/promises");
    bytes = await readFile(oggPathOrBuffer);
  } else {
    bytes = oggPathOrBuffer;
  }
  // TS lib requires a Uint8Array<ArrayBuffer> for BlobPart; copy so the
  // backing store is a plain ArrayBuffer (shared/foreign buffers are rejected
  // by the typings even though they work at runtime).
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy], { type: "audio/ogg" });
}

// Inbound: long poll

/**
 * Fetch updates via getUpdates with offset (confirm-on-read) and optional
 * long-poll `timeout` seconds. A timeout produces `{ ok: true, updates: [] }`.
 * See: https://core.telegram.org/bots/api#getupdates
 */
export async function getUpdates(
  token: string,
  offset?: number,
  timeout?: number,
  options: TelegramClientOptions = {},
): Promise<TelegramGetUpdatesResult> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const params = new URLSearchParams();
  if (offset != null && Number.isFinite(offset))
    params.set("offset", String(offset));
  if (timeout != null && Number.isFinite(timeout))
    params.set("timeout", String(timeout));
  params.set("limit", "100");
  const qs = params.toString();
  const url = apiUrl(baseUrl, token, "getUpdates") + (qs ? `?${qs}` : "");
  try {
    const res = await fetchFn(url, { method: "GET" });
    const json = await parseJsonOk(res);
    const result = json?.result;
    return {
      ok: true,
      updates: Array.isArray(result) ? (result as TelegramUpdate[]) : [],
    };
  } catch (error) {
    return { ok: false, updates: [], error: toErrorMessage(error) };
  }
}

// Inbound: media download (photo inbound, owner photo attachments)

/** Result of a getFile call (file metadata incl. the download file_path). */
export interface TelegramGetFileResult {
  ok: boolean;
  file?: {
    file_id?: string;
    file_unique_id?: string;
    file_size?: number;
    file_path?: string;
  };
  error?: string;
}

/** Result of a file-bytes download from the /file/bot<token>/<file_path> route. */
export interface TelegramDownloadResult {
  ok: boolean;
  bytes?: Uint8Array;
  error?: string;
}

/**
 * getFile: resolve a file_id to its download metadata (file_path on the bot
 * file CDN). Returns `{ ok, file?, error? }`; never throws. See:
 * https://core.telegram.org/bots/api#getfile
 */
export async function getFile(
  token: string,
  fileId: string,
  options: TelegramClientOptions = {},
): Promise<TelegramGetFileResult> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const url =
    apiUrl(baseUrl, token, "getFile") +
    `?file_id=${encodeURIComponent(fileId)}`;
  try {
    const res = await fetchFn(url, { method: "GET" });
    const json = await parseJsonOk(res);
    return { ok: true, file: json?.result ?? undefined };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/**
 * Download raw file bytes from the bot file CDN
 * (`https://api.telegram.org/file/bot<token>/<file_path>`). Returns
 * `{ ok, bytes?, error? }`; never throws. `filePath` is the `file_path` from
 * getFile. See: https://core.telegram.org/bots/api#file
 */
export async function downloadFile(
  token: string,
  filePath: string,
  options: TelegramClientOptions = {},
): Promise<TelegramDownloadResult> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const url = `${baseUrl.replace(/\/$/, "")}/file/bot${token}/${filePath}`;
  try {
    const res = await fetchFn(url, { method: "GET" });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} downloading ${filePath}` };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { ok: true, bytes };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

// Validation

/** getMe: validates the token and returns bot identity. */
export async function getMe(
  token: string,
  options: TelegramClientOptions = {},
): Promise<TelegramGetMeResult> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  try {
    const res = await fetchFn(apiUrl(baseUrl, token, "getMe"), {
      method: "GET",
    });
    const json = await parseJsonOk(res);
    return { ok: true, bot: json?.result ?? undefined };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/**
 * testToken: zero-failure token validation mirroring agent-zero's
 * `api/test_connection.py`. Returns `{ ok, bot?, error?, httpStatus? }`; never
 * throws. Primary pre-flight check before starting the inbound poller.
 */
export async function testToken(
  token: string,
  options: TelegramClientOptions = {},
): Promise<TelegramTestTokenResult> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  try {
    const res = await fetchFn(apiUrl(baseUrl, token, "getMe"), {
      method: "GET",
    });
    const status = res.status;
    const json = await parseJsonOk(res);
    return { ok: true, httpStatus: status, bot: json?.result ?? undefined };
  } catch (error) {
    const status = error instanceof TelegramApiError ? error.status : undefined;
    return {
      ok: false,
      httpStatus: status,
      error: toErrorMessage(error),
    };
  }
}

export interface TelegramClient {
  sendMessage(
    token: string,
    chatId: number | string,
    text: string,
    options?: TelegramSendOptions,
  ): Promise<TelegramSendResult>;
  editMessageText(
    token: string,
    chatId: number | string,
    messageId: number,
    text: string,
    options?: TelegramSendOptions,
  ): Promise<TelegramSendResult>;
  editMessageReplyMarkup(
    token: string,
    chatId: number | string,
    messageId: number,
    options?: TelegramSendOptions,
  ): Promise<TelegramSendResult>;
  answerCallbackQuery(
    token: string,
    callbackQueryId: string,
    options?: AnswerCallbackQueryOptions,
  ): Promise<TelegramActionResult>;
  sendChatAction(
    token: string,
    chatId: number | string,
    action?: string,
    options?: TelegramClientOptions,
  ): Promise<TelegramActionResult>;
  sendVoiceNote(
    token: string,
    chatId: number | string,
    oggPathOrBuffer: string | Buffer | Uint8Array,
    caption?: string,
    options?: TelegramClientOptions,
  ): Promise<TelegramSendResult>;
  getUpdates(
    token: string,
    offset?: number,
    timeout?: number,
    options?: TelegramClientOptions,
  ): Promise<TelegramGetUpdatesResult>;
  getFile(
    token: string,
    fileId: string,
    options?: TelegramClientOptions,
  ): Promise<TelegramGetFileResult>;
  downloadFile(
    token: string,
    filePath: string,
    options?: TelegramClientOptions,
  ): Promise<TelegramDownloadResult>;
  getMe(
    token: string,
    options?: TelegramClientOptions,
  ): Promise<TelegramGetMeResult>;
  testToken(
    token: string,
    options?: TelegramClientOptions,
  ): Promise<TelegramTestTokenResult>;
}

/**
 * Convenience factory binding one injectable fetch (and baseUrl) to every call.
 * `createTelegramClient({ fetch: fakeFetch })` is the primary test seam.
 */
export function createTelegramClient(
  options: TelegramClientOptions = {},
): TelegramClient {
  return {
    sendMessage: (token, chatId, text, perCall) =>
      sendMessage(token, chatId, text, { ...options, ...perCall }),
    editMessageText: (token, chatId, messageId, text, perCall) =>
      editMessageText(token, chatId, messageId, text, {
        ...options,
        ...perCall,
      }),
    editMessageReplyMarkup: (token, chatId, messageId, perCall) =>
      editMessageReplyMarkup(token, chatId, messageId, {
        ...options,
        ...perCall,
      }),
    answerCallbackQuery: (token, callbackQueryId, perCall) =>
      answerCallbackQuery(token, callbackQueryId, { ...options, ...perCall }),
    sendChatAction: (token, chatId, action) =>
      sendChatAction(token, chatId, action, options),
    sendVoiceNote: (token, chatId, ogg, caption) =>
      sendVoiceNote(token, chatId, ogg, caption, options),
    getUpdates: (token, offset, timeout) =>
      getUpdates(token, offset, timeout, options),
    getFile: (token, fileId) => getFile(token, fileId, options),
    downloadFile: (token, filePath) => downloadFile(token, filePath, options),
    getMe: (token) => getMe(token, options),
    testToken: (token) => testToken(token, options),
  };
}
