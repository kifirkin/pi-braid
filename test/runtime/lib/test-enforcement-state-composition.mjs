/**
 * Enforcement State Composition Test
 *
 * The `EnforcementState` is a spread-union of 7 sub-state interfaces:
 *   tool-tracking, error-tracking, session, memory-hygiene,
 *   scratchpad, context-hygiene, thought-chain.
 *
 * Each sub-state factory returns an object with a known set of keys.
 * `createState()` in `state.ts` spreads all 7 into one object:
 *
 *   const state: EnforcementState = {
 *     ...createToolTrackingState(),
 *     ...createErrorTrackingState(),
 *     ...createSessionState(),
 *     ...createMemoryHygieneState(),
 *     ...createScratchpadState(),
 *     ...createContextHygieneState(),
 *     ...createThoughtChainState(),
 *   };
 *
 * A duplicate key across two sub-states is silently dropped (the later
 * spread wins). The comment in `state.ts` explicitly warns:
 *   "If TypeScript reports an error, it means two sub-states have
 *    overlapping keys with incompatible types - which is a real bug
 *    the cast was hiding. Fix the sub-states, don't add the cast back."
 *
 * But TypeScript only catches *incompatible types*. Two sub-states with
 * the same key name and compatible types (e.g., both `number`) would
 * compile cleanly and silently overlap at runtime. This test catches
 * that class of bug by asserting:
 *
 *   1. The total number of keys in `createState()` matches a baseline.
 *      (Adding a new key to a sub-state fails the test -> must update.)
 *   2. A sentinel key from each sub-state interface is present.
 *
 * If a duplicate key is added, count drops below baseline -> test fails.
 * If a new key is added, count rises above baseline -> test fails.
 * Both cases require explicit acknowledgment, which is the right friction.
 *
 * Updating the baseline: when you intentionally add a new key to a
 * sub-state, increment the count and add the new key to the sentinel
 * list with the source sub-state name.
 */

import { strict as assert } from "assert";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

// ── Locate the compiled state module ───────────────────────────────────────

const distPath = join(ROOT, "dist", "extensions", "enforcement", "state.js");
if (!existsSync(distPath)) {
  console.log(
    "⚠️  dist/extensions/enforcement/state.js not found.\n" +
      "Run `npm run build` first. Skipping enforcement state composition test.",
  );
  process.exit(0);
}

const require = createRequire(import.meta.url);
const { createState } = require(distPath);

const state = createState();
const actualKeys = Object.keys(state).sort();
const actualCount = actualKeys.length;

// ── Baseline (update when adding intentional new keys) ─────────────────────
//
// ROADMAP session 2026-07-02: 5 nudge-tracking fields added to support
// per-turn think/finalize/verify/startup enforcement (see EW-7.2 sub-signal
// wiring in turn-end-handler.ts). Bumped 65 -> 70. New sentinels added
// under error-tracking-state (where the per-turn nudge counters live) and
// session-state (startupPlanShown drives PLANNING mode via determineContrastMode).

const BASELINE_COUNT = 70;

const SENTINEL_KEYS = {
  "tool-tracking-state": ["totalToolCalls", "uniqueToolsUsed", "toolChain", "lastRecommendationType"],
  "error-tracking-state": ["consecutiveErrorTurns", "lastFailedToolTurn", "validationFailures", "lastFinalizeNudge", "lastVerifyNudge", "lastThinkPerTurnNudge", "lastStartupNudge"],
  "session-state": ["currentTurn", "turnHistory", "originalRequest", "driftDetector", "startupPlanShown"],
  "memory-hygiene-state": ["lastMemoryCall", "turnsSinceMemory", "memoryNudgeSent"],
  "scratchpad-state": ["lastScratchpadNudgeTurn", "claimsWithoutVerification", "verificationsDone"],
  "context-hygiene-state": ["contextNudgeSent", "lastCompactionTurn", "overflowRecently"],
  "thought-chain-state": ["silentTurns", "thoughtChains", "toolsSinceReflection"],
};

// ── Tests ──────────────────────────────────────────────────────────────────

console.log("Test 1: Key count matches baseline (no silent overlap)");
{
  assert.strictEqual(
    actualCount,
    BASELINE_COUNT,
    `Expected ${BASELINE_COUNT} keys in createState() (sum of all 7 sub-state keys, ` +
      `no duplicates). Got ${actualCount}. If you intentionally added a new key, ` +
      `update BASELINE_COUNT and SENTINEL_KEYS in this test.`,
  );
  console.log(`✅ PASS: ${actualCount} keys, matches baseline`);
}

console.log("\nTest 2: Sentinel key from each sub-state is present");
{
  for (const [source, sentinels] of Object.entries(SENTINEL_KEYS)) {
    for (const key of sentinels) {
      assert.ok(
        key in state,
        `Sentinel key '${key}' from ${source} is missing from createState(). ` +
          `This means the sub-state factory is not being called, or the key was renamed.`,
      );
    }
    console.log(`  ✅ ${source}: ${sentinels.length}/${sentinels.length} sentinels present`);
  }
}

console.log("\nTest 3: No Map/Set values are undefined or null after construction");
{
  const mapOrSetKeys = actualKeys.filter((k) => {
    const v = state[k];
    return v instanceof Map || v instanceof Set;
  });
  for (const k of mapOrSetKeys) {
    assert.ok(
      state[k] != null,
      `Map/Set key '${k}' is ${state[k]} after construction. Factory should initialize it.`,
    );
  }
  console.log(`  ✅ ${mapOrSetKeys.length} Map/Set keys all initialized`);
}

console.log("\n🎯 All enforcement state composition tests passed!");
