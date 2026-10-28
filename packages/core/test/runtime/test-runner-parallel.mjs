/**
 * The runner's contract: three outcome classes, the exit code, a cap that
 * kills, and a pool that actually overlaps.
 *
 * The runner walks the whole suite, so every property it guarantees is
 * unpinned unless it is pinned over a bench: a change that made every file
 * "pass" or every timeout "wait forever" would still look like a walk. This
 * file points the real runner at a temporary tree through PI_TEST_ROOT and
 * reads its verdict from the outside.
 *
 * Pinned here:
 *   - a passing file, a failing file and a file that outlives its cap are
 *     reported as passed, failed and timed out - not two failures and not a
 *     hang;
 *   - the run exits non-zero on either red class, and zero on a green tree;
 *   - a file that hangs is killed at its cap: the run returns in about the
 *     cap, not in the file's own lifetime, and the file's process is gone;
 *   - two one-second files at width 2 finish in about one second, while the
 *     timings artifact shows their durations overlapping instead of adding
 *     up. That last pair is what makes this a test of the pool rather than a
 *     test of the loop.
 *
 * Tamper hook: PI_TEST_FIXTURE_JOBS sets the nested run's width and defaults
 * to 2. Run this file with it set to 1 to watch the concurrency assertions
 * fail - a gate whose failure has never been seen is a gate nobody has
 * tested.
 *
 * Run: node test/runtime/test-runner-parallel.mjs
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertFixtureParses } from "./lib/fixture-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "../../scripts/run-tests.mjs");
const JOBS = Number(process.env.PI_TEST_FIXTURE_JOBS ?? 2);

/** The pool's width in the concurrency bench; width 1 is the serial control. */
const WIDTH = Number.isInteger(JOBS) && JOBS > 0 ? JOBS : 2;

/** The hang probe's own lifetime, far past the cap it is given, so waiting it out is visible. */
const HANG_MS = 60_000;
const CLASSIFICATION_CAP_MS = 1_200;
const SLEEP_MS = 1_000;

const PASS = `console.log("Results: 1 passed, 0 failed");
`;

const FAIL = `import { strict as assert } from "node:assert";
assert.equal("got", "wanted", "the reason a red run has to carry");
`;

/**
 * Writes its own pid, then outlives the cap. The pid is the proof the run
 * killed the file rather than waiting it out: a wait would leave it alive
 * until the bench's own 60s timeout reddened the whole file.
 */
const HANG = `import { writeFileSync } from "node:fs";
writeFileSync(process.env.PROBE_PID_FILE, String(process.pid));
setTimeout(() => {}, ${HANG_MS});
`;

