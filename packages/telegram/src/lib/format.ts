/**
 * Rich-format / split-to-fit helpers.
 *
 * Telegram caps a text message at 4096 chars. Rich (possibly long) responses
 * need to fit that limit or be split into several sequential messages. This
 * module is pure + unit-testable (no network): `splitLongText` breaks long
 * text on paragraph → line → word boundaries (never mid-word), and
 * `sendMessageChunks` delivers N sequential messages each with a `(i/N)`
 * continuity marker. `isBalancedMarkdown` is a pragmatic guard: Telegram's
 * `Markdown` parse_mode rejects unbalanced emphasis/links, so callers drop
 * parse_mode (fall back to plain text) when the delimiters are imbalanced.
 *
 * Dialect note: Telegram's `Markdown` parse_mode is the LEGACY dialect —
 * `*bold*`, `_italic_`, `` `code` ``, `[t](u)`. The MarkdownV2 delimiter
 * pairs (`**x**` bold, `__x__` underline, `~x~` strikethrough, `||x||`
 * spoiler) have no legacy meaning; left as-is they reach the wire literally.
 * `convertMarkdownV2ToHtml` rewrites them to their HTML equivalents
 * (`<b>`, `<u>`, `<s>`, `<tg-spoiler>`) so `resolveDeliveryFormat` can ship
 * them rendered instead of raw.
 */

import type {
  TelegramClient,
  TelegramReplyMarkup,
  TelegramSendResult,
  ParseMode,
} from "./telegram-client.js";

/** Telegram hard cap for a single text message (https://core.telegram.org/bots/api#sendmessage). */
export const TELEGRAM_MAX_TEXT_LENGTH = 4096;

/**
 * Split `text` into chunks each <= `maxLen - reserved` chars, preferring
 * paragraph boundaries (blank-line runs), then line boundaries, then word
 * boundaries, then a hard character cut. Never splits mid-word unless a single
 * word itself exceeds the limit. Empty input → []. `reserved` headroom lets
 * callers append a continuity marker without exceeding the Telegram cap.
 */
export function splitLongText(
  text: string,
  maxLen: number = TELEGRAM_MAX_TEXT_LENGTH,
  reserved: number = 0,
): string[] {
  const limit = maxLen - reserved;
  if (!(limit > 0))
    throw new Error("splitLongText: maxLen must exceed reserved");
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf) {
      chunks.push(buf);
      buf = "";
    }
  };
  for (const para of trimmed.split(/\n\s*\n/)) {
    if (para.length > limit) {
      // A single paragraph exceeds the limit — break it further on its own.
      flush();
      for (const part of hardChunk(para, limit)) chunks.push(part);
      continue;
    }
    if (buf && buf.length + 2 + para.length > limit) flush();
    buf = buf ? `${buf}\n\n${para}` : para;
  }
  flush();
  return chunks;
}

/** Break one unit (still > limit) on line → word → char boundaries. */
function hardChunk(s: string, limit: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > 0) {
    if (rest.length <= limit) {
      out.push(rest);
      break;
    }
    // Last newline within the limit keeps line sections whole.
    const nl = rest.lastIndexOf("\n", limit);
    if (nl > 0) {
      out.push(rest.slice(0, nl));
      rest = rest.slice(nl + 1);
      continue;
    }
    const sp = rest.lastIndexOf(" ", limit);
    if (sp > 0) {
      out.push(rest.slice(0, sp));
      rest = rest.slice(sp + 1);
      continue;
    }
    // One word longer than the limit — hard cut (last resort).
    out.push(rest.slice(0, limit));
    rest = rest.slice(limit);
  }
  return out.map((c) => c.trim()).filter((c) => c.length > 0);
}

/**
 * Pragmatic guard for Telegram's `Markdown` parse_mode, which rejects messages
 * with unbalanced emphasis/backtick/link delimiters. Returns false when the
 * paired-delimiter counts are odd — callers then deliver plain text instead of
 * surfacing a Telegram API error. Heuristic, not a full parser; balanced
 * counts are the common case (bold/code are even-counted anyway).
 *
 * NOTE: this predicate answers only "would Telegram accept this as Markdown?"
 * — it intentionally says `true` for a raw-HTML body (no Markdown markers to
 * be unbalanced). Mode selection for delivery MUST combine it with
 * `hasHtmlTags` (see `resolveDeliveryFormat`) so an HTML body is shipped as
 * HTML (or its tags neutralized) rather than leaking raw tags under Markdown.
 */
