/**
 * Test: DR-C-2 migration - context-lifecycle policy/detector state is
 * per-session.
 *
 * BACKGROUND:
 *   ROADMAP DR-C-2 found that `_policyState` and `_detectorState` in
 *   `extensions/memory/context-lifecycle/index.ts` were module-level
 *   singletons holding session data (cooldowns, topic history, tool
 *   sequence, etc.). They were `const` so they didn't violate the
 *   "no module-level let" lint, but they leaked across sessions
 *   because session_start only cleared `cooldowns` and called
 *   `resetDetectorState`. The `_policyState.policies` and
 *   `_policyState.governance` were never reset.
 *
 *   The fix (2026-06-22) migrates both into the per-session
 *   `ContextLifecycleState` (`state(ctx).policyEngine` and
 *   `state(ctx).detector`) so each session starts with a fresh engine
 *   and detector.
 *
 * This test verifies:
 *   1. `createState()` initializes `policyEngine` and `detector`.
 *   2. State is per-session: different ctx → different state.
 *   3. Source-level: the module-level consts are gone from index.ts,
 *      and the per-session fields are present in state.ts.
 *   4. Source-level: all 12+ call sites in index.ts reference
 *      `state(ctx).policyEngine` / `state(ctx).detector` (not the
 *      old module-level names).
 *   5. Source-level: the manual `resetDetectorState` /
 *      `_policyState.cooldowns.clear()` calls are gone from the
 *      session_start handler.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STATE_PATH = join(ROOT, "src/extensions/memory/context-lifecycle/state.ts");
const INDEX_TS = join(ROOT, "src/extensions/memory/context-lifecycle/index.ts");
const DIST_STATE = join(ROOT, "dist/extensions/memory/context-lifecycle/state.js");
const DIST_INDEX = join(ROOT, "dist/extensions/memory/context-lifecycle/index.js");

assert.ok(existsSync(STATE_PATH), "context-lifecycle/state.ts must exist");
assert.ok(existsSync(INDEX_TS), "context-lifecycle/index.ts must exist");
assert.ok(existsSync(DIST_STATE), "compiled state module must exist");
assert.ok(existsSync(DIST_INDEX), "compiled index module must exist");

const stateSrc = readFileSync(STATE_PATH, "utf-8");
const indexSrc = readFileSync(INDEX_TS, "utf-8");

console.log("=== DR-C-2 migration tests ===\n");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(`  ✗ ${name}: ${e.message}`);
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

await test("state() is per-session (different ctx → different state)", async () => {
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

// ── Structural: the module-level consts are gone from index.ts ──────────────

await test("index.ts has no module-level _policyState or _detectorState", () => {
  // The old pattern was:
  //   const _policyState = createPolicyEngineState();
  //   const _detectorState: DetectorState = createDetectorState();
  // The migration moves both into per-session state.
  assert.doesNotMatch(
    indexSrc,
    /^const\s+_policyState\s*=/m,
    "module-level _policyState must be removed (migrated to per-session state)",
  );
  assert.doesNotMatch(
    indexSrc,
    /^const\s+_detectorState\s*=/m,
    "module-level _detectorState must be removed (migrated to per-session state)",
  );
});

await test("index.ts no longer imports createPolicyEngineState / createDetectorState / resetDetectorState", () => {
  // The migration moved the state initialization into state.ts. The
  // factory functions and resetDetectorState are no longer used in
  // index.ts - they're called from state.ts instead.
  //
  // Note: an `assert.doesNotMatch` against the full file would also
  // match a `//   import { ... }` example in a comment. To avoid that
  // we check the import block at the top of the file specifically -
  // the real import statement lives between the first `import` and the
  // first `export default function`.
  const importBlock = indexSrc.split("export default function")[0];
  assert.doesNotMatch(
    importBlock,
    /\bcreatePolicyEngineState\b/,
    "index.ts imports must not include createPolicyEngineState (only state.ts does)",
  );
  assert.doesNotMatch(
    importBlock,
    /\bcreateDetectorState\b/,
    "index.ts imports must not include createDetectorState (only state.ts does)",
  );
  // resetDetectorState is no longer called from index.ts at all.
  // We check the whole file here, but the function only appears in
  // comments, not in code (we already verified the session_start
  // handler doesn't call it).
  assert.doesNotMatch(
    indexSrc,
    /(?<!\/\/\s)\bresetDetectorState\s*\(/,
    "index.ts must not call resetDetectorState (the per-session state is fresh on session_start)",
  );
});

await test("index.ts has no remaining _policyState or _detectorState references", () => {
  assert.doesNotMatch(indexSrc, /\b_policyState\b/, "no _policyState references in index.ts");
  assert.doesNotMatch(indexSrc, /\b_detectorState\b/, "no _detectorState references in index.ts");
});

await test("state.ts has policyEngine and detector fields", () => {
  assert.match(stateSrc, /policyEngine:\s*PolicyEngineState/);
  assert.match(stateSrc, /detector:\s*DetectorState/);
  // createState() initializes them.
  assert.match(stateSrc, /policyEngine:\s*createPolicyEngineState\(\)/);
  assert.match(stateSrc, /detector:\s*createDetectorState\(\)/);
});

await test("session_start handler no longer does manual policy/detector reset", () => {
  // The old handler had:
  //   _policyState.cooldowns.clear();
  //   resetDetectorState(_detectorState);
  // The new handler just calls resetState(ctx) and clearInjections().
  assert.doesNotMatch(
    indexSrc,
    /_policyState\.cooldowns\.clear/,
    "session_start must not manually clear _policyState.cooldowns (the per-session state is fresh)",
  );
  assert.doesNotMatch(
    indexSrc,
    /resetDetectorState\(_detectorState\)/,
    "session_start must not call resetDetectorState (the per-session state is fresh)",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
console.log("=== DR-C-2 migration tests passed ===");
