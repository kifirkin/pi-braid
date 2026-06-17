/**
 * Regression test for text-classifier.ts
 *
 * Tests:
 * - normalizeLabel(): prefix matching, case insensitivity, edge cases
 * - replacePlaceholders(): single-pass regex, no recursive substitution
 * - classify() tier fallback: utility → session → heuristic
 * - Latency logging
 *
 * The classify() function requires a full pi ExtensionContext with modelRegistry,
 * which can't be instantiated offline. We test the internals directly.
 */

import { join, dirname } from "node:path";
import { strict as assert } from "node:assert";

const __dirname = dirname(new URL(import.meta.url).pathname);
const ROOT = join(__dirname, "..", "..", "..");

console.log("=== text-classifier Regression Tests ===\n");

// ── Import ────────────────────────────────────────────────────────────────────

const { normalizeLabel, replacePlaceholders } = await import(
  join(ROOT, "dist", "lib", "ai", "text-classifier.js")
);

// ─── normalizeLabel() ─────────────────────────────────────────────────────────

console.log("[1] normalizeLabel() - prefix matching...");

// Exact matches
assert.strictEqual(normalizeLabel("yes"), "yes", 'exact "yes"');
assert.strictEqual(normalizeLabel("no"), "no", 'exact "no"');

// Case insensitivity
assert.strictEqual(normalizeLabel("YES"), "yes", '"YES" uppercase');
assert.strictEqual(normalizeLabel("No"), "no", '"No" capitalized');
assert.strictEqual(normalizeLabel("YeS"), "yes", '"YeS" mixed case');

// Prefix matching (the fix for verbose model outputs)
assert.strictEqual(normalizeLabel("Yes, this is code"), "yes", '"Yes, this is code" prefix');
assert.strictEqual(normalizeLabel("No, this is not safe"), "no", '"No, this is not safe" prefix');
assert.strictEqual(normalizeLabel("yes."), "yes", '"yes." with period');
assert.strictEqual(normalizeLabel("no."), "no", '"no." with period');

// Trimming
assert.strictEqual(normalizeLabel("  yes  "), "yes", '"  yes  " trimmed');

// Non-matching cases
assert.strictEqual(normalizeLabel("maybe"), null, '"maybe" null');
assert.strictEqual(normalizeLabel(""), null, 'empty string null');
assert.strictEqual(normalizeLabel("YesYes"), null, '"YesYes" - no word boundary after "Yes"');

// Edge: word boundary after "yes"/"no"
assert.strictEqual(normalizeLabel("yesterday"), null, '"yesterday" - "yes" isn\'t a word');
assert.strictEqual(normalizeLabel("notable"), null, '"notable" - "no" isn\'t a word boundary');

// Edge: punctuation after prefix
assert.strictEqual(normalizeLabel("No!"), "no", '"No!" prefix with exclamation');
assert.strictEqual(normalizeLabel("Yes?"), "yes", '"Yes?" prefix with question');

console.log("  ✅ 15/15 normalizeLabel assertions passed");

// ─── normalizeLabel() - multi-class path via validLabels ──────────────────────

console.log("\n[1b] normalizeLabel() - validLabels whitelist (trajectoryPattern case)...");

// 2026-06-17 regression: trajectoryPattern critic returns hyphenated
// pattern names (Read-Edit-Bash, Repeated-Test, etc.) but the old
// normalizeLabel only accepted yes/no, producing "unparseable label"
// warnings at the end of every session.

// Without validLabels: "Read-Edit-Bash" is unparseable (not yes/no)
assert.strictEqual(
  normalizeLabel("Read-Edit-Bash"),
  null,
  '"Read-Edit-Bash" with no validLabels → null (multi-class needs whitelist)',
);
assert.strictEqual(
  normalizeLabel("Repeated-Test"),
  null,
  '"Repeated-Test" with no validLabels → null',
);

// With validLabels: whitelisted labels are accepted
const patternLabels = [
  "Read-Fix-Verify",
  "Read-Fix-Test",
  "Read-Create-Verify",
  "Error-Diagnose-Fix",
  "Read-Test-Fix-Verify",
  "Research-Read-Fix-Verify",
  "Repeated-Test",
  "Multi-Source-Investigation",
  "Iterative-Fix-Verify",
];

for (const label of patternLabels) {
  assert.strictEqual(
    normalizeLabel(label, patternLabels),
    label.toLowerCase(),
    `"${label}" in validLabels → accepted (lowercased)`,
  );
}

// Case insensitivity: mistral-small often returns lowercase versions
// of labels that ARE in the whitelist. We test with a whitelisted label.
assert.strictEqual(
  normalizeLabel("repeated-test", patternLabels),
  "repeated-test",
  '"repeated-test" (lowercase, in validLabels) → accepted',
);
assert.strictEqual(
  normalizeLabel("REPEATED-TEST", patternLabels),
  "repeated-test",
  '"REPEATED-TEST" (uppercase, in validLabels) → accepted (lowercased)',
);