const SLEEP = `setTimeout(() => console.log("slept"), ${SLEEP_MS});
`;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [ok] ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  [fail] ${name}: ${error.message}`);
  }
}

/**
 * A tree of files for the runner to walk, plus the environment its run needs.
 *
 * Inherited PI_TEST_* settings are dropped: the pool's width, caps, allowance
 * overrides and timings target belong to the outer walk, and letting them
 * through would make this file's verdict depend on how the suite was invoked.
 */
function tree(files, dirName) {
  const dir = mkdtempSync(join(bench, dirName));
  for (const [name, source] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
    assertFixtureParses(target);
  }
  return dir;
}

function runRunner(dir, args, extraEnv = {}) {
  const env = { ...process.env, PI_TEST_ROOT: dir, ...extraEnv };
  for (const key of [
    "PI_TEST_JOBS",
    "PI_TEST_TIMEOUT_MS",
    "PI_TEST_ALLOWANCE",
    "PI_TEST_TIMINGS",
  ]) {
    if (!(key in extraEnv)) delete env[key];
  }
  const startedAt = Date.now();
  const run = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: dir,
    env,
    encoding: "utf8",
    // The hang probe lives 60s; a run that waited it out has to be reported
    // as this file's own failure rather than as an opaque timeout here.
    timeout: 20_000,
  });
  return { ...run, wallMs: Date.now() - startedAt, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

const bench = mkdtempSync(join(tmpdir(), "runner-parallel-"));
let run;
let sleepRun;

try {
  // ── The three outcome classes, and the cap ────────────────────────────────
  const probeDir = tree(
    { "test-pass.mjs": PASS, "test-fail.mjs": FAIL, "test-hang.mjs": HANG },
    "probe-",
  );
  const pidFile = join(bench, "hang.pid");
  run = runRunner(
    probeDir,
    ["--jobs", "3"],
    { PI_TEST_TIMEOUT_MS: String(CLASSIFICATION_CAP_MS), PROBE_PID_FILE: pidFile },
  );

  // ── The pool, over two files whose whole job is to sleep ──────────────────
  const sleepDir = tree({ "test-sleep-a.mjs": SLEEP, "test-sleep-b.mjs": SLEEP }, "sleep-");
  const timingsFile = join(bench, "timings.json");
  sleepRun = runRunner(sleepDir, ["--jobs", String(WIDTH), `--timings-json=${timingsFile}`]);

  check("a passing, a failing and a hanging file are classified apart", () => {
    assert.equal(
      run.error?.code,
      undefined,
      `the nested run returned on its own (wall ${run.wallMs}ms): ${run.output.slice(-400)}`,
    );
    assert.match(run.output, /1 passed, 1 failed, 1 timed out/, "each class is counted once");
    assert.match(run.output, /Failed: test-fail\.mjs/, "the failure is named");
    assert.match(run.output, /Timed out: test-hang\.mjs/, "the hang is named as a timeout, not as a failure");
    assert.match(
      run.output,
      /the reason a red run has to carry/,
      "the failing file's own assertion text reaches the run",
    );
  });

  check("the run exits non-zero when a file fails or times out", () => {
    assert.equal(run.status, 1, `a red tree is a red run: ${run.output.slice(-400)}`);
    assert.equal(
      sleepRun.status,
      0,
      `a green tree is a green run: ${sleepRun.output.slice(-400)}`,
    );
  });

  check("a hang is killed at its cap, not waited out", () => {
    // Two red classes at a 1.2s cap: a run that waited the hang out would
    // spend the probe's whole 60s lifetime here.
    assert.ok(
      run.wallMs < 10_000,
      `the run returned in ${run.wallMs}ms, so the hang was killed rather than awaited`,
    );
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(pid) && pid > 0, "the hang probe recorded its pid");
    assert.throws(
      () => process.kill(pid, 0),
      /ESRCH/,
      `process ${pid} outlived the run, so nothing killed its group`,
    );
  });

  check(`two ${SLEEP_MS}ms files at width ${WIDTH} finish in about one file's time`, () => {
    assert.equal(sleepRun.error?.code, undefined, "the nested run returned on its own");
    assert.match(sleepRun.output, /2 passed, 0 failed, 0 timed out/, "both files passed");
    if (WIDTH < 2) {
      // The tamper run: the assertion below is the one being watched redden.
      assert.fail(
        `width ${WIDTH} ran the files one at a time (${sleepRun.wallMs}ms) - the pool assertion has no subject`,
      );
    }
    assert.ok(
      sleepRun.wallMs < 2 * SLEEP_MS,
      `two ${SLEEP_MS}ms files at width ${WIDTH} took ${sleepRun.wallMs}ms, which is serial time`,
    );
  });

  check("the timings artifact shows the two files overlapped", () => {
    const artifact = JSON.parse(readFileSync(timingsFile, "utf8"));
    const summed = artifact.files.reduce((total, file) => total + file.ms, 0);
    const overlap = summed - artifact.totalMs;
    assert.equal(artifact.files.length, 2, "both files are in the artifact");
    assert.ok(
      overlap > SLEEP_MS / 2,
      `the files' own durations sum to ${summed}ms against a ${artifact.totalMs}ms run, so they did not overlap`,
    );
  });
} finally {
  rmSync(bench, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
