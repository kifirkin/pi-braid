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
  splitHtmlText,
  isBalancedMarkdown,
  sendMessageChunks,
  hasHtmlTags,
  stripHtmlTags,
  neutralizeMarkdownMarkers,
  convertMarkdownV2ToHtml,
  resolveDeliveryFormat,
} from "../dist/lib/format.js";
import { checkTelegramHtml } from "../dist/lib/html-check.js";

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

test("resolveDeliveryFormat: HTML request keeps HTML tags live, converts MarkdownV2 emphasis", () => {
  const r = resolveDeliveryFormat("HTML", "<b>hi</b>");
  assert.equal(r.parseMode, "HTML");
  assert.equal(r.text, "<b>hi</b>");
  const r2 = resolveDeliveryFormat("HTML", "**bold** <i>also</i>");
  assert.equal(r2.parseMode, "HTML");
  assert.equal(
    r2.text,
    "<b>bold</b> <i>also</i>",
    "**bold** becomes real HTML bold, never a literal marker",
  );
});

test("resolveDeliveryFormat: Markdown request keeps legacy Markdown, strips raw HTML tags", () => {
  const r = resolveDeliveryFormat("Markdown", "*bold* and _italic_");
  assert.equal(r.parseMode, "Markdown");
  assert.equal(r.text, "*bold* and _italic_");
  const r2 = resolveDeliveryFormat("Markdown", "<b>bold</b>");
  assert.equal(r2.parseMode, "Markdown");
  assert.equal(r2.text, "bold", "raw HTML tag must not leak under Markdown");
  const r3 = resolveDeliveryFormat("Markdown", "<b>x</b> **y**");
  assert.equal(r3.parseMode, "HTML");
  assert.equal(
    r3.text,
    "<b>x</b> <b>y</b>",
    "MarkdownV2 in a mixed body converts instead of shipping raw",
  );
});

test("resolveDeliveryFormat: no request + raw HTML → auto HTML (old bug: leaked as Markdown)", () => {
  const r = resolveDeliveryFormat(undefined, "<b>hi</b>");
  assert.equal(r.parseMode, "HTML");
  assert.equal(r.text, "<b>hi</b>");
  const r2 = resolveDeliveryFormat(undefined, "**bold**");
  assert.equal(r2.parseMode, "HTML", "MarkdownV2 bold is auto-converted");
  assert.equal(r2.text, "<b>bold</b>");
  assert.deepEqual(r2.converted, {
    bold: 1,
    underline: 0,
    strike: 0,
    spoiler: 0,
    code: 0,
  });
  const plain = resolveDeliveryFormat(undefined, "just words");
  assert.equal(
    plain.parseMode,
    undefined,
    "plain stays the no-request default for marker-free text",
  );
});

test("resolveDeliveryFormat: unbalanced Markdown request drops to plain (downgraded)", () => {
  const r = resolveDeliveryFormat("Markdown", "_unbalanced");
  assert.equal(r.parseMode, undefined);
  assert.equal(r.downgraded, true);
  assert.equal(r.text, "_unbalanced");
});

test("resolveDeliveryFormat: detectMarkdown flag auto-detects formats for a no-request body (live-update path)", () => {
  const html = resolveDeliveryFormat(undefined, "<b>bold</b>", true);
  assert.equal(html.parseMode, "HTML");
  assert.equal(html.text, "<b>bold</b>");
  const legacy = resolveDeliveryFormat(undefined, "*bold* and _italic_", true);
  assert.equal(legacy.parseMode, "Markdown");
  assert.equal(legacy.text, "*bold* and _italic_");
  const md = resolveDeliveryFormat(undefined, "**bold** and _italic_", true);
  assert.equal(md.parseMode, "HTML", "MarkdownV2 converts even when detected");
  assert.equal(md.text, "<b>bold</b> and italic");
  const mixed = resolveDeliveryFormat(undefined, "**lead** <i>then</i>", true);
  assert.equal(mixed.parseMode, "HTML");
  assert.equal(mixed.text, "<b>lead</b> <i>then</i>");
  const plain = resolveDeliveryFormat(undefined, "just words", true);
  assert.equal(
    plain.parseMode,
    "Markdown",
    "marker-free text is balanced markdown (legacy live-update behavior)",
  );
  assert.equal(plain.text, "just words");
});

