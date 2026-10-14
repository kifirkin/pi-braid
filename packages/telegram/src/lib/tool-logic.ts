/**
 * telegram_send tool logic — pure, unit-testable without pi-core runtime.
 *
 * Responsibilities:
 *  - param validation: `text` is required and must be non-empty.
 *  - truncation contract: when text exceeds
 *    the applicable limit, the crafting model distills first (LLM rewrite);
 *    if that is unavailable/failed/still-over, the result is an ERROR to the
 *    agent (nothing sent) unless an explicit strategy:"truncate" was passed.
 *    There is NO silent hard-truncation path. `limit` (chars) sets an
 *    explicit cap; `strategy` ("truncate"|"error") is the explicit handling.
 *    Refuses empty.
 *  - delivery: text via sendMessage, or voice via sendVoiceNote when a TTS
 *    synthesis hook is supplied (when no TTS source is configured, requesting
 *    voice returns a clear error rather than silently sending text). Outbound
 *    carries NO [tg-end] marker — that marker is an INBOUND parse boundary
 *    only.
 */

import type {
  TelegramClient,
  TelegramReplyMarkup,
  TelegramSendResult,
  ParseMode,
} from "./telegram-client.js";
import {
  prepareDecisionOptions,
  type DecisionOptionRows,
} from "./decision-buttons.js";
import {
  sendMessageChunks,
  resolveDeliveryFormat,
  TELEGRAM_MAX_TEXT_LENGTH,
  type ConversionCounts,
} from "./format.js";
import { markAgentDeliveredMessage } from "./notify/agent-delivery.js";
import {
  DEFAULT_SEND_MAX_CHARS,
  resolveSendMaxChars,
} from "./telegram-settings.js";

/**
 * Over-limit strategies (truncation contract):
 * an explicit `strategy` always wins; the DEFAULT when the body exceeds the
 * applicable cap with no explicit choice is an ERROR to the agent — never a
 * silent hard truncate. The crafting-model distillation stays the automatic
 * first rescue (an LLM rewrite, not a truncate); only its FAILURE falls
 * through to the default error.
 */
export type OverLimitStrategy = "truncate" | "error";

export interface TelegramSendToolParams {
  text: string;
  voice?: boolean;
  voiceText?: string;
  /** Rich-format parse mode (HTML | Markdown). Honored on the text path. */
  parse_mode?: ParseMode;
  /** Rich mode: text may exceed the default cap — split-to-fit instead. */
  rich?: boolean;
  /**
   * Explicit char cap for the plain path (default: the settings-driven
   * `braid.telegram.sendMaxChars`, 4096 when unset). An explicit limit is a
   * user choice: text within the limit sends verbatim; over the limit the
   * `strategy` applies (default: error, never truncate).
   */
  limit?: number;
  /**
   * Explicit over-limit handling: "truncate" hard-truncates to the limit
   * (ellipsis, `truncated:true`), "error" refuses with an explanatory error.
   * When set, crafting is SKIPPED — an explicit strategy means deliver MY text
   * (sized), not a rewrite. Absent + over limit + craft failed → error.
   */
  strategy?: OverLimitStrategy;
  /**
   * Decision buttons: 1-2 rows of up to 4 `{ label, value }` buttons attached
   * to the message as an inline keyboard. A tap reaches the agent as an
   * inbound `[decision] <token> → <label> (<value>)` message. Malformed rows
   * refuse the whole send (nothing delivered).
   */
  options?: DecisionOptionRows;
  /**
   * Correlation id for the decision buttons (1-16 chars of A-Za-z0-9_-).
   * Generated when omitted; echoed back on every tap and returned in the
   * outcome. Only meaningful together with `options`.
   */
  decisionToken?: string;
}

export interface TelegramSendOutcome {
  ok: boolean;
  messageId?: number;
  error?: string;
  /**
   * true ONLY when the delivered text was hard-truncated to the applicable
   * limit via an EXPLICIT `strategy: "truncate"` choice. There is no silent
   * truncation path anymore (A1): over-limit without an explicit strategy is
   * an error result, and the crafting path is an LLM rewrite (never flagged
   * as truncation).
   */
  truncated: boolean;
  warn?: string;
  /**
   * Per-kind counts of MarkdownV2 delimiter pairs (`**bold**`, `__underline__`,
   * `~strike~`, `||spoiler||`, `` `code` ``) that were rewritten to HTML so the
   * delivered message renders them instead of showing the raw markers. Present
   * only when a conversion happened and the message shipped as HTML.
   */
  converted?: ConversionCounts;
  charCount: number;
  channel: "text" | "voice";
  /** Rich split-to-fit: number of messages sent (1 = single message). */
  chunks?: number;
  /**
   * Correlation id carried by the decision buttons (present when `options`
   * were sent): a tap returns as `[decision] <token> → <label> (<value>)`.
   */
  decisionToken?: string;
}

