/**
 * Rich-format / split-to-fit helpers.
 *
 * Telegram caps a text message at 4096 chars. Rich (possibly long) responses
 * need to fit that limit or be split into several sequential messages. This
 * module is pure + unit-testable (no network): `splitLongText` breaks long
 * text on paragraph → line → word boundaries (never mid-word), `splitHtmlText`
 * does the same for HTML bodies while keeping tags whole (a chunk closes the
 * tags it opens and the next chunk reopens them), and `sendMessageChunks`
 * delivers N sequential messages each with a `(i/N)` continuity marker.
 * `isBalancedMarkdown` is a pragmatic guard: Telegram's `Markdown` parse_mode
 * rejects unbalanced emphasis/links, so callers drop parse_mode (fall back to
 * plain text) when the delimiters are imbalanced.
 *
 * Dialect note: Telegram's `Markdown` parse_mode is the LEGACY dialect —
 * `*bold*`, `_italic_`, `` `code` ``, `[t](u)`. The MarkdownV2 delimiter
 * pairs (`**x**` bold, `__x__` underline, `~x~` strikethrough, `||x||`
 * spoiler) have no legacy meaning; left as-is they reach the wire literally.
 * `convertMarkdownV2ToHtml` rewrites the clean single-line shapes to their
 * HTML equivalents (`<b>`, `<u>`, `<s>`, `<tg-spoiler>`) so
 * `resolveDeliveryFormat` can ship them rendered instead of raw.
 */

import type {
  TelegramClient,
  TelegramReplyMarkup,
  TelegramSendResult,
  ParseMode,
} from "./telegram-client.js";
import {
  TELEGRAM_HTML_TAGS,
  checkTelegramHtml,
  parseTelegramTagAt,
} from "./html-check.js";

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
// Tag recognition is quote-aware (`parseTelegramTagAt`): a `>` inside a quoted
// attribute value is part of the tag, so `<a href="a>b">` is one token and is
// removed whole rather than truncated at the first `>`.

/** True when the text contains a tag Telegram's HTML parser accepts.
 *
 * Tag-shaped is not enough: auto-selecting HTML for a body carrying `<n>` or
 * `<b/>` makes Telegram reject the whole message ("Unsupported start tag"),
 * while as a plain body the same characters reach the reader literally. Only
 * a token whose name is in Telegram's tag set and whose syntax the parser
 * accepts is a signal the body was authored as HTML.
 */
export function hasHtmlTags(text: string): boolean {
  return findTagToken(text) !== null;
}

/** First tag-shaped token Telegram would accept, or null. */
function findTagToken(text: string): { start: number; end: number } | null {
  let i = text.indexOf("<");
  while (i !== -1) {
    const tag = parseTelegramTagAt(text, i);
    if (tag && tag.error === undefined && TELEGRAM_HTML_TAGS.has(tag.name)) {
      return { start: i, end: tag.end };
    }
    i = text.indexOf("<", i + 1);
  }
  return null;
}

/**
 * Neutralize raw HTML tags from text about to be delivered under a NON-HTML
 * (Markdown/plain) parse_mode, so no `<b>`/`</i>` etc. leaks to the wire.
 * `<br>` becomes a newline; the inner content of every other tag is kept
 * (tags are removed, never escaped — Telegram's Markdown/plain modes do not
 * decode HTML entities, so escaping would leak the raw markup anyway).
 */
export function stripHtmlTags(text: string): string {
  const withBreaks = text.replace(/<br\s*\/?>/gi, "\n");
  const out: string[] = [];
  let copied = 0;
  let i = withBreaks.indexOf("<");
  while (i !== -1) {
    const tag = parseTelegramTagAt(withBreaks, i);
    if (tag) {
      out.push(withBreaks.slice(copied, i));
      copied = tag.end;
      i = withBreaks.indexOf("<", tag.end);
    } else {
      i = withBreaks.indexOf("<", i + 1);
    }
  }
  out.push(withBreaks.slice(copied));
  return out.join("");
}

