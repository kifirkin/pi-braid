/**
 * Test: Sycophancy detector reports classifierDown when the LLM is offline.
 *
 * HISTORY (2026-06-15):
 *   The sycophancy detector ran two classify() calls: one for user
 *   input tactics, one for assistant VbC. When the utility model was
 *   down, both returned tier: "failed" with label: "unknown". The
 *   detector then returned risk.score = 0 (silent default to "no
 *   problem") and the consumer had no way to know the monitor was
 *   offline. Same anti-pattern as the input-polisher (9966c8ad) and
 *   topic-drift fixes.
 *
 * FIX: SycophancyRisk gets a new optional `classifierDown` field. The
 * consumer (handleSycophancy) checks it and emits a separate
 * 'user_risk_classifier_down' signal so the operator knows the
 * monitor is offline.
 *
 * This test pins the contract at the source level.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FILES = {
  sycophancy: join(ROOT, "src/extensions/cognitive/sycophancy-detector/index.ts"),
};

for (const [name, path] of Object.entries(FILES)) {
  assert.ok(existsSync(path), `${name} source file should exist at ${path}`);
}

const src = readFileSync(FILES.sycophancy, "utf-8");

console.log("=== sycophancy classifierDown regression ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(`  [x] ${name}: ${e.message}`);
    failed++;
  }
}

test("SycophancyRisk interface includes classifierDown field", () => {
  const ifaceMatch = src.match(
    /interface SycophancyRisk\s*\{([\s\S]*?)\n\}/,
  );
  assert.ok(ifaceMatch, "SycophancyRisk interface not found");
  const body = ifaceMatch[1];
  assert.ok(
    /classifierDown\??:\s*boolean/.test(body),
    "SycophancyRisk must include classifierDown?: boolean",
  );
});

test("computeRisk sets classifierDown = result.classifierDown", () => {
  // After EW-7.4 migration to classifyWithOffline(), the offline
  // signal is exposed as result.classifierDown (not the raw tier).
  // The function must propagate it to the safe-default return.
  assert.match(
    src,
    /classifierDown:\s*result\.classifierDown/,
    "computeRisk must set classifierDown = result.classifierDown on the safe-default return",
  );
  // And it must use classifyWithOffline() now
  assert.match(
    src,
    /classifyWithOffline\(/,
    "computeRisk should call classifyWithOffline() (EW-7.4 migration)",
  );
});

test("computeRisk safe-default still returns score:0 (don't false-positive)", () => {
  // The fix must NOT change the score - it must remain 0 (the safe
  // default) so consumers that don't check classifierDown still get
  // sensible behavior. The new field is OPTIONAL and additive.
  const computeRiskBody = src.match(
    /async function computeRisk[\s\S]*?\n\}/,
  );
  assert.ok(computeRiskBody, "computeRisk body not found");
  const body = computeRiskBody[0];
  assert.ok(
    /score:\s*0,/.test(body),
    "computeRisk must still return score:0 on the safe-default path",
  );
  assert.ok(
    /classifierDown:\s*result\.classifierDown/.test(body),
    "computeRisk must add classifierDown flag to the safe-default return",
  );
});

test("handleSycophancy emits 'user_risk_classifier_down' signal when down", () => {
  assert.match(
    src,
    /if \(risk\.classifierDown\)[\s\S]*?emitSignal\(ctx, "sycophancy", "user_risk_classifier_down"/,
    "handleSycophancy must emit a 'user_risk_classifier_down' signal when the classifier is down",
  );
});

test("handleSycophancy uses warn severity for the offline signal (operator visibility)", () => {
  assert.match(
    src,
    /emitSignal\(ctx, "sycophancy", "user_risk_classifier_down", "warn"/,
    "The offline signal must use 'warn' severity (the operator should know)",
  );
});

test("handleSycophancy includes classifierDown flag in the main signal metadata", () => {
  // The 'sycophancy detected' signal should also carry the
  // userRiskClassifierDown flag so analytics can see the offline state.
  assert.match(
    src,
    /userRiskClassifierDown: risk\.classifierDown \?\? false/,
    "Main signal metadata must include userRiskClassifierDown flag",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== sycophancy classifierDown regression tests passed ===");