/** Optional TTS hook. When absent, voice delivery is refused with a clear error. */
export interface VoiceTtsHook {
  /**
   * Synthesize `text` into OGG/Opus bytes for a Telegram voice note. A throw
   * is surfaced by runTelegramSend as a failed voice outcome — never a silent
   * text fallback.
   */
  synthesize(text: string): Promise<Buffer | Uint8Array>;
}

export interface TelegramSendDeps {
  client: Pick<TelegramClient, "sendMessage" | "sendVoiceNote">;
  token: string;
  chatId: number | string;
  /** Voice path. Absent (no TTS source configured) => voice is refused. */
  tts?: VoiceTtsHook;
  /**
   * LLM-crafted content hook: on the default over-limit path (no
   * explicit strategy), the crafting model produces the actual message
   * instead of truncation. Return `null` when crafting is unavailable/not
   * applicable — the caller now ERRORS (A1: never silent-truncate) instead
   * of falling back to a hard truncate. When present, the hook is also used
   * for /telegram send. Never decorates with [tg-end].
   */
  craft?: (text: string) => Promise<{ text: string; crafted: boolean } | null>;
  /**
   * Default cap override — tests/wiring seam. Absent: the settings-driven
   * `braid.telegram.sendMaxChars` (4096 when unset), read per call so an
   * edit to ~/.pi/agent/settings.json applies without a restart.
   */
  sendMaxChars?: number;
  /**
   * Inbound-poller liveness check: consulted
   * AFTER a successful send — when it returns false the outcome gains a
   * `warn`, because a dead poller means the owner's reply is never consumed
   * and the agent waits forever. Intentional outbound-only deployments
   * (BRAID_TG_POLL_DISABLED) pass () => true. Absent => no check.
   */
  pollerRunning?: () => boolean;
  /**
   * Worker-role send: the poller is the orchestrator seat's machine-wide
   * singleton, so the dead-poller warning must NOT advise enabling it —
   * the seat owns inbound; this delivery is outbound-only.
   */
  workerRole?: boolean;
}

/**
 * Validate tool params. Refuses empty/whitespace `text`.
 */
export function validateSendParams(
  params: Partial<TelegramSendToolParams>,
): { ok: true; text: string } | { ok: false; error: string } {
  const text = typeof params?.text === "string" ? params.text.trim() : "";
  if (!text) {
    return {
      ok: false,
      error: "telegram_send: `text` is required and must be non-empty",
    };
  }
  return { ok: true, text };
}

/**
 * Concise enforcement: returns the (trimmed) message, truncating with an
 * ellipsis when it exceeds `maxLen`. `truncated` flags the shortening so the
 * agent knows delivery was shortened. Used ONLY for an explicit
 * `strategy: "truncate"` choice (A1: no silent truncation path remains).
 */
export function enforceConcise(
  text: string,
  maxLen: number = DEFAULT_SEND_MAX_CHARS,
): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return { text: trimmed, truncated: false };
  const head = trimmed.slice(0, Math.max(0, maxLen - 1)).trimEnd();
  return { text: head + "…", truncated: true };
}

/**
 * Build the over-limit error the agent receives when nothing was sent (A1
 * default path). States the limit, the body size, and the three options —
 * the agent can then pick rich:true, a shorter text, or an explicit strategy.
 */
export function overLimitError(textLen: number, limit: number): string {
  return (
    `telegram_send: text is ${textLen} chars; the limit is ${limit} — NOTHING was sent. ` +
    `Pick one: rich:true (long formatted report, split-to-fit at Telegram's 4096-cap), ` +
    `shorter text, or strategy:"truncate" (explicit hard truncation) / strategy:"error" (this error).`
  );
}

