/**
 * Payload hygiene: the request-side sanitizer's own contract.
 *
 * Two directions, both required:
 *   - what the sanitizer classifies is rewritten (an edge/WAF page fragment, an
 *     asset-sized base64 run, the edge filter's request trigger);
 *   - what it did NOT classify is untouched: every byte after a page span
 *     survives, including the evidence lines behind a page that carries no
 *     closing tag. A span that runs to end-of-input deletes the payload it was
 *     never asked to touch, which is how a judge's ground truth vanished.
 *
 * The bound is measured here, not asserted from the source: a fragment ends at
 * its own line or at the page cap, a page larger than the cap is still redacted
 * up to the cap, and the bound never becomes a bypass.
 *
 * SAFETY: markup-like inputs are assembled at runtime from innocuous fragments
 * (never a complete tag literal in this file).
 *
 * Test imports target the built dist/ (npm test builds first); no network.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { sanitizeLlmRequestText } = await import(
  join(ROOT, "dist", "lib", "ai", "payload-hygiene.js")
);
const { clearLogBuffer, getLogBuffer, setGlobalLogLevel } = await import(
  join(ROOT, "dist", "lib", "core", "logger.js")
);

// ── Fixture builders (runtime-assembled markup) ─────────────────────────────

const LT = "<";
const GT = ">";

function tag(name, attrs) {
  return LT + name + (attrs ? " " + attrs : "") + GT;
}

/** The page cap the bound uses: far above any observed page (~12KB). */
const PAGE_CAP = 65_536;

/** Page start + edge marker, no closing tag: the fragment shape a clipped result leaves. */
const FRAGMENT =
  tag("!doctype", "html") +
  tag("html", 'lang="en-US"') +
  tag("head") +
  tag("title") +
  "Just a moment..." +
  tag("/title") +
  tag("meta", 'charset="utf-8"');

/** A closed page with an edge marker: the terminated shape. */
const CLOSED_PAGE =
  FRAGMENT + tag("/head") + tag("body") + "you have been blocked" + tag("/body") + tag("/html");

const PAGE_MARKER_RE = /\[redacted edge\/WAF page fragment: (\d+) chars\]/;

function markerChars(out) {
  const m = out.match(PAGE_MARKER_RE);
  return m ? Number(m[1]) : null;
}

beforeEach(() => {
  clearLogBuffer();
  setGlobalLogLevel("debug");
});

// ── Direction 1: what it classifies is rewritten ───────────────────────────

describe("rewrites what it classified", () => {
  it("leaves clean prompt text byte-identical (no over-sanitizing)", () => {
    const clean = "Summarize the failing test output below.\nExit code 1 (assertion).";
    assert.deepEqual(sanitizeLlmRequestText(clean), { text: clean, redactions: 0 });
    assert.deepEqual(sanitizeLlmRequestText(""), { text: "", redactions: 0 });
  });

  it("leaves a benign HTML snippet without edge evidence alone", () => {
    const snippet =
      tag("html") + tag("body") + tag("p") + "hello world" + tag("/p") + tag("/body") + tag("/html");
    assert.deepEqual(sanitizeLlmRequestText(snippet), { text: snippet, redactions: 0 });
  });

  it("redacts a terminated edge page and keeps both sides", () => {
    const res = sanitizeLlmRequestText(`before\n${CLOSED_PAGE}\nafter`);
    assert.equal(res.redactions, 1);
    assert.equal(markerChars(res.text), CLOSED_PAGE.length);
    assert.ok(res.text.includes("before") && res.text.includes("after"), "neighbours kept");
    assert.equal(res.text.includes("you have been blocked"), false, "page prose gone");
  });

  it("redacts an asset-sized base64 run and keeps a sub-threshold one", () => {
    const big = "A".repeat(5000);
    const small = "A".repeat(2048);
    const bigRes = sanitizeLlmRequestText(`attachment: data:image/png;base64,${big} end`);
    assert.equal(bigRes.redactions, 1);
    assert.ok(bigRes.text.includes("[base64 redacted: 5000 chars]"));
    assert.equal(sanitizeLlmRequestText(`short: ${small}`).redactions, 0);
  });

  it("neutralizes the edge filter's request trigger in place, not deleted", () => {
    const trigger = "." + "exec" + "Sync" + "(";
    const neutral = "." + "exec" + "Sync" + " (";
    const res = sanitizeLlmRequestText("Run " + trigger + "'ls'.");
    assert.equal(res.redactions, 1);
    assert.equal(res.text, "Run " + neutral + "'ls'.");
  });
});