export function isBalancedMarkdown(text: string): boolean {
  if (!text) return true;
  const count = (ch: string): number => text.split(ch).length - 1;
  // **bold** openers/closers must pair: even count of "**" tokens. A lone
  // "**" (e.g. "**bold" missing its close) IS unbalanced in Telegram.
  const boldOpeners = text.split("**").length - 1;
  if (boldOpeners % 2 !== 0) return false;
  // After removing `**` pairs, any leftover single `*` is unbalanced (Telegram
  // also accepts *single-star* emphasis — two stars, i.e. even, is fine).
  const singleStars = text.replace(/\*\*/g, "").split("*").length - 1;
  return (
    singleStars % 2 === 0 &&
    count("_") % 2 === 0 &&
    count("`") % 2 === 0 &&
    count("[") === count("]")
  );
}

// `parse_mode` only picks the TRANSPORT format — it does not transform the
// text. A body carrying the OTHER mode's markup reaches the wire raw under the
// wrong parse_mode (`<b>` shown literally in Markdown mode, `**bold**` shown
// literally in HTML mode). These helpers neutralize the other mode's tokens so
// the intended content renders cleanly; the delivery decision point is
// `resolveDeliveryFormat`.

/** Raw HTML tag anywhere in the text (`<b>`, `</i>`, `<a href=…>`, case-insensitive). */
// Non-global so repeated `.test()` calls are stateless (a global regex carries
// `lastIndex` across calls and flips results). The global variant is used for
// `stripHtmlTags`' replace-all.
const HTML_TAG_RE = /<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?>/i;
const HTML_TAG_RE_G = /<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?>/gi;

/** True when the text contains raw HTML tags — a signal it was authored as HTML. */
export function hasHtmlTags(text: string): boolean {
  return HTML_TAG_RE.test(text);
}

/**
 * Neutralize raw HTML tags from text about to be delivered under a NON-HTML
 * (Markdown/plain) parse_mode, so no `<b>`/`</i>` etc. leaks to the wire.
 * `<br>` becomes a newline; the inner content of every other tag is kept
 * (tags are removed, never escaped — Telegram's Markdown/plain modes do not
 * decode HTML entities, so escaping would leak the raw markup anyway).
 */
export function stripHtmlTags(text: string): string {
  return text.replace(/<br\s*\/?>/gi, "\n").replace(HTML_TAG_RE_G, "");
}

/**
 * Neutralize PAIRED Telegram-Markdown markers from text about to be delivered
 * under HTML (or plain) parse_mode: `**bold**`→`bold`, `_italic_`→`italic`,
 * `` `code` ``→`code`, `[label](url)`→`label`. Only balanced pairs are
 * stripped; a lone `*`/`_`/backtick (math, globs, `snake_case` identifiers) is
 * left untouched — the function never invents structure the author did not
 * write. Telegram Markdown v1 has no heading/list syntax, so `#` and `-` are
 * literal in every mode and need no handling here.
 */
