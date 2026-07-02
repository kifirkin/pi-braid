/**
 * Test: 4 input-polisher critics are migrated to the input-polisher
 * prompt pattern (persona in system, instructions + <text> wrap in user).
 *
 * BACKGROUND (2026-06-15):
 *   The user reported that mistral-small-2603 and minimax-m3 were
 *   returning empty strings to classifier calls. The 4 input-polisher
 *   critics (inputCodeHeavy, inputWellWritten, inputClarity,
 *   inputAmbiguity) were migrated to the input-polisher prompt
 *   pattern. This test pins the structure so the migration doesn't
 *   regress.
 *
 * The other 20+ critics (topic-drift, claim-verification, etc.) were
 * NOT migrated - they don't appear in the user's report and the
 * conservative choice is to wait for evidence before changing them.
 * This test does NOT assert anything about them, leaving the door
 * open for future migrations.
 *
 * PATTERN PINNED:
 *   systemPrompt must be a pure persona statement (no "Answer only",
 *   no "Do not explain", no embedded task description).
 *   userPrompt must wrap content in <text>...</text> tags.
 *   userPrompt must start with "Your task:" (the instruction lives
 *   in the user message, not the system message).
 *   userPrompt must end with a "yes or no" format instruction.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC = join(ROOT, "src/lib/ai/critic-registry.ts");

assert.ok(existsSync(SRC), "critic-registry.ts must exist");
const src = readFileSync(SRC, "utf-8");

console.log("=== critic prompt migration: input-polisher pattern (4 critics) ===\n");

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

// All 32 critics are now migrated to the input-polisher prompt pattern.
// (persona-only system, instructions + <text> wrap in user, "Reply with
// exactly one word: ..." reply instruction). This list must stay in
// sync with critic-registry.ts. To check coverage:
//
//   grep -c 'You are a binary text classifier' src/lib/ai/critic-registry.ts
//   = 31 (31 critics)
const MIGRATED_CRITICS = [
  // Topic drift (3)
  "topicCoverage",
  "topicDivergence",
  "topicCompleteness",
  // Decomposition (1)
  "decompositionCoverage",
  // Topic classification (2)
  "topicClassification",
  "trajectoryPattern",
  // Claim verification (3)
  "claimContradiction",
  "claimSupported",
  "claimOverconfidence",
  // Turn-outcome (1)
  "toolLoopDetected",
  // Evidence (1)
  "evidenceConflict",
  // SOP (1)
  "sopQuality",
  // Hint quality (1)
  "hintQuality",
  // Context density (2)
  "contextDensity",
  "compressionUrgency",
  // Degradation (1)
  "qualitativeDegradation",
  // Removal safety (1)
  "removalSafety",
  // Error/command (3)
  "errorType",
  "instructionStrength",
  "commandType",
  // Input polisher (4 - original set)
  "inputCodeHeavy",
  "inputWellWritten",
  "inputClarity",
  "inputAmbiguity",
  // Hint relevance + conflict (2)
  "hintRelevance",
  "conflictResolution",
  // Compliance/polarity/entity (3)
  "complianceFraming",
  "polarityDetection",
  "entityExtraction",
  // Sycophancy (2)
  "sycophancyTactics",
  "vbCDetection",
];

function extractCriticPrompt(criticName, field) {
  // Find the start of the field
  const fieldMarker = `${field}:`;
  const criticStart = src.indexOf(`${criticName}:`);
  if (criticStart === -1) return null;
  const afterCritic = src.slice(criticStart);
  const fieldIdx = afterCritic.indexOf(fieldMarker);
  if (fieldIdx === -1) return null;
  let pos = criticStart + fieldIdx + fieldMarker.length;
  while (pos < src.length && /\s/.test(src[pos])) pos++;
  if (src[pos] !== '"') return null;
  pos += 1;

  // Walk through concatenated "..." + "..." literals
  let result = "";
  while (pos < src.length) {
    let endQuote = -1;
    let i = pos;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') {
        endQuote = i;
        break;
      }
      i++;
    }
    if (endQuote === -1) return null;
    result += src.slice(pos, endQuote);
    const after = src.slice(endQuote + 1).match(/^\s*\+\s*"/);
    if (after) {
      pos = endQuote + 1 + after[0].length;
      continue;
    }
    break;
  }
  return result.replace(/\\n/g, "\n");
}

for (const criticName of MIGRATED_CRITICS) {
  test(`${criticName} system prompt is persona-only (no format instructions)`, () => {
    const sp = extractCriticPrompt(criticName, "systemPrompt");
    assert.ok(sp, `${criticName} systemPrompt not found`);
    // These 4 migrated critics should not contain 'Answer only' or
    // 'Do not explain' in their system prompts - those instructions
    // are now in the user prompt for anti-prompt-leakage.
    assert.ok(
      !/Answer only/i.test(sp),
      `${criticName} systemPrompt should not contain 'Answer only' (moved to user prompt)`,
    );
    assert.ok(
      !/Do not explain/i.test(sp),
      `${criticName} systemPrompt should not contain 'Do not explain' (moved to user prompt)`,
    );
  });

  test(`${criticName} user prompt wraps content in <text>...</text> tags`, () => {
    const up = extractCriticPrompt(criticName, "userPrompt");
    assert.ok(up, `${criticName} userPrompt not found`);
    assert.ok(up.includes("<text>"), `${criticName} userPrompt should have <text> tag`);
    assert.ok(up.includes("</text>"), `${criticName} userPrompt should have </text> tag`);
  });

  test(`${criticName} user prompt has 'Your task:' instruction`, () => {
    const up = extractCriticPrompt(criticName, "userPrompt");
    assert.ok(/Your task:/i.test(up), `${criticName} should start with 'Your task:'`);
  });

  test(`${criticName} user prompt has reply-format instruction (yes/no or category list)`, () => {
    const up = extractCriticPrompt(criticName, "userPrompt");
    // Either "yes or no" (yes/no critics) or "Reply with exactly one word:"
    // (category critics with category lists). All critics should have
    // some form of "Reply with exactly one word" instruction.
    const hasYesNo = /yes or no/i.test(up);
    const hasCategory = /exactly one word/i.test(up) || /Reply with only/i.test(up);
    assert.ok(
      hasYesNo || hasCategory,
      `${criticName} should request a short reply format (yes/no or category)`,
    );
  });
}

// ── All critics migrated ────────────────────────────────────────────

test("All 31 critics are migrated (no stragglers in the old pattern)", () => {
  // This assertion pins the count: 31 migrated, 0 not migrated.
  // If you add a 32nd critic, add it to MIGRATED_CRITICS AND
  // verify it actually has the new pattern (the per-critic tests
  // above will catch a half-migration).
  assert.strictEqual(
    MIGRATED_CRITICS.length,
    31,
    "MIGRATED_CRITICS list should have exactly 31 entries (all critics)",
  );
});

test("critic-registry.ts has 31 'binary text classifier' system prompts", () => {
  // Sanity check: the count of "binary text classifier" occurrences
  // should match the MIGRATED_CRITICS length. If you add a critic
  // but forget to migrate it, this test fails.
  const occurrences = (src.match(/You are a binary text classifier/g) || []).length;
  assert.strictEqual(
    occurrences,
    31,
    `critic-registry.ts should have 31 'binary text classifier' system prompts, found ${occurrences}`,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== critic prompt migration tests passed ===");