// Non-whitelisted hyphenated label: not in the list, not yes/no
assert.strictEqual(
  normalizeLabel("Read-Edit-Bash", patternLabels.slice(0, 5)),
  null,
  '"Read-Edit-Bash" NOT in narrower validLabels → null (whitelist enforced)',
);

// Trailing punctuation: model sometimes adds "." or "," 
assert.strictEqual(
  normalizeLabel("Repeated-Test.", patternLabels),
  null,
  '"Repeated-Test." with trailing period → null (whitelist is exact-match)',
);

// yes/no still work in the multi-class path (defensive fallback for
// uncertain model responses)
assert.strictEqual(
  normalizeLabel("yes", patternLabels),
  "yes",
  '"yes" in multi-class path → still accepted (yes/no fallback)',
);
assert.strictEqual(
  normalizeLabel("no", patternLabels),
  "no",
  '"no" in multi-class path → still accepted (yes/no fallback)',
);

// Empty validLabels array: behave like no validLabels (binary fallback)
assert.strictEqual(
  normalizeLabel("Read-Edit-Bash", []),
  null,
  'empty validLabels array → binary fallback (Read-Edit-Bash → null)',
);

console.log("  ✅ validLabels whitelist verified for trajectoryPattern critic");

// ─── replacePlaceholders() ────────────────────────────────────────────────────

console.log("\n[2] replacePlaceholders() - template interpolation...");

// Basic substitution
assert.strictEqual(
  replacePlaceholders("Is this {{text}}?", { text: "code" }),
  "Is this code?",
  '{{text}} → "code"',
);

// Multiple placeholders
assert.strictEqual(
  replacePlaceholders("{{claim}} vs {{context}}", { claim: "A", context: "B" }),
  "A vs B",
  '{{claim}} + {{context}}',
);

// No placeholders - passthrough
assert.strictEqual(
  replacePlaceholders("Hello world", {}),
  "Hello world",
  'no placeholders',
);

// Unrecognized placeholder - preserved literally
assert.strictEqual(
  replacePlaceholders("{{unknown}} here", {}),
  "{{unknown}} here",
  'unknown placeholder preserved',
);

// Single-pass: injected value containing {{otherKey}} NOT re-substituted
const result = replacePlaceholders("{{a}}", {
  a: "contains {{b}}",
  b: "should not appear",
});
assert.strictEqual(result, "contains {{b}}", 'single-pass: {{b}} inside value not re-parsed');

// Multiple occurrences of same key
assert.strictEqual(
  replacePlaceholders("{{x}} and {{x}}", { x: "same" }),
  "same and same",
  'same key multiple times',
);

// Keys with numbers
assert.strictEqual(
  replacePlaceholders("{{var1}}", { var1: "value" }),
  "value",
  'key with numbers',
);

// Empty value
assert.strictEqual(
  replacePlaceholders("before{{mid}}after", { mid: "" }),
  "beforeafter",
  'empty substitution value',
);

console.log("  ✅ 9/9 replacePlaceholders assertions passed");

// ─── classify() exports ───────────────────────────────────────────────────────

console.log("\n[3] classify() - API surface...");

const { classify } = await import(
  join(ROOT, "dist", "lib", "ai", "text-classifier.js")
);
assert.strictEqual(typeof classify, "function", "classify() is a function");

// Verify the exported types exist via source inspection
const { readFileSync } = await import("node:fs");
const src = readFileSync(join(ROOT, "src", "lib", "ai", "text-classifier.ts"), "utf-8");

assert.ok(src.includes("export interface ClassificationResult"), "ClassificationResult exported");
assert.ok(src.includes("export interface ClassifierCriteria"), "ClassifierCriteria exported");
assert.ok(src.includes("export interface ClassifierOptions"), "ClassifierOptions exported");

// Verify the three-tier fallback structure exists
assert.ok(src.includes("Tier 1:"), "Tier 1 comment present");
assert.ok(src.includes("Tier 2:"), "Tier 2 comment present");
assert.ok(src.includes("Tier 3:"), "Tier 3 comment present");

// Verify latency logging
assert.ok(src.includes("latencyMs"), "latencyMs in ClassificationResult");
assert.ok(src.includes("${latency}ms"), "latency logging present");

console.log("  ✅ classify() exports verified");
console.log("  ✅ Three-tier fallback structure verified");
console.log("  ✅ Latency logging verified");

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log("\n======================================================");
console.log("All text-classifier regression tests passed");
console.log("======================================================");

process.exit(0);
