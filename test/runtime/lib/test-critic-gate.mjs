/**
 * Test: Critic Gate - pre-check classifier for generative LLM calls.
 *
 * Tests the source file for:
 *   - Correct export of criticGate function
 *   - Proper triple-tier fallback pattern
 *   - Correct return types (CriticGateResult)
 *   - Integration points (hypothesize.ts, think.ts import it)
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ── Source files ────────────────────────────────────────────────────────────

const FILES = {
  criticGate: join(ROOT, "src/lib/ai/critic-gate.ts"),
  hypothesize: join(ROOT, "src/extensions/cognitive/metacognition/handlers/hypothesize.ts"),
  think: join(ROOT, "src/extensions/cognitive/metacognition/handlers/think.ts"),
};

for (const [name, path] of Object.entries(FILES)) {
  assert.ok(existsSync(path), `${name} source file should exist at ${path}`);
}

const gateSrc = readFileSync(FILES.criticGate, "utf-8");
const hypotSrc = readFileSync(FILES.hypothesize, "utf-8");
const thinkSrc = readFileSync(FILES.think, "utf-8");

// ── Tests ─────────────────────────────────────────────────────────────────────

// Test 1: criticGate export signature
assert.ok(gateSrc.includes("export async function criticGate("), "should export criticGate async function");
assert.ok(gateSrc.includes("CriticGateOptions"), "should export CriticGateOptions type");
assert.ok(gateSrc.includes("CriticGateResult"), "should export CriticGateResult type");

// Test 2: Three-tier fallback pattern
assert.ok(gateSrc.includes("shouldProceed: false"), "should handle skip path");
assert.ok(gateSrc.includes("suggestedDepth: \"deep\""), "should handle deep path");
assert.ok(gateSrc.includes("suggestedDepth: \"normal\""), "should handle normal path");
assert.ok(gateSrc.includes("label: opts.name"), "should pass label for observability");
assert.ok(gateSrc.includes("fallback: opts.fallback"), "should pass fallback to classify");

// Test 3: Uses classify() under the hood
assert.ok(gateSrc.includes("from \"./text-classifier.js\""), "should import classify from text-classifier");

// Test 4: Integration - hypothesize.ts imports criticGate
assert.ok(hypotSrc.includes("critic-gate"), "hypothesize.ts should import from critic-gate");
assert.ok(hypotSrc.includes("criticGate"), "hypothesize.ts should call criticGate");

// Test 5: Integration - think.ts imports criticGate
assert.ok(thinkSrc.includes("critic-gate"), "think.ts should import from critic-gate");
assert.ok(thinkSrc.includes("criticGate"), "think.ts should call criticGate");

// Test 6: hypothesize gate message uses result fields
assert.ok(hypotSrc.includes("gate.shouldProceed"), "hypothesize should check gate.shouldProceed");
assert.ok(hypotSrc.includes("gate.suggestedDepth"), "hypothesize should check gate.suggestedDepth");

// Test 7: hypothesize has skip path for insufficient evidence
assert.ok(hypotSrc.includes("gate.message"), "hypothesize should show gate.message when skipped");

console.log("\n=== Results: All critic-gate tests passed ===");
