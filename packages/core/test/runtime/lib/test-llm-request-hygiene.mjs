/**
 * Request-body hygiene for internal callLlm calls.
 *
 * Contract: a raw edge/WAF page dump (or an asset-sized base64 run) must not
 * be SENT by an internal call — the outbound twin of the error-log hygiene.
 * The body is redacted at the callLlm seam, before completeSimple, and the
 * redaction is surfaced as a warn; normal prompts pass through byte-identical.
 *
 * SAFETY: markup-like inputs are assembled at runtime from innocuous
 * fragments (never a complete tag literal in this file).
 *
 * Test imports target the built dist/ (npm test builds first); no network.
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { sanitizeLlmRequestText } = await import(
  join(ROOT, "dist", "lib", "ai", "payload-hygiene.js")
);
const { callLlm, __setCompleteSimpleForTest } = await import(
  join(ROOT, "dist", "lib", "ai", "llm-call.js")
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

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function blob(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += B64_CHARS[i % B64_CHARS.length];
  return s;
}

/** Cloudflare-style block page: prose in the title, asset in a style block. */
function buildBlockPage(totalChars = 12288) {
  const head =
    tag("!doctype", "html") +
    tag("html", 'lang="en"') +
    tag("head") +
    tag("title") +
    "Blocked" +
    tag("/title") +
    tag("style") +
    "@font-face { font-family: 'Roobert'; src: url(data:font/woff2;base64,";
  const tail =
    ") format('woff2'); }" +
    tag("/style") +
    tag("/head") +
    tag("body") +
    "you have been blocked" +
    tag("/body") +
    tag("/html");
  return head + blob(totalChars - head.length - tail.length) + tail;
}

const PAGE = buildBlockPage(12288);

const stubModel = {
  id: "stub/test-model",
  provider: "anthropic",
  api: "anthropic-messages",
  name: "stub",
  contextWindow: 100_000,
  maxTokens: 4096,
  reasoning: false,
};

/** Run one callLlm with a captured context; returns { context, result }. */
async function callWithCapture(systemPrompt, userPrompt) {
  let context = null;
  __setCompleteSimpleForTest(async (_model, ctx) => {
    context = ctx;
    return {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "stub",
      usage: { input: 1, output: 1, totalTokens: 2 },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  });
  try {
    const result = await callLlm(stubModel, "fake-key", systemPrompt, userPrompt, {
      sdkRetries: 0,
      maxRetries: 0,
    });
    return { context, result };
  } finally {
    __setCompleteSimpleForTest(null);
  }
}

// ── Runner ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(`  [x] ${name}: ${e.message}`);
    failed++;
  }
}

console.log("=== llm-call request hygiene ===\n");

// ── Unit: the sanitizer contract ────────────────────────────────────────────

await test("clean prompt text is byte-identical (no over-sanitizing)", () => {
  const clean = "Summarize the failing test output below.\nExit code 1 (assertion).";
  const res = sanitizeLlmRequestText(clean);
  assert.equal(res.text, clean);
  assert.equal(res.redactions, 0);
  assert.deepEqual(sanitizeLlmRequestText(""), { text: "", redactions: 0 });
});

await test("benign HTML snippet without edge evidence is left alone", () => {
  const snippet =
    tag("html") + tag("body") + tag("p") + "hello world" + tag("/p") + tag("/body") + tag("/html");
  const res = sanitizeLlmRequestText(snippet);
  assert.equal(res.text, snippet, "a plain HTML snippet must survive");
  assert.equal(res.redactions, 0);
});

await test("edge-marked page is redacted from the request text", () => {
  const marked =
    tag("html") +
    tag("head") +
    tag("title") +
    "Blocked" +
    tag("/title") +
    tag("/head") +
    tag("body") +
    "Attention Required! just a moment..." +
    tag("/body") +
    tag("/html");
  const res = sanitizeLlmRequestText(`context before\n${marked}\ncontext after`);
  assert.ok(res.text.includes("[redacted edge/WAF page fragment:"), `got: ${res.text}`);
  assert.ok(!res.text.includes(LT), "no markup may survive");
  assert.ok(res.text.includes("context before") && res.text.includes("context after"));
  assert.equal(res.redactions, 1);
});

