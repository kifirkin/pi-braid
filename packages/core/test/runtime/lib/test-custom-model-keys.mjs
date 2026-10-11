/**
 * Custom model keys survive module re-evaluation (src/dist split simulation).
 *
 * WHY THIS TEST EXISTS:
 *   The polyfill extension is loaded from the TS SOURCE tree
 *   (src/extensions/core/polyfill/index.ts → src/lib/state/global-state.ts)
 *   while contrib's model-resolver imports the compiled DIST
 *   (dist/lib/state/global-state.js via the pi-braid/lib export). That yields
 *   TWO module instances of global-state.ts in one process. A module-level
 *   Map would be populated by the src instance (polyfill's
 *   loadCustomKeysFromDisk at factory load) and read EMPTY by the dist
 *   instance (model-resolver) — the utilityModel custom key would fall
 *   through to priority-3 first-available (MiniMax 429).
 *
 * FIX:
 *   The custom model keys map is stored in a `globalThis` slot
 *   (`__braid_custom_model_keys`), following the KEY_RING_FEEDBACK_KEY
 *   pattern in the same file. Any module instance — src or dist, before or
 *   after /reload — reads/writes the same process-global Map.
 *
 * SIMULATION:
 *   Cache-busting re-imports (?v=N) force a fresh module evaluation, the
 *   same technique test-async-storage-reload-guard.mjs uses to simulate
 *   /reload. Instance #1 sets a key; instance #2 (a genuinely different
 *   module instance) must still read it back.
 *
 * REVERT-PROOF:
 *   With the pre-fix module-level `const _customModelKeys = new Map()`,
 *   instance #2 has its own empty map and `getCustomModelKey` returns
 *   undefined — the "cross-instance persistence" assertion fails.
 */

import { strict as assert } from "node:assert";

// Instance #1 — e.g. the src-loaded polyfill's view of the module.
const mod1 = await import("../../../dist/lib/state/global-state.js?v=1");
// Instance #2 — e.g. the dist-loaded model-resolver's view of the module.
const mod2 = await import("../../../dist/lib/state/global-state.js?v=2");
// Instances #3/#4 — for the same-map-by-reference check.
const mod3 = await import("../../../dist/lib/state/global-state.js?v=3");
const mod4 = await import("../../../dist/lib/state/global-state.js?v=4");

// Deterministic start: clear the process-global slot (a fresh `node` process
// runs each test file, so this is belt-and-suspenders).
delete globalThis[mod1.CUSTOM_MODEL_KEYS_KEY];

console.log("=== Custom model keys survive module re-evaluation ===\n");

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

// ── Cross-instance persistence (the src/dist split simulation) ────────────

test("cache-busted re-imports are genuinely separate module instances", () => {
  assert.notEqual(
    mod1.setCustomModelKey,
    mod2.setCustomModelKey,
    "the two imports must be separate module evaluations for this simulation to mean anything",
  );
});

test("key set via instance #1 is readable via instance #2 (fresh evaluation)", () => {
  mod1.setCustomModelKey(mod1.UTILITY_MODEL_KEY, "sample/qwen3-vl-235b-a22b");

  // The core assertion: the key set through instance #1 is readable through
  // instance #2 — the map lives on globalThis, not in the module.
  assert.equal(
    mod2.getCustomModelKey(mod2.UTILITY_MODEL_KEY),
    "sample/qwen3-vl-235b-a22b",
    "custom model key must survive module re-evaluation (globalThis-backed map)",
  );
});

// ── Same-map-by-reference (process-global, not per-instance) ──────────────

test("getCustomModelKeys returns the same Map across module instances", () => {
  assert.equal(mod3.getCustomModelKeys(), mod4.getCustomModelKeys());
});

// ── Behavior unchanged for existing callers ────────────────────────────────

test("getCustomModelKey returns undefined for an unset key", () => {
  mod1.setCustomModelKey(mod1.UTILITY_MODEL_KEY, "sample/qwen3-vl-235b-a22b");
  assert.equal(mod1.getCustomModelKey("not-set-key"), undefined);
});

test("setCustomModelKey overwrites an existing key", () => {
  mod1.setCustomModelKey(mod1.UTILITY_MODEL_KEY, "first");
  mod1.setCustomModelKey(mod1.UTILITY_MODEL_KEY, "second");
  assert.equal(mod1.getCustomModelKey(mod1.UTILITY_MODEL_KEY), "second");
});

test("getCustomModelKeys exposes the Map API (set/delete used by polyfill)", () => {
  const map = mod1.getCustomModelKeys();
  map.set("utilityModel", "test-utility");
  assert.equal(mod1.getCustomModelKey("utilityModel"), "test-utility");
  map.delete("utilityModel");
  assert.equal(mod1.getCustomModelKey("utilityModel"), undefined);
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