/**
 * Resolve the outbound plain text under the truncation contract.
 *
 *   body ≤ effectiveLimit            -> send verbatim (no crafting)
 *   strategy "truncate" (explicit)   -> hard-truncate to the limit (skip crafting:
 *                                        the user chose truncate, not a rewrite)
 *   strategy "error" (explicit)      -> refuse (nothing sent)
 *   no strategy (default)            -> crafting model distills (stays; an LLM
 *                                        rewrite, not a truncate). Craft
 *                                        unavailable/failed/empty OR crafted
 *                                        result still over the limit -> ERROR.
 *                                        NEVER a silent hard truncate.
 *
 * Returns either the text to deliver (truncated:false unless the explicit
 * truncate strategy ran) or an `error` — the caller sends nothing on error.
 */
async function resolveSendText(
  text: string,
  opts: {
    limit?: number;
    /** Cap when `limit` is absent (settings-driven; see TelegramSendDeps). */
    defaultLimit: number;
    strategy?: OverLimitStrategy;
    craft?: TelegramSendDeps["craft"];
  },
): Promise<{ text: string; truncated: boolean } | { error: string }> {
  const trimmed = text.trim();
  const effectiveLimit =
    typeof opts.limit === "number" &&
    Number.isFinite(opts.limit) &&
    opts.limit >= 1
      ? Math.floor(opts.limit)
      : opts.defaultLimit;

  if (trimmed.length <= effectiveLimit) {
    return { text: trimmed, truncated: false };
  }

  // Explicit strategy ALWAYS wins (and skips crafting — the user chose how
  // to handle THEIR text; a rewrite would not be their choice).
  if (opts.strategy === "truncate") {
    const enforced = enforceConcise(trimmed, effectiveLimit);
    return { text: enforced.text, truncated: true };
  }
  if (opts.strategy === "error") {
    return { error: overLimitError(trimmed.length, effectiveLimit) };
  }

  // Default path: try the crafting model (distillation stays per contract);
  // any failure — unavailable, malformed, or crafted-but-still-over — is an
  // ERROR to the agent (never a silent truncate). The error names the limit
  // and the options so the agent can pick rich / shorter / explicit strategy.
  if (opts.craft) {
    try {
      const crafted = await opts.craft(trimmed);
      if (crafted?.crafted && crafted.text?.trim()) {
        const craftedText = crafted.text.trim();
        if (craftedText.length <= effectiveLimit) {
          return { text: craftedText, truncated: false };
        }
        // Crafted but still over: fall through to the default error (the
        // distillation did not produce a deliverable message).
      }
    } catch {
      // crafting failed — fall through to the default error
    }
  }
  return { error: overLimitError(trimmed.length, effectiveLimit) };
}

/**
 * Run the send. Orchestrates validate -> cap/craft/strategy -> deliver
 * text/voice. With `rich: true` the cap/craft step is SKIPPED: the text
 * is delivered verbatim, split-to-fit across Telegram's 4096 cap, honoring
 * `parse_mode`. On the plain path, over-limit without an explicit strategy
 * is an ERROR result (nothing sent) — never a silent truncate (A1).
 */
export async function runTelegramSend(
  params: Partial<TelegramSendToolParams>,
  deps: TelegramSendDeps,
): Promise<TelegramSendOutcome> {
  const outcome = await runTelegramSendInner(params, deps);
  // Use-time inbound-liveness guard: a successful
  // send is the worst moment for the poller to be silently dead — the owner
  // answers and nothing consumes it. Only ok outcomes carry the warning; the
  // intentional outbound-only mode satisfies the check via its dep closure.
  if (outcome.ok && deps.pollerRunning && !deps.pollerRunning()) {
    const pollerWarn = deps.workerRole
      ? "inbound poller OFF — the orchestrator seat owns the Telegram poller; this message is delivered without inbound (owner replies reach the seat session)"
      : "inbound poller OFF — owner replies won't reach the agent; enable via telegram_poller action=enable";
    outcome.warn = outcome.warn ? `${outcome.warn}; ${pollerWarn}` : pollerWarn;
  }
  return outcome;
}

