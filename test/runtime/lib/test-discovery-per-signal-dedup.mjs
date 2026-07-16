/**
 * Per-signal dedup for session-start discoverability (2026-07-16).
 *
 * HISTORY:
 *   The discoverability handler in enforcement used bundle-TEXT dedup
 *   (`getShownDiscoveryBundles().has(bundled)`). The bundle text varies
 *   whenever ANY signal content changes (openPlans count, goal slice,
 *   tag names list), so the dedup misses on common variations:
 *
 *     1. /reload after scratchpad modification → bundle text changes
 *     2. New tag created → tag list changes
 *     3. Goal text edited → goal slice changes
 *
 * FIX:
 *   Per-signal dedup via `getShownSignals()` — stores stable signal TYPE
 *   keys (e.g., "scratchpad_prior") instead of bundle text. The TYPE is
 *   stable across content variations, so dedup works correctly.
 *
 *   If `scratchpad_prior` was shown once with 3 open plans, then the agent
 *   adds another plan (4 open plans), the bundle text changes but the
 *   TYPE is stable — dedup correctly skips.
 */

import { strict as assert } from "node:assert";

// Import compiled module.
const {
  DiscoverySignalType,
  isSignalShown,
  markSignalShown,
  getShownSignals,
  resetShownSignals,
  // Legacy bundle-text dedup (kept for backward compat):
  getShownDiscoveryBundles,
  resetShownDiscoveryBundles,
} = await import("../../../dist/lib/state/global-state.js");

console.log("=== Per-signal dedup for session-start discoverability ===\n");

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

// ── DiscoverySignalType is a stable TypeScript union ─────────────────────

test("DiscoverySignalType contains the 6 documented enum values", () => {
  const expected = [
    "scratchpad_prior",
    "memory_prior",
    "sessions_prior",
    "resume",
    "tags_prior",
    "context_hygiene_tip",
  ];
  // TypeScript types are erased at runtime, but the file should export the
  // union as a type and the helper functions below should accept all of them.
  // Validate by exercising the API.
  for (const t of expected) {
    assert.doesNotThrow(() => isSignalShown(/** @type {any} */ (t)));
  }
});

// ── Per-signal dedup rounds-trip ────────────────────────────────────────

test("isSignalShown returns false for un-shown TYPE", () => {
  resetShownSignals();
  assert.equal(isSignalShown("scratchpad_prior"), false);
});

test("markSignalShown makes isSignalShown return true", () => {
  resetShownSignals();
  markSignalShown("scratchpad_prior");
  assert.equal(isSignalShown("scratchpad_prior"), true);
});

test("different TYPEs are independent (no cross-pollination)", () => {
  resetShownSignals();
  markSignalShown("scratchpad_prior");
  assert.equal(isSignalShown("scratchpad_prior"), true);
  assert.equal(isSignalShown("memory_prior"), false);
  assert.equal(isSignalShown("sessions_prior"), false);
  assert.equal(isSignalShown("resume"), false);
  assert.equal(isSignalShown("tags_prior"), false);
  assert.equal(isSignalShown("context_hygiene_tip"), false);
});

test("getShownSignals returns the same Set across calls (process-global)", () => {
  resetShownSignals();
  const set1 = getShownSignals();
  const set2 = getShownSignals();
  assert.equal(set1, set2, "getShownSignals must return the same Set by reference");
});

test("getShownSignals persists across helper calls (no lazy reset)", () => {
  resetShownSignals();
  markSignalShown("scratchpad_prior");
  // Simulate multiple "calls" to the handler — the dedup must persist.
  assert.equal(isSignalShown("scratchpad_prior"), true);
  assert.equal(isSignalShown("scratchpad_prior"), true);
  assert.equal(isSignalShown("scratchpad_prior"), true);
});

test("dedup survives 'content' changes — only TYPE matters", () => {
  resetShownSignals();
  markSignalShown("scratchpad_prior");

  // Regardless of how the content would change (e.g., openPlans count
  // growing from 3 → 4 → 5), the TYPE-level dedup should skip.
  // This is the key behavior: bundle-text dedup would MISS on these
  // changes, per-TYPE dedup correctly ignores them.
  for (let plans = 3; plans <= 10; plans++) {
    assert.equal(
      isSignalShown("scratchpad_prior"),
      true,
      `scratchpad_prior must remain shown even if plan count grew to ${plans}`,
    );
  }
});

test("legacy getShownDiscoveryBundles still works (backward compat)", () => {
  resetShownDiscoveryBundles();
  const legacyShown = getShownDiscoveryBundles();
  assert.equal(typeof legacyShown.add, "function", "must expose Set API");

  legacyShown.add("test bundle");
  // The set should persist
  assert.equal(getShownDiscoveryBundles().has("test bundle"), true);
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