// ── MarkdownV2 → HTML conversion ───────────────────────────────────────────

test("convertMarkdownV2ToHtml: **bold**, __underline__, `code` → HTML with per-kind counts", () => {
  const r = convertMarkdownV2ToHtml("**B** and __u__ and `c`");
  assert.equal(r.text, "<b>B</b> and <u>u</u> and <code>c</code>");
  assert.deepEqual(r.converted, {
    bold: 1,
    underline: 1,
    strike: 0,
    spoiler: 0,
    code: 1,
  });
});

test("convertMarkdownV2ToHtml: ~strike~ → <s>; a tilde run, lone ~ or spaced pair stays literal", () => {
  const r = convertMarkdownV2ToHtml("~struck~ and 5~10ms");
  assert.equal(r.text, "<s>struck</s> and 5~10ms");
  assert.deepEqual(r.converted, {
    bold: 0,
    underline: 0,
    strike: 1,
    spoiler: 0,
    code: 0,
  });
  // GFM's `~~x~~` is not a MarkdownV2 pair — it must reach the wire whole,
  // never half-rewritten into `~<s>x</s>~`.
  assert.equal(convertMarkdownV2ToHtml("~~kept~~").text, "~~kept~~");
  assert.equal(convertMarkdownV2ToHtml("~~kept~~").converted.strike, 0);
  // A spaced tilde is a shell/prose operator (`cd ~ && ls ~`), not emphasis.
  assert.equal(
    convertMarkdownV2ToHtml("cd ~ && ls ~").text,
    "cd ~ &amp;&amp; ls ~",
  );
  assert.equal(convertMarkdownV2ToHtml("~ x ~").text, "~ x ~");
});

test("convertMarkdownV2ToHtml: ||spoiler|| → <tg-spoiler>, the || operator stays literal", () => {
  const r = convertMarkdownV2ToHtml("||secret||");
  assert.equal(r.text, "<tg-spoiler>secret</tg-spoiler>");
  assert.deepEqual(r.converted, {
    bold: 0,
    underline: 0,
    strike: 0,
    spoiler: 1,
    code: 0,
  });
  // `x || y || z` is a logical OR in prose, not a spoiler.
  assert.equal(convertMarkdownV2ToHtml("x || y || z").text, "x || y || z");
  assert.equal(convertMarkdownV2ToHtml("cmd || fallback").converted.spoiler, 0);
  assert.equal(convertMarkdownV2ToHtml("|| x ||").text, "|| x ||");
});

test("convertMarkdownV2ToHtml: unbalanced / word-adjacent markers stay literal", () => {
  const r = convertMarkdownV2ToHtml("**open and snake__case__name");
  assert.equal(r.text, "**open and snake__case__name");
  assert.deepEqual(r.converted, {
    bold: 0,
    underline: 0,
    strike: 0,
    spoiler: 0,
    code: 0,
  });
});

test("convertMarkdownV2ToHtml: code-span content stays literal (no nested emphasis)", () => {
  const r = convertMarkdownV2ToHtml("literal `**x**` stays");
  assert.equal(r.text, "literal <code>**x**</code> stays");
  assert.deepEqual(r.converted, {
    bold: 0,
    underline: 0,
    strike: 0,
    spoiler: 0,
    code: 1,
  });
});

test("convertMarkdownV2ToHtml: every pair inside a code span stays literal", () => {
  const r = convertMarkdownV2ToHtml("literal `**x** __y__ ~z~ ||s||` stays");
  assert.equal(r.text, "literal <code>**x** __y__ ~z~ ||s||</code> stays");
  assert.deepEqual(r.converted, {
    bold: 0,
    underline: 0,
    strike: 0,
    spoiler: 0,
    code: 1,
  });
});

test("convertMarkdownV2ToHtml: reserved characters in body text are escaped (no API parse error)", () => {
  const r = convertMarkdownV2ToHtml("**done** latency < 50ms & rising");
  assert.equal(r.text, "<b>done</b> latency &lt; 50ms &amp; rising");
});

