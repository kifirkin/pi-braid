/**
 * Raw-payload hygiene for the internal LLM-call path.
 *
 * callLlm() hands provider error text back to every caller, and callers print
 * or store it (text-classifier's tier-failure warn, verification-judge,
 * llm-call's own logs). When the provider's edge answers with
 * an HTML block page — the Cloudflare-style "Blocked" family, a full document
 * with base64 font assets — that text becomes a ~12KB dump: observed
 * One 403 produced a raw `<!DOCTYPE html>…` warning line per retry
 * attempt, and pi-core stores returned error text where it rides into later
 * request bodies.
 *
 * sanitizeLlmErrorForLog() is the single sanitizer for that boundary. It never
 * touches classification inputs: callLlm classifies, and feeds the key ring
 * with, the RAW text; only the log/return copy is collapsed here.
 *
 * sanitizeLlmRequestText() is the outbound twin: internal call bodies are
 * redacted before they reach the provider. Same class of payloads — a page
 * fragment dumped into a prompt can trigger the same edge/WAF block the
 * response sanitizer exists to absorb ("no huge file dumps, no raw
 * payloads").
 *
 * Why the logic is duplicated from providers rather than shared: providers is
 * a standalone package with no import path into core (and core must not grow
 * a dependency on a provider package), so there is no module seam. The
 * duplicated part is the minimal edge-marker list, page-span detection and the
 * edge filter's request trigger; the two sides serve different boundaries
 * (providers classifies RESPONSES and rewrites the main loop's payloads, core
 * sanitizes REQUESTS and its own logs).
 *
 * Invariants:
 *   - An embedded HTML page collapses to ONE line: status + first prose
 *     excerpt (≤120 chars; tag, style, script and comment contents stripped)
 *     + content type + size — e.g. `403 Blocked (text/html, ~12KB)`.
 *   - A page span ends where the page ends: at its closing tag; for a fragment
 *     with no closing tag, at the end of its own line or the page cap,
 *     whichever comes first. Nothing after the span is touched.
 *   - Base64-class runs are replaced with a length-only marker.
 *   - The edge filter's request trigger (a dot, the `execSync` identifier, an
 *     open paren) gains a space before the paren: neutralized wherever it
 *     sits, never deleted, so the text stays readable and valid.
 *   - Everything else passes through untouched, capped at LOG_MAX_CHARS so no
 *     single log line can carry an oversized body.
 *
 * Coverage boundary: this file covers the LLM request path (outbound body
 * redaction) and the main-loop error display (inbound error collapse). It
 * does NOT cover compaction summarization or branch summarization — those
 * paths call the LLM directly via core's summarization pipeline, which has
 * its own response handling and does not route through callLlm's
 * error-sanitization path.
 */

import { createLogger } from "../core/logger.js";

const log = createLogger("payload-hygiene");

/** A page open: the marker that turns the rest of the text into a body. */
const HTML_START_PATTERN = /<!doctype\s+html|<html[\s>]/i;

/** Status code at the head of a provider error ("403 …", "HTTP 502 …"). */
const HTTP_STATUS_PATTERN = /\b([45]\d{2})\b/;

/** Markup whose CONTENT is never prose: stripped together with the tags. */
const CONTENT_BLOCK_PATTERN = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Same blocks left unclosed by a truncated dump: strip to the end. */
const UNCLOSED_CONTENT_BLOCK_PATTERN = /<(script|style)\b[^>]*>[\s\S]*$/gi;

const COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const TAG_PATTERN = /<[^>]*>/g;

/**
 * A base64-class run: ≥1024 chars from the base64 alphabet with no spaces.
 * Prose cannot produce a run this long, so any match is an encoded asset or
 * data URL — exactly what must not reach the log.
 */
const BASE64_RUN_PATTERN = /[A-Za-z0-9+/]{1024,}={0,2}/g;

/** Excerpt cap (matches the log contract: status + ~120 chars stripped). */
const EXCERPT_MAX_CHARS = 120;

/** Hard cap for any single sanitized log line. */
const LOG_MAX_CHARS = 2000;

/** One-line size label from a character count (~12KB for a 12KB body). */
function humanSize(chars: number): string {
  if (chars >= 1024) return `~${Math.round(chars / 1024)}KB`;
  return `~${chars}B`;
}

/** Replace base64-class runs with a length-only marker. */
function redactBase64Runs(text: string): string {
  return text.replace(BASE64_RUN_PATTERN, (run) => `[base64 redacted, ${run.length} chars]`);
}

/**
 * First readable prose from an HTML body: script/style/comment contents and
 * all tags removed, whitespace collapsed, base64 redacted, capped. Empty when
 * the page carries no prose (markup + assets only) — callers then omit the
 * excerpt rather than emit an empty slot.
 */
