/**
 * Provider-failure classification: the status decides first, and a number is
 * a status only where the text frames one.
 *
 * Two defects the census reproduced against the shipped classifier are pinned
 * here in both directions:
 *
 *   - `4012` is a millisecond figure, not an HTTP 401. Reading it as one made
 *     a connect timeout `auth`: no retry, and the owner asked for a credential
 *     that was never rejected.
 *   - `Ваш баланс исчерпан` is an exhausted account, not an `unknown`
 *     failure. `unknown` is retryable, so the refusal was retried forever.
 *
 * The contract the file tests:
 *
 *   1. A status the failure carries - on the error object, or framed in its
 *      text (first, parenthesised, behind `HTTP`, behind a status word) -
 *      names the class; the wording arms never outrank it.
 *   2. A three-digit run the text does not frame is not a status, so a
 *      duration, a port, a buffered count and a token count stay `unknown`.
 *   3. Wording that names a class is the fallback for a message that frames
 *      no status, and the balance table carries the recorded localised refusal.
 *   4. Every category keeps the retry policy it had; classification changes,
 *      policy does not.
 *
 * Test imports target the built dist/ (npm test builds first); no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { classifyLlmError, extractHttpCodeFromText, isContextWindowErrorText } = await import(
  join(ROOT, "dist", "lib", "errors", "llm-error.js")
);

/** A gateway's 429 prefix in the shape the session store records it. */
const GATEWAY_429 =
  '429: {"type":"server_error","message":"Upstream request failed: [prefill_cap_refused] the cell is at capacity; retry shortly (after 30 s)"}';

// ── 1. The two census directions ────────────────────────────────────────────

test("a millisecond figure is not a status, so a timeout is retried", () => {
  for (const failure of [
    { message: "Connect timeout after 4012 ms" },
    "Connect timeout after 4012 ms",
    "4012 ms",
  ]) {
    const verdict = classifyLlmError(failure);
    assert.notEqual(verdict.category, "auth", `${JSON.stringify(failure)} is not a credential fact`);
    assert.equal(verdict.retryable, true, "a timeout is retried");
    assert.equal(verdict.userActionRequired, false, "a timeout asks nothing of the owner");
  }
});

test("an exhausted balance in the owner's language is balance", () => {
  for (const failure of [{ message: "Ваш баланс исчерпан" }, "Ваш баланс исчерпан"]) {
    const verdict = classifyLlmError(failure);
    assert.equal(verdict.category, "balance", "an exhausted account is not an unknown failure");
    assert.equal(verdict.retryable, false, "the same call cannot succeed");
    assert.equal(verdict.userActionRequired, true, "the owner tops the balance up");
  }
});

// ── 2. Anchoring: a number is a status only where the text frames one ──────

test("a longer number is not a status in any numeric class", () => {
  const cases = [
    ["1429", "rate_limit"],
    ["1429 requests buffered", "rate_limit"],
    ["1413 tokens", "context_window"],
    ["1402 buffered", "balance"],
    ["4012 ms", "auth"],
  ];
  for (const [text, forbidden] of cases) {
    assert.notEqual(
      classifyLlmError(text).category,
      forbidden,
      `${JSON.stringify(text)} must not read as ${forbidden}`,
    );
  }
});

test("a framed status still decides (the control)", () => {
  assert.equal(classifyLlmError(GATEWAY_429).category, "rate_limit");
  assert.equal(classifyLlmError(GATEWAY_429).retryable, true);
  assert.equal(classifyLlmError("402 Payment Required").category, "balance");
  assert.equal(classifyLlmError("HTTP 401 Unauthorized").category, "auth");
  assert.equal(classifyLlmError("502 Bad Gateway").category, "transient");
  const payload = classifyLlmError("HTTP 413 Request Entity Too Large");
  assert.equal(payload.category, "context_window");
  assert.equal(payload.requestShape, "context_length");
});