test("convertMarkdownV2ToHtml: author HTML tags and entities stay wire-ready", () => {
  const r = convertMarkdownV2ToHtml("**a** <i>keep</i> &lt;kept&gt;");
  assert.equal(r.text, "<b>a</b> <i>keep</i> &lt;kept&gt;");
});

test("convertMarkdownV2ToHtml: code-span content is escaped inside <code>", () => {
  const r = convertMarkdownV2ToHtml("**x** `a < b`");
  assert.equal(r.text, "<b>x</b> <code>a &lt; b</code>");
});

test("convertMarkdownV2ToHtml: a long balanced pair converts (no short inner cap)", () => {
  const long = "y".repeat(500);
  const r = convertMarkdownV2ToHtml(`**${long}** and __${long}__`);
  assert.equal(r.text, `<b>${long}</b> and <u>${long}</u>`);
  assert.deepEqual(r.converted, {
    bold: 1,
    underline: 1,
    strike: 0,
    spoiler: 0,
    code: 0,
  });
});

test("resolveDeliveryFormat: a converted body with a stray < stays deliverable (HTML-escaped)", () => {
  const r = resolveDeliveryFormat("Markdown", "**done** latency < 50ms");
  assert.equal(r.parseMode, "HTML");
  assert.equal(r.text, "<b>done</b> latency &lt; 50ms");
});

// Required contract matrix: {requested} × {body}. Cells with a MarkdownV2
// body must resolve to HTML with the markers converted (revert the conversion
// and they go red); legacy Markdown stays on the legacy rails; an unbalanced
// marker is never converted and keeps the documented downgrade. One body per
// MarkdownV2 delimiter pair: `**` bold + `__` underline in `mdv2`, `~` strike,
// `||` spoiler.
const MATRIX_BODIES = {
  plain: "deploy finished, 12 tests green",
  mdv2: "**deploy finished** and __12 tests green__",
  strike: "~deploy finished~ and the ~~literal~~ run",
  spoiler: "||deploy finished|| and ||12 tests green||",
  legacy: "*deploy finished* and _12 tests green_",
  mixed: "**deploy finished** <i>12 tests green</i>",
  unbalanced: "**deploy finished",
};
const COUNTS = (kinds) => ({
  bold: 0,
  underline: 0,
  strike: 0,
  spoiler: 0,
  code: 0,
  ...kinds,
});
const CONVERTED_MDV2 = COUNTS({ bold: 1, underline: 1 });
const CONVERTED_STRIKE = COUNTS({ strike: 1 });
const CONVERTED_SPOILER = COUNTS({ spoiler: 2 });
const CONVERTED_MIXED = COUNTS({ bold: 1 });
const MDV2_TEXT = "<b>deploy finished</b> and <u>12 tests green</u>";
const STRIKE_TEXT = "<s>deploy finished</s> and the ~~literal~~ run";
const SPOILER_TEXT =
  "<tg-spoiler>deploy finished</tg-spoiler> and <tg-spoiler>12 tests green</tg-spoiler>";
const MIXED_TEXT = "<b>deploy finished</b> <i>12 tests green</i>";