// ── Direction 2: what it did not classify is untouched ─────────────────────

describe("keeps what it did not classify", () => {
  it("redacts an unterminated fragment to its own line; every line after it survives", () => {
    const lines = [
      "16:00:00 bash [OK]: $ npm test: 81 passed, 0 failed",
      `16:01:00 bash [OK]: $ curl -s https://example.org/graphql: ${FRAGMENT}`,
      "16:02:00 write [OK]: src/controller.ts",
      "## CODE CHANGES: YES",
      "## GIT HISTORY (recent commits)",
      "abc1234 a commit",
    ];
    const res = sanitizeLlmRequestText(lines.join("\n"));
    assert.equal(res.redactions, 1, "the page is still redacted");
    assert.equal(markerChars(res.text), FRAGMENT.length, "the span is the fragment, not the tail");
    for (const line of [lines[0], lines[2], lines[3], lines[4], lines[5]]) {
      assert.ok(res.text.includes(line), `line after the page must survive: ${line.slice(0, 40)}`);
    }
    const warn = getLogBuffer().find(
      (l) => l.source === "payload-hygiene" && l.message.includes(`${FRAGMENT.length} chars redacted`),
    );
    assert.ok(warn, "a bounded span is logged with its byte count");
  });

  it("redacts an unterminated fragment at end-of-input to the end", () => {
    const head = "16:00:00 bash [OK]: $ curl: ";
    const res = sanitizeLlmRequestText(`${head}${FRAGMENT}`);
    assert.equal(res.redactions, 1);
    assert.equal(res.text, `${head}[redacted edge/WAF page fragment: ${FRAGMENT.length} chars]`);
    const warn = getLogBuffer().find(
      (l) => l.source === "payload-hygiene" && l.message.includes("end-of-input"),
    );
    assert.ok(warn, "reaching end-of-input is logged");
  });

  it("redacts an unterminated page larger than the cap up to the cap; the payload after it survives", () => {
    const pageHead = tag("!doctype", "html") + tag("html") + "Just a moment...";
    const payload = "## CODE CHANGES: YES\n## GIT HISTORY (recent commits)";
    const page = pageHead + "-".repeat(100_000) + "\n" + payload;
    const res = sanitizeLlmRequestText(page);
    assert.equal(res.redactions, 1);
    assert.equal(markerChars(res.text), PAGE_CAP, "the cap is the bound: redacted up to it");
    assert.ok(res.text.includes(payload), "the payload after the page survives");
    assert.ok(res.text.includes("-".repeat(1000)), "the bytes past the cap are left in place");
  });

  it("keeps a multi-line unterminated page's body after the first line (the line bound)", () => {
    // Pinned, not praised: the bound is the line, so a page whose dump continues
    // on later lines is redacted on its first line only. The tail is what the
    // bound protects; the body is the price, and this case makes any change to
    // that trade visible.
    const firstLine = tag("!doctype", "html") + tag("html") + "Just a moment...";
    const body = Array.from({ length: 5 }, (_, i) => `${tag("div")}checking ${i}${tag("/div")}`);
    const payload = "## CODE CHANGES: YES";
    const res = sanitizeLlmRequestText([firstLine, ...body, payload].join("\n"));
    assert.equal(res.redactions, 1);
    assert.equal(markerChars(res.text), firstLine.length, "the span stops at the first line");
    for (const line of body) assert.ok(res.text.includes(line), "the page body survives");
    assert.ok(res.text.includes(payload), "the payload survives");
  });

  it("leaves an unterminated page with no edge evidence and no asset alone", () => {
    const benign = tag("!doctype", "html") + tag("html") + tag("body") + "hello" + tag("/body");
    assert.deepEqual(sanitizeLlmRequestText(benign), { text: benign, redactions: 0 });
  });
});