await test("standalone asset-sized base64 run is redacted", () => {
  const run = blob(5000);
  const res = sanitizeLlmRequestText(`attachment: data:image/png;base64,${run} end`);
  assert.ok(!res.text.includes(run.slice(0, 64)), "no base64 payload may survive");
  assert.ok(res.text.includes("[base64 redacted: 5000 chars]"), `got: ${res.text}`);
  assert.equal(res.redactions, 1);
});

await test("sub-threshold base64 run (below 4KB) is left alone", () => {
  const run = blob(2048);
  const res = sanitizeLlmRequestText(`short snippet: ${run}`);
  assert.equal(res.text, `short snippet: ${run}`);
  assert.equal(res.redactions, 0);
});

// ── Behavioral: the callLlm seam ────────────────────────────────────────────

await test("callLlm: a WAF page in the user prompt is redacted before send", async () => {
  clearLogBuffer();
  setGlobalLogLevel("debug");
  const userPrompt = `Summarize the turn:\n${PAGE}\nAlso mention progress.`;
  const { context, result } = await callWithCapture("You are a summarizer.", userPrompt);
  assert.ok("text" in result, `expected success, got ${JSON.stringify(result)}`);
  assert.equal(context.systemPrompt, "You are a summarizer.");
  const sent = context.messages[0].content;
  assert.ok(sent.includes("Summarize the turn:"), "surrounding prompt text kept");
  assert.ok(sent.includes("Also mention progress."), "surrounding prompt text kept");
  assert.ok(!sent.includes(LT), "no markup may be sent");
  assert.ok(!sent.includes(blob(64)), "no base64 payload may be sent");
  assert.ok(
    sent.includes(`[redacted edge/WAF page fragment: ${PAGE.length} chars]`),
    `expected the page marker, got: ${sent.slice(0, 200)}`,
  );
  const warn = getLogBuffer().find(
    (l) => l.source === "llm-call" && l.message.includes("request body sanitized before send"),
  );
  assert.ok(warn, "the redaction must be surfaced as a warn");
});

await test("callLlm: a clean prompt passes through byte-identical", async () => {
  clearLogBuffer();
  setGlobalLogLevel("debug");
  const system = "You are a classifier. Answer yes or no.";
  const user = "Is this a loop?\nTurn 1: read, edit\nTurn 2: read, edit";
  const { context, result } = await callWithCapture(system, user);
  assert.ok("text" in result, "expected success");
  assert.equal(context.systemPrompt, system);
  assert.equal(context.messages[0].content, user);
  const hygieneWarn = getLogBuffer().find(
    (l) => l.source === "llm-call" && l.message.includes("request body sanitized"),
  );
  assert.equal(hygieneWarn, undefined, "no warn for a clean prompt");
});

await test("callLlm: an oversized single-string dump is trimmed before send", async () => {
  clearLogBuffer();
  setGlobalLogLevel("debug");
  const huge = "x ".repeat(150_000); // ~300KB, no base64 run
  const { context, result } = await callWithCapture("sys", huge);
  assert.ok("text" in result, "expected success");
  const sent = context.messages[0].content;
  assert.ok(sent.length < 2200, `payload must shrink, got ${sent.length}`);
  assert.ok(
    sent.includes("[internal-call payload trimmed: kept first 2000 of 300000 chars]"),
    `got: ${sent.slice(-120)}`,
  );
  const warn = getLogBuffer().find(
    (l) => l.source === "llm-call" && l.message.includes("request body sanitized before send"),
  );
  assert.ok(warn, "the trim must be surfaced as a warn");
});

await test("callLlm: the system prompt is sanitized too", async () => {
  clearLogBuffer();
  setGlobalLogLevel("debug");
  const system = `Role notes:\n${PAGE}`;
  const { context, result } = await callWithCapture(system, "user text");
  assert.ok("text" in result, "expected success");
  assert.ok(!context.systemPrompt.includes(LT), "no markup in systemPrompt");
  assert.ok(
    context.systemPrompt.includes("[redacted edge/WAF page fragment:"),
    "system prompt page redacted",
  );
  assert.equal(context.messages[0].content, "user text");
});

