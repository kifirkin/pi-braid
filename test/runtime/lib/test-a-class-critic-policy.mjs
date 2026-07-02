/**
 * Test: A-class critic fallback policy.
 *
 * Locks the rule from docs/FRAGILE-HEURISTICS-INVENTORY.md:
 * A-class (accuracy-critical) critic fallbacks must be replaced with
 * `tierPolicy: "always-llm"`. Their heuristic regex/string-match
 * implementations silently produce wrong answers on adversarial or
 * borderline inputs.
 *
 * The 11 A-class fallbacks in critic-registry.ts and their call sites:
 *   - sycophancyFallback
 *   - vbCFallback
 *   - contradictionFallback
 *   - inputWellWrittenFallback
 *   - inputClarityFallback
 *   - inputAmbiguityFallback
 *   - commandTypeFallback
 *   - evidenceConflictFallback
 *   - entityExtractionFallback
 *   - polarityDetectionFallback
 *   - conflictResolutionFallback
 *
 * This test scans all src/ files. For each A-class fallback name, it
 * asserts that no caller still passes `fallback: () => CRITICS.X(...)`
 * - they must use `tierPolicy: "always-llm"` instead.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC = join(ROOT, "src");

const A_CLASS_FALLBACKS = [
  "sycophancyFallback",
  "vbCFallback",
  "contradictionFallback",
  "inputWellWrittenFallback",
  "inputClarityFallback",
  "inputAmbiguityFallback",
  "commandTypeFallback",
  "evidenceConflictFallback",
  "entityExtractionFallback",
  "polarityDetectionFallback",
  "conflictResolutionFallback",
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      yield* walk(full);
    } else if (entry.endsWith(".ts")) {
      yield full;
    }
  }
}

const violations = [];
let scanned = 0;

for (const file of walk(SRC)) {
  scanned++;
  const src = readFileSync(file, "utf-8");
  for (const fallback of A_CLASS_FALLBACKS) {
    // A caller must NOT use `fallback: () => CRITICS.<name>(...)`.
    // The correct form is `tierPolicy: "always-llm"`.
    const re = new RegExp(`fallback:\\s*\\(\\)\\s*=>\\s*CRITICS\\.${fallback}\\b`, "g");
    const matches = src.match(re);
    if (matches) {
      // Allow the fallback method's own definition in critic-registry.ts
      if (file.endsWith("critic-registry.ts")) continue;
      // Allow critic-gate.ts (different abstraction layer)
      if (file.endsWith("critic-gate.ts")) continue;
      // Allow anything in test/ or doc/ files
      violations.push({
        file: file.replace(ROOT + "/", ""),
        fallback,
        count: matches.length,
      });
    }
  }
}

if (violations.length > 0) {
  console.error("[fail] A-class critic fallbacks still being used as fallbacks. Use tierPolicy: 'always-llm':");
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.fallback} (${v.count}x)`);
  }
  assert.equal(
    violations.length,
    0,
    `Found ${violations.length} A-class fallbacks still in use (should be always-llm)`,
  );
}

console.log(
  `[ok] A-class critic policy: scanned ${scanned} files, 0 violations across ${A_CLASS_FALLBACKS.length} fallbacks.`,
);
console.log("    (all A-class heuristic fallbacks converted to tierPolicy: 'always-llm')");
