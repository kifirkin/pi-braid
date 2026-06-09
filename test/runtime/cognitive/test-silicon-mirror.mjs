/**
 * Silicon Mirror (Sycophancy Detector) — behavior tests.
 *
 * The detector's primary path is the utility-model `classify()` call (in
 * `src/extensions/cognitive/sycophancy-detector/index.ts`), which uses
 * `CRITICS.sycophancyTactics` / `CRITICS.vbCDetection` from critic-registry.
 * `classify()` itself requires a live pi ExtensionContext with a model
 * registry, so we test the **heuristic fallbacks** that ship with those
 * critic definitions. If the fallbacks are correct, the offline
 * classification path is correct.
 *
 * Research base: arxiv:2604.00478 "The Silicon Mirror" (K&W 2026)
 *                arxiv:2604.19117 "LLMs know they're wrong" (Pandey 2026)
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { CRITICS } = await import(
  join(ROOT, "dist/lib/ai/critic-registry.js")
);

const { sycophancyFallback, vbCFallback } = CRITICS;

let passed = 0;
let failed = 0;
const check = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else      { failed++; console.log(`  ❌ ${msg}`); }
};

// ── [1] sycophancyFallback: positive cases ────────────────────────────
console.log("\n[1] sycophancyFallback — should trigger on pressure tactics");
const positiveCases = [
  ["Surely you must agree that this approach is correct?",       "AGREEABLENESS"],
  ["I think the bug is in the loop. You must be right about that.", "AGREEABLENESS dual"],
  ["Why did you choose that approach? That solution is bad.",    "LOADED_QUESTION + SKEPTICISM"],
  ["As an expert, this is definitely the wrong way to do it",    "AUTHORITY + CONFIDENCE"],
  ["Obviously the code always works that way. Trust me.",        "CONFIDENCE + AUTHORITY"],
  ["Why would you use that library? Everyone knows it's terrible.", "SKEPTICISM + AUTHORITY"],
  ["You must agree that connection pooling is the solution.",    "AGREEABLENESS single"],
];
for (const [input, label] of positiveCases) {
  check(sycophancyFallback(input) === "yes", `triggers: ${label}`);
}

// ── [2] sycophancyFallback: negative cases ───────────────────────────
console.log("\n[2] sycophancyFallback — should NOT trigger on neutral input");
const negativeCases = [
  ["Can you help me debug this code?",                        "neutral request"],
  ["What's the best way to implement a cache?",               "neutral question"],
  ["I'm getting Error 500 on the API endpoint. Any ideas?",   "technical report"],
  ["The test suite fails on this edge case.",                  "bug report"],
  ["Please refactor this function to use modern JS.",         "task request"],
  ["How do I sort this array in descending order?",            "how-to question"],
];
for (const [input, label] of negativeCases) {
  check(sycophancyFallback(input) === "no", `ignores: ${label}`);
}

// ── [3] vbCFallback: positive cases ────────────────────────────────
console.log("\n[3] vbCFallback — should detect validation-before-correction");
const vbcCases = [
  ["You're right that the database could be the issue. However, looking at the stack trace, the actual problem is in the connection pool.",
    "classic VbC: 'you're right' + 'however'"],
  ["I agree that we should consider Redis. But for this specific case an in-memory cache is better.",
    "'I agree' + 'but'"],
  ["I think you are right about the race condition. However the real issue is incorrect serialization in the schema.",
    "'you are right' + 'however'"],
];
for (const [input, label] of vbcCases) {
  check(vbCFallback(input) === "yes", `detects: ${label}`);
}

// ── [4] vbCFallback: short input is too short to be VbC ───────────
console.log("\n[4] vbCFallback — short input is not VbC");
const tooShort = ["OK.", "Got it.", "Yes."];
for (const input of tooShort) {
  check(vbCFallback(input) === "no", `rejects: "${input}"`);
}

// ── Report ─────────────────────────────────────────────────────────
console.log(`\n==================================================`);
console.log(`Silicon Mirror Tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
