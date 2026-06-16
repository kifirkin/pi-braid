/**
 * Test: classifier passes reasoning: "minimal" + maxTokens: 64 by default.
 *
 * BACKGROUND (2026-06-16):
 *   User report: mistral-small-2603 and minimax-m3 both have
 *   `reasoning: true` in their pi-ai model spec. When classify()
 *   doesn't pass a `reasoning` option, the model uses its default
 *   thinking level (usually medium/high), which burns the entire
 *   max_tokens budget on internal thinking and produces 0 output
 *   tokens. The user sees:
 *     unparseable label: "" (stopReason=length, used 0/N tokens)
 *
 *   The "used 0/N" smoking gun reveals: the model didn't even try
 *   to answer, it spent all the budget on thinking.
 *
 * FIX:
 *   1. classify() default maxTokens: 10 -> 16 -> 64. Generous
 *      headroom for yes/no answers.
 *   2. classify() passes `reasoning: "minimal"` on every call.
 *      pi-ai's clampThinkingLevel maps "minimal" to the lowest
 *      available level for the model (effectively "off" for models
 *      that support it, otherwise "minimal" or "low" - whichever
 *      is available). This minimizes thinking-token consumption.
 *   3. callLlm() plumbs the `reasoning` option through to
 *      completeSimple (was previously dropped on the floor).
 *
 * This test pins the contract.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FILES = {
  textClassifier: join(ROOT, "src/lib/ai/text-classifier.ts"),
  llmCall: join(ROOT, "src/lib/ai/llm-call.ts"),
};

for (const [name, path] of Object.entries(FILES)) {
  assert.ok(existsSync(path), `${name} source must exist at ${path}`);
}

const classifierSrc = readFileSync(FILES.textClassifier, "utf-8");
const llmCallSrc = readFileSync(FILES.llmCall, "utf-8");

console.log("=== classifier: reasoning: minimal + maxTokens: 64 by default ===\n");

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

// ── classify() defaults ──────────────────────────────────────────────

test("classify() default maxTokens is 64 (not 10 or 16)", () => {
  // The default lives in classify() and is referenced by the
  // `options?.maxTokens ?? <N>` line.
  const match = classifierSrc.match(/options\?\.maxTokens\s*\?\?\s*(\d+)/);
  assert.ok(match, "Could not find default maxTokens in classify()");
  assert.strictEqual(
    Number(match[1]),
    64,
    `classify() default maxTokens should be 64, got ${match[1]}`,
  );
});

test("classify() passes reasoning: 'minimal' on every callLlm call (THE fix)", () => {
  // The tryModelCall function must pass reasoning: "minimal"
  // to callLlm. Without this, modern reasoning-capable models
  // (mistral-small, minimax-m3) burn max_tokens on thinking
  // and produce 0 output tokens.
  const tryModelCallBody = classifierSrc.match(
    /async function tryModelCall[\s\S]*?\n\}/,
  );
  assert.ok(tryModelCallBody, "tryModelCall function not found");
  const body = tryModelCallBody[0];
  assert.match(
    body,
    /reasoning:\s*["']minimal["']/,
    "tryModelCall must pass reasoning: 'minimal' to callLlm to suppress thinking tokens",
  );
});

// ── callLlm plumbing ────────────────────────────────────────────────

test("callLlm() has a `reasoning` option in its public type", () => {
  // The option is documented in the LlmCallOptions interface.
  // Including it here means future contributors can opt out of
  // thinking for other call sites (not just classify()).
  assert.match(
    llmCallSrc,
    /export interface LlmCallOptions[\s\S]*?reasoning\?:\s*"minimal"\s*\|\s*"low"/,
    "LlmCallOptions interface must include a 'reasoning' option",
  );
});

test("callLlm() plumbs the reasoning option through to completeSimple", () => {
  // The actual plumbing: when options.reasoning is set, it must
  // be passed to completeSimple. Without this the option is just
  // a documentation-only change.
  assert.match(
    llmCallSrc,
    /options\.reasoning\s*\?\s*\{[\s\S]*?reasoning:\s*options\.reasoning[\s\S]*?\}\s*:\s*\{\}/,
    "callLlm must pass options.reasoning to completeSimple when set",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== classifier reasoning fix tests passed ===");
