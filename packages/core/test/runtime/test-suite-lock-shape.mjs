/**
 * Test: the suite lock's file, where it lives, and when it may be taken.
 *
 * The lock exists to stop a second full suite from running beside the first, and
 * every rule that makes it safe is a rule about a file: where the file sits
 * (one repository, one file, every worktree sharing it), what it carries (a
 * refusal that names nobody teaches nothing), and when it may be taken from its
 * holder (a pid the kernel no longer has, an age past the ceiling, and never
 * another host's lock).
 *
 * Pinned here:
 *   - the file is inside the checkout's common git directory, and a second
 *     worktree of the same repository resolves to the same file - one lock per
 *     repository, not one per worktree, which is the overlap the rule is for;
 *   - the file is not the machine's temp root and not the home directory;
 *   - a taken lock carries the pid, host, start time, command line, working
 *     directory and revision, each read back out of the file itself;
 *   - a lock whose pid is gone is reclaimed, and the line says which rule fired;
 *   - a lock past the ceiling is reclaimed even with a live pid, because a reused
 *     pid looks alive forever;
 *   - a live holder's lock is not reclaimed, and the refusal names the holder;
 *   - a lock from another host is never reclaimed, even with a dead pid;
 *   - a file that does not read as a lock is refused until its age passes the
 *     ceiling, never on the strength of its content;
 *   - release removes the lock only while it still carries this run's token.
 *
 * Run: node test/runtime/test-suite-lock-shape.mjs
 */

import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import {
  CEILING_ENV,
  FILE_ENV,
  SuiteLockBusy,
  TOKEN_ENV,
  WAIT_ENV,
  acquireSuiteLock,
  suiteLockTarget,
} from "../../scripts/lib/suite-lock.mjs";
import { makeBench } from "./lib/suite-lock-bench.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const THIS_HOST = hostname();

/** A lock record the fixture plants itself, so a rule can be read apart from a live run. */
function record(overrides = {}) {
  const startedAtMs = Date.now();
  return {
    pid: process.pid,
    host: THIS_HOST,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    command: "node bench-runner.mjs",
    cwd: "/bench/packages/core",
    revision: "abc1234",
    branch: "bench",
    token: "planted-by-the-fixture",
    ...overrides,
  };
}

/** Plant a record at `file`, optionally aged on disk so its mtime is old too. */
function plant(file, overrides = {}, { ageMs = 0 } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record(overrides), null, 2)}\n`);
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(file, when, when);
  }
}

/** Run `fn` with these environment values, restoring whatever was there after. */
async function withEnv(vars, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The refusal an acquisition raises, or null when it did not raise one. */
async function refusal(options) {
  try {
    const lock = await acquireSuiteLock(options);
    lock.release();
    return null;
  } catch (error) {
    return error;
  }
}

describe("where the lock lives", () => {
  let bench;
  before(() => {
    bench = makeBench();
  });
  after(() => bench?.remove());

  it("is inside the checkout's common git directory", () => {
    const target = suiteLockTarget(bench.core);
    assert.equal(target.file, join(bench.commonDir, "pi-braid", "suite.lock"));
    assert.equal(dirname(target.file), join(target.commonDir, "pi-braid"));
  });
  it("is one file for every worktree of the repository", () => {
    const fromWorktree = suiteLockTarget(bench.addWorktree()).file;
    assert.equal(
      fromWorktree,
      suiteLockTarget(bench.core).file,
      "a second checkout of the same repository must contend for the same file",
    );
  });

  it("is neither the machine's temp root nor the home directory", () => {
    // The repository this suite runs in, not a bench: the rule is about where a
    // real checkout puts the lock.
    const target = suiteLockTarget(resolve(HERE, "..", ".."));
    assert.ok(target.repo, "the suite runs inside a repository");
    assert.equal(
      dirname(target.file),
      join(target.commonDir, "pi-braid"),
      `the lock belongs to the repository's git directory, not the machine: ${target.file}`,
    );
    assert.notEqual(dirname(target.file), tmpdir());
    assert.notEqual(dirname(target.file), homedir());
    assert.equal(
      target.commonDir.startsWith(`${tmpdir()}/`),
      false,
      `the lock's own directory is inside a temp tree: ${target.commonDir}`,
    );
  });
});

