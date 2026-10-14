/**
 * Strict local checker for Telegram's HTML `parse_mode` subset.
 *
 * Telegram rejects a message outright when any tag is unsupported, an end tag
 * does not match the innermost open tag, an attribute is malformed, or a
 * `span`/`tg-emoji` misses its required attribute. This module mirrors that
 * parser closely enough to decide, before an API call, whether a body is
 * safe to ship with `parse_mode: "HTML"`: the MarkdownV2→HTML conversion uses
 * it to refuse a conversion whose output would not parse, and the tests and
 * the corpus runner use it as the local stand-in for the live parser. It is
 * calibrated against the live API; `test/live-html-probe.mjs` re-runs that
 * comparison on demand (opt-in, no delivery).
 *
 * Calibrated rules (the probe log lives with the report):
 *  - only Telegram's tag set, case-insensitively;
 *  - attributes: `name`, `name=value`, `name="value"` or `name='value'`;
 *    quoted values may contain `>`, `<` and whitespace, unquoted values may
 *    not contain `/` or `<`;
 *  - `span` requires class="tg-spoiler" (exactly), `tg-emoji` requires a
 *    numeric `emoji-id`;
 *  - strict LIFO nesting, case-insensitively; no self-closing tags;
 *  - a `<` that starts no valid tag is an error ("Unsupported start tag");
 *  - everything outside tags is literal text: Telegram does not validate
 *    entities, so `&`, `&unknown;` and bare `>` are accepted.
 */

/** Tag names Telegram's HTML parse_mode accepts (lowercased). */
export const TELEGRAM_HTML_TAGS: ReadonlySet<string> = new Set([
  "b",
  "strong",
  "i",
  "em",
  "u",
  "ins",
  "s",
  "strike",
  "del",
  "code",
  "pre",
  "a",
  "blockquote",
  "span",
  "tg-spoiler",
  "tg-emoji",
]);

/** One attribute of a parsed tag. */
export interface TelegramTagAttribute {
  name: string;
  value: string | undefined;
  /** True when the value was `"`- or `'`-quoted. */
  quoted: boolean;
}

/** A tag-shaped token starting at `<`. */
export interface ParsedTelegramTag {
  /** Index just past the closing `>`. */
  end: number;
  /** Lowercased tag name. */
  name: string;
  closing: boolean;
  /** Syntax problem Telegram would reject (undefined = syntactically fine). */
  error: string | undefined;
  attributes: TelegramTagAttribute[];
}

const NAME_START_RE = /[A-Za-z]/;
const NAME_CHAR_RE = /[A-Za-z0-9-]/;
const ATTR_NAME_RE = /^[A-Za-z0-9_-]+$/;
const SPACE_RE = /\s/;

/**
 * Parse the tag starting at `start` (which must be `<`). Returns null when no
 * `>` terminates a well-formed start token (Telegram: "Unclosed start tag"),
 * i.e. the `<` is plain text. A returned tag may still carry `error` for
 * shapes Telegram rejects (empty attribute name, self-closing, bad value).
 */
