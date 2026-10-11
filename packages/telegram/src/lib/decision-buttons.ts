/**
 * Decision buttons — inline keyboards that carry the owner's choice back to
 * the agent as a normal inbound message.
 *
 * Both protocol halves live here so a format change lands in one file:
 *  - send: `prepareDecisionOptions` turns rows of `{ label, value }` into a
 *    `reply_markup` whose buttons carry `dec:<token>:<value>` callback_data.
 *    The token is a short opaque correlation id (echoed back on the tap and
 *    in the tool result), so the agent can match a tap to the question it
 *    asked. Telegram caps callback_data at 64 bytes — enforced here, before
 *    anything is sent.
 *  - receive: `parseDecisionCallbackData` recognizes the prefix,
 *    `findDecisionOptionLabel` recovers the tapped button's label from the
 *    message markup, and `handleDecisionCallbackQuery` answers the tap
 *    (toast) and returns the delivery payload (an `IncomingOwnerMessage`
 *    the caller hands to the same inbound path as a text message). A tap is
 *    single-use: the first tap of a token delivers and strips the keyboard,
 *    every later tap is acknowledged only. Control callbacks
 *    (`pause`/`resume`/`status`) fail the prefix check and keep their own
 *    handler's path.
 *
 * Placement: this is the telegram package's domain protocol (its prefix, its
 * token, its tap format). Nothing generic knows the `dec:` vocabulary; the
 * tool/params layer treats options as rows of {label, value} and asks this
 * module for the wire shape.
 */

import type {
  TelegramClient,
  TelegramMessage,
  TelegramReplyMarkup,
  TelegramUpdate,
} from "./telegram-client.js";
import type { IncomingOwnerMessage } from "./inbound-poller.js";

/** callback_data prefix that marks a decision-button tap. */
export const DECISION_CALLBACK_PREFIX = "dec:";
/** Telegram's hard limit for callback_data (bytes, UTF-8). */
export const MAX_CALLBACK_DATA_BYTES = 64;
/** Layout limits: 1-2 rows, at most 4 buttons per row (a compact keyboard). */
export const MAX_DECISION_ROWS = 2;
export const MAX_DECISION_BUTTONS_PER_ROW = 4;
/**
 * Token shape: short, no colons (the second colon separates value), URL-safe
 * characters only. Not a secret — a correlation id, so a guess costs nothing.
 */
const DECISION_TOKEN_RE = /^[A-Za-z0-9_-]{1,16}$/;

/** One button: `label` is what the owner sees, `value` what the agent gets. */
export interface DecisionOption {
  label: string;
  value: string;
}

/** Rows of options (Telegram's inline_keyboard layout). */
export type DecisionOptionRows = DecisionOption[][];

export type DecisionPrepOutcome =
  | { ok: true; token: string; keyboard: TelegramReplyMarkup }
  | { ok: false; error: string };

/**
 * Generate a correlation token for a decision keyboard: up to 8 chars of
 * base36. Callers that pass their own `decisionToken` keep it; this is the
 * fallback and its result is returned to the agent in the tool outcome.
 */
export function generateDecisionToken(): string {
  let token = "";
  while (!DECISION_TOKEN_RE.test(token)) {
    token = Math.random().toString(36).slice(2, 10);
  }
  return token;
}

/** The callback_data a button sends back: `dec:<token>:<value>`. */
export function decisionCallbackData(token: string, value: string): string {
  return `${DECISION_CALLBACK_PREFIX}${token}:${value}`;
}

/**
 * Validate `options` + resolve the token, or explain the refusal. Malformed
 * rows are REJECTED (the caller sends nothing): an explicit param that
 * quietly loses its keyboard would leave the agent believing the owner can
 * tap when they cannot. Pinned by tests.
 */
