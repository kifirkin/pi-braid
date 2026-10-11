/**
 * Log hygiene for the internal LLM-call error path.
 *
 * Contract: an HTTP error body must NEVER reach the TUI log (or a caller)
 * raw. callLlm classifies on the raw provider text and feeds the key ring
 * with it, but everything logged or returned is collapsed by
 * sanitizeLlmErrorForLog() — an HTML block page becomes one line like
 * `403 Blocked (text/html, ~12KB)`, base64 runs become length markers.
 *
 * Regression (owner finding): a Cloudflare-style "Blocked" 403
 * on the internal turn-completion call dumped the full page (~12KB incl.
 * base64 fonts) into the TUI as a `WARN [llm-call] LLM rate-limited …`
 * line, and the raw text rode back to callers.
 *
 * SAFETY: every markup-like input below is assembled at runtime from
 * innocuous fragments (never a complete tag literal in this file), so the
 * test source itself stays payload-free.
 *
 * Test imports target the built dist/ (npm test builds first); no network.
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { sanitizeLlmErrorForLog } = await import(
  join(ROOT, "dist", "lib", "ai", "payload-hygiene.js")
);
const { callLlm, __setCompleteSimpleForTest, __resetRateLimitCooldownForTest } = await import(
  join(ROOT, "dist", "lib", "ai", "llm-call.js")
);
const { setKeyRingFeedbackHandler, resetKeyRingFeedbackHandler, setLlmCallListeners } =
  await import(join(ROOT, "dist", "lib", "state", "global-state.js"));
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

/** Deterministic base64-class run of exactly `n`chars. */
function blob(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += B64_CHARS[i % B64_CHARS.length];
  return s;
}

/**
 * Cloudflare-style "Blocked"page: prose only in the title, assets in a
 * style block, the rate-limit phrase in a script block (so the raw text
 * classifies as rate-limit while the excerpt stays `Blocked`).
 */
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
    tag("script") +
    "var edgeCode = 1015; // you are being rate limited (429)" +
    tag("/script") +
    tag("/body") +
    tag("/html");
  return head + blob(totalChars - head.length - tail.length) + tail;
}

const stubModel = {
  id: "stub/test-model",
  provider: "anthropic",
  api: "anthropic-messages",
  name: "stub",
  contextWindow: 100_000,
  maxTokens: 4096,
  reasoning: false,
};

function errorStub(errorMessage) {
  return async () => ({
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "stub",
    usage: { input: 0, output: 0, totalTokens: 0 },
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  });
}

// ── Runner ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  }
}

console.log("=== llm-call error log hygiene ===\n");

// ── Unit: the sanitizer contract ────────────────────────────────────────────

const PAGE = buildBlockPage(12288);
const RAW_403 = "403 " + PAGE;

await test("403 + HTML page collapses to `403 Blocked (text/html, ~12KB)`", () => {
  const out = sanitizeLlmErrorForLog(RAW_403);
  assert.equal(out, "403 Blocked (text/html, ~12KB)");
  assert.ok(!out.includes(LT), "no markup may survive");
  assert.ok(!out.toLowerCase().includes("doctype"), "no doctype may survive");
  assert.ok(!out.includes("base64"), "no base64 marker may survive");
  assert.ok(out.length < 80, `sanitized line must stay compact, got ${out.length}`);
});

await test("the raw fixture really carries the payload (guard against a no-op test)", () => {
  assert.ok(RAW_403.includes(tag("!doctype", "html")), "fixture has page markup");
  assert.ok(RAW_403.includes(blob(256)), "fixture has a base64 run");
  assert.ok(RAW_403.length >= 12000, "fixture is a ~12KB body");
});

await test("long page prose is truncated to ~120 chars", () => {
  const prose = "blocked by an edge policy ".repeat(20);
  const page =
    tag("!doctype", "html") +
    tag("html") +
    tag("body") +
    tag("p") +
    prose +
    tag("/p") +
    tag("/body") +
    tag("/html");
  const out = sanitizeLlmErrorForLog("403 " + page);
  assert.ok(out.startsWith("403 blocked by an edge policy"), `got: ${out}`);
  assert.ok(out.length <= 80 + 130, `excerpt must be capped, got ${out.length}`);
  assert.ok(!out.includes(LT), "no markup may survive");
});

await test("JSON provider error text passes through untouched", () => {
  const json = '{"error":{"message":"insufficient_quota","code":"402"}}';
  assert.equal(sanitizeLlmErrorForLog(json), json);
  assert.equal(sanitizeLlmErrorForLog("429 rate limit exceeded"), "429 rate limit exceeded");
  assert.equal(sanitizeLlmErrorForLog("Request was aborted"), "Request was aborted");
  assert.equal(sanitizeLlmErrorForLog(""), "");
  assert.equal(sanitizeLlmErrorForLog(null), "");
});