test("resolveDeliveryFormat matrix: {no mode, Markdown, HTML} × {plain, mdv2, strike, spoiler, legacy, mixed, unbalanced}", () => {
  const cells = [
    [undefined, "plain", undefined, MATRIX_BODIES.plain, undefined],
    [undefined, "mdv2", "HTML", MDV2_TEXT, CONVERTED_MDV2],
    [undefined, "strike", "HTML", STRIKE_TEXT, CONVERTED_STRIKE],
    [undefined, "spoiler", "HTML", SPOILER_TEXT, CONVERTED_SPOILER],
    [undefined, "legacy", undefined, MATRIX_BODIES.legacy, undefined],
    [undefined, "mixed", "HTML", MIXED_TEXT, CONVERTED_MIXED],
    [undefined, "unbalanced", undefined, MATRIX_BODIES.unbalanced, undefined],
    ["Markdown", "plain", "Markdown", MATRIX_BODIES.plain, undefined],
    ["Markdown", "mdv2", "HTML", MDV2_TEXT, CONVERTED_MDV2],
    ["Markdown", "strike", "HTML", STRIKE_TEXT, CONVERTED_STRIKE],
    ["Markdown", "spoiler", "HTML", SPOILER_TEXT, CONVERTED_SPOILER],
    ["Markdown", "legacy", "Markdown", MATRIX_BODIES.legacy, undefined],
    ["Markdown", "mixed", "HTML", MIXED_TEXT, CONVERTED_MIXED],
    ["Markdown", "unbalanced", undefined, MATRIX_BODIES.unbalanced, undefined],
    ["HTML", "plain", "HTML", MATRIX_BODIES.plain, undefined],
    ["HTML", "mdv2", "HTML", MDV2_TEXT, CONVERTED_MDV2],
    ["HTML", "strike", "HTML", STRIKE_TEXT, CONVERTED_STRIKE],
    ["HTML", "spoiler", "HTML", SPOILER_TEXT, CONVERTED_SPOILER],
    [
      "HTML",
      "legacy",
      "HTML",
      "*deploy finished* and 12 tests green",
      undefined,
    ],
    ["HTML", "mixed", "HTML", MIXED_TEXT, CONVERTED_MIXED],
    ["HTML", "unbalanced", "HTML", MATRIX_BODIES.unbalanced, undefined],
  ];
  for (const [requested, key, mode, text, converted] of cells) {
    const r = resolveDeliveryFormat(requested, MATRIX_BODIES[key]);
    const label = `requested=${requested ?? "none"} body=${key}`;
    assert.equal(r.parseMode, mode, `${label}: resolved mode`);
    assert.equal(r.text, text, `${label}: delivered text`);
    assert.deepEqual(r.converted, converted, `${label}: converted report`);
    if (mode === "HTML" && key !== "unbalanced") {
      assert.ok(
        !/\*\*|__/.test(r.text),
        `${label}: no raw MarkdownV2 marker on an HTML wire`,
      );
    }
  }
  // The per-pair markers leave no literal delimiter on the HTML wire.
  const strike = resolveDeliveryFormat("Markdown", MATRIX_BODIES.strike);
  assert.ok(!/(^|[^~])~[^~]/.test(strike.text), "no lone ~ on the strike wire");
  const spoiler = resolveDeliveryFormat("Markdown", MATRIX_BODIES.spoiler);
  assert.ok(!/\|\|/.test(spoiler.text), "no literal || on the spoiler wire");
  // Unbalanced Markdown request keeps the documented downgrade to plain text.
  const unbal = resolveDeliveryFormat("Markdown", MATRIX_BODIES.unbalanced);
  assert.equal(unbal.downgraded, true, "unbalanced Markdown still downgrades");
});

// ── conversion refusal: crossing pairs, unbalanced author HTML, caps ────────

const ZERO_COUNTS = {
  bold: 0,
  underline: 0,
  strike: 0,
  spoiler: 0,
  code: 0,
};

test("convertMarkdownV2ToHtml: crossing pairs refuse the conversion (R1, live-verified)", () => {
  // Each of these would produce `<x>…<y>…</x>…</y>` — Telegram rejects
  // "Unmatched end tag" — so the conversion reports zero counts and the body
  // ships as authored (Markdown/MarkdownV2 both parse the literal forms).
  const crossing = [
    "__a ~b__ c~",
    "~a __b~ c__",
    "**a ~b** c~",
    "~a **b~ c**",
    "__a ||b__ c||",
    "||a __b|| c__",
  ];
  for (const body of crossing) {
    const r = convertMarkdownV2ToHtml(body);
    assert.equal(r.text, body, `${body}: literal text returned`);
    assert.deepEqual(r.converted, ZERO_COUNTS, `${body}: nothing counted`);
    const wire = resolveDeliveryFormat("Markdown", body);
    assert.equal(
      wire.parseMode,
      "Markdown",
      `${body}: unconverted path stays Markdown`,
    );
    assert.equal(wire.text, body);
  }
  // Nested (properly paired) forms keep converting.
  for (const body of ["__a ~b~ c__", "~a **b** c~", "||a __b__ c||"]) {
    const r = convertMarkdownV2ToHtml(body);
    assert.ok(
      r.converted.bold +
        r.converted.underline +
        r.converted.strike +
        r.converted.spoiler >
        0,
      `${body}: nested pair still converts`,
    );
    assert.equal(
      checkTelegramHtml(r.text).ok,
      true,
      `${body}: converted output parses`,
    );
  }
});

