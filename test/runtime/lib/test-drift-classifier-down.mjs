/**
 * Test: Topic-drift detector reports classifierDown when all 3 critics fail.
 *
 * HISTORY (2026-06-15):
 *   The detector ran 3 parallel classify() calls (coverage, divergence,
 *   completeness). When the utility model was down, all 3 returned
 *   tier: "failed" with label: "unknown". The detector then evaluated:
 *     coverageResult?.label === "no"   -> undefined === "no"   -> false
 *     divergenceResult?.label === "yes" -> undefined === "yes" -> false
 *     completenessResult?.label === "no" -> undefined === "no" -> false
 *   So negativeVotes = 0, drifted = false. The detector silently
 *   returned "no drift" when the classifier was down - the same
 *   anti-pattern as the input-polisher bug (commit 9966c8ad).
 *
 * FIX: DriftCheck gets a new optional `classifierDown` field, set when
 * every classify() result has tier === "failed" (or is null). Consumers
 * can distinguish "no drift" from "could not check". The drift-handler
 * emits a "[drift-detector] Classifier unavailable" whisper in the
 * classifierDown case so the agent knows the monitor is offline.
 *
 * This test pins the contract at the source level.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FILES = {
  detector: join(ROOT, "src/lib/detection/topic-drift-detector.ts"),
  driftHandler: join(ROOT, "src/extensions/enforcement/handlers/analysis/drift-handler.ts"),
};

for (const [name, path] of Object.entries(FILES)) {
  assert.ok(existsSync(path), `${name} source file should exist at ${path}`);
}

const detectorSrc = readFileSync(FILES.detector, "utf-8");
const handlerSrc = readFileSync(FILES.driftHandler, "utf-8");

console.log("=== topic-drift classifierDown regression ===\n");

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

test("DriftCheck interface includes classifierDown field", () => {
  const ifaceMatch = detectorSrc.match(
    /export interface DriftCheck\s*\{([\s\S]*?)\n\}/,
  );
  assert.ok(ifaceMatch, "DriftCheck interface not found");
  const body = ifaceMatch[1];
  assert.ok(
    /classifierDown\??:\s*boolean/.test(body),
    "DriftCheck must include classifierDown?: boolean (optional, for back-compat)",
  );
});

test("DriftCheck.classifierDown is documented as a 'detector offline' signal", () => {
  const ifaceMatch = detectorSrc.match(
    /export interface DriftCheck\s*\{([\s\S]*?)\n\}/,
  );
  assert.ok(ifaceMatch, "DriftCheck interface not found");
  const body = ifaceMatch[1];
  assert.ok(
    /classifier is offline|classifier_unavailable|classifierDown/i.test(body),
    "classifierDown field needs a JSDoc comment explaining when it fires",
  );
});

test("check() detects all-failed case via .every tier === 'failed'", () => {
  assert.match(
    detectorSrc,
    /allTiers\.every\(\s*\(r\)\s*=>\s*r === null \|\| r\.tier === "failed"/,
    "check() must set classifierDown when every result is null OR tier === 'failed'",
  );
});

test("check() initializes classifierDown at function start", () => {
  assert.match(
    detectorSrc,
    /let classifierDown = false/,
    "check() must declare classifierDown with default false",
  );
});

test("check() catch block sets classifierDown = true", () => {
  // The outer try/catch around the 3-way classify() should also set
  // classifierDown = true, so a thrown error doesn't silently default
  // to "no drift" either.
  assert.match(
    detectorSrc,
    /catch \{[\s\S]*?classifierDown = true/,
    "catch block must set classifierDown = true so thrown errors are visible too",
  );
});

test("check() returns classifierDown in the result", () => {
  assert.match(
    detectorSrc,
    /return\s*\{[\s\S]*?classifierDown,/,
    "check() must include classifierDown in the returned DriftCheck",
  );
});

test("generateWhisper emits offline message when classifierDown", () => {
  const fnMatch = detectorSrc.match(
    /generateWhisper\(check: DriftCheck\): string \| null\s*\{([\s\S]*?)\n  \}/,
  );
  assert.ok(fnMatch, "generateWhisper function body not found");
  const body = fnMatch[1];
  assert.ok(
    /if \(check\.classifierDown\)/.test(body),
    "generateWhisper must check check.classifierDown FIRST",
  );
  assert.ok(
    /Classifier unavailable|classifier.*offline|drift.*offline/i.test(body),
    "The offline whisper must mention 'Classifier unavailable' or similar",
  );
});

test("generateWhisper still handles the normal drift path after the offline check", () => {
  // The original drift path must be preserved.
  const fnMatch = detectorSrc.match(
    /generateWhisper\(check: DriftCheck\): string \| null\s*\{([\s\S]*?)\n  \}/,
  );
  assert.ok(fnMatch, "generateWhisper function body not found");
  const body = fnMatch[1];
  assert.ok(
    /if \(!check\.drifted\) return null/.test(body),
    "generateWhisper must still return null when not drifted and classifier is up",
  );
  assert.ok(
    /Topic drift detected/.test(body),
    "generateWhisper must still emit 'Topic drift detected' for the normal path",
  );
});

test("drift-handler dispatches on classifierDown", () => {
  // The handler must check classifierDown and emit a separate signal.
  assert.match(
    handlerSrc,
    /driftCheck\.classifierDown/,
    "drift-handler must consult driftCheck.classifierDown",
  );
});

test("drift-handler emits 'classifier_down' signal kind for the offline case", () => {
  assert.match(
    handlerSrc,
    /driftCheck\.classifierDown \? "classifier_down" : "detected"/,
    "drift-handler must use signal kind 'classifier_down' when classifier is down",
  );
});

test("drift-handler uses warn severity for classifier_down (operator should know)", () => {
  assert.match(
    handlerSrc,
    /driftCheck\.classifierDown \? "warn" :/,
    "drift-handler must use 'warn' severity for the offline case (operator visibility)",
  );
});

test("drift-handler tags the source as 'enforcement/drift/offline'", () => {
  assert.match(
    handlerSrc,
    /driftCheck\.classifierDown \? "enforcement\/drift\/offline" : "enforcement\/drift"/,
    "drift-handler must use a distinct source label for the offline case",
  );
});

test("drift-handler passes classifierDown flag to emitSignal", () => {
  // The signal metadata must include classifierDown so downstream
  // consumers (analytics, logging) can see the offline state.
  assert.match(
    handlerSrc,
    /classifierDown: driftCheck\.classifierDown \?\? false/,
    "drift-handler must pass classifierDown flag in the signal metadata",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== topic-drift classifierDown regression tests passed ===");
