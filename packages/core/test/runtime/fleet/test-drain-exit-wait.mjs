/**
 * Test: the drain-atomicity kill arm waits for an exit it may have missed.
 *
 * That arm spawns a child drainer, sends it a SIGKILL, and then waits for the
 * child's exit. A listener attached to a child that has already exited never
 * fires, so a wait built that way settles or never settles depending on how fast
 * the child finished: node answers with an unsettled top-level await and exit
 * code 13, and the file goes red with every one of its assertions green.
 *
 * The arm owns the wait from the spawn and reads the child's terminal state, so
 * a kill that arrives after the drain has finished is a miss it can report
 * instead of a wait it cannot complete.
 *
 * This file is the control for that. It drives the arm into the ordering the
 * arm's own timing only sometimes reaches: with the drain allowed to complete
 * first, the kill cannot land inside the window, so the arm has measured
 * nothing, has to say so on stdout, and the run still exits 0. A wait that
 * regressed to attaching after the kill leaves this file nothing to assert on:
 * the status is not 0 and the miss line never appears.
 *
 * Run: node test/runtime/fleet/test-drain-exit-wait.mjs
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ARM = join(dirname(fileURLToPath(import.meta.url)), "test-drain-atomicity.mjs");

let passed = 0;
let failed = 0;
function check(name, body) {
  try {
    body();
    passed += 1;
    console.log(`  [ok] ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  [FAIL] ${name}\n         ${error.message}`);
  }
}

/**
 * Run the arm and keep both streams: a wait that never settles is reported on
 * stderr, and the run's status is what the assertions read.
 */
function runArm(args) {
  const result = spawnSync(process.execPath, [ARM, ...args], { encoding: "utf8", timeout: 60_000 });
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function assertSettled(run, label) {
  assert.equal(run.status, 0, `${label}: the arm ended ${run.status ?? run.signal}, so its wait did not settle`);
  assert.doesNotMatch(run.stderr, /unsettled top-level await/, `${label}: node reported an unsettled top-level await`);
  assert.doesNotMatch(run.stdout, /\[FAIL\]/, `${label}: the arm reported a failed assertion`);
}

const missed = runArm(["--kill-arm", "--child-finished-before-kill"]);
check("a kill that arrives after the child has gone exits 0 and says it measured nothing", () => {
  assertSettled(missed, "already-exited child");
  assert.match(missed.stdout, /measured nothing/, `the miss was not reported: ${missed.stdout.trim()}`);
  assert.match(missed.stdout, /answered=40 open=0/, "the arm did not report the store it audited");
});

check("that run still checks the store the late kill left behind", () => {
  assert.match(missed.stdout, /\[ok\] a SIGKILL mid-drain leaves no ask half-done/);
  assert.match(missed.stdout, /\[ok\] the store is recoverable after the kill/);
});

// The arm's own report, verbatim in this file's output: a reader of a green run
// has to be able to see that the arm observed the degenerate case, not just that
// an assertion about it passed.
for (const line of missed.stdout.split("\n")) {
  if (line.includes("SIGKILL mid-drain:")) console.log(line);
}

const live = runArm(["--kill-arm"]);
check("an arm against a child that is still running exits 0", () => {
  assertSettled(live, "running child");
  assert.match(live.stdout, /SIGKILL mid-drain: /, "the arm did not report what it observed");
});

// ── summary ─────────────────────────────────────────────────────────────────

if (failed > 0) {
  console.log(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
