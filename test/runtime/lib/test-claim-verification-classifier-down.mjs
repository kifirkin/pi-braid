/**
 * Test: claim-verification reports classifierDown when classifier is down.
 *
 * HISTORY (2026-06-15):
 *   Following the input-polisher 9966c8ad, topic-drift b25006f3,
 *   sycophancy b25006f3, turn-outcome fc492a54, and cognitive
 *   topic-drift f28d2d54 fixes: any detector that calls classify()
 *   must propagate classifierDown. The verify_claim tool runs 3
 *   classify() calls (contradiction, support, overconfidence).
 *   When the utility model is down, all 3 return tier=failed and
 *   the previous code silently returned "no issues" - a clean
 *   pass, even though the check could not run normally.
 *
 * FIX:
 *   - checkSupport returns { supported, classifierDown }
 *   - checkOverconfidence returns { issues, classifierDown }
 *   - checkContradiction returns a richer object including
 *     classifierDown when result.tier === 'failed'
 *   - The tool execute() aggregates anyClassifierDown and surfaces
 *     it in:
 *     * The summary text ("Claim verification DEGRADED...")
 *     * The details object (classifierDown flag)
 *     * The verified field (set to false when classifier is down,
 *       so downstream consumers don't treat it as a clean pass)
 *
 * This test pins the contract.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FILES = {
  claimVerification: join(ROOT, "src/extensions/cognitive/metacognition/handlers/claim-verification.ts"),
};

for (const [name, path] of Object.entries(FILES)) {
  assert.ok(existsSync(path), `${name} source file should exist at ${path}`);
}

const src = readFileSync(FILES.claimVerification, "utf-8");

console.log("=== claim-verification classifierDown regression ===\n");

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

// Helper: extract a function body by anchoring to the next `async function` or `function`
// declaration. The simple brace-counting approach fails because the return type
// contains `{ ... }` (e.g. `Promise<{ supported: boolean; classifierDown: boolean }>`).
function extractFunctionBody(src, fnName) {
  const startIdx = src.indexOf(`async function ${fnName}(`);
  if (startIdx === -1) return null;
  // Find the next function declaration to use as the end anchor.
  // Search the substring AFTER startIdx for the next 'async function' or 'function' line.
  const searchFrom = startIdx + `async function ${fnName}(`.length;
  const rest = src.slice(searchFrom);
  const nextFnMatch = rest.match(/\nasync function |\nfunction /);
  if (nextFnMatch) {
    return rest.slice(0, nextFnMatch.index);
  }
  return rest;
}

test("checkSupport returns object with supported + classifierDown", () => {
  const body = extractFunctionBody(src, "checkSupport");
  assert.ok(body, "checkSupport function not found");
  assert.match(
    body,
    /Promise<\{[\s\S]*?supported:\s*boolean[\s\S]*?classifierDown:\s*boolean[\s\S]*?\}>/,
    "checkSupport return type must include both supported and classifierDown",
  );
  assert.ok(
    /supported:\s*result\.label === "yes"/.test(body),
    "checkSupport must set supported = result.label === 'yes'",
  );
  assert.ok(
    /classifierDown:\s*result\.tier === "failed"/.test(body),
    "checkSupport must set classifierDown = result.tier === 'failed'",
  );
});

test("checkSupport catch block returns classifierDown = true", () => {
  const body = extractFunctionBody(src, "checkSupport");
  const catchBlock = body.match(
    /\} catch \(err\) \{[\s\S]*?return \{[\s\S]*?classifierDown: true[\s\S]*?\};[\s\S]*?\}/,
  );
  assert.ok(catchBlock, "catch block must return { classifierDown: true, supported: false }");
});

test("checkOverconfidence returns object with issues + classifierDown", () => {
  const body = extractFunctionBody(src, "checkOverconfidence");
  assert.ok(body, "checkOverconfidence function not found");
  assert.match(
    body,
    /Promise<\{[\s\S]*?issues:\s*Array[\s\S]*?classifierDown:\s*boolean[\s\S]*?\}>/,
    "checkOverconfidence return type must include both issues and classifierDown",
  );
  assert.ok(
    /classifierDown:\s*result\.tier === "failed"/.test(body),
    "checkOverconfidence must set classifierDown = result.tier === 'failed'",
  );
});

test("checkOverconfidence catch block returns classifierDown = true", () => {
  const body = extractFunctionBody(src, "checkOverconfidence");
  const catchBlock = body.match(
    /\} catch \(err\) \{[\s\S]*?return \{[\s\S]*?classifierDown: true[\s\S]*?\};[\s\S]*?\}/,
  );
  assert.ok(catchBlock, "catch block must return { classifierDown: true, issues: [] }");
});

test("checkContradiction includes classifierDown in the success-path return", () => {
  const body = extractFunctionBody(src, "checkContradiction");
  assert.ok(body, "checkContradiction function not found");
  // The success-path return (label === "yes") should include the
  // classifierDown flag so the consumer can track the offline state
  // even when a contradiction IS detected.
  assert.ok(
    /classifierDown:\s*result\.tier === "failed"/.test(body),
    "checkContradiction success-path return must include classifierDown flag",
  );
});

test("Tool execute() destructures classifierDown from sub-checks", () => {
  const toolBody = src.match(
    /execute: async[\s\S]*?return\s*\{[\s\S]*?\};/,
  );
  assert.ok(toolBody, "Tool execute() body not found");
  const body = toolBody[0];
  assert.ok(
    /supportedResult\.classifierDown/.test(body),
    "Tool execute() must read supportedResult.classifierDown",
  );
  assert.ok(
    /overconfidenceResult\.classifierDown/.test(body),
    "Tool execute() must read overconfidenceResult.classifierDown",
  );
  assert.ok(
    /const anyClassifierDown =/.test(body),
    "Tool execute() must aggregate anyClassifierDown",
  );
});

test("Tool result summary mentions 'DEGRADED' when classifier is down", () => {
  const toolBody = src.match(
    /execute: async[\s\S]*?return\s*\{[\s\S]*?\};/,
  );
  assert.ok(toolBody, "Tool execute() body not found");
  const body = toolBody[0];
  assert.match(
    body,
    /const summary = anyClassifierDown[\s\S]*?Claim verification DEGRADED/i,
    "Summary must say 'Claim verification DEGRADED' when classifier is down",
  );
  assert.match(
    body,
    /\/logs level info/,
    "Summary must point the operator to /logs level info for the underlying error",
  );
});

test("Tool result 'verified' field is false when classifier is down", () => {
  const toolBody = src.match(
    /execute: async[\s\S]*?return\s*\{[\s\S]*?\};/,
  );
  assert.ok(toolBody, "Tool execute() body not found");
  const body = toolBody[0];
  assert.match(
    body,
    /verified:\s*highIssues\.length === 0 && !anyClassifierDown/,
    "verified must be false when anyClassifierDown is true (so downstream consumers don't treat it as a clean pass)",
  );
});

test("Tool result details object includes classifierDown flag", () => {
  const toolBody = src.match(
    /execute: async[\s\S]*?return\s*\{[\s\S]*?\};/,
  );
  assert.ok(toolBody, "Tool execute() body not found");
  const body = toolBody[0];
  assert.match(
    body,
    /classifierDown:\s*anyClassifierDown/,
    "details object must include classifierDown flag for analytics",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== claim-verification classifierDown regression tests passed ===");
