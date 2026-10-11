/**
 * Part 3 + Part 4: auto-rollback test-debug guard.
 *
 * Evidence (session audit): auto-rollback (checkpoint
 * extension) fired mid-implementation on a legitimate failing-test loop
 * (error rate 10.6%), rewound the conversation to turn 21 and cost ~1.4M
 * tokens of cache-invalidated re-prefill. TDD / gate-triage error bursts are
 * intentional verification failures, not degradation.
 *
 * Pinned here:
 * 1. classifier — test-runner commands and outputs (pass/fail counts,
 * runner banners, assertion errors) vs ordinary tool output;
 * 2. suppression — a burst whose errors are ALL test-marked (>= 3) is
 * test-dominated -> rollback withheld (whisper-only downgrade);
 * 3. no weakening — a SINGLE non-test error in the burst means genuine
 * degradation -> rollback stays exactly as today;
 * 4. end-to-end — heartbeatCheckpointTick surfaces the suppression and the
 * real autoRollback performs the destructive restore only for
 * non-test bursts.
 *
 * Run: node test/runtime/lib/test-test-burst-rollback-guard.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const D = join(ROOT, "dist");

const {
  classifyTestRunnerSignal,
  noteToolOutcomeForBurst,
  evaluateTestBurst,
  shouldSuppressRollbackForTestBurst,
  MIN_BURST_ERRORS,
} = await import("file://" + join(D, "lib/detection/test-burst.js"));
const { createCheckpoint, heartbeatCheckpointTick } = await import(
  "file://" + join(ROOT, "dist/lib/state/state-checkpoint.js")
);

console.log("=== auto-rollback test-debug guard ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
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
      getSessionFile: () => `fake-${sessionId}.jsonl`,
      getSessionId: () => sessionId,
    },
  };
}

/** Feed a burst scenario into a fresh ctx ring. */
function feed(ctx, outcomes) {
  for (const o of outcomes) {
    noteToolOutcomeForBurst(ctx, o.tool ?? "bash", o.fail ?? false, {
      command: o.command,
      output: o.output,
    });
  }
}

const FAILING_NPM_TEST = {
  tool: "bash",
  fail: true,
  command: "npm test",
  output: "> pi-braid@0.3.2 test\n3 failing\n  1) test-x: expected 4 to equal 3",
};
const FAILING_VITEST = {
  tool: "bash",
  fail: true,
  command: "npx vitest run src/foo.test.ts",
  output: "Tests:  2 failed, 12 passed, 14 total",
};
const TSC_ERRORS = {
  tool: "bash",
  fail: true,
  command: "npx tsc --noEmit",
  // Fixture path is intentionally not under the source tree — check:deps'
  // stale-ref scanner treats a quoted path literal starting with "src/"in a
  // test file as a real file reference and fails the gate on a non-existent one.
  output: "a.ts(3,7): error TS2322: Type 'number' is not assignable",
};
const PASSING_TEST = { tool: "bash", fail: false, command: "npm test", output: "5 passing" };
const NON_TEST_ERROR = { tool: "read", fail: true, output: "ENOENT: no such file or directory" };

// ── 1. Classifier ────────────────────────────────────────────────────────────

await test("1. runner commands classify test-like", () => {
  assert.equal(classifyTestRunnerSignal("npm test", undefined), true);
  assert.equal(classifyTestRunnerSignal("npm run test:core", undefined), true);
  assert.equal(classifyTestRunnerSignal("npx vitest run", undefined), true);
  assert.equal(classifyTestRunnerSignal("npx tsc --noEmit", undefined), true);
  assert.equal(classifyTestRunnerSignal("node --test", undefined), true);
  assert.equal(classifyTestRunnerSignal("pytest -q", undefined), true);
  assert.equal(classifyTestRunnerSignal("cargo test", undefined), true);
});

await test("2. runner outputs classify test-like", () => {
  assert.equal(classifyTestRunnerSignal(undefined, "12 passing, 3 failing"), true);
  assert.equal(classifyTestRunnerSignal(undefined, "Tests:  2 failed, 12 passed, 14 total"), true);
  assert.equal(classifyTestRunnerSignal(undefined, "Test Suites: 1 failed, 4 passed"), true);
  assert.equal(classifyTestRunnerSignal(undefined, "AssertionError: expected 5 to equal 3"), true);
  assert.equal(classifyTestRunnerSignal(undefined, "✓ adds numbers"), true);
  assert.equal(classifyTestRunnerSignal(undefined, "not ok 3 - subtest"), true);
});

