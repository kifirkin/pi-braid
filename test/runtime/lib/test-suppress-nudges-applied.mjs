/**
 * P1-4 / EW-7.3: braid.suppressNudges is applied at the right layer.
 *
 * HISTORY (2026-06-15):
 *   The off-switch was checked in only 4 sites (sendEnforcementWhisper
 *   + 3 heartbeat/analytics sites), but there are 20+ callers of
 *   sendTrackedMessage. Setting braid.suppressNudges=true therefore
 *   silenced only the enforcement layer; the other 70% of agent-facing
 *   whispers (memory, hints, drift, dreamer, timer, etc.) still
 *   reached the agent.
 *
 * FIX: Move the check to the universal entry point -- sendTrackedMessage.
 * All 20+ callers now respect the off-switch without each site needing
 * its own check. The pre-existing checks in sendEnforcementWhisper and
 * the 3 analytics sites are now redundant (the wrapper checks first)
 * but are intentionally left in place for more specific debug logging
 * (e.g. "[analytics] Addiction alert suppressed" vs the generic
 * "[injection-tracker] Tracked message suppressed").
 *
 * This test pins the contract at the source level.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FILES = {
  injectionTracker: join(ROOT, "src/lib/utils/injection-tracker.ts"),
  braidSettings: join(ROOT, "src/lib/config/braid-settings.ts"),
};

for (const [name, path] of Object.entries(FILES)) {
  assert.ok(existsSync(path), `${name} source file should exist at ${path}`);
}

const trackerSrc = readFileSync(FILES.injectionTracker, "utf-8");
const settingsSrc = readFileSync(FILES.braidSettings, "utf-8");

console.log("=== P1-4: suppressNudges applied at the universal wrapper ===\n");

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

test("sendTrackedMessage imports areCognitiveNudgesDisabled", () => {
  assert.match(
    trackerSrc,
    /import\s*\{[^}]*areCognitiveNudgesDisabled[^}]*\}\s*from\s*["']\.\.\/config\/braid-settings\.js["']/,
    "sendTrackedMessage must import areCognitiveNudgesDisabled from braid-settings",
  );
});

test("areCognitiveNudgesDisabled is a function in braid-settings", () => {
  assert.match(
    settingsSrc,
    /export\s+function\s+areCognitiveNudgesDisabled\s*\(\s*\)\s*:\s*boolean/,
    "braid-settings must export areCognitiveNudgesDisabled(): boolean",
  );
});

test("suppressNudges check happens at the START of sendTrackedMessage", () => {
  // The function body is large; we just verify the check is the first
  // action after the function signature. Pinning position (not just
  // presence) prevents regressions where someone moves the check
  // AFTER expensive work like flood-cap or tracking.
  const fnBody = trackerSrc.match(
    /export\s+function\s+sendTrackedMessage\s*\([\s\S]*?\):\s*void\s*\{([\s\S]*?)Per-turn whisper cap/,
  );
  assert.ok(fnBody, "sendTrackedMessage body before flood-cap check not found");
  const beforeFloodCap = fnBody[1];
  assert.ok(
    /areCognitiveNudgesDisabled\s*\(\s*\)/.test(beforeFloodCap),
    "The suppressNudges check must appear BEFORE the flood-cap check " +
      "(so we don't even compute flood-cap state when the off-switch is on)",
  );
  // The check must return early (no work done)
  assert.ok(
    /areCognitiveNudgesDisabled[\s\S]*?return;/.test(beforeFloodCap),
    "The suppressNudges check must early-return when on",
  );
});

test("suppressNudges check uses the canonical 'braid.suppressNudges=true' debug string", () => {
  // The log message is operator-facing: it tells the user that
  // their off-switch is being respected. Pin the format so
  // log-searches keep working.
  assert.match(
    trackerSrc,
    /braid\.suppressNudges=true/,
    "Debug log must include 'braid.suppressNudges=true' so operator can grep for it",
  );
});

test("The check applies to the 'pi'/'ctx' generic message path (not just specific types)", () => {
  // The function is generic over message type (params.content, etc.).
  // The check is at the function level, not type-specific.
  // Verify by checking that the check is inside the function body
  // (not in a conditional branch that only fires for one type).
  const fnStart = trackerSrc.indexOf("export function sendTrackedMessage");
  const fnEnd = trackerSrc.indexOf("\n}", fnStart);
  assert.ok(fnStart !== -1, "sendTrackedMessage function not found");
  assert.ok(fnEnd !== -1, "sendTrackedMessage function end not found");
  const fnBody = trackerSrc.slice(fnStart, fnEnd);
  // Count the number of `areCognitiveNudgesDisabled()` calls in the function body.
  const checks = fnBody.match(/areCognitiveNudgesDisabled\s*\(\s*\)/g) ?? [];
  assert.ok(
    checks.length >= 1,
    "sendTrackedMessage must check suppressNudges at least once (P1-4 fix)",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== P1-4 suppressNudges tests passed ===");
