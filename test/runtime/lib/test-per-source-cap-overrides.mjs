/**
 * EW-7.13: per-source priority-aware caps.
 *
 * HISTORY (2026-06-15):
 *   All sources shared PER_SOURCE_CAP = 2. A 3rd `triggerTurn: true`
 *   whisper from a high-priority source (e.g. enforcement during a
 *   degraded turn) was silently dropped - exactly where dropping is
 *   worst. The agent missed a real signal because the per-source cap
 *   didn't account for legitimate high-priority sources.
 *
 * FIX:
 *   - Add PER_SOURCE_CAP_OVERRIDES: Record<string, number>
 *   - Default enforcement/whisper -> 3 (was 2)
 *   - Add getPerSourceCap(source) accessor
 *   - tryWhisper uses the override-aware cap for both critical and
 *     non-critical paths
 *
 * This test pins the contract at the runtime level (not just source
 * pattern) to verify the override is actually applied.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Import the module from the compiled output
const { PER_SOURCE_CAP, PER_SOURCE_CAP_OVERRIDES, getPerSourceCap, tryWhisper, beginTurn, _resetForTests } = await import(
  "../../../dist/lib/enforcement/turn-dedup.js"
);

assert.ok(
  existsSync(join(ROOT, "src/lib/enforcement/turn-dedup.ts")),
  "turn-dedup.ts must exist",
);

const src = readFileSync(join(ROOT, "src/lib/enforcement/turn-dedup.ts"), "utf-8");

console.log("=== EW-7.13 per-source cap overrides ===\n");

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

test("PER_SOURCE_CAP default is 2", () => {
  assert.equal(PER_SOURCE_CAP, 2, "default per-source cap should be 2");
});

test("PER_SOURCE_CAP_OVERRIDES is exported and has enforcement/whisper: 3", () => {
  assert.ok(
    PER_SOURCE_CAP_OVERRIDES && typeof PER_SOURCE_CAP_OVERRIDES === "object",
    "PER_SOURCE_CAP_OVERRIDES must be exported",
  );
  assert.equal(
    PER_SOURCE_CAP_OVERRIDES["enforcement/whisper"],
    3,
    "enforcement/whisper should have cap 3 (was 2)",
  );
});

test("getPerSourceCap returns override when set", () => {
  assert.equal(
    getPerSourceCap("enforcement/whisper"),
    3,
    "enforcement/whisper should resolve to 3",
  );
});

test("getPerSourceCap returns default when no override", () => {
  assert.equal(
    getPerSourceCap("some-other-source"),
    PER_SOURCE_CAP,
    "unknown source should fall back to PER_SOURCE_CAP",
  );
});

test("enforcement source can deliver 3 high-priority whispers in a turn", () => {
  _resetForTests();
  beginTurn();
  // 3 high-priority whispers from enforcement should all pass
  // (PER_SOURCE_CAP_OVERRIDES raises the cap to 3 for this source)
  assert.equal(
    tryWhisper("high", "enforcement/whisper"),
    true,
    "1st enforcement whisper should pass",
  );
  assert.equal(
    tryWhisper("high", "enforcement/whisper"),
    true,
    "2nd enforcement whisper should pass",
  );
  assert.equal(
    tryWhisper("high", "enforcement/whisper"),
    true,
    "3rd enforcement whisper should pass (override cap = 3)",
  );
  // 4th should be suppressed
  assert.equal(
    tryWhisper("high", "enforcement/whisper"),
    false,
    "4th enforcement whisper should be suppressed (cap = 3)",
  );
});

test("non-override source still has cap = 2", () => {
  _resetForTests();
  beginTurn();
  assert.equal(tryWhisper("high", "regular-source"), true, "1st should pass");
  assert.equal(tryWhisper("high", "regular-source"), true, "2nd should pass");
  assert.equal(
    tryWhisper("high", "regular-source"),
    false,
    "3rd should be suppressed (default cap = 2)",
  );
});

test("tryWhisper uses getPerSourceCap for critical priority too", () => {
  // The source-level check verifies the function uses the override-aware
  // cap. The runtime check above (5th test) covers non-critical. For
  // critical, we just verify the source contains the right call.
  assert.match(
    src,
    /if \(priority === "critical"\)[\s\S]*?getPerSourceCap\(source\)/,
    "critical path must use getPerSourceCap(source)",
  );
  assert.match(
    src,
    /const sourceCap = getPerSourceCap\(source\);[\s\S]*?if \(sourceCount >= sourceCap\)/,
    "non-critical path must use getPerSourceCap(source)",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== EW-7.13 per-source cap tests passed ===");