/**
 * Neutralize PAIRED Telegram-Markdown markers from text about to be delivered
 * under HTML (or plain) parse_mode: `**bold**`→`bold`, `_italic_`→`italic`,
 * `` `code` ``→`code`, `[label](url)`→`label`. Only balanced pairs are
 * stripped; a lone `*`/`_`/backtick (math, globs, `snake_case` identifiers) is
 * left untouched — the function never invents structure the author did not
 * write. Telegram Markdown v1 has no heading/list syntax, so `#` and `-` are
 * literal in every mode and need no handling here.
 *
 * Code and pre spans are exempt: their content is literal on the wire, so a
 * `**x**` example inside `<code>` is content, not emphasis (this runs after
 * the conversion, whose code spans are already `<code>`-wrapped).
 */
export function neutralizeMarkdownMarkers(text: string): string {
  const spans = text.split(
    /((?:<code(?:\s[^>]*)?>[\s\S]*?<\/code>|<pre(?:\s[^>]*)?>[\s\S]*?<\/pre>))/gi,
  );
  return spans
    .map((part, i) => (i % 2 === 1 ? part : neutralizeOutsideSpans(part)))
    .join("");
}

/** The marker-stripping rules, applied to a stretch without code/pre spans. */
function neutralizeOutsideSpans(text: string): string {
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

/** HTML entity reference (named, decimal, hex) — already wire-ready text. */
const HTML_ENTITY_AT_RE = /&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);/y;

/** Escape the three characters Telegram's HTML parser reserves. */
function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Zero counts: the conversion was refused, nothing was rewritten. */
function zeroCounts(): ConversionCounts {
  return { bold: 0, underline: 0, strike: 0, spoiler: 0, code: 0 };
}

/**
 * Replace every tag-shaped token and HTML entity of `text` with a placeholder
 * produced by `protect`, so the escaping and emphasis passes leave them alone.
 * Tag-shaped means `parseTelegramTagAt` found the closing `>`: an unclosed or
 * unrecognizable `<` stays literal text and is escaped with the rest.
 */
function protectWireTokens(
  text: string,
  slot: string,
  protect: (raw: string) => string,
): string {
  const out: string[] = [];
  let copied = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "<") {
      const tag = parseTelegramTagAt(text, i);
      if (tag) {
        out.push(text.slice(copied, i), protect(text.slice(i, tag.end)));
        i = tag.end;
        copied = i;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "&") {
      HTML_ENTITY_AT_RE.lastIndex = i;
      const match = HTML_ENTITY_AT_RE.exec(text);
      if (match) {
        out.push(text.slice(copied, i), protect(match[0]));
        i += match[0].length;
        copied = i;
        continue;
      }
    }
    i++;
  }
  out.push(text.slice(copied));
  return out.join("");
}

/**
 * Pick a character absent from `text` to delimit internal placeholders. The
 * slot references are then unforgeable: a U+E000..U+E003 sequence written by
 * the author stays their characters instead of being read as a slot.
 */
function pickPlaceholderChar(text: string): string {
  const used = new Set(text);
  for (let code = 0xe000; code <= 0xf8ff; code++) {
    const ch = String.fromCharCode(code);
    if (!used.has(ch)) return ch;
  }
  return "\uE000";
}

