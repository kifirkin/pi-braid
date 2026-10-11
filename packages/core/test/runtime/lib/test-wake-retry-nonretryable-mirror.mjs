#!/usr/bin/env node
/**
 * test-wake-retry-nonretryable-mirror.mjs
 *
 * Pins the wake-retry queue's non-retryable veto (WAKE_NON_RETRYABLE_ERROR_PATTERN
 * behind isRetryableWakeError, extensions/scheduling/timer/wake-retry.ts)
 * against the INSTALLED pi-ai classifier it mirrors.
 *
 * The failure mode: isRetryableWakeError answers "will pi-core auto-retry this
 * failed run inside the same run?". A wrong yes holds the wake's outcome window
 * for a retry that never comes; a wrong no lets drainDue arm a redelivery in
 * the middle of pi-core's retry cycle: the flood the hold exists to prevent.
 * The mirror is hand-written, so the tokens it vetoes are derived here from the
 * module it mirrors instead of being copied beside it.
 *
 * Pinned exhaustively: every literal in pi-ai's
 * NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN array, read out of the installed
 * dist file, must be vetoed by the mirror even when the same text also carries
 * a retryable marker: pi-ai's veto outranks its retryable match, so the wake
 * must not be held. An upstream addition fails this file.
 *
 * NOT pinned: the retryable side of the mirror (WAKE_RETRYABLE_ERROR_PATTERN) is
 * a hand-written subset of pi-ai's retryable classes. The witnesses below check
 * that side only on the texts listed, so this file claims no equivalence for
 * texts outside them.
 *
 * Run: node test/runtime/lib/test-wake-retry-nonretryable-mirror.mjs
 * (the compiled dist/ tree is required: `npm test` builds it first).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { isRetryableWakeError } =
  await import("../../../dist/extensions/scheduling/timer/wake-retry.js");

// Both derivations come from the SAME installed module: the classifier is the
// oracle for every probe, and the pattern source is where the token list lives
// (pi-ai does not export the pattern itself).
const retryModulePath = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/utils/retry"));
const { isRetryableAssistantError } = await import(retryModulePath);
const retryModuleSource = readFileSync(retryModulePath, "utf8");

/** The message shape isRetryableAssistantError inspects. */
const failedMessage = (errorMessage) => ({
  role: "assistant",
  stopReason: "error",
  errorMessage,
});

/**
 * pi-ai's declared non-retryable literals. The constant is not exported, so the
 * array literal is read out of the shipped source; a shape change (rename,
 * computed array) fails loudly here instead of silently shrinking the set.
 */
function upstreamFatalTokens() {
  const declaration =
    /const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN\s*=\s*buildProviderErrorPattern\(\[([\s\S]*?)\]\)/.exec(
      retryModuleSource,
    );
  assert.ok(
    declaration,
    `${retryModulePath}: NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN is no longer built from a literal array`,
  );
  const parsed = [...declaration[1].matchAll(/"([^"]*)"/g)].map((match) => match[1]);
  assert.ok(
    parsed.length >= 8,
    `${retryModulePath}: parsed ${parsed.length} fatal tokens: the pattern source shape changed`,
  );
  return parsed;
}

/**
 * Texts whose expected verdict comes from the real classifier at run time, not
 * from a table written here: each one is a case where the two mirrors could
 * drift apart, including "429 usage limit reached", a text pi-ai DOES retry:
 * so a veto on the bare phrase "usage limit" would settle a wake mid-retry.
 */
const WITNESSES = [
  "429 too many requests",
  "429 usage limit reached",
  "Monthly usage limit reached",
  "GoUsageLimitError",
  "subscription_sharing_usage_limit_exceeded",
  "HTTP 503 Service Unavailable",
  "insufficient_quota: monthly limit",
  "context length limit exceeded",
  "",
];

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}\n    ${error.message}`);
  }
}

test("every fatal token the installed pi-ai declares is vetoed by the wake mirror", () => {
  const tokens = upstreamFatalTokens();
  for (const token of tokens) {
    // The carrier makes the probe a real divergence witness: the text is
    // retryable on its own, so only pi-ai's veto (and the mirror's) keeps the
    // wake from being held.
    const probe = `${token} 429`;
    assert.equal(
      isRetryableAssistantError(failedMessage(probe)),
      false,
      `precondition: the installed pi-ai must veto "${token}"`,
    );
    assert.equal(isRetryableWakeError(probe), false, `the wake mirror must veto "${token}"`);
  }
});

test("the wake mirror agrees with the installed pi-ai on the witness texts", () => {
  for (const text of WITNESSES) {
    assert.equal(
      isRetryableWakeError(text),
      isRetryableAssistantError(failedMessage(text)),
      `disagrees with pi-ai on "${text}"`,
    );
  }
});

test("non-strings never hold a wake", () => {
  assert.equal(isRetryableWakeError(undefined), false);
  assert.equal(isRetryableWakeError("   "), false);
});

console.log(`\n${failed === 0 ? "all tests passed" : `${failed} failed`}`);
process.exit(failed > 0 ? 1 : 0);