export function prepareDecisionOptions(
  options: unknown,
  requestedToken?: unknown,
): DecisionPrepOutcome {
  if (options === undefined && requestedToken !== undefined) {
    return {
      ok: false,
      error:
        "telegram_send: `decisionToken` requires `options` — the token is the id the buttons echo back",
    };
  }
  if (
    !Array.isArray(options) ||
    options.length === 0 ||
    options.length > MAX_DECISION_ROWS
  ) {
    return {
      ok: false,
      error: `telegram_send: \`options\` must be 1-${MAX_DECISION_ROWS} rows of buttons`,
    };
  }

  const rows: DecisionOptionRows = [];
  for (const row of options) {
    if (
      !Array.isArray(row) ||
      row.length === 0 ||
      row.length > MAX_DECISION_BUTTONS_PER_ROW
    ) {
      return {
        ok: false,
        error: `telegram_send: every \`options\` row must carry 1-${MAX_DECISION_BUTTONS_PER_ROW} buttons`,
      };
    }
    const built: DecisionOption[] = [];
    for (const button of row) {
      const raw = button as { label?: unknown; value?: unknown } | null;
      const label = typeof raw?.label === "string" ? raw.label.trim() : "";
      const value = typeof raw?.value === "string" ? raw.value.trim() : "";
      if (!label || !value) {
        return {
          ok: false,
          error:
            "telegram_send: every `options` button needs a non-empty `label` and `value`",
        };
      }
      built.push({ label, value });
    }
    rows.push(built);
  }

  let token: string;
  if (requestedToken === undefined) {
    token = generateDecisionToken();
  } else if (
    typeof requestedToken === "string" &&
    DECISION_TOKEN_RE.test(requestedToken.trim())
  ) {
    token = requestedToken.trim();
  } else {
    return {
      ok: false,
      error:
        "telegram_send: `decisionToken` must be 1-16 characters of A-Za-z0-9_- (no colons)",
    };
  }

  // Byte cap: Telegram rejects the whole send when any callback_data is over
  // 64 bytes, so refuse here with the offending value named.
  for (const row of rows) {
    for (const button of row) {
      const data = decisionCallbackData(token, button.value);
      const bytes = Buffer.byteLength(data, "utf8");
      if (bytes > MAX_CALLBACK_DATA_BYTES) {
        return {
          ok: false,
          error: `telegram_send: \`options\` value ${JSON.stringify(button.value)} makes callback_data ${bytes} bytes, over Telegram's ${MAX_CALLBACK_DATA_BYTES}-byte limit`,
        };
      }
    }
  }

  return {
    ok: true,
    token,
    keyboard: {
      inline_keyboard: rows.map((row) =>
        row.map((button) => ({
          text: button.label,
          callback_data: decisionCallbackData(token, button.value),
        })),
      ),
    },
  };
}

/** Parsed decision callback payload. */
export interface ParsedDecisionCallback {
  token: string;
  /** The button's value; may itself contain colons (only the first splits). */
  value: string;
}

/**
 * Parse `dec:<token>:<value>`; null for anything else. A malformed payload is
 * not a decision tap — the caller keeps its existing callback path (the
 * control handler answers unknown actions with a hint, never a crash).
 */
export function parseDecisionCallbackData(
  data: unknown,
): ParsedDecisionCallback | null {
  if (typeof data !== "string" || !data.startsWith(DECISION_CALLBACK_PREFIX)) {
    return null;
  }
  const rest = data.slice(DECISION_CALLBACK_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  const token = rest.slice(0, separator);
  const value = rest.slice(separator + 1);
  if (!DECISION_TOKEN_RE.test(token) || value.length === 0) return null;
  return { token, value };
}

/**
 * Recover the tapped button's label from the message the keyboard is attached
 * to: the button whose callback_data matches the tap. Lookup is deliberately
 * tolerant (unknown markup → undefined) so a tap still delivers with the raw
 * value when the markup is unavailable.
 */
export function findDecisionOptionLabel(
  update: TelegramUpdate,
  callbackData: string,
): string | undefined {
  const markup = (
    update.callback_query?.message as { reply_markup?: unknown } | undefined
  )?.reply_markup as { inline_keyboard?: unknown } | undefined;
  const rows = markup?.inline_keyboard;
  if (!Array.isArray(rows)) return undefined;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const button of row) {
      const candidate = button as { text?: unknown; callback_data?: unknown };
      if (
        candidate?.callback_data === callbackData &&
        typeof candidate.text === "string" &&
        candidate.text.trim()
      ) {
        return candidate.text.trim();
      }
    }
  }
  return undefined;
}