await test("standalone base64 run is redacted to a length marker", () => {
  const run = blob(2048);
  const out = sanitizeLlmErrorForLog(`upload failed: data:image/png;base64,${run}`);
  assert.ok(!out.includes(run.slice(0, 64)), "no base64 payload may survive");
  assert.ok(out.includes("[base64 redacted, 2048 chars]"), `got: ${out}`);
});

await test("oversized non-payload text is capped at 2000 chars", () => {
  const raw = "error line with spaces ".repeat(250);
  const out = sanitizeLlmErrorForLog(raw);
  assert.ok(out.length <= 2000 + 32, `must be capped, got ${out.length}`);
  assert.ok(out.includes(`[+${raw.length - 2000} chars]`), "truncation marker present");
});

// ── Behavioral: callLlm log + return path ───────────────────────────────────

function llmCallLogs() {
  return getLogBuffer().filter((l) => l.source === "llm-call");
}

await test("callLlm: a 403 page logs sanitized and returns sanitized", async () => {
  __resetRateLimitCooldownForTest();
  clearLogBuffer();
  setGlobalLogLevel("debug");
  __setCompleteSimpleForTest(errorStub(RAW_403));
  try {
    const result = await callLlm(stubModel, "fake-key", "sys", "user", {
      sdkRetries: 0,
      maxRetries: 0,
    });
    assert.ok("error" in result, `expected { error }, got ${JSON.stringify(result)}`);
    assert.equal(result.error, "403 Blocked (text/html, ~12KB)");

    const logs = llmCallLogs();
    assert.ok(logs.length >= 1, "the failure must produce at least one llm-call log line");
    const warn = logs.find((l) => l.message.includes("LLM rate-limited, giving up"));
    assert.ok(warn, `expected the rate-limited warn; got ${JSON.stringify(logs)}`);
    assert.ok(
      warn.message.includes("403 Blocked (text/html, ~12KB)"),
      "the warn line carries the sanitized summary",
    );
    for (const line of logs) {
      assert.ok(!line.message.includes(LT), `no markup in any log line: ${line.message}`);
      assert.ok(!line.message.includes("base64"), `no base64 in any log line: ${line.message}`);
      assert.ok(
        !line.message.includes(blob(64)),
        `no payload fragment in any log line: ${line.message}`,
      );
    }
  } finally {
    __setCompleteSimpleForTest(null);
  }
});

await test("callLlm: classification + key-ring + listener still get the RAW text", async () => {
  __resetRateLimitCooldownForTest();
  clearLogBuffer();
  setGlobalLogLevel("debug");

  const feedback = [];
  setKeyRingFeedbackHandler({
    reportFailure: (modelId, providerId, errText) =>
      feedback.push({ kind: "failure", modelId, providerId, errText }),
    reportSuccess: () => {},
  });
  const listenerErrors = [];
  setLlmCallListeners({ onError: (err) => listenerErrors.push(String(err)) });

  __setCompleteSimpleForTest(errorStub(RAW_403));
  try {
    const result = await callLlm(stubModel, "fake-key", "sys", "user", {
      sdkRetries: 0,
      maxRetries: 0,
    });
    assert.ok("error" in result, "expected an error result");
    // Raw for classification/rotation: the WAF markers must reach the ring.
    assert.equal(feedback.length, 1, "exactly one failure fed back");
    assert.ok(
      feedback[0].errText.includes(tag("!doctype", "html")),
      "key-ring feedback keeps the raw page (its WAF classifier needs it)",
    );
    assert.equal(listenerErrors.length, 1, "exactly one listener error");
    assert.ok(
      listenerErrors[0].includes(tag("!doctype", "html")),
      "session-health listener keeps the raw page for classification",
    );
    // While the caller-visible copy stays sanitized.
    assert.equal(result.error, "403 Blocked (text/html, ~12KB)");
  } finally {
    __setCompleteSimpleForTest(null);
    resetKeyRingFeedbackHandler();
    setLlmCallListeners({});
  }
});

await test("callLlm: a thrown payload error is sanitized on the catch path", async () => {
  __resetRateLimitCooldownForTest();
  clearLogBuffer();
  setGlobalLogLevel("debug");
  __setCompleteSimpleForTest(async () => {
    throw new Error("provider stream failed: " + RAW_403);
  });
  try {
    const result = await callLlm(stubModel, "fake-key", "sys", "user", {
      sdkRetries: 0,
      maxRetries: 0,
    });
    assert.ok("error" in result, "expected an error result");
    assert.ok(
      !result.error.includes(LT),
      `returned error must be sanitized, got: ${result.error.slice(0, 120)}`,
    );
    assert.ok(
      result.error.includes("403 Blocked (text/html, ~12KB)"),
      `sanitized summary must survive the prefix text, got: ${result.error}`,
    );
    for (const line of llmCallLogs()) {
      assert.ok(!line.message.includes(LT), `no markup in log: ${line.message.slice(0, 200)}`);
    }
  } finally {
    __setCompleteSimpleForTest(null);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== llm-call error log hygiene tests passed ===");