await test("3. ordinary commands/outputs do NOT classify test-like", () => {
  assert.equal(classifyTestRunnerSignal("ls -la", "total 0"), false);
  assert.equal(classifyTestRunnerSignal("echo hello", "hello world"), false);
  assert.equal(classifyTestRunnerSignal("git status", "nothing to commit"), false);
  assert.equal(classifyTestRunnerSignal("cat package.json", '{"name": "pi-braid"}'), false);
  assert.equal(classifyTestRunnerSignal(undefined, undefined), false);
});

// ── 2. Suppression decision ──────────────────────────────────────────────────

await test("4. all-test burst (>=3) is suppressed", () => {
  const ctx = makeCtx("burst-all-test");
  feed(ctx, [FAILING_NPM_TEST, FAILING_VITEST, TSC_ERRORS]);
  const ev = evaluateTestBurst(ctx);
  assert.equal(ev.burst, true);
  assert.equal(ev.testErrors, 3);
  assert.equal(ev.nonTestErrors, 0);
  assert.equal(ev.testDominated, true);
  assert.equal(shouldSuppressRollbackForTestBurst(ctx), true);
});

await test("5. one non-test error in the burst -> NOT suppressed (no rollback weakening)", () => {
  const ctx = makeCtx("burst-mixed");
  feed(ctx, [FAILING_NPM_TEST, FAILING_VITEST, NON_TEST_ERROR]);
  const ev = evaluateTestBurst(ctx);
  assert.equal(ev.burst, true);
  assert.equal(ev.nonTestErrors, 1, "a non-test tool family error spans the burst");
  assert.equal(ev.testDominated, false, "genuine degradation keeps rollback");
  assert.equal(shouldSuppressRollbackForTestBurst(ctx), false);
});

await test("6. small error count (< 3) -> no burst, not suppressed", () => {
  const ctx = makeCtx("burst-small");
  feed(ctx, [FAILING_NPM_TEST, FAILING_VITEST]);
  const ev = evaluateTestBurst(ctx);
  assert.equal(ev.burst, false);
  assert.equal(ev.testDominated, false);
});

await test("7. successes bound the window; empty ring -> no suppression", () => {
  const ctx = makeCtx("burst-successes");
  feed(ctx, [PASSING_TEST, PASSING_TEST, PASSING_TEST, PASSING_TEST]);
  assert.equal(shouldSuppressRollbackForTestBurst(ctx), false);
  assert.equal(shouldSuppressRollbackForTestBurst(makeCtx("burst-empty")), false);
});

await test("8. ring is bounded (constant window, successes age errors out)", () => {
  const ctx = makeCtx("burst-window");
  feed(ctx, [FAILING_NPM_TEST, FAILING_NPM_TEST, FAILING_NPM_TEST]);
  for (let i = 0; i < 12; i++) feed(ctx, [PASSING_TEST]);
  assert.equal(shouldSuppressRollbackForTestBurst(ctx), false, "errors aged out of the ring");
  assert.ok(MIN_BURST_ERRORS >= 3, "suppression floor documented (>=3)");
});

// ── 3. End-to-end: real autoRollback / heartbeatCheckpointTick ───────────────

await test("9. test-dominated burst: checkpoint tick withholds rollback (whisper-only downgrade)", async () => {
  const sid = `w11-tb-9-${Date.now()}`;
  const ctx = makeCtx(sid);
  feed(ctx, [FAILING_NPM_TEST, FAILING_VITEST, TSC_ERRORS]);
  await createCheckpoint(ctx, 25, sid);
  const result = await heartbeatCheckpointTick(ctx, 30, sid, true);
  assert.equal(result.rollbackPerformed, false, "no destructive rewind");
  assert.equal(result.rollbackSuppressed, true, "downgraded to whisper-only");
  assert.match(result.message ?? "", /test-runner dominated/);
});

await test("10. non-test burst: rollback performs exactly as today (no weakening)", async () => {
  const sid = `w11-tb-10-${Date.now()}`;
  const ctx = makeCtx(sid);
  feed(ctx, [
    NON_TEST_ERROR,
    { ...NON_TEST_ERROR, tool: "write" },
    { ...NON_TEST_ERROR, tool: "edit" },
  ]);
  await createCheckpoint(ctx, 25, sid);
  const result = await heartbeatCheckpointTick(ctx, 30, sid, true);
  assert.equal(result.rollbackPerformed, true, "genuine degradation still rolls back");
  assert.ok(!result.rollbackSuppressed, "not flagged suppressed");
});

await test("11. clean session: checkpoint tick unaffected by the guard", async () => {
  const sid = `w11-tb-11-${Date.now()}`;
  const ctx = makeCtx(sid);
  feed(ctx, [PASSING_TEST, PASSING_TEST]);
  const result = await heartbeatCheckpointTick(ctx, 25, sid, false);
  assert.equal(result.checkpointCreated, true);
  assert.equal(result.rollbackPerformed, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
