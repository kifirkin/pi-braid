/**
 * Test: turn-outcome loop detector reports classifierDown via LOOP_DETECTOR_OFFLINE.
 *
 * HISTORY (2026-06-15):
 *   Following the input-polisher (9966c8ad), topic-drift, and
 *   sycophancy fixes: when the utility model is down, the loop
 *   detector silently defaulted to "no loop detected" (return null).
 *   This is dangerous because if the agent IS in a loop and the
 *   detector can't see it, the agent gets no warning.
 *
 * FIX:
 *   - New exported sentinel LOOP_DETECTOR_OFFLINE returned when
 *     classify() result has tier === "failed"
 *   - Consumer (turn-outcome turn_end handler) checks the sentinel
 *     and emits a softer "detector offline" steer with a separate
 *     cooldown bucket
 *   - log.warn records the offline event so the operator sees it
 *     via the new /logs command
 *
 * This test pins the contract at the source level.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FILES = {
  turnOutcome: join(ROOT, "src/extensions/cognitive/turn-outcome/index.ts"),
};

for (const [name, path] of Object.entries(FILES)) {
  assert.ok(existsSync(path), `${name} source file should exist at ${path}`);
}

const src = readFileSync(FILES.turnOutcome, "utf-8");

console.log("=== turn-outcome loop-detector-offline regression ===\n");

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

test("LOOP_DETECTOR_OFFLINE sentinel is exported", () => {
  assert.match(
    src,
    /export const LOOP_DETECTOR_OFFLINE\s*=\s*["']__loop_detector_offline__["']/,
    "Sentinel must be exported (the consumer needs to compare against it)",
  );
});

test("Sentinel comment documents the same anti-pattern as the other fixes", () => {
  // Find the comment block immediately above the sentinel declaration.
  const sentinelDecl = src.match(
    /\/\*\*[\s\S]*?\*\/\s*export const LOOP_DETECTOR_OFFLINE/,
  );
  assert.ok(sentinelDecl, "Sentinel declaration with comment not found");
  const docText = sentinelDecl[0];
  assert.ok(
    /input-polisher|topic-drift|sycophancy/.test(docText),
    "The sentinel doc must reference the other classifier-down fixes so the pattern is visible",
  );
  assert.ok(
    /never silently default|anti-pattern/i.test(docText),
    "The sentinel doc must explain WHY the sentinel exists",
  );
});

test("detectLoop returns LOOP_DETECTOR_OFFLINE when result.tier === 'failed'", () => {
  const detectLoopBody = src.match(
    /async function detectLoop[\s\S]*?\n\}/,
  );
  assert.ok(detectLoopBody, "detectLoop body not found");
  const body = detectLoopBody[0];
  // The detection must come AFTER the normal "label === yes" branch
  // (we still want to return the loop details if the model succeeded)
  // but BEFORE the final "return null" (so the sentinel is the offline
  // signal, not the silent "no" default).
  const yesIdx = body.indexOf('result.label === "yes"');
  const failedIdx = body.indexOf('result.tier === "failed"');
  const returnNullIdx = body.lastIndexOf("return null");
  assert.ok(yesIdx !== -1, "Normal 'label === yes' branch must exist");
  assert.ok(failedIdx !== -1, "Failed-tier check must exist");
  assert.ok(yesIdx < failedIdx, "yes-branch must come before the failed-tier check");
  assert.ok(failedIdx < returnNullIdx, "failed-tier check must come before the silent return null");
  // The failed-tier check must return the sentinel
  assert.ok(
    /result\.tier === "failed"[\s\S]*?return LOOP_DETECTOR_OFFLINE/.test(body),
    "Failed-tier branch must return the LOOP_DETECTOR_OFFLINE sentinel",
  );
});

test("detectLoop logs a warn with /logs level info hint when classifier is down", () => {
  const detectLoopBody = src.match(
    /async function detectLoop[\s\S]*?\n\}/,
  );
  assert.ok(detectLoopBody, "detectLoop body not found");
  const body = detectLoopBody[0];
  assert.ok(
    /log\.warn\([\s\S]*?\/logs level info/.test(body),
    "Failed-tier branch must log a warn pointing the operator to /logs level info",
  );
});

test("Consumer branches on LOOP_DETECTOR_OFFLINE before the normal loop path", () => {
  // The consumer (turn_end handler) must check the sentinel and
  // dispatch a different steer. The order matters: the offline check
  // must come BEFORE the normal "fire loop steer" path.
  const handlerBody = src.match(
    /onEvent\(pi, TURN_END, async[\s\S]*?\}\);/,
  );
  assert.ok(handlerBody, "TURN_END handler not found");
  const body = handlerBody[0];
  const offlineIdx = body.indexOf("LOOP_DETECTOR_OFFLINE");
  const normalIdx = body.indexOf('formatSteerMessage(details)');
  assert.ok(offlineIdx !== -1, "Consumer must reference LOOP_DETECTOR_OFFLINE");
  assert.ok(normalIdx !== -1, "Normal formatSteerMessage call must exist");
  assert.ok(offlineIdx < normalIdx, "Offline check must come BEFORE the normal loop path");
});

test("Offline steer has separate cooldown bucket from normal loop", () => {
  // The offline case uses "loop-detector-offline" as the lastFired
  // key (not "tool-loop") so the two cooldowns don't interfere.
  const handlerBody = src.match(
    /onEvent\(pi, TURN_END, async[\s\S]*?\}\);/,
  );
  assert.ok(handlerBody, "TURN_END handler not found");
  const body = handlerBody[0];
  assert.ok(
    /lastFired\["loop-detector-offline"\]/.test(body),
    "Offline path must use a separate lastFired key",
  );
  assert.ok(
    /lastFired\["tool-loop"\]/.test(body),
    "Normal path must keep its own lastFired key (not collide with offline)",
  );
});

test("Offline steer mentions think() and context_archive for self-monitoring", () => {
  // The offline steer should give the agent concrete actions it can
  // take (think(), context_archive) since the detector can't help.
  const handlerBody = src.match(
    /onEvent\(pi, TURN_END, async[\s\S]*?\}\);/,
  );
  assert.ok(handlerBody, "TURN_END handler not found");
  const body = handlerBody[0];
  assert.ok(
    /think\(\)/.test(body),
    "Offline steer should mention think() for self-evaluation",
  );
  assert.ok(
    /context_archive/.test(body),
    "Offline steer should mention context_archive for checkpointing",
  );
});

test("Offline steer source label is distinct (turn-outcome/loop-detector-offline)", () => {
  const handlerBody = src.match(
    /onEvent\(pi, TURN_END, async[\s\S]*?\}\);/,
  );
  assert.ok(handlerBody, "TURN_END handler not found");
  const body = handlerBody[0];
  assert.ok(
    /source:\s*["']turn-outcome\/loop-detector-offline["']/.test(body),
    "Offline steer must use a distinct source label so analytics can separate it from the normal loop path",
  );
});

test("Offline steer uses deliverAs: 'steer', triggerTurn: false (soft advisory)", () => {
  // The offline case is a soft advisory - the agent might be in a
  // loop but we can't be sure. Don't force a new turn (the agent is
  // already mid-turn and busy).
  const offlineBlock = src.match(
    /if \(details === LOOP_DETECTOR_OFFLINE\) \{[\s\S]*?return;\s*\}/,
  );
  assert.ok(offlineBlock, "Offline branch not found");
  assert.ok(
    /deliverAs:\s*["']steer["']/.test(offlineBlock[0]),
    "Offline steer must use deliverAs: 'steer' (not followUp)",
  );
  assert.ok(
    /triggerTurn:\s*false/.test(offlineBlock[0]),
    "Offline steer must use triggerTurn: false (don't force a new turn mid-work)",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== turn-outcome loop-detector-offline regression tests passed ===");
