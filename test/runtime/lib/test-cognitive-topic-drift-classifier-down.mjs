/**
 * Test: cognitive/topic-drift extension reports classifierDown (parallel to the
 * lib version fix in b25006f3).
 *
 * HISTORY (2026-06-15):
 *   The cognitive/topic-drift extension in
 *   src/extensions/cognitive/topic-drift/index.ts is a SEPARATE
 *   implementation of the same triple-critic drift detection used in
 *   lib/detection/topic-drift-detector.ts (the lib one was fixed in
 *   b25006f3 to report classifierDown). The cognitive clone was missed
 *   in that commit and still has the same anti-pattern: when the
 *   utility model is down, all 3 classify() calls return tier=failed,
 *   and the function silently returns drifted=false, similarity=0.8
 *   (or 1.0 on error). The agent then reads "No topic drift" and
 *   thinks the check ran normally.
 *
 * FIX:
 *   - detectDriftWithCritics() now returns optional classifierDown
 *   - The tool_result handler emits a soft "drift monitor offline"
 *     whisper when classifierDown=true
 *   - The topic_drift tool result text says "drift check unavailable
 *     this turn (classifier offline)" instead of "No topic drift"
 *     when the detector is down
 *   - Both surfaces include classifierDown in their details/recommendations
 *
 * This test pins the contract.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FILES = {
  topicDrift: join(ROOT, "src/extensions/cognitive/topic-drift/index.ts"),
};

for (const [name, path] of Object.entries(FILES)) {
  assert.ok(existsSync(path), `${name} source file should exist at ${path}`);
}

const src = readFileSync(FILES.topicDrift, "utf-8");

console.log("=== cognitive/topic-drift classifierDown regression ===\n");

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

test("detectDriftWithCritics return type includes classifierDown", () => {
  const fnBody = src.match(
    /async function detectDriftWithCritics[\s\S]*?Promise<\{[\s\S]*?\}> \{/,
  );
  assert.ok(fnBody, "detectDriftWithCritics signature not found");
  const body = fnBody[0];
  assert.match(
    body,
    /classifierDown\??:\s*boolean/,
    "Return type must include classifierDown?: boolean",
  );
});

test("detectDriftWithCritics initializes classifierDown = false", () => {
  assert.match(
    src,
    /let classifierDown = false/,
    "Function must initialize classifierDown at the top so it's in scope for the catch block",
  );
});

test("detectDriftWithCritics propagates classifierDown from consolidated critic", () => {
  // The consolidated call returns classifierDown when all model tiers fail.
  // detectDriftWithCritics propagates it directly in the return.
  assert.match(
    src,
    /classifierDown: consolidated\.classifierDown/,
    "Function must propagate classifierDown from consolidatedTopicCritique result",
  );
  // The consolidated critic is called, not the old 3-parallel fallback
  assert.match(
    src,
    /consolidatedTopicCritique\(/,
    "detectDriftWithCritics uses consolidatedTopicCritique (P2-7, no 3-parallel fallback)",
  );
});

test("detectDriftWithCritics catch block sets classifierDown = true", () => {
  const catchBlock = src.match(
    /\} catch \(err\) \{[\s\S]*?return \{[\s\S]*?classifierDown: true[\s\S]*?\};[\s\S]*?\}/,
  );
  assert.ok(catchBlock, "catch block must set classifierDown: true on the error return");
});

test("detectDriftWithCritics return includes classifierDown in the success path", () => {
  assert.match(
    src,
    /return \{[\s\S]*?classifierDown: consolidated\.classifierDown[\s\S]*?\};/,
    "Success-path return must include classifierDown from consolidated result",
  );
});

test("tool_result handler emits a 'drift monitor offline' whisper when classifierDown", () => {
  const handlerBody = src.match(
    /onEvent\(pi, "tool_result", async[\s\S]*?\}\);/,
  );
  assert.ok(handlerBody, "tool_result handler not found");
  const body = handlerBody[0];
  assert.match(
    body,
    /if \(result\.classifierDown\)/,
    "tool_result handler must branch on result.classifierDown",
  );
  assert.match(
    body,
    /Topic drift monitor is offline|drift.*offline/i,
    "The whisper must explicitly mention the monitor is offline",
  );
});

test("tool_result handler's offline whisper includes the original request for self-check", () => {
  const handlerBody = src.match(
    /onEvent\(pi, "tool_result", async[\s\S]*?\}\);/,
  );
  assert.ok(handlerBody, "tool_result handler not found");
  const body = handlerBody[0];
  assert.match(
    body,
    /state\.originalRequest/,
    "The whisper should include state.originalRequest so the agent can self-check against it",
  );
});

test("tool_result handler returns early after the offline whisper (don't proceed to drift check)", () => {
  const handlerBody = src.match(
    /onEvent\(pi, "tool_result", async[\s\S]*?\}\);/,
  );
  assert.ok(handlerBody, "tool_result handler not found");
  const body = handlerBody[0];
  // The classifierDown check should be BEFORE the result.drifted check
  // and should return early so the regular drift path doesn't run.
  const offlineIdx = body.indexOf("if (result.classifierDown)");
  const driftedIdx = body.indexOf("if (result.drifted");
  assert.ok(offlineIdx !== -1 && driftedIdx !== -1, "Both branches must exist");
  assert.ok(offlineIdx < driftedIdx, "Offline check must come BEFORE the normal drift check");
  // The offline block must have a `return;` statement
  const offlineBlock = body.slice(offlineIdx, driftedIdx);
  assert.match(
    offlineBlock,
    /return;/,
    "Offline branch must return early (don't also run the drift detection)",
  );
});

test("topic_drift tool reads classifierDown from critResult", () => {
  assert.match(
    src,
    /classifierDown = critResult\.classifierDown \?\? false/,
    "The tool execute must propagate classifierDown from the critic result",
  );
});

test("topic_drift tool result text says 'drift check unavailable' when classifierDown", () => {
  const toolBlock = src.match(
    /case "check": \{[\s\S]*?return \{ content: \[\{ type: "text" as const, text \}\], details \};[\s\S]*?\}/,
  );
  assert.ok(toolBlock, "tool 'check' case body not found");
  assert.match(
    toolBlock[0],
    /classifier offline|drift check unavailable/i,
    "The text must mention classifier is offline or the check is unavailable",
  );
});

test("topic_drift tool result includes classifierDown in the details object", () => {
  const toolBlock = src.match(
    /case "check": \{[\s\S]*?return \{ content: \[\{ type: "text" as const, text \}\], details \};[\s\S]*?\}/,
  );
  assert.ok(toolBlock, "tool 'check' case body not found");
  const detailsMatch = toolBlock[0].match(/const details = \{([\s\S]*?)\n\s*\};/);
  assert.ok(detailsMatch, "details object literal not found");
  const detailsBody = detailsMatch[1];
  assert.ok(
    /classifierDown,/.test(detailsBody),
    "details object must include classifierDown field",
  );
});

test("topic_drift tool recommendations adapt when classifierDown (manual verify)", () => {
  const toolBlock = src.match(
    /case "check": \{[\s\S]*?return \{ content: \[\{ type: "text" as const, text \}\], details \};[\s\S]*?\}/,
  );
  assert.ok(toolBlock, "tool 'check' case body not found");
  assert.match(
    toolBlock[0],
    /classifierDown[\s\S]*?Manually verify|Manual verify/i,
    "When classifierDown, recommendations should suggest manual verification",
  );
});

test("debug log includes classifierDown flag for observability", () => {
  assert.match(
    src,
    /classifierDown=\$\{consolidated\.classifierDown\}/,
    "Debug log must include classifierDown from consolidated result",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== cognitive/topic-drift classifierDown regression tests passed ===");
