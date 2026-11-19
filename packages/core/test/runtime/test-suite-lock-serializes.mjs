/**
 * Test: two suites serialize, a third refuses and names the first, and a run
 * inside the holder does not contend at all.
 *
 * The device is only worth its file if the second run of the suite actually
 * waits: a lock the second run takes by mistake, or ignores, would leave two
 * suites on the box while a green suite claimed otherwise. So the instrument is
 * the runs' own timestamps - each benchmark file stamps its start and end into a
 * file of its own, and the check is that the two intervals do not overlap -
 * together with what each run printed.
 *
 * The holder is under the fixture's control in each case, which is what makes
 * the checks worth running on a loaded box: the first suite is held open by a
 * gate the fixture opens, so the window in which the second run must contend is
 * as wide as the check needs rather than as wide as the machine happens to be
 * fast. A fixture racing a timer would fail on a loaded box for a reason that is
 * not the device's.
 *
 * Pinned here:
 *   - a second run waits, prints the holder's line naming its pid, and runs only
 *     after the holder releases: no file of the two runs was in flight at once;
 *   - a run that is not going to get the lock refuses with exit 75 and names the
 *     holder's pid, command line, working directory and revision, plus the
 *     command that opens the lock file - and starts none of its own files;
 *   - a run inside the holder does not contend, which is what keeps a fixture
 *     that spawns the runner from deadlocking the suite it is part of;
 *   - a bench tree (PI_TEST_ROOT) takes no lock, and says so.
 *
 * Run: node test/runtime/test-suite-lock-serializes.mjs
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { MODE_ENV, TOKEN_ENV, WAIT_ENV, acquireSuiteLock } from "../../scripts/lib/suite-lock.mjs";
import {
  gatedFixture,
  intervalOf,
  makeBench,
  readStamps,
  waitFor,
} from "./lib/suite-lock-bench.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "../../scripts/run-tests.mjs");

/** The bound a queued run is given: far past any wait the fixture puts it through. */
const QUEUE_MS = 20_000;

