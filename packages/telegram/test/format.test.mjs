/**
 * format.test.mjs — rich-format / split-to-fit helpers (item 31):
 * splitLongText (paragraph→line→word boundaries), isBalancedMarkdown (guard
 * against Telegram's strict Markdown parse_mode), and sendMessageChunks
 * (sequential N messages with (i/N) continuity markers). NO network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TELEGRAM_MAX_TEXT_LENGTH,
  splitLongText,
  isBalancedMarkdown,
  sendMessageChunks,
  hasHtmlTags,
  stripHtmlTags,
  neutralizeMarkdownMarkers,
  resolveDeliveryFormat,
} from "../dist/lib/format.js";

import { BOT_TOKEN, OWNER_CHAT_ID } from "./fixtures.mjs";

// ── splitLongText ───────────────────────────────────────────────────────────

test("splitLongText: returns the trimmed text whole when it fits the limit", () => {
  assert.deepEqual(splitLongText("short"), ["short"]);
  assert.deepEqual(splitLongText("  padded  "), ["padded"]);
  const atCap = "a".repeat(TELEGRAM_MAX_TEXT_LENGTH);
  assert.deepEqual(splitLongText(atCap), [atCap]);
});

test("splitLongText: empty/whitespace input returns []", () => {
  assert.deepEqual(splitLongText(""), []);
  assert.deepEqual(splitLongText("   \n   \n  "), []);
});

test("splitLongText: splits on paragraph boundaries first (short maxLen)", () => {
  const p = (ch) => ch.repeat(50);
  const text = `${p("a")}\n\n${p("b")}\n\n${p("c")}`;
  const chunks = splitLongText(text, 100);
  assert.deepEqual(chunks, [p("a"), p("b"), p("c")]);
  assert.ok(chunks.every((c) => c.length <= 100));
});

test("splitLongText: never splits mid-word when a boundary fits", () => {
  // "aaaa bbbb cccc" (15 > 10): the splitter cuts at a space boundary — the
  // first cut lands after "aaaa bbbb" (fits), keeping every word whole.
  const chunks = splitLongText("aaaa bbbb cccc", 10);
  assert.deepEqual(chunks, ["aaaa bbbb", "cccc"]);
  assert.ok(chunks.every((c) => c.length <= 10));
  assert.equal(
    chunks.every((c) => !c.startsWith(" ") && !c.endsWith(" ")),
    true,
    "no chunk trims a word in half",
  );
});

test("splitLongText: hard-cuts a single word longer than the limit (last resort)", () => {
  const word = "x".repeat(25);
  const chunks = splitLongText(word, 10);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 10, `chunk within limit: ${c.length}`);
  }
  assert.equal(chunks.join(""), "x".repeat(25), "no characters lost");
});

test("splitLongText: reserved headroom keeps every chunk under maxLen - reserved", () => {
  const text = Array.from(
    { length: 300 },
    (_, i) => `paragraph ${i} ` + "z".repeat(40),
  ).join("\n\n");
  for (const c of splitLongText(text, 100, 12)) {
    assert.ok(
      c.length <= 100 - 12,
      `chunk ${c.length} respects reserved headroom`,
    );
  }
});

test("splitLongText: joins back to the original content (whitespace-trimmed, nothing dropped)", () => {
  const paras = Array.from(
    { length: 60 },
    (_, i) => `para ${i} ` + "q".repeat(120),
  ).join("\n\n");
  const chunks = splitLongText(paras, 400);
  assert.ok(chunks.length > 1);
  // Paragraphs survive intact at their boundaries.
  for (const c of chunks) assert.ok(c.length <= 400);
});

// ── isBalancedMarkdown ──────────────────────────────────────────────────────

test("isBalancedMarkdown: balanced emphasis/links pass", () => {
  assert.equal(
    isBalancedMarkdown("**bold**, _italic_, `code` and [link](https://x)"),
    true,
  );
  assert.equal(isBalancedMarkdown("plain update 50% complete"), true);
  assert.equal(isBalancedMarkdown(""), true);
});

test("isBalancedMarkdown: odd/unpaired delimiters fail (Telegram would reject them)", () => {
  assert.equal(isBalancedMarkdown("**bold"), false); // unclosed bold
  assert.equal(isBalancedMarkdown("_italic"), false); // unclosed italic
  assert.equal(isBalancedMarkdown("`code"), false); // unclosed backtick
  assert.equal(isBalancedMarkdown("a [b c"), false); // unpaired bracket
});

// ── sendMessageChunks ───────────────────────────────────────────────────────

function stubClient({ failAt } = {}) {
  const calls = [];
  let seq = 100;
  return {
    calls,
    client: {
      sendMessage: async (token, chatId, text, options = {}) => {
        calls.push({ token, chatId, text, options });
        if (failAt != null && calls.length >= failAt)
          return { ok: false, error: "injected failure" };
        return { ok: true, messageId: ++seq };
      },
    },
  };
}

function longText(paragraphs = 200) {
  return Array.from(
    { length: paragraphs },
    (_, i) => `section ${i} ` + "x".repeat(60),
  ).join("\n\n");
}

test("sendMessageChunks: single chunk → one send, no marker", async () => {
  const { client, calls } = stubClient();
  const res = await sendMessageChunks(client, {
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    text: "short",
  });
  assert.equal(res.ok, true);
  assert.equal(res.total, 1);
  assert.equal(res.sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "short");
  assert.ok(!calls[0].text.includes("(1/1)"), "no marker for a single message");
});

test("sendMessageChunks: N chunks carry (i/N) markers, stay under the cap, sequential", async () => {
  const { client, calls } = stubClient();
  const res = await sendMessageChunks(client, {
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    text: longText(),
  });
  assert.equal(res.ok, true);
  assert.equal(res.total, res.sent);
  assert.ok(res.total > 1);
  assert.equal(calls.length, res.total, "one send per chunk");
  calls.forEach((c, i) => {
    assert.ok(
      c.text.length <= TELEGRAM_MAX_TEXT_LENGTH,
      `chunk ${i} within cap`,
    );
    assert.ok(
      c.text.endsWith(`(${i + 1}/${res.total})`),
      `chunk ${i + 1} of ${res.total} marker`,
    );
  });
});

test("sendMessageChunks: stops on first failure and reports the sent count", async () => {
  const { client, calls } = stubClient({ failAt: 2 });
  const res = await sendMessageChunks(client, {
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    text: longText(),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /injected failure/);
  assert.equal(res.total > 2, true);
  assert.equal(res.sent, 1, "first chunk delivered, second failed");
  assert.equal(calls.length, 2);
});

test("sendMessageChunks: empty text → no sends, ok resolved true", async () => {
  const { client, calls } = stubClient();
  const res = await sendMessageChunks(client, {
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    text: "   ",
  });
  assert.equal(res.ok, true);
  assert.equal(res.sent, 0);
  assert.equal(res.total, 0);
  assert.equal(calls.length, 0);
});

test("sendMessageChunks: passes parse_mode through to the delivered messages", async () => {
  const { client, calls } = stubClient();
  const res = await sendMessageChunks(client, {
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    text: "**bold** summary",
    parseMode: "Markdown",
  });
  assert.equal(res.ok, true);
  assert.equal(calls[0].options.parseMode, "Markdown");

  const { client: c2, calls: calls2 } = stubClient();
  await sendMessageChunks(c2, {
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    text: longText(),
    parseMode: "HTML",
  });
  assert.ok(
    calls2.every((c) => c.options.parseMode === "HTML"),
    "marker applied to every split chunk",
  );
});

// ── cross-mode sanitization (Task C) ────────────────────────────────────────

test("hasHtmlTags: detects raw HTML tags, ignores comparisons and markdown", () => {
  assert.equal(hasHtmlTags("<b>bold</b>"), true);
  assert.equal(hasHtmlTags('<a href="https://x">link</a>'), true);
  assert.equal(hasHtmlTags("closing </i> tag"), true);
  assert.equal(hasHtmlTags("plain 50% complete"), false);
  assert.equal(
    hasHtmlTags("5 < 6 and 6 > 5"),
    false,
    "angeled comparison is not a tag",
  );
  assert.equal(hasHtmlTags("**bold** _italic_ `code`"), false);
});

test("stripHtmlTags: removes raw tags, keeps inner content, <br> becomes newline", () => {
  assert.equal(stripHtmlTags("<b>bold</b>"), "bold");
  assert.equal(stripHtmlTags('<a href="https://x">link</a>'), "link");
  assert.equal(stripHtmlTags("line<br>break"), "line\nbreak");
  assert.equal(stripHtmlTags("plain text"), "plain text");
});

test("neutralizeMarkdownMarkers: strips paired markers to inner text", () => {
  assert.equal(neutralizeMarkdownMarkers("**bold** text"), "bold text");
  assert.equal(neutralizeMarkdownMarkers("_italic_ text"), "italic text");
  assert.equal(neutralizeMarkdownMarkers("`code` here"), "code here");
  assert.equal(neutralizeMarkdownMarkers("[label](https://x)"), "label");
  assert.equal(
    neutralizeMarkdownMarkers("**a** and _b_ and `c` and [d](https://y)"),
    "a and b and c and d",
  );
});

test("neutralizeMarkdownMarkers: leaves unambiguous literals untouched (conservative)", () => {
  assert.equal(
    neutralizeMarkdownMarkers("snake_case_name"),
    "snake_case_name",
    "identifiers are not italic",
  );
  assert.equal(
    neutralizeMarkdownMarkers("50% * of the way"),
    "50% * of the way",
    "lone star not stripped",
  );
  assert.equal(
    neutralizeMarkdownMarkers("a ** b"),
    "a ** b",
    "unbalanced bold pair left",
  );
  assert.equal(neutralizeMarkdownMarkers("plain text"), "plain text");
});

test("resolveDeliveryFormat: HTML request keeps HTML tags live, neutralizes Markdown", () => {
  const r = resolveDeliveryFormat("HTML", "<b>hi</b>");
  assert.equal(r.parseMode, "HTML");
  assert.equal(r.text, "<b>hi</b>");
  const r2 = resolveDeliveryFormat("HTML", "**bold** <i>also</i>");
  assert.equal(r2.parseMode, "HTML");
  assert.equal(r2.text, "bold <i>also</i>", "no raw ** reaches an HTML wire");
});

test("resolveDeliveryFormat: Markdown request keeps Markdown, strips raw HTML tags", () => {
  const r = resolveDeliveryFormat("Markdown", "**bold**");
  assert.equal(r.parseMode, "Markdown");
  assert.equal(r.text, "**bold**");
  const r2 = resolveDeliveryFormat("Markdown", "<b>bold</b>");
  assert.equal(r2.parseMode, "Markdown");
  assert.equal(r2.text, "bold", "raw HTML tag must not leak under Markdown");
  const r3 = resolveDeliveryFormat("Markdown", "<b>x</b> **y**");
  assert.equal(r3.parseMode, "Markdown");
  assert.equal(r3.text, "x **y**");
});

test("resolveDeliveryFormat: no request + raw HTML → auto HTML (old bug: leaked as Markdown)", () => {
  const r = resolveDeliveryFormat(undefined, "<b>hi</b>");
  assert.equal(r.parseMode, "HTML");
  assert.equal(r.text, "<b>hi</b>");
  const r2 = resolveDeliveryFormat(undefined, "**bold**");
  assert.equal(
    r2.parseMode,
    undefined,
    "plain remains the legacy default for pure markdown",
  );
  assert.equal(r2.text, "**bold**");
  assert.equal(r2.downgraded, undefined);
});

test("resolveDeliveryFormat: unbalanced Markdown request drops to plain (downgraded)", () => {
  const r = resolveDeliveryFormat("Markdown", "_unbalanced");
  assert.equal(r.parseMode, undefined);
  assert.equal(r.downgraded, true);
  assert.equal(r.text, "_unbalanced");
});

test("resolveDeliveryFormat: detectMarkdown flag auto-detects BOTH formats for a no-request body (live-update path, legacy chooseDeliveryMode)", () => {
  const html = resolveDeliveryFormat(undefined, "<b>bold</b>", true);
  assert.equal(html.parseMode, "HTML");
  assert.equal(html.text, "<b>bold</b>");
  const md = resolveDeliveryFormat(undefined, "**bold** and _italic_", true);
  assert.equal(md.parseMode, "Markdown");
  assert.equal(md.text, "**bold** and _italic_");
  const mixed = resolveDeliveryFormat(undefined, "**lead** <i>then</i>", true);
  assert.equal(mixed.parseMode, "HTML");
  assert.equal(mixed.text, "lead <i>then</i>");
  const plain = resolveDeliveryFormat(undefined, "just words", true);
  assert.equal(
    plain.parseMode,
    "Markdown",
    "marker-free text is balanced markdown (legacy live-update behavior)",
  );
  assert.equal(plain.text, "just words");
});
