/**
 * Regression test: input-critic's overall tier is "failed" when all checks
 * fail (not silently "utility").
 *
 * HISTORY (2026-06-15):
 *   The input polisher's classifier was reporting TIER 2 + TIER 3 as
 *   failing repeatedly. The `critiqueInput()` function returned an
 *   `overallTier` of "utility" even when every per-check call had
 *   `tier: "failed"` (because the priority resolution only checked
 *   for "heuristic" and "session" in the array, falling through to
 *   "utility" as default). The consumer (input-polisher/index.ts)
 *   checked `critique.isCode || (critique.isWellWritten && critique.isClear)`
 *   which evaluates to false for "unknown" labels, so the polisher
 *   would proceed with a FULL LLM polish call when the cheaper
 *   classifier had just failed.
 *
 * FIX:
 *   - input-critic.ts now correctly returns tier="failed" when all
 *     per-check tiers are "failed". The "failed" variant was added
 *     to the CritiqueResult type union.
 *   - input-polisher/index.ts checks `critique.tier === "failed"`
 *     FIRST and skips polishing (returns action="handled" with the
 *     original text) when the classifier is down. This prevents the
 *     expensive polish LLM call when we don't know if the input
 *     needs work.
 *
 *   The classifier's text-classifier.ts also now surfaces the actual
 *   error message in log.debug() instead of swallowing it, so future
 *   "classifier always fails" reports will show the underlying cause
 *   (rate limit, model not found, timeout, etc.) in the operator log.
 *
 * This test pins the contract at the input-critic level: when all
 * checks fail, the result's tier field is "failed" (not "utility"),
 * and the type signature allows it.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const INPUT_CRITIC_SRC = readFileSync(
  join(ROOT, "src/extensions/core/input-polisher/input-critic.ts"),
  "utf-8",
);
const INPUT_POLISHER_SRC = readFileSync(
  join(ROOT, "src/extensions/core/input-polisher/index.ts"),
  "utf-8",
);
const TEXT_CLASSIFIER_SRC = readFileSync(
  join(ROOT, "src/lib/ai/text-classifier.ts"),
  "utf-8",
);

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

console.log("=== input-critic failed-tier regression ===\n");

// ── input-critic.ts: tier union includes "failed" ────────────────────────

test("CritiqueResult.tier type union includes \"failed\"", () => {
  assert.match(
    INPUT_CRITIC_SRC,
    /tier:\s*"utility"\s*\|\s*"session"\s*\|\s*"heuristic"\s*\|\s*"failed"/,
    'CritiqueResult.tier must include "failed" so consumers can detect classifier failure',
  );
});

test("overallTier returns \"failed\" when no per-check succeeded", () => {
  // The new logic: anySucceeded check + fallback to "failed" if none
  assert.match(
    INPUT_CRITIC_SRC,
    /anySucceeded/,
    "input-critic must check anySucceeded to detect fully-failed state",
  );
  assert.match(
    INPUT_CRITIC_SRC,
    /overallTier:\s*"utility"\s*\|\s*"session"\s*\|\s*"heuristic"\s*\|\s*"failed"\s*=/,
    "overallTier type must allow \"failed\" as a value",
  );
  assert.match(
    INPUT_CRITIC_SRC,
    /!anySucceeded\s*\?\s*"failed"/,
    "tier resolution must include the \"failed\" fallback (anySucceeded ? ... : \"failed\")",
  );
});

// ── input-polisher/index.ts: handles failed tier ────────────────────────

test("input-polisher checks tier === \"failed\" before doing the expensive polish call", () => {
  // The fix: a "failed" tier means the classifier is down. The polisher
  // should NOT proceed with a full LLM polish call (waste of compute)
  // and should NOT auto-send (would surprise the user). Instead it
  // returns the original text untouched.
  const hasCheck = /critique\.tier\s*===\s*"failed"/.test(INPUT_POLISHER_SRC);
  assert.ok(hasCheck, 'input-polisher must check critique.tier === "failed"');
  // The check should appear BEFORE the isCode/isWellWritten check
  // (which is the expensive path that we want to skip when failed).
  const failedIdx = INPUT_POLISHER_SRC.indexOf('critique.tier === "failed"');
  const expensiveIdx = INPUT_POLISHER_SRC.indexOf("critique.isCode || (critique.isWellWritten && critique.isClear)");
  assert.ok(
    failedIdx > 0 && failedIdx < expensiveIdx,
    "tier === \"failed\" check must come BEFORE the expensive polish-skip check",
  );
});

test("input-polisher skips polish (returns handled) when classifier failed", () => {
  // The failed branch should call setEditorText(original) and
  // resolve to { action: "handled" } - it should NOT call
  // processMessage() (the expensive polish path).
  const failedBranchStart = INPUT_POLISHER_SRC.indexOf('critique.tier === "failed"');
  const nextBlock = INPUT_POLISHER_SRC.slice(failedBranchStart, failedBranchStart + 1000);
  assert.match(
    nextBlock,
    /setEditorText\(original\)/,
    "failed branch must restore original text",
  );
  assert.match(
    nextBlock,
    /action:\s*"handled"/,
    "failed branch must resolve as handled (don't re-polish)",
  );
  assert.doesNotMatch(
    nextBlock,
    /processMessage\(/,
    "failed branch must NOT call processMessage (that's the expensive path)",
  );
});

// ── text-classifier.ts: surfaces error messages ────────────────────────

test("text-classifier tryModelCall surfaces the actual error in log.debug", () => {
  // Previously tryModelCall returned null and only the outer
  // "TIER X failed" log line was emitted. Now the actual callLlm
  // error message is included in the log so the operator can
  // diagnose why the classifier is failing.
  assert.match(
    TEXT_CLASSIFIER_SRC,
    /log\.debug\(`\[text-classifier\][^`]*\$\{result\.error\}/,
    "tryModelCall must log the actual callLlm error (not just 'failed')",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== input-critic failed-tier regression tests passed ===");
