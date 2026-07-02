/**
 * Test: Text Classifier tierPolicy contract.
 *
 * Locks the new tierPolicy semantics:
 *  - "always-llm": tier 1 (heuristic) is skipped entirely.
 *  - "fallback-only": tier 1 used, but confidence reduced to 0.5.
 *  - "prefer-heuristic" (default): tier 1 used at 0.7 confidence.
 *  - validLabels whitelist: heuristic answer must be in the set,
 *    otherwise fall through to LLM.
 *
 * Regression test for the silent-drop bug: previously the matcher
 * only accepted "yes"/"no", dropping labels like "positive",
 * "STABLE", "AGGRESSIVE", etc.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const SRC = join(ROOT, "src/lib/ai/text-classifier.ts");
assert.ok(existsSync(SRC), "text-classifier.ts must exist");

const src = readFileSync(SRC, "utf-8");

// ── 1. ClassifierOptions has tierPolicy ───────────────────────────────────

assert.ok(
  /tierPolicy\?:\s*"prefer-heuristic"\s*\|\s*"fallback-only"\s*\|\s*"always-llm"/.test(src),
  "ClassifierOptions must include tierPolicy: 'prefer-heuristic' | 'fallback-only' | 'always-llm'",
);

// ── 2. ClassifierOptions has validLabels ───────────────────────────────────

assert.ok(
  /validLabels\?:\s*string\[\]/.test(src),
  "ClassifierOptions must include validLabels?: string[]",
);

// ── 3. Tier 1 skip on always-llm ───────────────────────────────────────────

// Find the Tier 1 block and verify it gates on tierPolicy.
// Anchor on the section header (with box-drawing chars) to avoid matching
// the JSDoc "Tier 1: Heuristic fallback callback..." line.
const tier1Block = src.match(/\/\/ ── Tier 1:[\s\S]*?\n  \}/);
assert.ok(tier1Block, "Tier 1 block should be present");
assert.ok(
  /tierPolicy !== "always-llm"/.test(tier1Block[0]),
  "Tier 1 must skip when tierPolicy === 'always-llm'",
);

// ── 4. validLabels enforcement ─────────────────────────────────────────────

assert.ok(
  /validLabels\.includes\(lower\)/.test(src),
  "When validLabels is set, heuristic answer must be in the whitelist",
);

// ── 5. fallback-only reduces confidence to 0.5 ────────────────────────────

assert.ok(
  /\?\s*0\.5\s*:\s*0\.7/.test(src),
  "fallback-only must reduce tier 1 confidence from 0.7 to 0.5",
);

// ── 6. Default 0.7 confidence preserved ────────────────────────────────────

assert.ok(
  /confidence,/.test(tier1Block[0]),
  "Default confidence should be dynamic (0.7 or 0.5 based on tierPolicy)",
);

console.log("[ok] text-classifier tierPolicy contract locked:");
console.log("    - always-llm skips tier 1");
console.log("    - fallback-only uses tier 1 with 0.5 confidence");
console.log("    - prefer-heuristic uses tier 1 with 0.7 confidence");
console.log("    - validLabels whitelist enforced when set");