async function runTelegramSendInner(
  params: Partial<TelegramSendToolParams>,
  deps: TelegramSendDeps,
): Promise<TelegramSendOutcome> {
  const validated = validateSendParams(params);
  if (!validated.ok) {
    return {
      ok: false,
      error: validated.error,
      truncated: false,
      charCount: 0,
      channel: "text",
    };
  }

  // Defensive limit validation: an explicit but malformed limit is refused,
  // never silently ignored (explicit params must not fall back quietly).
  if (
    params.limit !== undefined &&
    (typeof params.limit !== "number" ||
      !Number.isFinite(params.limit) ||
      params.limit < 1)
  ) {
    return {
      ok: false,
      error: "telegram_send: `limit` must be a positive number of characters",
      truncated: false,
      charCount: validated.text.length,
      channel: "text",
    };
  }
  if (
    params.strategy !== undefined &&
    params.strategy !== "truncate" &&
    params.strategy !== "error"
  ) {
    return {
      ok: false,
      error: 'telegram_send: `strategy` must be "truncate" or "error"',
      truncated: false,
      charCount: validated.text.length,
      channel: "text",
    };
  }

  // decision buttons (explicit param; malformed rows refuse the send)
  // Prepared once here, threaded into the delivery paths below. The voice
  // path cannot carry buttons through this tool, so the combination is
  // refused rather than silently dropping the keyboard.
  let decision: { token: string; keyboard: TelegramReplyMarkup } | undefined;
  if (params.options !== undefined || params.decisionToken !== undefined) {
    if (params.voice === true) {
      return {
        ok: false,
        error:
          "telegram_send: `options` are not supported on the voice path — send a text message to attach decision buttons",
        truncated: false,
        charCount: validated.text.length,
        channel: "voice",
      };
    }
    const prepared = prepareDecisionOptions(
      params.options,
      params.decisionToken,
    );
    if (!prepared.ok) {
      return {
        ok: false,
        error: prepared.error,
        truncated: false,
        charCount: validated.text.length,
        channel: "text",
      };
    }
    decision = { token: prepared.token, keyboard: prepared.keyboard };
  }

  const wantsVoice = params.voice === true;
  const voiceText = wantsVoice
    ? typeof params.voiceText === "string" && params.voiceText.trim()
      ? params.voiceText
      : validated.text
    : undefined;

  if (wantsVoice) {
    if (!deps.tts) {
      return {
        ok: false,
        error:
          "telegram_send: voice notes requested but no TTS source is configured " +
          '(braid.telegram.tts source is "none"). Pass `voice: false` (or omit) to send text.',
        truncated: false,
        charCount: validated.text.length,
        channel: "voice",
      };
    }
    let ogg: Buffer | Uint8Array;
    try {
      ogg = await deps.tts.synthesize(voiceText ?? validated.text);
    } catch (error) {
      return {
        ok: false,
        error: `telegram_send: voice synthesis failed — ${
          error instanceof Error ? error.message : String(error)
        }`,
        truncated: false,
        charCount: validated.text.length,
        channel: "voice",
      };
    }
    const result: TelegramSendResult = await deps.client.sendVoiceNote(
      deps.token,
      deps.chatId,
      ogg,
      validated.text,
    );
    return resultToOutcome(result, {
      truncated: false,
      charCount: validated.text.length,
      channel: "voice",
    });
  }

  const parseMode =
    params.parse_mode === "HTML" || params.parse_mode === "Markdown"
      ? params.parse_mode
      : undefined;

  // rich path: no cap enforcement — split-to-fit + optional parse_mode
  if (params.rich === true) {
    const fmt = resolveDeliveryFormat(parseMode, validated.text);
    const result = await sendMessageChunks(deps.client, {
      token: deps.token,
      chatId: deps.chatId,
      text: fmt.text,
      ...(fmt.parseMode ? { parseMode: fmt.parseMode } : {}),
      // Buttons ride the LAST chunk: the end of the report is where the
      // reader answers, and an early chunk would leave a stale keyboard
      // behind it.
      ...(decision ? { replyMarkup: decision.keyboard } : {}),
    });
    if (result.ok) {
      // The agent explicitly delivered a report — live-update finish() will
      // suppress its own separate turn summary (no duplicate message).
      markAgentDeliveredMessage();
      return {
        ok: true,
        messageId: result.messageIds[0],
        truncated: false,
        charCount: validated.text.length,
        channel: "text",
        chunks: result.total,
        ...(decision ? { decisionToken: decision.token } : {}),
        ...(fmt.converted ? { converted: fmt.converted } : {}),
        ...(fmt.downgraded
          ? {
              warn: "parse_mode Markdown dropped — text has unbalanced markdown delimiters",
            }
          : {}),
      };
    }
    return {
      ok: false,
      error: `telegram_send failed: ${result.error ?? "unknown error"}`,
      truncated: false,
      charCount: validated.text.length,
      channel: "text",
      chunks: result.total,
      ...(decision ? { decisionToken: decision.token } : {}),
    };
  }

  // default (plain) path — truncation contract
  // Over-limit without an explicit strategy is an ERROR (nothing sent);
  // crafting still distills first; an explicit truncate strategy is the
  // only hard-truncation path. The default cap is long (sendMaxChars,
  // 4096 when unset): plain sends are verbatim up to Telegram's per-message
  // limit — there is no tweet-length default.
  const defaultLimit =
    typeof deps.sendMaxChars === "number" &&
    Number.isFinite(deps.sendMaxChars) &&
    deps.sendMaxChars >= 1
      ? Math.floor(deps.sendMaxChars)
      : resolveSendMaxChars();
  const resolved = await resolveSendText(validated.text, {
    limit: params.limit,
    defaultLimit,
    strategy: params.strategy,
    craft: deps.craft,
  });
  if ("error" in resolved) {
    return {
      ok: false,
      error: resolved.error,
      truncated: false,
      charCount: validated.text.length,
      channel: "text",
    };
  }
  const { text, truncated } = resolved;
  const fmt = resolveDeliveryFormat(parseMode, text);
  // A convertible body sits under the cap as authored, but its HTML rendering
  // (tags + escaped reserved characters) can cross Telegram's per-message cap
  // on marker-dense text. Split-to-fit then, mirroring the rich path: the
  // conversion must never turn a deliverable send into an API error.
  if (fmt.converted && fmt.text.length > TELEGRAM_MAX_TEXT_LENGTH) {
    const chunked = await sendMessageChunks(deps.client, {
      token: deps.token,
      chatId: deps.chatId,
      text: fmt.text,
      ...(fmt.parseMode ? { parseMode: fmt.parseMode } : {}),
      ...(decision ? { replyMarkup: decision.keyboard } : {}),
    });
    if (chunked.ok) {
      markAgentDeliveredMessage();
      const outcome: TelegramSendOutcome = {
        ok: true,
        messageId: chunked.messageIds[0],
        truncated,
        charCount: text.length,
        channel: "text",
        chunks: chunked.total,
        converted: fmt.converted,
        ...(decision ? { decisionToken: decision.token } : {}),
      };
      return outcome;
    }
    return {
      ok: false,
      error: `telegram_send failed: ${chunked.error ?? "unknown error"}`,
      truncated,
      charCount: text.length,
      channel: "text",
      chunks: chunked.total,
      ...(decision ? { decisionToken: decision.token } : {}),
    };
  }
  const result: TelegramSendResult = await deps.client.sendMessage(
    deps.token,
    deps.chatId,
    fmt.text,
    {
      ...(fmt.parseMode ? { parseMode: fmt.parseMode } : {}),
      ...(decision ? { replyMarkup: decision.keyboard } : {}),
    },
  );
  const outcome = resultToOutcome(result, {
    truncated,
    charCount: text.length,
    channel: "text",
  });
  if (fmt.converted) outcome.converted = fmt.converted;
  if (decision) outcome.decisionToken = decision.token;
  return outcome;
}

function resultToOutcome(
  result: TelegramSendResult,
  extra: { truncated: boolean; charCount: number; channel: "text" | "voice" },
): TelegramSendOutcome {
  if (result.ok) {
    // The agent explicitly delivered a report — live-update finish() will
    // suppress its own separate turn summary (no duplicate message).
    markAgentDeliveredMessage();
    return {
      ok: true,
      messageId: result.messageId,
      truncated: extra.truncated,
      warn: extra.truncated
        ? `message truncated to the explicit limit (strategy: "truncate")`
        : undefined,
      charCount: extra.charCount,
      channel: extra.channel,
    };
  }
  return {
    ok: false,
    error: `telegram_send failed: ${result.error ?? "unknown error"}`,
    truncated: extra.truncated,
    warn: extra.truncated
      ? `message truncated to the explicit limit (strategy: "truncate")`
      : undefined,
    charCount: extra.charCount,
    channel: extra.channel,
  };
}