/**
 * Rewrite MarkdownV2-style emphasis that Telegram's legacy `Markdown`
 * parse_mode does not understand into its HTML equivalent: `**x**` →
 * `<b>x</b>`, `__x__` → `<u>x</u>`, `~x~` → `<s>x</s>` and `||x||` →
 * `<tg-spoiler>x</tg-spoiler>`, plus paired backticks → `<code>x</code>`.
 * Left as-is those shapes reach the wire literally under legacy Markdown and
 * plain text.
 *
 * Only clean single-line pairs convert: delimiter runs (`~~x~~`), spaced/
 * operator forms (`cd ~ && ls ~`, `x || y || z`), word-adjacent `__`
 * (`snake__case__name`) and pairs whose inner text spans a newline or a code
 * span stay literal. Pairs may wrap arbitrarily long text: a length cap on the
 * inner text would leave a long bolded paragraph shipping raw `**`.
 *
 * The result is validated against Telegram's HTML parser before it is
 * returned. A conversion whose output would not parse — crossing delimiter
 * pairs (`__a ~b__ c~` would become `<u>a <s>b</u> c</s>`), an unbalanced or
 * attribute-broken author tag, an interleaved tag pair — is refused: the
 * original text comes back with zero counts, the caller's unconverted path
 * stays in charge and the body ships as authored. `renderedCap` refuses a
 * conversion whose result would cross a caller-imposed wire cap (the plain
 * send path passes the configured `sendMaxChars`), so converted bodies never
 * silently ship over the owner's cap.
 *
 * Inside an accepted conversion the output is safe for Telegram's HTML
 * parser: text outside tags, entities and code spans has `&`, `<` and `>`
 * escaped (a stray `<` is fatal to Telegram), authors' tags and entities stay
 * wire-ready, and code-span content is escaped inside `<code>`. The caller
 * decides when to deliver the result: see `resolveDeliveryFormat`.
 */