test("convertMarkdownV2ToHtml: unbalanced author HTML refuses; a quoted '>' stays whole (F1)", () => {
  // The merge turned these into "<s>x</s> <b>unclosed" etc. — rejected by
  // Telegram. Refusal restores the pre-merge deliverable path.
  for (const body of [
    "~x~ <b>unclosed",
    "||x|| </b>",
    "~a<b>c~",
    "~x~ <span>y</span>",
  ]) {
    const r = convertMarkdownV2ToHtml(body);
    assert.equal(r.text, body, `${body}: literal text returned`);
    assert.deepEqual(r.converted, ZERO_COUNTS, `${body}: nothing counted`);
    const wire = resolveDeliveryFormat("Markdown", body);
    assert.equal(
      checkTelegramHtml(wire.text).ok,
      true,
      `${body}: Markdown wire parses`,
    );
  }
  // A '>' inside a quoted attribute is part of the tag: the tag is protected
  // whole, the result parses, and the strike still converts (live: PARSES).
  const quoted = convertMarkdownV2ToHtml('~x~ <a href="a>b">y</a>');
  assert.equal(quoted.text, '<s>x</s> <a href="a>b">y</a>');
  assert.equal(quoted.converted.strike, 1);
  assert.equal(checkTelegramHtml(quoted.text).ok, true);
  // Balanced author HTML nested inside a pair still converts.
  assert.equal(
    convertMarkdownV2ToHtml("__a <b>b</b> c__").text,
    "<u>a <b>b</b> c</u>",
  );
});

test("convertMarkdownV2ToHtml: author sentinel-shaped characters survive (F2)", () => {
  const cases = [
    ["**b** \uE0009\uE001", "<b>b</b> \uE0009\uE001"],
    ["~x~ \uE0009\uE001", "<s>x</s> \uE0009\uE001"],
    ["\uE0029\uE003 ~x~", "\uE0029\uE003 <s>x</s>"],
    ["~\uE0009\uE001~", "<s>\uE0009\uE001</s>"],
    ["~y~ &amp;\uE0020\uE003;", "<s>y</s> &amp;\uE0020\uE003;"],
    [
      '`c` <a href="\uE0000\uE001">x</a> ~y~',
      '<code>c</code> <a href="\uE0000\uE001">x</a> <s>y</s>',
    ],
  ];
  for (const [body, expected] of cases) {
    const r = convertMarkdownV2ToHtml(body);
    assert.equal(
      r.text,
      expected,
      `${JSON.stringify(body)}: no deletion/substitution`,
    );
  }
});

test("convertMarkdownV2ToHtml: renderedCap refuses a rendering past the cap (F8)", () => {
  const body = "~" + "x".repeat(295) + "~"; // 297 authored, 302 rendered
  const refused = convertMarkdownV2ToHtml(body, { renderedCap: 300 });
  assert.equal(
    refused.text,
    body,
    "over-cap rendering refused, authored text returned",
  );
  assert.deepEqual(refused.converted, ZERO_COUNTS);
  const allowed = convertMarkdownV2ToHtml(body, { renderedCap: 302 });
  assert.equal(allowed.text.length, 302, "at-cap rendering still converts");
  assert.equal(allowed.converted.strike, 1);
});

test("convertMarkdownV2ToHtml: an accepted conversion always parses (guarded absolute)", () => {
  const bodies = [
    "**a** and __b__ and ~c~ and ||d|| and `e`",
    "**a <b>x</b> b**",
    "||a <i>x</i> b||",
    '~x~ <a href="a>b">y</a>',
    "**done** latency < 50ms & rising",
    "**bold** <i>also</i>",
  ];
  for (const body of bodies) {
    const r = convertMarkdownV2ToHtml(body);
    assert.equal(
      checkTelegramHtml(r.text).ok,
      true,
      `${JSON.stringify(body)} → ${JSON.stringify(r.text)} must parse`,
    );
  }
});