describe("the record it carries", () => {
  describe("a taken lock", () => {
    let bench;
    let lock;

    before(async () => {
      bench = makeBench();
      lock = await acquireSuiteLock({ root: bench.core });
    });
    after(() => {
      lock?.release();
      delete process.env[TOKEN_ENV];
      bench?.remove();
    });

    it("is a file at the resolved path", () => {
      assert.ok(existsSync(bench.lockFile), `no lock at ${bench.lockFile}`);
    });

    it("names the holding pid and host", () => {
      const taken = bench.readLock();
      assert.equal(taken.pid, process.pid);
      assert.equal(taken.host, THIS_HOST);
    });

    it("carries a start time a reader can check against the clock", () => {
      const taken = bench.readLock();
      assert.ok(Number.isFinite(taken.startedAtMs), "startedAtMs is the age instrument");
      assert.ok(
        Math.abs(Date.now() - taken.startedAtMs) < 10_000,
        `startedAtMs ${taken.startedAtMs} is not the moment the lock was taken`,
      );
      assert.ok(
        Math.abs(Date.now() - Date.parse(taken.startedAt)) < 10_000,
        `startedAt ${taken.startedAt} is not the moment the lock was taken`,
      );
    });

    it("carries the command line and the working directory that took it", () => {
      const taken = bench.readLock();
      assert.equal(taken.command, process.argv.join(" "));
      assert.ok(taken.command.includes(process.argv[1]), "the command names the script that ran");
      assert.equal(taken.cwd, process.cwd());
    });

    it("carries the revision and the branch it was taken at", () => {
      const taken = bench.readLock();
      assert.equal(taken.revision, bench.revision);
      assert.equal(taken.branch, bench.git(["rev-parse", "--abbrev-ref", "HEAD"]));
    });

    it("carries a token, which is how a child run proves it is inside this one", () => {
      const taken = bench.readLock();
      assert.equal(typeof taken.token, "string");
      assert.ok(taken.token.length > 0);
      assert.equal(process.env[TOKEN_ENV], taken.token, "the holder exports the token to its children");
    });
  });
});

