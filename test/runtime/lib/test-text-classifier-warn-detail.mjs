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
 *   - classify() captures the reason in tier2FailureReason /
 *     tier3FailureReason
 *   - The WARN messages inline the reason:
 *     [text-classifier] TIER 2 failed (utility model 'X'): <reason>. Falling to TIER 3.
 *     [text-classifier] TIER 3 failed (session model 'Y'): <reason>.
 *   - The "ALL TIERS FAILED" message also includes the captured
 *     reasons so the user sees both at once.
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
  assert.match(
    body,
    /return \{ ok: false, reason: `unparseable label:/,
    "Unparseable label branch must return a reason that includes 'unparseable label'",
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

test("classify() declares tier2FailureReason and tier3FailureReason", () => {
  assert.match(
    src,
    /let tier2FailureReason: string \| null = null/,
    "classify() must declare tier2FailureReason before the TIER 2 call",
  );
  assert.match(
    src,
    /let tier3FailureReason: string \| null = null/,
    "classify() must declare tier3FailureReason before the TIER 3 call",
  );
});

test("classify() captures tier2 reason from tryModelCall result", () => {
  assert.match(
    src,
    /tier2FailureReason = tier1 && !tier1\.ok \? tier1\.reason : "unknown failure"/,
    "TIER 2 failure must capture the actual reason (with 'unknown failure' fallback)",
  );
});

test("classify() captures tier3 reason from tryModelCall result", () => {
  assert.match(
    src,
    /tier3FailureReason = tier2 && !tier2\.ok \? tier2\.reason : "unknown failure"/,
    "TIER 3 failure must capture the actual reason (with 'unknown failure' fallback)",
  );
});

test("TIER 2 warn includes the actual reason inline (not behind /logs)", () => {
  assert.match(
    src,
    /log\.warn\(\s*`\[text-classifier\] TIER 2 failed \(utility model '\$\{utilityModel\.id\}'\): \$\{tier2FailureReason\}\. Falling to TIER 3\.`/,
    "TIER 2 warn must inline the reason: '[text-classifier] TIER 2 failed (utility model 'X'): <reason>. Falling to TIER 3.'",
  );
});

test("TIER 3 warn includes the actual reason inline", () => {
  assert.match(
    src,
    /log\.warn\(\s*`\[text-classifier\] TIER 3 failed \(session model '\$\{sessionModel\.id\}'\): \$\{tier3FailureReason\}\.`/,
    "TIER 3 warn must inline the reason: '[text-classifier] TIER 3 failed (session model 'Y'): <reason>.'",
  );
});

test("ALL TIERS FAILED warn includes both reasons for the operator", () => {
  assert.match(
    src,
    /TIER 2: \$\{tier2FailureReason \?\? "no utility model configured"\}/,
    "ALL TIERS FAILED message must include TIER 2 reason with a 'no utility model configured' fallback",
  );
  assert.match(
    src,
    /TIER 3: \$\{tier3FailureReason \?\? "no session model"\}/,
    "ALL TIERS FAILED message must include TIER 3 reason with a 'no session model' fallback",
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