test("the framed status outranks the wording a provider body carries", () => {
  // A server that failed is not the owner's key, whatever its body says.
  assert.equal(
    classifyLlmError('503: {"message":"Account authentication is unavailable"}').category,
    "transient",
  );
  assert.equal(
    classifyLlmError({ message: "authentication failed", status: 503 }).category,
    "transient",
  );
  // The object's own code outranks a status printed in the body.
  assert.equal(
    classifyLlmError({ message: "429 rate limit exceeded", status: 402 }).category,
    "balance",
  );
});

test("abort keeps its precedence over a status", () => {
  assert.equal(classifyLlmError({ name: "AbortError", status: 500 }).category, "abort");
});

test("a 403 is not classified by its number alone", () => {
  // The recorded 403 shapes are a spent quota, a WAF block, a payload refusal
  // and a capacity refusal. None of them is a rejected credential, so the
  // number cannot decide; the wording does, and the shapes that name a class
  // keep it.
  const cases = [
    ['403: {"message":"User has no quota left"}', "unknown"],
    ["403 Request blocked by WAF", "unknown"],
    ["403 prefill_cap_refused: the cell is at capacity", "unknown"],
    ["403 context_length_exceeded", "context_window"],
  ];
  for (const [text, expected] of cases) {
    assert.equal(classifyLlmError(text).category, expected, text);
  }
});

// ── 3. Request shape ────────────────────────────────────────────────────────

test("a 400 that names a context-length refusal is request shape", () => {
  const incident =
    '400: {"type":"invalid_request_error","message":"Upstream request failed: This model\'s maximum ' +
    'context length is 1048576 tokens. However, you requested 1147002 tokens. ' +
    'Please reduce the length of the messages or completion."}';
  const verdict = classifyLlmError(incident);
  assert.equal(verdict.category, "context_window");
  assert.equal(verdict.requestShape, "context_length");
  assert.equal(verdict.retryable, false);

  const unremarkable = classifyLlmError(
    '400: {"type":"invalid_request_error","message":"bad tool schema"}',
  );
  assert.equal(unremarkable.category, "unknown");
  assert.equal(unremarkable.requestShape, undefined);
});

test("the payload predicate reads a framed status and rejects a substring", () => {
  assert.equal(isContextWindowErrorText("413: Request Entity Too Large"), true);
  assert.equal(isContextWindowErrorText("413"), true);
  assert.equal(isContextWindowErrorText("context_length_exceeded"), true);
  assert.equal(isContextWindowErrorText("4130 tokens requested"), false);
  assert.equal(isContextWindowErrorText("HTTP 503"), false);
  assert.equal(extractHttpCodeFromText("HTTP 503"), 503);
  assert.equal(extractHttpCodeFromText("code 1429 garbage"), undefined);
});

// ── 4. Policy is the classifier's, and it did not move ─────────────────────

test("every category keeps its retry policy", () => {
  const expected = {
    balance: { retryable: false, fallbackToNonLlm: true, userActionRequired: true },
    rate_limit: { retryable: true, fallbackToNonLlm: false, userActionRequired: false },
    context_window: { retryable: false, fallbackToNonLlm: true, userActionRequired: false },
    transient: { retryable: true, fallbackToNonLlm: false, userActionRequired: false },
    abort: { retryable: false, fallbackToNonLlm: false, userActionRequired: false },
    auth: { retryable: false, fallbackToNonLlm: true, userActionRequired: true },
    unknown: { retryable: true, fallbackToNonLlm: false, userActionRequired: false },
  };
  const samples = {
    balance: "insufficient balance",
    rate_limit: "429 Too Many Requests",
    context_window: "HTTP 413 payload too large",
    transient: "ETIMEDOUT",
    abort: { name: "AbortError" },
    auth: "401 Unauthorized",
    unknown: "a string that names nothing",
  };
  for (const [category, failure] of Object.entries(samples)) {
    const verdict = classifyLlmError(failure);
    assert.equal(verdict.category, category, `sample for ${category}`);
    assert.deepEqual(
      {
        retryable: verdict.retryable,
        fallbackToNonLlm: verdict.fallbackToNonLlm,
        userActionRequired: verdict.userActionRequired,
      },
      expected[category],
      `retry policy for ${category}`,
    );
  }
});
