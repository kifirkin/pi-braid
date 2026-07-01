/**
 * Test: text-classifier TIER 2/3 warn messages include the actual
 * failure reason (not just "model error").
 *
 * HISTORY (2026-06-15):
 *   User reported classifier "always failing" with messages like:
 *     TIER 2 failed (utility model 'mistral-small-2603'), falling to TIER 3
 *     TIER 3 failed (session model error), returning 'unknown'
 *   The actual underlying reason (429, API key invalid, timeout,
 *   unparseable label) was hidden behind a /logs level info pointer,
 *   which was friction. The user wants the actual error INLINE in
 *   the warn message.
 *
 * FIX:
 *   - tryModelCall now returns { ok: false, reason: string } on
 *     failure (with the actual callLlm error, throw message, or
 *     "unparseable label" text)
 *   - classify() captures the reason in a failureReasons array
 *     (replaced hardcoded tier2FailureReason/tier3FailureReason
 *     when the dynamic tier loop was introduced for modelPreference
 *     strategies)
 *   - The WARN messages inline the reason:
 *     [text-classifier] TIER N failed (tier.name model 'model.id'): <reason>.
 *   - The "ALL TIERS FAILED" message includes all captured reasons.
 *
 * This test pins the contract at the source level.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC = join(ROOT, "src/lib/ai/text-classifier.ts");

assert.ok(existsSync(SRC), "text-classifier.ts must exist");
const src = readFileSync(SRC, "utf-8");

console.log("=== text-classifier warn detail regression ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

// ── tryModelCall return-type contract ───────────────────────────────────

test("tryModelCall return type includes ok: boolean discriminator", () => {
  const fnBody = src.match(
    /async function tryModelCall[\s\S]*?\n\}/,
  );
  assert.ok(fnBody, "tryModelCall function not found");
  const body = fnBody[0];
  assert.match(
    body,
    /Promise<[\s\S]*?ok:\s*true;[\s\S]*?raw:\s*string;[\s\S]*?label:\s*string[\s\S]*?\|[\s\S]*?ok:\s*false;[\s\S]*?reason:\s*string[\s\S]*?>/,
    "tryModelCall must return a discriminated union: { ok: true, raw, label } | { ok: false, reason }",
  );
});

test("tryModelCall returns { ok: false, reason } on API-key missing", () => {
  const fnBody = src.match(
    /async function tryModelCall[\s\S]*?\n\}/,
  );
  assert.ok(fnBody, "tryModelCall function not found");
  const body = fnBody[0];
  assert.match(
    body,
    /if \(!apiKey\) return \{ ok: false, reason: `no API key for provider/,
    "Missing API key must return a reason that includes 'no API key for provider'",
  );
});

test("tryModelCall returns { ok: false, reason } on callLlm error", () => {
  const fnBody = src.match(
    /async function tryModelCall[\s\S]*?\n\}/,
  );
  assert.ok(fnBody, "tryModelCall function not found");
  const body = fnBody[0];
  assert.match(
    body,
    /if \("error" in result\)[\s\S]*?return \{ ok: false, reason: result\.error \}/,
    "callLlm error branch must return { ok: false, reason: result.error } (the actual error message)",
  );
});

test("tryModelCall returns { ok: false, reason } on unparseable label", () => {
  const fnBody = src.match(
    /async function tryModelCall[\s\S]*?\n\}/,
  );
  assert.ok(fnBody, "tryModelCall function not found");
  const body = fnBody[0];
  // The reason must include 'unparseable label' so classify() can
  // include the actual reason in TIER 2/3 warns. The exact string
  // format may evolve (we now also include stopReason and usage),
  // but the leading prefix is stable.
  assert.match(
    body,
    /ok:\s*false[,\s]+reason:.*unparseable label/s,
    "Unparseable label branch must return a reason that includes 'unparseable label'",
  );
});

test("tryModelCall unparseable-label reason surfaces stopReason + token usage (the real fix)", () => {
  // User report (2026-06-15): mistral-small-2603 returns empty with
  // no error. The previous WARN said only 'unparseable label: ""',
  // giving no hint about WHY. With stopReason=length and usage info
  // surfaced inline, the user sees:
  //   'unparseable label: "" (stopReason=length, used 0/16 tokens)'
  // which directly identifies the max_tokens ceiling as the cause.
  //
  // Usage field name: pi-ai uses { input, output, totalTokens }
  // (NOT { inputTokens, outputTokens }) - the test pins the
  // correct field name to prevent re-introducing the wrong name.
  const fnBody = src.match(
    /async function tryModelCall[\s\S]*?\n\}/,
  );
  assert.ok(fnBody, "tryModelCall function not found");
  const body = fnBody[0];
  assert.match(
    body,
    /stopReason/,
    "tryModelCall unparseable branch must reference stopReason in the reason it returns",
  );
  assert.match(
    body,
    /usage\.output\b/,
    "tryModelCall unparseable branch must reference usage.output in the reason (pi-ai field name)",
  );
});

test("tryModelCall catch block returns { ok: false, reason: 'threw: ...' }", () => {
  const fnBody = src.match(
    /async function tryModelCall[\s\S]*?\n\}/,
  );
  assert.ok(fnBody, "tryModelCall function not found");
  const body = fnBody[0];
  assert.match(
    body,
    /\} catch \(e\)[\s\S]*?return \{ ok: false, reason: `threw: \$\{message\}` \}/,
    "Catch block must return { ok: false, reason: 'threw: ...' }",
  );
});

// ── classify() captures reasons and includes them in WARN ───────────────

// With the dynamic tier loop (modelPreference strategies), the old
// hardcoded tier2FailureReason/tier3FailureReason variables are replaced
// by a `failureReasons: string[]` array populated in the loop body.
// Each tier captures its reason inline and the ALL TIERS FAILED message
// includes all captured reasons.

test("classify() declares failureReasons array before the loop", () => {
  assert.match(
    src,
    /const failureReasons: string\[\] = \[\];/,
    "classify() must declare failureReasons array before the TIER loop",
  );
});

test("classify() captures failure reason from tryModelCall result", () => {
  assert.match(
    src,
    /const reason = result && !result\.ok \? result\.reason : "unknown failure";/,
    "TIER failure must capture the actual reason (with 'unknown failure' fallback)",
  );
});

test("TIER warn includes the actual reason inline (not behind /logs)", () => {
  // 2026-06-17: TIER warns now go through a logTierFailure helper
  // that demotes to log.debug when bestEffort is set or the failure
  // was an abort. The reason-inline contract is preserved: the helper
  // is called with a string template that includes the tier name,
  // model ID, and failure reason.
  assert.match(
    src,
    /logTierFailure\(`TIER \$\{tierNum\} failed \(\$\{tier\.name\} model '\$\{tier\.model\.id\}'\): \$\{reason\}\.`\)/,
    "TIER warn must inline the reason: logTierFailure('TIER N failed (tier.name model \\'model.id\\'): <reason>.')",
  );
  // Verify the helper does emit log.warn (not just log.debug) for
  // the non-bestEffort, non-abort case.
  assert.match(
    src,
    /log\.warn\(`\[text-classifier\] \$\{reason\}`\)/,
    "logTierFailure helper must route non-bestEffort, non-abort to log.warn",
  );
});

test("ALL TIERS FAILED warn includes all captured reasons for the operator", () => {
  assert.match(
    src,
    /failureReasons\.join\(" "\);/,
    "ALL TIERS FAILED message must join failureReasons by space",
  );
});

test("No remaining 'Run /logs level info for the actual error' pointer", () => {
  // We removed this friction point per user direction.
  assert.ok(
    !src.includes("Run /logs level info for the actual error"),
    "The 'Run /logs level info' pointer should be removed (the actual error is now inline)",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== text-classifier warn detail regression tests passed ===");