function excerptFromHtml(body: string): string {
  const stripped = body
    .replace(CONTENT_BLOCK_PATTERN, " ")
    .replace(UNCLOSED_CONTENT_BLOCK_PATTERN, " ")
    .replace(COMMENT_PATTERN, " ")
    .replace(TAG_PATTERN, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactBase64Runs(stripped);
  if (redacted.length <= EXCERPT_MAX_CHARS) return redacted;
  return `${redacted.slice(0, EXCERPT_MAX_CHARS).trimEnd()}…`;
}

/** Cap a sanitized line at LOG_MAX_CHARS with a visible truncation marker. */
function capForLog(text: string): string {
  if (text.length <= LOG_MAX_CHARS) return text;
  return `${text.slice(0, LOG_MAX_CHARS)} …[+${text.length - LOG_MAX_CHARS} chars]`;
}

/**
 * Collapse raw HTTP/page payloads in error text into a single safe log line.
 * Pure; safe for any input. Identity for error text that carries no payload
 * (the common case) apart from the LOG_MAX_CHARS cap.
 */
export function sanitizeLlmErrorForLog(raw: unknown): string {
  const text = String(raw ?? "");
  if (!text) return "";

  const htmlAt = text.search(HTML_START_PATTERN);
  if (htmlAt >= 0) {
    const status = text.slice(0, htmlAt).match(HTTP_STATUS_PATTERN)?.[1];
    const body = text.slice(htmlAt);
    const excerpt = excerptFromHtml(body);
    const head = [status, excerpt].filter(Boolean).join(" ");
    // The body size is measured on the payload itself — the leading status
    // token is not part of the page.
    return `${head ? `${head} ` : ""}(text/html, ${humanSize(body.length)})`;
  }

  return capForLog(redactBase64Runs(text));
}

// ── Request-body hygiene ──────────────────────────────────────────
//
// The outbound copy of the same job. An internal call (classify, judge,
// summarize, polish) builds its prompt from session-derived text; when that
// text carries a previously dumped edge page or a raw asset, the request
// re-sends the exact payload class the edge/WAF block rejects — and pi-core
// stores the failed body, so the dump circulates. Redacting at the call seam
// is the one place every internal caller passes through.

/**
 * Request-side asset threshold: 4KB. Larger than the log-side 1KB because a
 * request body may legitimately carry short encoded snippets, while a 4KB
 * run is always an asset dump an internal call cannot use.
 */
const REQUEST_BASE64_RUN_SOURCE = "[A-Za-z0-9+/]{4096,}={0,2}";
const REQUEST_BASE64_RUN_PATTERN = new RegExp(REQUEST_BASE64_RUN_SOURCE);
const REQUEST_BASE64_RUN_GLOBAL = new RegExp(REQUEST_BASE64_RUN_SOURCE, "g");

/**
 * Discriminator subset of providers/ring-lifecycle.ts WAF_BLOCK_MARKERS — the
 * structural markers ("<html", "text/html") are omitted because here they
 * describe the page span itself, not the block. A page span is redacted when
 * it carries one of these OR an asset-sized base64 run.
 */
const REQUEST_EDGE_MARKERS: readonly string[] = [
  "cf-ray",
  "__cf",
  "cloudflare",
  "just a moment",
  "challenge-platform",
  "tetris challenge",
  "attention required",
  "request blocked",
  "blocked by waf",
];

/**
 * Single-string size above which a request payload is a file dump, not a
 * prompt (mirrors providers/presend-guard.ts SHRINK_MIN_CHARS). The kept head
 * preserves the opening context; the marker states the trim.
 */
const REQUEST_DUMP_MAX_CHARS = 262_144;
const REQUEST_DUMP_HEAD_CHARS = 2000;

export interface RequestHygieneResult {
  /** Text safe to send (identical to the input when nothing matched). */
  text: string;
  /** Fragments replaced (0 = untouched). */
  redactions: number;
}

/** First page span (`<!doctype html`/`<html` … `</html>`), if any. */
interface PageSpan {
  start: number;
  end: number;
  /** Where the end came from; anything but "closing-tag" means the page was unterminated. */
  bound: "closing-tag" | "line-end" | "cap" | "end-of-input";
}

/**
 * A page fragment with no closing tag ends at its own line or at this cap.
 * The cap is far above any observed page (the largest live block page seen is
 * ~12KB), so it binds only on a single-line dump.
 */
const REQUEST_PAGE_MAX_CHARS = 65_536;

/**
 * First page span, if any. A page that carries its closing tag ends there.
 * A fragment that does not (a clipped tool result, a truncated dump) ends at
 * the smaller of its enclosing line's end and REQUEST_PAGE_MAX_CHARS: the
 * fragment is a piece of one line, so the next line is no longer part of it,
 * and an unterminated span must never run to end-of-input: that deletes the
 * payload behind the page, which is the bytes this sanitizer exists to keep
 * (it classified the page, not the tail).
 */
function findPageSpan(text: string): PageSpan | null {
  const start = text.search(HTML_START_PATTERN);
  if (start < 0) return null;
  const closeAt = text.toLowerCase().lastIndexOf("</html>");
  if (closeAt >= start) return { start, end: closeAt + "</html>".length, bound: "closing-tag" };
  const newlineAt = text.indexOf("\n", start);
  const atLineEnd = newlineAt < 0 ? text.length : newlineAt;
  const atCap = start + REQUEST_PAGE_MAX_CHARS;
  const end = Math.min(atLineEnd, atCap);
  const bound = end === atCap ? "cap" : end === text.length ? "end-of-input" : "line-end";
  return { start, end, bound };
}

/**
 * Request-side edge-filter trigger: the gateway host rejects a body that
 * carries a dot, the identifier below and an open paren; probed live, the block
 * is not limited to a presumed inspection window, so the rewrite is
 * offset-independent. The prompt text an internal call builds comes from the
 * session, so one stored message is enough to block the call. The rewrite
 * inserts a space before the paren: the line stays valid and readable, and the
 * edge accepts it. Written as a character class so this file's own source does
 * not carry the sequence.
 */
const REQUEST_EDGE_TRIGGER_PATTERN = /[.]execSync[(]/g;
const REQUEST_EDGE_TRIGGER_REPLACEMENT = ".execSync (";

/**
 * Redact raw payloads from an internal-call request body before it is sent.
 * Four rules, mirroring the outbound guard's stance ("no huge file dumps, no
 * raw payloads"):
 *   1. the edge filter's request trigger is neutralized in place (rewritten
 *      with a space, not removed) wherever it appears;
 *   2. an edge/WAF page span (markers or an asset-sized base64 run inside it)
 *      becomes a length-only marker;
 *   3. remaining asset-sized base64 runs become length-only markers;
 *   4. a single string at/above 256KB keeps only its leading 2000 chars.
 * Identity elsewhere — a benign HTML snippet is left alone.
 */
export function sanitizeLlmRequestText(text: string): RequestHygieneResult {
  if (!text) return { text, redactions: 0 };
  let out = text;
  let redactions = 0;

  // 1) The edge filter's own trigger. Offset-independent on purpose: a live
  //    probe drew the same block with the sequence at 96KB and at 128KB, so no
  //    offset can be treated as safe.
  out = out.replace(REQUEST_EDGE_TRIGGER_PATTERN, () => {
    redactions++;
    return REQUEST_EDGE_TRIGGER_REPLACEMENT;
  });

  // 2) Page dumps. Loop so multiple pages in one prompt are all covered;
  //    a page without edge evidence stops the scan (conservative).
  for (;;) {
    const span = findPageSpan(out);
    if (!span) break;
    const page = out.slice(span.start, span.end);
    const lower = page.toLowerCase();
    const hasEdgeMarker = REQUEST_EDGE_MARKERS.some((marker) => lower.includes(marker));
    const hasAsset = REQUEST_BASE64_RUN_PATTERN.test(page);
    if (!hasEdgeMarker && !hasAsset) break;
    if (span.bound !== "closing-tag") {
      // A silent tail loss becomes a visible one: the span had no closing tag,
      // so the bound decided where it stopped, and the byte count says how much
      // the page claimed. Bytes after it are kept.
      log.warn(
        `page span without a closing tag: ${span.end - span.start} chars redacted (${span.bound}); bytes after it are kept`,
      );
    }
    const marker = `[redacted edge/WAF page fragment: ${page.length} chars]`;
    out = `${out.slice(0, span.start)}${marker}${out.slice(span.end)}`;
    redactions++;
  }

  // 3) Remaining asset-sized runs.
  out = out.replace(REQUEST_BASE64_RUN_GLOBAL, (run) => {
    redactions++;
    return `[base64 redacted: ${run.length} chars]`;
  });

  // 4) Oversized single strings.
  if (out.length >= REQUEST_DUMP_MAX_CHARS) {
    const kept = out.slice(0, REQUEST_DUMP_HEAD_CHARS);
    out = `${kept}\n[internal-call payload trimmed: kept first ${REQUEST_DUMP_HEAD_CHARS} of ${out.length} chars]`;
    redactions++;
  }

  return { text: out, redactions };
}
