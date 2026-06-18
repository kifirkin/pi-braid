/**
 * P2-11: critic-gate tierPolicy propagation.
 *
 * HISTORY (2026-06-18):
 *   critic-gate is used by metacognition tools (think.ts,
 *   hypothesize.ts) to decide whether to do an expensive
 *   generative LLM call. The gate accepts a heuristic fallback
 *   but DID NOT accept a tierPolicy. So the 2 callers that
 *   needed B-class tierPolicy (fallback-only, downweight heuristic
 *   to 0.5 confidence) had no way to declare it.
 *
 * FIX:
 *   - CriticGateOptions.tierPolicy added.
 *   - criticGate() passes tierPolicy through to classify().
 *   - think.ts and hypothesize.ts now set tierPolicy:
 *     "fallback-only" with comments explaining why.
 *
 * This test pins the contract at the source level (no LLM needed).
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const criticGateSrc = readFileSync(
  join(ROOT, "src/lib/ai/critic-gate.ts"),
  "utf-8",
);
const thinkSrc = readFileSync(
  join(ROOT, "src/extensions/cognitive/metacognition/handlers/think.ts"),
  "utf-8",
);
const hypSrc = readFileSync(
  join(ROOT, "src/extensions/cognitive/metacognition/handlers/hypothesize.ts"),
  "utf-8",
);

assert.ok(
  existsSync(join(ROOT, "src/lib/ai/critic-gate.ts")),
  "critic-gate.ts must exist",
);

console.log("=== P2-11 critic-gate tierPolicy ===\n");

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

test("CriticGateOptions.tierPolicy is declared", () => {
  assert.match(
    criticGateSrc,
    /tierPolicy\?:\s*"prefer-heuristic"\s*\|\s*"fallback-only"\s*\|\s*"always-llm"/,
    "CriticGateOptions must declare tierPolicy union type",
  );
});

test("criticGate passes tierPolicy to classify()", () => {
  // Find the classify() call inside criticGate
  const block = criticGateSrc.match(
    /await classify\(ctx, opts\.criteria, opts\.input,\s*\{[\s\S]*?\}/,
  );
  assert.ok(block, "criticGate must have an await classify() call");
  assert.match(
    block[0],
    /tierPolicy:\s*opts\.tierPolicy/,
    "criticGate must pass tierPolicy through to classify()",
  );
});

test("think.ts criticGate call sets tierPolicy: fallback-only", () => {
  // Find the think.ts criticGate call block
  const thinkGateBlock = thinkSrc.match(
    /criticGate\(ctx,\s*\{[\s\S]*?\}\);/,
  );
  assert.ok(thinkGateBlock, "think.ts must call criticGate");
  assert.match(
    thinkGateBlock[0],
    /tierPolicy:\s*"fallback-only"/,
    "think.ts criticGate must set tierPolicy: 'fallback-only' (B-class heuristic)",
  );
});

test("hypothesize.ts criticGate call sets tierPolicy: fallback-only", () => {
  const hypGateBlock = hypSrc.match(
    /criticGate\(ctx,\s*\{[\s\S]*?\}\);/,
  );
  assert.ok(hypGateBlock, "hypothesize.ts must call criticGate");
  assert.match(
    hypGateBlock[0],
    /tierPolicy:\s*"fallback-only"/,
    "hypothesize.ts criticGate must set tierPolicy: 'fallback-only' (B-class heuristic)",
  );
});

test("Both callers have P2-11 B-class comments explaining why", () => {
  assert.match(
    thinkSrc,
    /P2-11 B-class:.*keyword-list heuristic/,
    "think.ts must have a P2-11 B-class justification comment",
  );
  assert.match(
    hypSrc,
    /P2-11 B-class:.*length-based heuristic/,
    "hypothesize.ts must have a P2-11 B-class justification comment",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== P2-11 critic-gate tierPolicy tests passed ===");