describe("a second suite", () => {
  let bench;
  before(() => {
    bench = makeBench({
      files: {
        "test-gated.mjs": gatedFixture({ label: "gated" }),
        "test-plain.mjs": gatedFixture({ label: "plain" }),
      },
    });
  });
  after(() => bench?.remove());

  it("waits for the holder, names it, and runs only after it released", async () => {
    const firstStamps = join(bench.dir, "first.stamps");
    const secondStamps = join(bench.dir, "second.stamps");
    const gate = join(bench.dir, "gate.open");

    // The first suite runs one file and stops at the gate; the second file it
    // would reach is never asked for, because --jobs 1 keeps it behind the gate.
    const first = bench.start(["--jobs", "1"], { BENCH_STAMPS: firstStamps, BENCH_GATE: gate });
    try {
      // The gate is the only precondition: it proves the first run is live and
      // holds the lock. Waiting on the lock file itself would make this case
      // unable to say "no lock was taken" - which is the first thing it has to
      // be able to say when the acquisition is removed.
      await waitFor("the first run to reach its gate", () =>
        readStamps(firstStamps).some((stamp) => stamp.phase === "armed"),
      );

      const second = bench.start(["--jobs", "1"], {
        BENCH_STAMPS: secondStamps,
        [WAIT_ENV]: String(QUEUE_MS),
      });
      // Either the holder's line arrives or the second run settles without one.
      // Both outcomes are facts the assertions below judge; neither may hold the
      // check here until a timer expires, because the box's speed is not the
      // subject.
      const holderLine = waitFor("the second run to report the holder", () =>
        /Suite lock: waiting, another suite holds it/.test(second.output()),
      );
      await Promise.race([second.done, holderLine.catch(() => null)]);

      // Open the gate: the holder finishes its file, exits, and releases.
      writeFileSync(gate, "open\n");
      const [firstResult, secondResult] = await Promise.all([first.done, second.done]);

      // The timing is the claim: no file of one run was in flight while a file
      // of the other was. Everything below explains it; this proves it.
      const before = intervalOf(readStamps(firstStamps));
      const afterRelease = intervalOf(readStamps(secondStamps));
      assert.ok(before, "the first run stamped nothing");
      assert.ok(afterRelease, "the second run stamped nothing, so it never ran");
      assert.ok(
        afterRelease.start > before.end,
        `the runs overlapped: the holder ended at ${before.end}, the second run started at ` +
          `${afterRelease.start} - a second suite ran beside the first`,
      );

      assert.equal(firstResult.status, 0, firstResult.output);
      assert.equal(secondResult.status, 0, secondResult.output);
      assert.match(firstResult.output, /Suite lock: held by this run/);
      assert.match(secondResult.output, /Suite lock: waiting, another suite holds it/);
      assert.match(secondResult.output, /Suite lock: held by this run/);
      assert.match(
        secondResult.output,
        new RegExp(`pid\\s+${first.pid} on`),
        `the waiting run must name the holder's pid: ${secondResult.output}`,
      );
    } finally {
      // A failed assertion above must not leave the first run waiting at the
      // gate until the runner kills it at the cap.
      writeFileSync(gate, "open\n");
      await first.done;
    }
  });

  it("that will not get the lock refuses, naming the holder, and starts nothing", async () => {
    const refusedStamps = join(bench.dir, "refused.stamps");
    // This fixture holds the lock through the same module, so the refusal is
    // about the lock's rules rather than about another process's lifetime.
    const holder = await acquireSuiteLock({ root: bench.core });
    try {
      const refused = bench.start(["--jobs", "1"], {
        BENCH_STAMPS: refusedStamps,
        [WAIT_ENV]: "300",
      });
      const result = await refused.done;
      assert.equal(result.status, 75, `expected EX_TEMPFAIL: ${result.output}`);

      const said = result.output;
      assert.match(said, /Suite lock: refused after waiting/);
      assert.ok(new RegExp(`pid\\s+${process.pid} on`).test(said), `the pid is missing: ${said}`);
      assert.ok(
        said.includes(`command   ${process.argv.join(" ")}`),
        `the holder's command line is missing: ${said}`,
      );
      assert.ok(said.includes(`cwd       ${process.cwd()}`), `the holder's cwd is missing: ${said}`);
      assert.ok(
        said.includes(`revision  ${bench.revision}`),
        `the holder's revision is missing: ${said}`,
      );
      assert.ok(said.includes(`cat ${bench.lockFile}`), `the inspect command is missing: ${said}`);
      assert.match(said, /Nothing was started/);
      assert.equal(existsSync(refusedStamps), false, "the refused run started a file");
    } finally {
      holder.release();
      delete process.env[TOKEN_ENV];
    }
  });

  it("inside the holder does not contend, and runs", async () => {
    const nestedStamps = join(bench.dir, "nested.stamps");
    const holder = await acquireSuiteLock({ root: bench.core, log: () => {} });
    try {
      const token = bench.readLock().token;
      const nested = bench.start([], {
        BENCH_STAMPS: nestedStamps,
        [TOKEN_ENV]: token,
        [WAIT_ENV]: "0",
        [MODE_ENV]: "refuse",
      });
      const result = await nested.done;
      assert.equal(result.status, 0, `a run inside the holder must not be refused: ${result.output}`);
      assert.match(result.output, /inside that suite, not beside it/);
      assert.equal(
        /Suite lock: refused/.test(result.output),
        false,
        "a run inside the holder must not print a refusal",
      );
      assert.ok(intervalOf(readStamps(nestedStamps)), "the nested run never ran its files");
    } finally {
      holder.release();
      delete process.env[TOKEN_ENV];
    }
  });
});

describe("a bench tree", () => {
  let tree;
  before(() => {
    tree = mkdtempSync(join(tmpdir(), "suite-lock-bench-tree-"));
    writeFileSync(join(tree, "bench-pass.mjs"), 'console.log("Results: 1 passed, 0 failed");\n');
  });
  after(() => rmSync(tree, { recursive: true, force: true }));

  it("takes no lock, because it is not the suite", async () => {
    const env = { ...process.env, PI_TEST_ROOT: tree, PI_TEST_JOBS: "1" };
    delete env[TOKEN_ENV];
    delete env[WAIT_ENV];
    const result = await spawnRunner(env);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Suite lock: none taken - PI_TEST_ROOT runs a bench tree/);
  });
});

/** Run the repository's own runner over the bench tree, and collect what it printed. */
function spawnRunner(env) {
  const child = spawn(process.execPath, [RUNNER], {
    cwd: dirname(RUNNER),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => chunks.push(chunk));
  return new Promise((settle) => {
    child.on("error", (error) =>
      settle({ status: null, output: `${chunks.join("")}${error.message}` }),
    );
    child.on("close", (status) => settle({ status, output: chunks.join("") }));
  });
}