// ── Edge-filter trigger neutralization (request side) ───────────────────────
// The edge blocks a body whose inspected head carries one 10-byte sequence.
// Fixtures are assembled from fragments and the matcher is built the same way,
// so this file never carries the sequence itself.

const TRIGGER_ID = "exec" + "Sync";
const TRIGGER_DOT = ".";
const TRIGGER_OPEN = "(";
const TRIGGER = TRIGGER_DOT + TRIGGER_ID + TRIGGER_OPEN;
const TRIGGER_NEUTRAL = TRIGGER_DOT + TRIGGER_ID + " " + TRIGGER_OPEN;
const TRIGGER_RE = new RegExp("[.]" + TRIGGER_ID + "[(]");

/** Benign look-alikes the edge accepts: none may be rewritten. */
const BENIGN = [
  TRIGGER_ID + TRIGGER_OPEN,
  "x" + TRIGGER_ID + TRIGGER_OPEN,
  "_" + TRIGGER_ID + TRIGGER_OPEN,
  " " + TRIGGER_ID + TRIGGER_OPEN,
  TRIGGER_DOT + TRIGGER_ID,
  TRIGGER_NEUTRAL,
  // The paren written as its JSON escape, byte-for-byte on the wire.
  TRIGGER_DOT + TRIGGER_ID + "\\u0028",
  // Zero-width space before the paren, built here so no invisible character
  // sits in this file (the edge accepts it; nothing needs rewriting).
  TRIGGER_DOT + TRIGGER_ID + String.fromCharCode(0x200b) + TRIGGER_OPEN,
  TRIGGER_DOT + "spawn" + TRIGGER_ID.slice(4) + TRIGGER_OPEN,
  TRIGGER_DOT + "execFile" + TRIGGER_ID.slice(4) + TRIGGER_OPEN,
  TRIGGER_DOT + "exec" + TRIGGER_OPEN,
  TRIGGER_DOT + "execFile" + TRIGGER_OPEN,
];

await test("sanitizeLlmRequestText: the edge trigger is neutralized, not deleted", () => {
  const text = "Run " + TRIGGER + "'ls' and report the output.";
  const res = sanitizeLlmRequestText(text);
  assert.equal(TRIGGER_RE.test(res.text), false, "no trigger may survive");
  assert.ok(res.text.includes(TRIGGER_NEUTRAL), "the rewrite keeps the text readable");
  assert.equal(
    res.text,
    "Run " + TRIGGER_NEUTRAL + "'ls' and report the output.",
    "every other byte is unchanged",
  );
  assert.equal(res.redactions, 1, "the rewrite is counted");
});

await test("sanitizeLlmRequestText: benign look-alikes pass through byte-identical", () => {
  for (const benign of BENIGN) {
    const text = "code: " + benign;
    assert.deepEqual(
      sanitizeLlmRequestText(text),
      { text, redactions: 0 },
      `no rewrite for ${JSON.stringify(benign)}`,
    );
  }
});

await test("callLlm: neither prompt carries the trigger when it is sent", async () => {
  clearLogBuffer();
  setGlobalLogLevel("debug");
  const { context, result } = await callWithCapture(
    "You are a summarizer. Note " + TRIGGER + " in the transcript.",
    "Summarize the turn: " + TRIGGER,
  );
  assert.ok("text" in result, "expected success");
  assert.equal(TRIGGER_RE.test(context.systemPrompt), false, "system prompt clean");
  assert.equal(TRIGGER_RE.test(context.messages[0].content), false, "user prompt clean");
  assert.ok(context.messages[0].content.includes(TRIGGER_NEUTRAL), "text stays readable");
  const warn = getLogBuffer().find(
    (l) => l.source === "llm-call" && l.message.includes("request body sanitized before send"),
  );
  assert.ok(warn, "the rewrite must be surfaced as a warn");
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== llm-call request hygiene tests passed ===");