/**
 * The inbound body the agent sees: `[decision] <token> → <label> (<value>)`.
 * When the label equals the value (or is unknown) only the value is shown —
 * repeating it would read as two different choices.
 */
export function formatDecisionAnswerText(
  token: string,
  value: string,
  label?: string,
): string {
  const shown = label && label !== value ? `${label} (${value})` : value;
  return `[decision] ${token} → ${shown}`;
}

export interface DecisionCallbackDeps {
  client: Pick<
    TelegramClient,
    "answerCallbackQuery" | "editMessageReplyMarkup"
  >;
  /** Bot token (the client's auth), not the decision token. */
  token: string;
  log?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    ...rest: unknown[]
  ) => void;
}

export interface DecisionCallbackOutcome {
  /** True when the tap WAS a well-formed decision payload. */
  handled: boolean;
  /** answerCallbackQuery succeeded (the tap was acknowledged). */
  answered: boolean;
  /** Present when the tap is deliverable — hand to the inbound delivery path. */
  delivery?: IncomingOwnerMessage;
  error?: string;
}

/** What the first tap of a decision token carried. */
interface AnsweredDecision {
  value: string;
  /** The tapped button's label, when the message markup was recoverable. */
  label?: string;
  /** Epoch ms of the answering tap (insertion order for eviction). */
  at: number;
}

/**
 * Answered decision tokens, oldest first. Single-use semantics: the first tap
 * of a token answers the question for this process's lifetime; every later
 * tap is acknowledged but not delivered. Process-global by design — one
 * question asked once is answered once, across handler invocations.
 *
 * Bounded so a long-lived process cannot grow the map without limit: the most
 * recent answers are kept and the oldest evicted; an evicted token is treated
 * as unanswered (its next tap delivers).
 */
const ANSWERED_DECISIONS = new Map<string, AnsweredDecision>();

/** Answered tokens remembered before the oldest is evicted. */
const MAX_ANSWERED_DECISIONS = 64;

/** Remember the first answer to `token`, evicting the oldest over the bound. */
function rememberAnsweredDecision(
  token: string,
  value: string,
  label?: string,
): void {
  ANSWERED_DECISIONS.set(token, {
    value,
    ...(label ? { label } : {}),
    at: Date.now(),
  });
  while (ANSWERED_DECISIONS.size > MAX_ANSWERED_DECISIONS) {
    const oldest = ANSWERED_DECISIONS.keys().next().value;
    if (oldest === undefined) break;
    ANSWERED_DECISIONS.delete(oldest);
  }
}

/** Does the tapped message still carry an inline keyboard to strip? */
function hasInlineKeyboard(message: TelegramMessage): boolean {
  const markup = message.reply_markup as
    | { inline_keyboard?: unknown }
    | undefined;
  return (
    Array.isArray(markup?.inline_keyboard) && markup.inline_keyboard.length > 0
  );
}

/**
 * Best-effort keyboard strip: an empty inline_keyboard removes the buttons so
 * the owner's client cannot tap them again. Never blocks the caller — both an
 * ok:false result and a thrown/rejected edit are swallowed; the first tap's
 * failure is logged as a warn (the owner may still see the keyboard), the
 * repeat path's as debug (the question is already answered either way).
 */