export function convertMarkdownV2ToHtml(
  text: string,
  opts: { renderedCap?: number } = {},
): MarkdownV2Conversion {
  const slot = pickPlaceholderChar(text);
  const codeSpans: string[] = [];
  // Protect code spans first: their content must stay literal for the
  // emphasis passes below (a `**x**` example inside `code` is not bold).
  let out = text.replace(/`([^`\n]+)`/g, (_m, inner: string) => {
    codeSpans.push(inner);
    return `${slot}c${codeSpans.length - 1}${slot}`;
  });
  // Protect author HTML (every tag-shaped token, Telegram's tag set or not)
  // and entities so the escaping pass leaves them wire-ready. A tag the
  // validation below refuses takes the whole conversion down with it.
  const protectedParts: string[] = [];
  out = protectWireTokens(out, slot, (raw: string) => {
    protectedParts.push(raw);
    return `${slot}p${protectedParts.length - 1}${slot}`;
  });
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
  // Restore in ONE pass: a restored value is never rescanned, so a protected
  // attribute value cannot be re-read as a code-slot reference, an author's
  // slot-shaped characters stay their characters, and an unknown slot is
  // returned verbatim instead of being deleted.
  const slotRe = new RegExp(`${slot}([cp])(\\d+)${slot}`, "g");
  out = out.replace(slotRe, (_m, kind: string, index: string) => {
    const i = Number(index);
    if (kind === "c") {
      const inner = codeSpans[i];
      return inner !== undefined ? `<code>${escapeHtmlText(inner)}</code>` : _m;
    }
    const part = protectedParts[i];
    return part !== undefined ? part : _m;
  });
  const counts: ConversionCounts = {
    bold,
    underline,
    strike,
    spoiler,
    code: codeSpans.length,
  };
  // Refuse instead of emitting wire text Telegram rejects: the caller's
  // unconverted path then delivers the body as authored (Markdown/plain) or
  // strips the author's tags for a Markdown request.
  if (opts.renderedCap !== undefined && out.length > opts.renderedCap) {
    return { text, converted: zeroCounts() };
  }
  if (!checkTelegramHtml(out).ok) {
    return { text, converted: zeroCounts() };
  }
  return { text: out, converted: counts };
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
 *     `~x~` strikethrough, `||x||` spoiler) in a clean single-line shape:
 *     converted to HTML and shipped as HTML whatever was requested — under
 *     legacy Markdown or plain those shapes would show literally. Runs
 *     (`~~x~~`), spaced/operator forms (`x ~ y ~ z`), word-adjacent `__` and
 *     pairs whose conversion would cross or unbalance tags stay literal, and
 *     the conversion reports zero counts (see `convertMarkdownV2ToHtml`).
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
 *
 * `renderedCap` is the wire cap the caller's mode accepts: a conversion whose
 * result would exceed it is refused (the body ships as authored) so tag
 * overhead never pushes a body past a configured `sendMaxChars`.
 */
export function resolveDeliveryFormat(
  requested: ParseMode | undefined,
  text: string,
  detectMarkdown: boolean = false,
  renderedCap?: number,
): DeliveryFormat {
  // MarkdownV2 delimiter pairs (`**x**` bold, `__x__` underline, `~x~`
  // strikethrough, `||x||` spoiler) are not legacy Markdown: left as-is they
  // would reach the wire literally under BOTH Markdown (legacy) and plain.
  // Rewrite them to HTML and ship HTML, whatever was requested, so the body
  // renders the way its author meant; any other legacy markers are then
  // neutralized and raw tags the author already wrote stay live, so a mixed
  // body ends up fully HTML with no raw Markdown left. A conversion that would
  // not parse (crossing pairs, unbalanced author tags) or that would cross the
  // caller's cap reports zero counts and is skipped.
  const conv = convertMarkdownV2ToHtml(
    text,
    renderedCap !== undefined ? { renderedCap } : {},
  );
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
 * Split HTML text so every chunk parses on its own, for `parse_mode: "HTML"`.
 * Unlike `splitLongText`, a cut never lands inside a tag or entity: the tags
 * open at a cut are closed at the end of the chunk and reopened at the start
 * of the next one, so a long `<b>…</b>` paragraph stays bold on every message
 * instead of breaking the parse with `<b>…</b` / `>` fragments. Cuts inside
 * text prefer word boundaries and fall back to a hard character cut; a single
 * token longer than the limit (a giant word or tag) is emitted whole — an atom
 * is never split, and `sendMessageChunks` refuses an over-cap HTML chunk
 * instead of trimming inside it.
 */
export function splitHtmlText(
  text: string,
  maxLen: number = TELEGRAM_MAX_TEXT_LENGTH,
  reserved: number = 0,
): string[] {
  const limit = maxLen - reserved;
  if (!(limit > 0))
    throw new Error("splitHtmlText: maxLen must exceed reserved");
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  const open: string[] = [];
  let buf = "";

  const closersLen = (stack: string[]): number =>
    stack.reduce((n, name) => n + name.length + 3, 0); // "</" + name + ">"
  const closerTags = (stack: string[]): string =>
    stack
      .slice()
      .reverse()
      .map((name) => `</${name}>`)
      .join("");
  const reopenTags = (stack: string[]): string =>
    stack.map((name) => `<${name}>`).join("");
  const hasContent = (): boolean => buf.length > reopenTags(open).length;
  const flush = (): void => {
    chunks.push(buf + closerTags(open));
    buf = reopenTags(open);
  };

  let i = 0;
  while (i < trimmed.length) {
    if (trimmed[i] === "<") {
      const tag = parseTelegramTagAt(trimmed, i);
      if (tag) {
        const raw = trimmed.slice(i, tag.end);
        const nextStack = tag.closing ? open.slice(0, -1) : [...open, tag.name];
        if (
          buf.length + raw.length + closersLen(nextStack) > limit &&
          hasContent()
        ) {
          flush();
        }
        buf += raw;
        if (tag.closing) open.pop();
        else open.push(tag.name);
        i = tag.end;
        continue;
      }
    }
    // Text/entity run up to the next "<".
    const nextLt = trimmed.indexOf("<", i);
    const runEnd = nextLt === -1 ? trimmed.length : nextLt;
    let rest = trimmed.slice(i, runEnd);
    i = runEnd;
    while (rest.length > 0) {
      const room = limit - buf.length - closersLen(open);
      if (room <= 0) {
        if (!hasContent()) {
          // The open-tag overhead alone eats the limit (pathological): emit
          // the rest whole rather than loop.
          buf += rest;
          break;
        }
        flush();
        continue;
      }
      if (rest.length <= room) {
        buf += rest;
        break;
      }
      // Prefer a word boundary, then back off an entity that would be cut.
      let cut = room;
      const space = rest.lastIndexOf(" ", room - 1);
      if (space > 0) cut = space;
      const guarded = backOffEntity(rest, cut);
      if (guarded <= 0) {
        if (hasContent()) {
          flush();
          continue;
        }
        buf += rest;
        break;
      }
      cut = guarded;
      buf += rest.slice(0, cut).trimEnd();
      rest = rest.slice(cut).replace(/^\s+/, "");
      flush();
    }
  }
  chunks.push(buf + closerTags(open));
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

/** HTML entity (named, decimal, hex) at the start of `text`. */
const HTML_ENTITY_AT_START_RE =
  /&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);/y;

/** If the cut falls inside an entity, return the entity's start index. */
function backOffEntity(text: string, cut: number): number {
  const amp = text.lastIndexOf("&", cut);
  if (amp === -1 || amp >= cut) return cut;
  HTML_ENTITY_AT_START_RE.lastIndex = amp;
  const match = HTML_ENTITY_AT_START_RE.exec(text);
  if (match && amp + match[0].length > cut) return amp;
  return cut;
}

/**
 * Pick the splitter for a wire body: HTML bodies go through `splitHtmlText`
 * (tag-aware, with the `(i/N)` marker's length reserved), everything else
 * keeps `splitLongText`'s paragraph→line→word boundaries. The marker length
 * depends on the chunk count, so the reserved headroom is iterated to a fixed
 * point (at most a couple of rounds; counts stay in the low single digits).
 */
function splitForWire(
  text: string,
  maxLen: number,
  parseMode: ParseMode | undefined,
): string[] {
  if (parseMode !== "HTML") return splitLongText(text, maxLen);
  const trimmed = text.trim();
  if (!trimmed) return [];
  let reserved = "\n\n(1/9)".length;
  let chunks = splitHtmlText(trimmed, maxLen, reserved);
  for (let guard = 0; guard < 4; guard++) {
    const needed = `\n\n(1/${Math.max(chunks.length, 2)})`.length;
    if (needed <= reserved) break;
    reserved = needed;
    chunks = splitHtmlText(trimmed, maxLen, reserved);
  }
  return chunks;
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
  const chunks = splitForWire(opts.text, maxLen, opts.parseMode);
  if (chunks.length === 0) {
    return { ok: true, sent: 0, total: 0, messageIds: [] };
  }
  // A single token longer than the cap (a giant tag) is emitted whole by the
  // splitter; the safety-net trim below would cut it mid-attribute and ship a
  // body Telegram rejects. Refuse the body before anything is sent instead.
  if (opts.parseMode === "HTML") {
    const over = chunks.findIndex(
      (chunk, index) =>
        chunk.length +
          (chunks.length > 1
            ? `\n\n(${index + 1}/${chunks.length})`.length
            : 0) >
        maxLen,
    );
    if (over !== -1) {
      return {
        ok: false,
        sent: 0,
        total: chunks.length,
        messageIds: [],
        error:
          `HTML chunk ${over + 1}/${chunks.length} is ${chunks[over].length} chars; the cap is ${maxLen} ` +
          `and a tag longer than the cap cannot be split without breaking it. ` +
          `NOTHING was sent — shorten the tag or the body.`,
      };
    }
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
      // Safety net for the legacy boundary splitter. HTML bodies never reach
      // it: `sendMessageChunks` refused an over-cap HTML chunk above, and
      // `splitHtmlText` reserves the marker, so a trim here would only cut a
      // closing tag.
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