test("neutralizeMarkdownMarkers: code and pre span content is exempt (F3)", () => {
  assert.equal(
    neutralizeMarkdownMarkers("<b>b</b> <code>**x**</code>"),
    "<b>b</b> <code>**x**</code>",
    "a `**x**` example inside <code> is content, not emphasis",
  );
  assert.equal(
    neutralizeMarkdownMarkers("<pre>_y_</pre> and _z_"),
    "<pre>_y_</pre> and z",
    "pre content stays literal; outside markers still strip",
  );
  assert.equal(
    neutralizeMarkdownMarkers("<code>a</code> `b` <code>c</code>"),
    "<code>a</code> b <code>c</code>",
    "per-span splitting keeps the outside pass working",
  );
});

// ── tag-aware splitting (R2) ────────────────────────────────────────────────

test("splitHtmlText: every chunk parses, tags close and reopen across cuts", () => {
  const body = "<b>" + "x".repeat(50) + "</b>";
  const chunks = splitHtmlText(body, 30);
  assert.ok(chunks.length > 1, "long tagged body splits");
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 30, `chunk within limit: ${chunk.length}`);
    assert.equal(checkTelegramHtml(chunk).ok, true, `chunk parses: ${chunk}`);
    assert.match(chunk, /^<b>/, "reopens the bold tag");
    assert.match(chunk, /<\/b>$/, "closes the bold tag");
  }
  assert.equal(stripHtmlTags(chunks.join("")), "x".repeat(50));
});

test("splitHtmlText: nested tags are closed/reopened in order", () => {
  const body = "<b><u>" + "y".repeat(40) + "</u></b>";
  const chunks = splitHtmlText(body, 25);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 25, `chunk within limit: ${chunk.length}`);
    assert.equal(checkTelegramHtml(chunk).ok, true, `chunk parses: ${chunk}`);
  }
  assert.equal(stripHtmlTags(chunks.join("")), "y".repeat(40));
});

test("splitHtmlText: never cuts inside an entity", () => {
  const chunks = splitHtmlText("aaaaa&amp;bbbbb", 8);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 8, `chunk within limit: ${chunk.length}`);
    assert.ok(
      !/(^|[^&])&[a-z0-9#]*$/.test(chunk),
      `no chunk ends inside an entity: ${JSON.stringify(chunk)}`,
    );
  }
  assert.equal(chunks.join(""), "aaaaa&amp;bbbbb");
});

test("splitHtmlText: reserved headroom is honored", () => {
  const body = "<i>" + "z".repeat(200) + "</i>";
  for (const chunk of splitHtmlText(body, 40, 8)) {
    assert.ok(chunk.length <= 32, `chunk within 40-8: ${chunk.length}`);
    assert.equal(checkTelegramHtml(chunk).ok, true);
  }
});

test("sendMessageChunks: HTML bodies are split tag-aware (each wire chunk parses)", async () => {
  const { client, calls } = stubClient();
  const body = "<b>" + "w".repeat(9000) + "</b>";
  const res = await sendMessageChunks(client, {
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    text: body,
    parseMode: "HTML",
  });
  assert.equal(res.ok, true);
  assert.ok(res.total > 1);
  calls.forEach((call, index) => {
    assert.ok(
      call.text.length <= TELEGRAM_MAX_TEXT_LENGTH,
      `chunk ${index} within cap`,
    );
    assert.equal(
      checkTelegramHtml(call.text).ok,
      true,
      `chunk ${index} parses: ${checkTelegramHtml(call.text).error ?? ""}`,
    );
    assert.ok(call.text.startsWith("<b>"), `chunk ${index} reopens bold`);
    assert.ok(call.text.includes(`</b>`), `chunk ${index} closes bold`);
    assert.ok(
      call.text.endsWith(`(${index + 1}/${res.total})`),
      `chunk ${index} carries the marker`,
    );
  });
});