export function neutralizeMarkdownMarkers(text: string): string {
  return text
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*\n]{1,200})\*\*/g, "$1")
    .replace(/(^|[\s([{*`>])_([^_\n]{1,60}?)_(?=[\s.,;:!?)\]}<]|$)/g, "$1$2")
    .replace(/\[([^\]\n]+)\]\(([^()\s]{1,200})\)/g, "$1");
}

/** Per-marker-kind counts produced by `convertMarkdownV2ToHtml`. */
export interface ConversionCounts {
  /** `**x**` → `<b>x</b>` rewrites. */
  bold: number;
  /** `__x__` → `<u>x</u>` rewrites. */
  underline: number;
  /** `~x~` → `<s>x</s>` rewrites. */
  strike: number;
  /** `||x||` → `<tg-spoiler>x</tg-spoiler>` rewrites. */
  spoiler: number;
  /** `` `x` `` → `<code>x</code>` rewrites. */
  code: number;
}

/** Result of `convertMarkdownV2ToHtml`: the rewritten text plus its counts. */
export interface MarkdownV2Conversion {
  text: string;
  converted: ConversionCounts;
}

/** Telegram HTML tag names (Bot API HTML parse mode), with attributes. */
const TELEGRAM_HTML_TAG_RE =
  /<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|blockquote|span|tg-spoiler|tg-emoji)(?:\s[^<>]*)?>/gi;

/** HTML entity reference (named, decimal, hex) — already wire-ready text. */
const HTML_ENTITY_RE = /&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);/g;

/** Escape the three characters Telegram's HTML parser reserves. */
function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Rewrite MarkdownV2-style emphasis that Telegram's legacy `Markdown`
 * parse_mode does not understand into its HTML equivalent: `**x**` →
 * `<b>x</b>`, `__x__` → `<u>x</u>`, `~x~` → `<s>x</s>` and `||x||` →
 * `<tg-spoiler>x</tg-spoiler>`, plus paired backticks → `<code>x</code>`.
 * Left as-is those shapes reach the wire literally under legacy Markdown and
 * plain text. Balanced, single-line pairs only; code-span content stays
 * literal and no nesting is interpreted (single-pass regexes, not a parser).
 * Pairs may wrap arbitrarily long text: a length cap would leave a long
 * bolded paragraph shipping raw `**`.
 *
 * The output is safe for `parse_mode: "HTML"`: text outside Telegram tags,
 * entities and code spans has `&`, `<` and `>` escaped — a stray `<` is fatal
 * to Telegram's HTML parser, and converting a body must never turn a
 * deliverable message into an API error. The caller decides when to deliver
 * the result: see `resolveDeliveryFormat`.
 */
export function convertMarkdownV2ToHtml(text: string): MarkdownV2Conversion {
  const codeSpans: string[] = [];
  // Protect code spans first: their content must stay literal for the
  // emphasis passes below (a `**x**` example inside `code` is not bold).
  let out = text.replace(/`([^`\n]+)`/g, (_m, inner: string) => {
    codeSpans.push(inner);
    return `\uE000${codeSpans.length - 1}\uE001`;
  });
  // Protect author HTML (Telegram's own tag set) and existing entities so the
  // escaping pass below leaves them wire-ready instead of turning them into
  // literal text (a mixed body must stay fully HTML, tags live).
  const protectedParts: string[] = [];
  const protect = (m: string): string => {
    protectedParts.push(m);
    return `\uE002${protectedParts.length - 1}\uE003`;
  };
  out = out.replace(TELEGRAM_HTML_TAG_RE, protect);
  out = out.replace(HTML_ENTITY_RE, protect);
  out = escapeHtmlText(out);
  let bold = 0;
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, inner: string) => {
    bold++;
    return `<b>${inner}</b>`;
  });
  let underline = 0;
  // Boundary guards mirror `neutralizeMarkdownMarkers`: a word-adjacent
  // `__` (snake__case__name) is an identifier, not emphasis.
  out = out.replace(
    /(^|[\s([{*`>])__([^_\n]+?)__(?=[\s.,;:!?)\]}<]|$)/g,
    (_m, pre: string, inner: string) => {
      underline++;
      return `${pre}<u>${inner}</u>`;
    },
  );
  let strike = 0;
  // MarkdownV2 strikethrough is a SINGLE-tilde pair, and a `~` adjacent to
  // another `~` (GFM `~~x~~`) is no MarkdownV2 delimiter: the guards exclude
  // tilde runs, so `~~x~~` stays whole instead of being half-rewritten into
  // `~<s>x</s>~`. Whitespace at an inner edge marks prose (`cd ~ && ls ~`),
  // not formatting, and stays literal.
  out = out.replace(
    /(^|[\s([{*`>])~(?!~)([^\s~](?:[^~\n]*[^\s~])?)~(?!~)(?=[\s.,;:!?)\]}<]|$)/g,
    (_m, pre: string, inner: string) => {
      strike++;
      return `${pre}<s>${inner}</s>`;
    },
  );
  let spoiler = 0;
  // `||` is MarkdownV2's spoiler delimiter and also the logical-OR operator in
  // prose and shell; the inner-edge rule keeps `x || y || z` literal.
  out = out.replace(
    /(^|[\s([{*`>])\|\|([^\s|](?:[^|\n]*[^\s|])?)\|\|(?=[\s.,;:!?)\]}<]|$)/g,
    (_m, pre: string, inner: string) => {
      spoiler++;
      return `${pre}<tg-spoiler>${inner}</tg-spoiler>`;
    },
  );
  out = out.replace(/\uE002(\d+)\uE003/g, (_m, i: string) =>
    protectedParts[Number(i)] !== undefined ? protectedParts[Number(i)] : "",
  );
  out = out.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => {
    const inner = codeSpans[Number(i)];
    return inner !== undefined ? `<code>${escapeHtmlText(inner)}</code>` : "";
  });
  return {
    text: out,
    converted: { bold, underline, strike, spoiler, code: codeSpans.length },
  };
}

/** Result of `resolveDeliveryFormat`: which parse_mode ships + the body for it. */
export interface DeliveryFormat {
  /** parse_mode to ship (undefined = plain text). */
  parseMode: ParseMode | undefined;
  /** Body transformed (neutralized) so it renders cleanly in `parseMode`. */
  text: string;
  /** True when an explicit Markdown request falls back to plain text (unbalanced). */
  downgraded?: boolean;
  /**
   * Per-kind counts when MarkdownV2-style markers were rewritten to HTML and
   * the message ships as HTML (so the caller can report what happened).
   */
  converted?: ConversionCounts;
}

/**
 * Single decision point for "which parse_mode ships + how the body is
 * sanitized to it". The caller's explicit mode wins; with no request,
 * a body containing raw HTML tags auto-selects HTML (so `<b>` renders instead
 * of leaking); otherwise the body ships as-is plain — preserving the legacy
 * default. Cross-mode tokens are neutralized so no markup meant for the other
 * mode reaches the wire raw:
 *   - MarkdownV2 delimiter pairs present (`**x**` bold, `__x__` underline,
 *     `~x~` strikethrough, `||x||` spoiler): converted to HTML and shipped as
 *     HTML whatever was requested — under legacy Markdown or plain those
 *     shapes would show literally.
 *   - HTML requested/auto-selected: Markdown markers stripped, HTML kept live.
 *   - Markdown requested + raw HTML present: tags stripped to inner text, then
 *     the Markdown balance guard still applies (unbalanced → plain + downgraded).
 *   - Markdown requested + no HTML: balance guard only (legacy safeParseMode).
 *
 * `detectMarkdown` (the live-update crafted-summary path) opts a NO-REQUEST
 * body into active Markdown detection:
 * raw HTML → HTML (markers neutralized); balanced Markdown → Markdown;
 * anything else → plain. Without it the no-request default stays plain — the
 * two behaviors differ only on a marker-free/balanced no-request body.
 */
export function resolveDeliveryFormat(
  requested: ParseMode | undefined,
  text: string,
  detectMarkdown: boolean = false,
): DeliveryFormat {
  // MarkdownV2 delimiter pairs (`**x**` bold, `__x__` underline, `~x~`
  // strikethrough, `||x||` spoiler) are not legacy Markdown: left as-is they
  // would reach the wire literally under BOTH Markdown (legacy) and plain.
  // Rewrite them to HTML and ship HTML, whatever was requested, so the body
  // renders the way its author meant; any other legacy markers are then
  // neutralized and raw tags the author already wrote stay live, so a mixed
  // body ends up fully HTML with no raw Markdown left.
  const conv = convertMarkdownV2ToHtml(text);
  const counts = conv.converted;
  const converted =
    counts.bold + counts.underline + counts.strike + counts.spoiler > 0
      ? counts
      : undefined;
  if (converted) {
    return {
      parseMode: "HTML",
      text: neutralizeMarkdownMarkers(conv.text),
      converted,
    };
  }

  const html = hasHtmlTags(text);
  if (requested === "HTML" || (requested === undefined && html)) {
    return { parseMode: "HTML", text: neutralizeMarkdownMarkers(text) };
  }
  if (requested === "Markdown") {
    if (html) {
      const stripped = stripHtmlTags(text);
      if (isBalancedMarkdown(stripped)) {
        return { parseMode: "Markdown", text: stripped };
      }
      return { parseMode: undefined, text: stripped, downgraded: true };
    }
    if (!isBalancedMarkdown(text)) {
      return { parseMode: undefined, text, downgraded: true };
    }
    return { parseMode: "Markdown", text };
  }
  // No explicit request and no HTML. Legacy no-request default is plain;
  // when `detectMarkdown` is set, actively pick up balanced Markdown so a
  // crafted body never leaks raw markup under the wrong transport.
  if (detectMarkdown && isBalancedMarkdown(text)) {
    return { parseMode: "Markdown", text };
  }
  return { parseMode: undefined, text };
}

export interface SendChunksOptions {
  token: string;
  chatId: number | string;
  text: string;
  /** parse_mode applied to every chunk (HTML | Markdown). Optional. */
  parseMode?: ParseMode;
  /** Hard cap per chunk (default Telegram's 4096). */
  maxLen?: number;
  /**
   * Inline keyboard attached to the LAST chunk only (decision buttons). A
   * keyboard on an intermediate chunk would sit above the text that still
   * follows it, i.e. on the wrong message.
   */
  replyMarkup?: TelegramReplyMarkup;
}

export interface SendChunksResult {
  ok: boolean;
  /** Number of messages actually delivered. */
  sent: number;
  /** Number of messages planned (1 when the text fits in one message). */
  total: number;
  messageIds: number[];
  error?: string;
}

/**
 * Send a (possibly very long) text as N sequential messages with a `(i/N)`
 * continuity marker on every chunk when N > 1 (single chunk → no marker).
 * Stops on the first delivery failure. Never throws — failures surface as
 * `{ ok:false, error, sent }`.
 */
export async function sendMessageChunks(
  client: Pick<TelegramClient, "sendMessage">,
  opts: SendChunksOptions,
): Promise<SendChunksResult> {
  const maxLen = opts.maxLen ?? TELEGRAM_MAX_TEXT_LENGTH;
  const chunks = splitLongText(opts.text, maxLen);
  if (chunks.length === 0) {
    return { ok: true, sent: 0, total: 0, messageIds: [] };
  }
  if (chunks.length === 1) {
    const res = await client.sendMessage(opts.token, opts.chatId, chunks[0], {
      ...(opts.parseMode ? { parseMode: opts.parseMode } : {}),
      ...(opts.replyMarkup ? { replyMarkup: opts.replyMarkup } : {}),
    });
    if (!res.ok) {
      return { ok: false, sent: 0, total: 1, messageIds: [], error: res.error };
    }
    return {
      ok: true,
      sent: 1,
      total: 1,
      messageIds: res.messageId != null ? [res.messageId] : [],
    };
  }

  const total = chunks.length;
  const messageIds: number[] = [];
  let lastError: string | undefined;
  const sendOne = (
    body: string,
    attachMarkup: boolean,
  ): Promise<TelegramSendResult> =>
    client.sendMessage(opts.token, opts.chatId, body, {
      ...(opts.parseMode ? { parseMode: opts.parseMode } : {}),
      ...(attachMarkup && opts.replyMarkup
        ? { replyMarkup: opts.replyMarkup }
        : {}),
    });

  for (let i = 0; i < total; i++) {
    const marker = `\n\n(${i + 1}/${total})`;
    let body = chunks[i] + marker;
    if (body.length > maxLen) {
      // Trim the chunk so the marker still fits under the cap.
      body =
        chunks[i].slice(0, Math.max(0, maxLen - marker.length - 1)).trimEnd() +
        "…" +
        marker;
    }
    const res = await sendOne(body, i === total - 1);
    if (res.ok) {
      if (res.messageId != null) messageIds.push(res.messageId);
    } else {
      lastError = res.error;
      break;
    }
  }
  return {
    ok: lastError === undefined,
    sent: messageIds.length,
    total,
    messageIds,
    ...(lastError !== undefined ? { error: lastError } : {}),
  };
}