describe("a stale lock is reclaimed", () => {
  let bench;
  before(() => {
    bench = makeBench();
  });
  after(() => bench?.remove());

  it("when its pid is gone, and the line says so", async () => {
    plant(bench.lockFile, { pid: 999_999 });
    const lines = [];
    const lock = await acquireSuiteLock({ root: bench.core, log: (line) => lines.push(line) });
    try {
      const reclaimed = lines.find((line) => line.includes("reclaimed"));
      assert.ok(reclaimed, `no reclaim line in ${JSON.stringify(lines)}`);
      assert.match(reclaimed, /pid 999999 is gone/);
      assert.equal(bench.readLock().pid, process.pid, "the reclaimed lock is this run's now");
    } finally {
      lock.release();
      delete process.env[TOKEN_ENV];
    }
  });

  it("when it is past the ceiling, even though its pid is alive", async () => {
    plant(bench.lockFile, { startedAtMs: Date.now() - 3 * 3_600_000 });
    const lines = [];
    const lock = await withoutToken(() =>
      withEnv({ [CEILING_ENV]: "3600000" }, () =>
        acquireSuiteLock({ root: bench.core, log: (line) => lines.push(line) }),
      ),
    );
    try {
      const reclaimed = lines.find((line) => line.includes("reclaimed"));
      assert.ok(reclaimed, `no reclaim line in ${JSON.stringify(lines)}`);
      assert.match(reclaimed, /past the 1h ceiling/);
    } finally {
      lock.release();
      delete process.env[TOKEN_ENV];
    }
  });

  it("but a live holder's lock is not, and the refusal names it", async () => {
    plant(bench.lockFile, { pid: process.pid });
    // Held, not released, until the file has been read: the takeover is what
    // this case is about, so the evidence of it has to survive the assertion.
    const attempt = await withoutToken(() =>
      withEnv({ [WAIT_ENV]: "150" }, async () => {
        try {
          return { lock: await acquireSuiteLock({ root: bench.core }), error: null };
        } catch (error) {
          return { lock: null, error };
        }
      }),
    );
    try {
      const after = bench.readLock();
      assert.equal(
        after?.token,
        "planted-by-the-fixture",
        `the live holder's lock was taken from it by pid ${after?.pid} (${after?.token})`,
      );
      assert.ok(attempt.error instanceof SuiteLockBusy, `expected a refusal, got ${attempt.error}`);
      assert.equal(attempt.error.exitCode, 75);
      assert.match(attempt.error.message, new RegExp(`pid ${process.pid} on ${THIS_HOST}`));
      assert.match(attempt.error.message, /never taken over/);
      assert.match(
        attempt.error.message,
        new RegExp(`cat ${bench.lockFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
    } finally {
      attempt.lock?.release();
      rmSync(bench.lockFile, { force: true });
    }
  });

  it("but a lock from another host never is, even with a dead pid", async () => {
    plant(bench.lockFile, { pid: 999_999, host: "another-host.invalid" });
    const error = await withoutToken(() =>
      withEnv({ [WAIT_ENV]: "150" }, () => refusal({ root: bench.core })),
    );
    try {
      assert.ok(error instanceof SuiteLockBusy, `expected a refusal, got ${error}`);
      assert.match(error.message, /another suite is live \(pid 999999 on another-host\.invalid\)/);
      assert.match(error.message, /never reclaimed from here; a person releases it/);
      assert.equal(bench.readLock().pid, 999_999, "the foreign lock was not taken");
    } finally {
      rmSync(bench.lockFile, { force: true });
    }
  });

  it("and a file that does not read as a lock is refused until its age passes the ceiling", async () => {
    mkdirSync(dirname(bench.lockFile), { recursive: true });
    writeFileSync(bench.lockFile, "not a lock record at all\n");
    const young = await withoutToken(() =>
      withEnv({ [WAIT_ENV]: "150" }, () => refusal({ root: bench.core })),
    );
    assert.ok(young instanceof SuiteLockBusy, `expected a refusal, got ${young}`);
    assert.match(young.message, /cannot read/);
    assert.match(young.message, /rm /, "the reader is told how to clear it by hand");

    const when = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(bench.lockFile, when, when);
    const lines = [];
    const lock = await withoutToken(() =>
      withEnv({ [CEILING_ENV]: "3600000" }, () =>
        acquireSuiteLock({ root: bench.core, log: (line) => lines.push(line) }),
      ),
    );
    try {
      assert.ok(
        lines.some((line) => line.includes("reclaimed") && line.includes("unreadable")),
        `no reclaim line for the old unreadable file: ${JSON.stringify(lines)}`,
      );
    } finally {
      lock.release();
      delete process.env[TOKEN_ENV];
    }
  });
});

describe("release", () => {
  let scratch;
  let file;
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "suite-lock-release-"));
    file = join(scratch, "suite.lock");
  });
  after(() => rmSync(scratch, { recursive: true, force: true }));

  it("removes the lock this run took", async () => {
    const lock = await withoutToken(() =>
      withEnv({ [FILE_ENV]: file }, () => acquireSuiteLock({ root: scratch })),
    );
    assert.ok(existsSync(file), "the lock was taken");
    lock.release();
    assert.equal(existsSync(file), false, "the lock outlived the run that took it");
  });

  it("leaves a lock another run has taken over, and does not report success", async () => {
    const lock = await withoutToken(() =>
      withEnv({ [FILE_ENV]: file }, () => acquireSuiteLock({ root: scratch })),
    );
    // A replacement lock at the same path, as a reclaim by another run leaves.
    plant(file, { token: "another-run" });
    lock.release();
    assert.equal(existsSync(file), true, "a lock this run no longer holds was deleted");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).token, "another-run");
    rmSync(file, { force: true });
  });
});

/** Run with no inherited holder token, so the fixture is a stranger to the lock. */
async function withoutToken(fn) {
  return withEnv({ [TOKEN_ENV]: undefined }, fn);
}
