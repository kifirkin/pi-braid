/**
 * Test: DR-C-2 migration - context-lifecycle policy/detector state is
 * per-session.
 *
 * BACKGROUND:
 * ROADMAP DR-C-2 found that `_policyState`and `_detectorState`in
 * `extensions/memory/context-lifecycle/index.ts`were module-level
 * singletons holding session data (cooldowns, topic history, tool
 * sequence, etc.). They were `const`so they didn't violate the
 * "no module-level let"lint, but they leaked across sessions
 * because session_start only cleared `cooldowns`and called
 * `resetDetectorState`. The `_policyState.policies`and
 * `_policyState.governance`were never reset.
 *
 * The fix migrates both into the per-session
 * `ContextLifecycleState` (`state(ctx).policyEngine`and
 * `state(ctx).detector`) so each session starts with a fresh engine
 * and detector.
 *
 * This test verifies:
 * 1. `createState()`initializes `policyEngine`and `detector`.
 * 2. State is per-session: different ctx -> different state.
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIST_STATE = join(ROOT, "dist/extensions/memory/context-lifecycle/state.js");

console.log("=== DR-C-2 migration tests ===\n");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

function makeCtx(sessionId) {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };
}

// ── Behavioral: per-session state via getExtensionState ─────────────────────

await test("createState() initializes policyEngine and detector", async () => {
  const { createState } = await import(DIST_STATE);
  const s = createState();
  assert.ok(s.policyEngine, "policyEngine field is initialized");
  assert.ok(s.detector, "detector field is initialized");
  // Light shape checks: the policy engine has cooldowns + policies,
  // the detector has the standard fields.
  assert.ok(s.policyEngine.cooldowns, "policyEngine has cooldowns (Map or similar)");
  assert.ok(Array.isArray(s.policyEngine.policies), "policyEngine has policies array");
  assert.ok(Array.isArray(s.policyEngine.governance), "policyEngine has governance array");
  assert.ok(Array.isArray(s.detector.topicHistory), "detector has topicHistory array");
  assert.ok(Array.isArray(s.detector.toolSequence), "detector has toolSequence array");
  assert.ok(Array.isArray(s.detector.pendingSignals), "detector has pendingSignals array");
});

await test("state() is per-session (different ctx -> different state)", async () => {
  const { _getState } = await import(DIST_STATE);
  const ctxA = makeCtx("test-session-A");
  const ctxB = makeCtx("test-session-B");
  const sA = _getState(ctxA);
  const sB = _getState(ctxB);
  assert.notStrictEqual(sA, sB, "different ctxs get different state objects");
  assert.notStrictEqual(sA.policyEngine, sB.policyEngine, "policyEngine is per-session");
  assert.notStrictEqual(sA.detector, sB.detector, "detector is per-session");
});

await test("state() returns the same state for the same ctx", async () => {
  const { _getState } = await import(DIST_STATE);
  const ctx = makeCtx("test-session-stable");
  const s1 = _getState(ctx);
  const s2 = _getState(ctx);
  assert.strictEqual(s1, s2, "same ctx returns same state (cache hit)");
});

await test("mutations to per-session state don't leak across sessions", async () => {
  const { _getState } = await import(DIST_STATE);
  const ctxA = makeCtx("test-session-mut-A");
  const ctxB = makeCtx("test-session-mut-B");
  const sA = _getState(ctxA);
  // Mutate session A's detector.
  sA.detector.topicHistory.push({ turn: 1, topic: "leaked" });
  sA.policyEngine.cooldowns.set("policy-1", Date.now());
  // Session B should be unaffected.
  const sB = _getState(ctxB);
  assert.strictEqual(sB.detector.topicHistory.length, 0, "session B detector is fresh");
  assert.strictEqual(sB.policyEngine.cooldowns.size, 0, "session B cooldowns are fresh");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
console.log("=== DR-C-2 migration tests passed ===");
