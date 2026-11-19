/**
 * Test: the lock is released on every path a suite can end on.
 *
 * A device that holds a lock past the run that took it is worse than no device:
 * the next suite waits out its bound and refuses, and the fix a person reaches
 * for is to delete the file by hand, which teaches everyone to delete the file
 * by hand. So release is pinned here on each way a run ends, and the check is
 * the same each time - the lock file is not there afterwards.
 *
 * Pinned here:
 *   - a green run leaves no lock;
 *   - a run whose file fails leaves no lock (the suite's own exit code, 1);
 *   - a run whose file throws while it loads leaves no lock;
 *   - SIGTERM while a file is in flight leaves no lock, and the runner still
 *     reports the signal it took;
 *   - `--build` runs the workspace build after the lock is taken and before the
 *     first file, and a build that fails leaves no lock.
 *
 * Run: node test/runtime/test-suite-lock-release.mjs
 */

import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  FAILING_FIXTURE,
  THROWING_FIXTURE,
  inFlightFixture,
  intervalOf,
  makeBench,
  readStamps,
  stampingFixture,
  waitFor,
} from "./lib/suite-lock-bench.mjs";

/** A build script that records itself, so the order of build and files is readable. */
const STAMPING_BUILD = {
  name: "bench-core",
  private: true,
  scripts: {
    build:
      "node -e \"require('node:fs').appendFileSync(process.env.BENCH_STAMPS, 'build - ' + Date.now() + '\\n')\"",
  },
};

/** A build script that fails, so the lock has to survive a build that never finished. */
const FAILING_BUILD = {
  name: "bench-core",
  private: true,
  scripts: { build: "node -e \"process.exit(3)\"" },
};

describe("a run that ends", () => {
  let bench;
  before(() => {
    bench = makeBench({ files: { "test-pass.mjs": stampingFixture({ label: "pass", ms: 50 }) } });
  });
  after(() => bench?.remove());

  it("green leaves no lock behind", async () => {
    const result = await bench.start([], { BENCH_STAMPS: join(bench.dir, "green.stamps") }).done;
    assert.equal(result.status, 0, result.output);
    assert.equal(existsSync(bench.lockFile), false, `the lock outlived the run: ${bench.lockFile}`);
  });
});

describe("a run whose files fail", () => {
  let bench;
  before(() => {
    bench = makeBench({ files: { "test-boom.mjs": FAILING_FIXTURE } });
  });
  after(() => bench?.remove());

  it("exits 1 with the lock gone", async () => {
    const result = await bench.start([], { BENCH_STAMPS: join(bench.dir, "fail.stamps") }).done;
    assert.equal(result.status, 1, result.output);
    assert.equal(existsSync(bench.lockFile), false, `the lock outlived the failed run`);
  });
});

describe("a run whose file throws while it loads", () => {
  let bench;
  before(() => {
    bench = makeBench({ files: { "test-throws.mjs": THROWING_FIXTURE } });
  });
  after(() => bench?.remove());

  it("exits 1 with the lock gone", async () => {
    const result = await bench.start([], { BENCH_STAMPS: join(bench.dir, "throw.stamps") }).done;
    assert.equal(result.status, 1, result.output);
    assert.equal(existsSync(bench.lockFile), false, "the lock outlived the throwing run");
  });
});

describe("a run that is interrupted", () => {
  let bench;
  let proof;
  before(() => {
    bench = makeBench();
    proof = join(bench.dir, "in-flight.proof");
    bench.write("test-in-flight.mjs", inFlightFixture({ proofFile: proof }));
  });
  after(() => bench?.remove());

  it("exits on the signal with the lock gone", async () => {
    const run = bench.start([], { BENCH_STAMPS: join(bench.dir, "term.stamps") });
    await waitFor("the file to prove it is running", () => existsSync(proof));
    assert.ok(bench.readLock(), "the run held the lock before the signal");

    run.child.kill("SIGTERM");
    const result = await run.done;
    assert.equal(result.status, 143, `expected the runner's SIGTERM exit code: ${result.output}`);
    assert.match(result.output, /SIGTERM: killed 1 running file group/);
    assert.equal(existsSync(bench.lockFile), false, "the lock outlived the interrupted run");
  });
});

describe("the build a workspace's npm test runs", () => {
  it("runs after the lock is taken and before the first file", async () => {
    const bench = makeBench({
      files: { "test-pass.mjs": stampingFixture({ label: "file", ms: 50 }) },
      packageManifest: STAMPING_BUILD,
    });
    try {
      const stamps = join(bench.dir, "build.stamps");
      const result = await bench.start(["--build"], { BENCH_STAMPS: stamps }).done;
      assert.equal(result.status, 0, result.output);
      const order = readStamps(stamps).map((stamp) => stamp.phase);
      assert.deepEqual(order, ["build", "start", "end"], `expected the build first: ${order}`);
      assert.equal(existsSync(bench.lockFile), false, "the lock outlived the run");
    } finally {
      bench.remove();
    }
  });

  it("leaves no lock when the build itself fails", async () => {
    const bench = makeBench({
      files: { "test-pass.mjs": stampingFixture({ label: "file", ms: 50 }) },
      packageManifest: FAILING_BUILD,
    });
    try {
      const stamps = join(bench.dir, "build-failed.stamps");
      const result = await bench.start(["--build"], { BENCH_STAMPS: stamps }).done;
      assert.equal(result.status, 3, `the build's exit code has to reach the caller: ${result.output}`);
      assert.equal(intervalOf(readStamps(stamps)), null, "files ran beside a failed build");
      assert.equal(existsSync(bench.lockFile), false, "the lock outlived the failed build");
    } finally {
      bench.remove();
    }
  });
});