test("sendMessageChunks: Markdown/plain bodies keep the legacy boundary splitter", async () => {
  const { client, calls } = stubClient();
  const body = Array.from(
    { length: 300 },
    (_, i) => `line ${i} ` + "q".repeat(40),
  ).join("\n");
  const res = await sendMessageChunks(client, {
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    text: body,
    parseMode: "Markdown",
  });
  assert.equal(res.ok, true);
  assert.ok(res.total > 1);
  for (const call of calls) {
    assert.ok(call.text.length <= TELEGRAM_MAX_TEXT_LENGTH);
  }
  // Same chunks as splitLongText would produce (marker excluded).
  const plain = splitLongText(body);
  assert.equal(plain.length, res.total);
});

test("checkTelegramHtml: mirrors Telegram's verdicts on the review's failure shapes", () => {
  assert.equal(checkTelegramHtml("<u>a <s>b</s> c</u>").ok, true);
  assert.equal(checkTelegramHtml("<u>a <s>b</u> c</s>").ok, false);
  assert.equal(checkTelegramHtml("<b>x").ok, false);
  assert.equal(checkTelegramHtml("</b>").ok, false);
  assert.equal(checkTelegramHtml("<span>x</span>").ok, false);
  assert.equal(checkTelegramHtml('<span class="tg-spoiler">x</span>').ok, true);
  assert.equal(checkTelegramHtml("a < b").ok, false);
  assert.equal(checkTelegramHtml("a & b").ok, true);
  assert.equal(checkTelegramHtml("").ok, true);
});

test("checkTelegramHtml: attribute shapes follow the live parser (calibrated)", () => {
  const cases = [
    ['<b>x</b class="z">', false],
    ['<span class="tg-spoiler">x</span class="y">', false],
    ["<b>x</b>", true],
    ["<b class=a=b>y</b>", false],
    ['<b class=a"b>y</b>', false],
    ["<b class=a'b>y</b>", false],
    ['<b class="z">y</b>', true],
    ['<tg-emoji emoji-id="00123">y</tg-emoji>', false],
    ['<tg-emoji emoji-id="0">y</tg-emoji>', false],
    ['<tg-emoji emoji-id="123">y</tg-emoji>', true],
    ['<tg-emoji emoji-id="1234567890123456789">y</tg-emoji>', true],
    ['<tg-emoji emoji-id="9223372036854775807">y</tg-emoji>', true],
    ['<tg-emoji emoji-id="9999999999999999999">y</tg-emoji>', false],
  ];
  for (const [wire, ok] of cases) {
    assert.equal(checkTelegramHtml(wire).ok, ok, `${wire} must be ${ok}`);
  }
});

test("convertMarkdownV2ToHtml: attribute shapes Telegram rejects refuse the conversion", () => {
  for (const body of [
    '~x~ <b>y</b class="z">',
    '<span class="tg-spoiler">x</span class="y"> ~s~',
    "~x~ <b class=a=b>y</b>",
    '~x~ <b class=a"b>y</b>',
    "~x~ <b class=a'b>y</b>",
    '~x~ <tg-emoji emoji-id="00123">y</tg-emoji>',
    '~x~ <tg-emoji emoji-id="0">y</tg-emoji>',
  ]) {
    const r = convertMarkdownV2ToHtml(body);
    assert.equal(r.text, body, `${body}: authored text returned`);
    assert.deepEqual(r.converted, ZERO_COUNTS, `${body}: nothing counted`);
    const wire = resolveDeliveryFormat("Markdown", body);
    assert.notEqual(wire.parseMode, "HTML", `${body}: no rejected HTML wire`);
  }
});

test("sendMessageChunks: an over-cap HTML tag refuses the body instead of trimming it", async () => {
  const body = '<a href="https://e.com/' + "q".repeat(5000) + '">y</a>';
  assert.equal(checkTelegramHtml(body).ok, true, "the source body parses");
  const { client, calls } = stubClient();
  const res = await sendMessageChunks(client, {
    token: BOT_TOKEN,
    chatId: OWNER_CHAT_ID,
    text: body,
    parseMode: "HTML",
  });
  assert.equal(res.ok, false, "the send is refused");
  assert.equal(res.sent, 0);
  assert.equal(calls.length, 0, "nothing reaches the wire");
  assert.match(res.error ?? "", /cap is 4096/);
});