async function stripDecisionKeyboard(
  deps: DecisionCallbackDeps,
  message: TelegramMessage,
  bestEffort = false,
): Promise<void> {
  let failure: string | undefined;
  try {
    const result = await deps.client.editMessageReplyMarkup(
      deps.token,
      message.chat.id,
      message.message_id,
      { replyMarkup: { inline_keyboard: [] } },
    );
    if (!result.ok) failure = result.error ?? "unknown error";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (failure === undefined) return;
  const detail = `keyboard strip failed for message ${message.message_id}: ${failure}`;
  if (bestEffort) {
    deps.log?.("debug", `telegram decision: repeat-tap ${detail}`);
    return;
  }
  deps.log?.(
    "warn",
    `telegram decision: ${detail} — delivering the first answer anyway`,
  );
}

/**
 * Acknowledge a repeat tap: name the first answer in the toast, deliver
 * nothing, and re-strip the keyboard when the tapped message still carries
 * one (the first strip can have failed or raced the tap).
 */
async function answerRepeatTap(
  deps: DecisionCallbackDeps,
  callbackQueryId: string,
  message: TelegramMessage | undefined,
  first: AnsweredDecision,
): Promise<DecisionCallbackOutcome> {
  const answer = await deps.client.answerCallbackQuery(
    deps.token,
    callbackQueryId,
    { text: `already answered: ${first.label ?? first.value}` },
  );
  if (message && hasInlineKeyboard(message)) {
    await stripDecisionKeyboard(deps, message, true);
  }
  return { handled: true, answered: answer.ok };
}

/**
 * Handle one decision-button tap: acknowledge it (toast with the label) and
 * return the message to deliver. Never throws; a non-decision payload comes
 * back `handled: false` with nothing answered, so the caller's control path
 * stays byte-for-byte in charge of pause/resume/status/unknown.
 *
 * Single-use per token: the first tap of a token is recorded BEFORE any
 * network call (two racing taps cannot both pass the record check), then
 * acknowledged and its keyboard stripped. Every later tap of the same token
 * is acknowledged with the first answer named and delivers nothing.
 *
 * Delivery is NOT done here: the caller owns it (index.ts hands the payload
 * to the same coalescing + steer handoff a text message takes).
 */
export async function handleDecisionCallbackQuery(
  deps: DecisionCallbackDeps,
  update: TelegramUpdate,
): Promise<DecisionCallbackOutcome> {
  const callbackQuery = update.callback_query;
  const parsed = parseDecisionCallbackData(callbackQuery?.data);
  if (!callbackQuery?.id || !parsed) {
    return { handled: false, answered: false };
  }

  const answered = ANSWERED_DECISIONS.get(parsed.token);
  if (answered) {
    return answerRepeatTap(
      deps,
      callbackQuery.id,
      callbackQuery.message,
      answered,
    );
  }

  const label = findDecisionOptionLabel(update, callbackQuery.data ?? "");
  const shown = label ?? parsed.value;
  // Record before the first network call: a racing duplicate of this tap sees
  // the token answered and takes the repeat path instead of a second delivery.
  rememberAnsweredDecision(parsed.token, parsed.value, label);

  const answer = await deps.client.answerCallbackQuery(
    deps.token,
    callbackQuery.id,
    { text: `✓ ${shown}` },
  );

  const message = callbackQuery.message;
  const from = callbackQuery.from;
  if (!message || typeof from?.id !== "number") {
    deps.log?.(
      "warn",
      `telegram decision: tap ${callbackQuery.id} has no usable message context — acknowledged, not delivered`,
    );
    return {
      handled: true,
      answered: answer.ok,
      error: "no message context for delivery",
    };
  }

  await stripDecisionKeyboard(deps, message);

  const delivery: IncomingOwnerMessage = {
    updateId: update.update_id,
    messageId: message.message_id,
    fromId: from.id,
    ...(from.username ? { username: from.username } : {}),
    ...(from.first_name ? { firstName: from.first_name } : {}),
    chatId: message.chat.id,
    chatType: message.chat.type ?? "private",
    text: formatDecisionAnswerText(parsed.token, parsed.value, label),
    receivedAt:
      typeof message.date === "number" ? message.date * 1000 : Date.now(),
  };
  return { handled: true, answered: answer.ok, delivery };
}