export function parseTelegramTagAt(
  text: string,
  start: number,
): ParsedTelegramTag | null {
  if (text[start] !== "<") return null;
  let i = start + 1;
  let closing = false;
  if (text[i] === "/") {
    closing = true;
    i++;
  }
  if (i >= text.length || !NAME_START_RE.test(text[i])) return null;
  const nameStart = i;
  while (i < text.length && NAME_CHAR_RE.test(text[i])) i++;
  const name = text.slice(nameStart, i).toLowerCase();

  const attributes: TelegramTagAttribute[] = [];
  let error: string | undefined;
  for (;;) {
    while (i < text.length && SPACE_RE.test(text[i])) i++;
    if (i >= text.length) return null; // never closed
    const ch = text[i];
    if (ch === ">") {
      i++;
      break;
    }
    if (ch === "/") {
      // `<b/>`: Telegram reads the name as `b/` and rejects it.
      if (text[i + 1] === ">") {
        error ??= `Unsupported start tag "${name}/"`;
        i += 2;
        break;
      }
      error ??= `Unsupported start tag "${name}/"`;
      i++;
      continue;
    }
    const attrStart = i;
    while (
      i < text.length &&
      !SPACE_RE.test(text[i]) &&
      text[i] !== "=" &&
      text[i] !== ">" &&
      text[i] !== "/" &&
      text[i] !== "<"
    ) {
      i++;
    }
    const attrName = text.slice(attrStart, i);
    if (attrName === "" || !ATTR_NAME_RE.test(attrName)) {
      error ??= `Empty attribute name in the tag "${name}"`;
      // Skip the offending character so the scan always progresses.
      i = Math.max(i, attrStart) + 1;
      continue;
    }
    let value: string | undefined;
    let quoted = false;
    const save = i;
    while (i < text.length && SPACE_RE.test(text[i])) i++;
    if (text[i] === "=") {
      i++;
      while (i < text.length && SPACE_RE.test(text[i])) i++;
      const quote = text[i];
      if (quote === '"' || quote === "'") {
        const valueStart = i + 1;
        let j = valueStart;
        while (j < text.length && text[j] !== quote) j++;
        if (j >= text.length) return null; // unterminated quoted value
        value = text.slice(valueStart, j);
        quoted = true;
        i = j + 1;
      } else {
        const valueStart = i;
        while (i < text.length && !SPACE_RE.test(text[i]) && text[i] !== ">") {
          i++;
        }
        value = text.slice(valueStart, i);
        // An empty unquoted value (`class=`) parses; `/` and `<` do not.
        if (value.includes("/") || value.includes("<")) {
          error ??= `Unexpected end of name token at byte offset ${start}`;
        }
      }
    } else {
      i = save;
    }
    attributes.push({ name: attrName.toLowerCase(), value, quoted });
  }

  if (!TELEGRAM_HTML_TAGS.has(name)) {
    error ??= `Unsupported start tag "${name}"`;
  }
  if (name === "span" && !closing) {
    const cls = attributes.find((a) => a.name === "class");
    if (cls?.value !== "tg-spoiler") {
      error ??= 'Tag "span" must have class "tg-spoiler"';
    }
  }
  if (name === "tg-emoji" && !closing) {
    const id = attributes.find((a) => a.name === "emoji-id");
    if (!id?.value || !/^\d{1,19}$/.test(id.value)) {
      error ??= "Invalid custom emoji identifier specified";
    }
  }
  return { end: i, name, closing, error, attributes };
}

/** Verdict of `checkTelegramHtml`. */
export type TelegramHtmlVerdict = { ok: true } | { ok: false; error: string };

/**
 * Check a body against Telegram's HTML parser rules. `ok: false` means the
 * API would reject it with "can't parse entities: …"; the error text mirrors
 * the API's wording (without byte offsets) so it reads like the wire error.
 */
export function checkTelegramHtml(text: string): TelegramHtmlVerdict {
  if (!text) return { ok: true };
  const open: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "<") {
      i++;
      continue;
    }
    const tag = parseTelegramTagAt(text, i);
    if (!tag) {
      return {
        ok: false,
        error: `Unsupported start tag "" (stray "<" or unclosed tag)`,
      };
    }
    if (tag.error) return { ok: false, error: tag.error };
    if (tag.closing) {
      const top = open[open.length - 1];
      if (top === undefined) {
        return {
          ok: false,
          error: `Unexpected end tag at byte offset ${i}: "</${tag.name}>"`,
        };
      }
      if (top !== tag.name) {
        return {
          ok: false,
          error: `Unmatched end tag: expected "</${top}>", found "</${tag.name}>"`,
        };
      }
      open.pop();
    } else {
      open.push(tag.name);
    }
    i = tag.end;
  }
  const unclosed = open[open.length - 1];
  if (unclosed !== undefined) {
    return {
      ok: false,
      error: `Can't find end tag corresponding to start tag "${unclosed}"`,
    };
  }
  return { ok: true };
}
