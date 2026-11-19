/**
 * suite-lock-bench.mjs: the bench repository the suite-lock fixtures run against.
 *
 * The lock reads its repository from the runner's own location and its file from
 * that repository's common git directory, so a bench that is not a repository
 * would take no lock and prove nothing. This builds one: a git repository, a
 * copy of the real runner under `packages/core/scripts/` with the module it
 * imports beside it, and benchmark fixture files under
 * `packages/core/test/runtime/`. A run of the copy is therefore a suite with its
 * own lock, and nothing in the repository under test is touched.
 *
 * Why a real repository instead of PI_SUITE_LOCK_FILE: a refusal has to name the
 * revision the holder took, and a directory with no `.git` has none to name. The
 * file the module resolves for a bench is also part of what is under test - it
 * has to be inside the git directory, shared by every worktree of the same
 * repository - and pointing the module at a path instead would test neither.
 *
 * The bench control knobs the parent environment may carry are dropped from a
 * spawned run's environment: a developer running the suite with a longer wait
 * bound must not change what these fixtures prove. The holder's token is dropped
 * for the same reason and a second one: the fixtures that want contention must
 * look like a suite started from a shell, not like a child of the holder whose
 * lock they are contending for.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertFixtureParses } from "./fixture-guard.mjs";
import {
  CEILING_ENV,
  FILE_ENV,
  MODE_ENV,
  TOKEN_ENV,
  WAIT_ENV,
  suiteLockTarget,
} from "../../../scripts/lib/suite-lock.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, "..", "..", "..", "scripts");

/** The bench control knobs, all of which a spawned run starts without. */
const DROPPED_ENV = [CEILING_ENV, FILE_ENV, MODE_ENV, TOKEN_ENV, WAIT_ENV];

/**
 * A benchmark fixture that stamps its own start and end into a file.
 *
 * The stamps are the instrument the serialising check needs: a run's process
 * start time says when the runner was spawned, but what has to be shown is that
 * no two runs' files were ever in flight together, which is the thing the lock
 * is for. Each run gets its own stamp file, so the two intervals are read apart.
 */
export function stampingFixture({ label, ms }) {
  return `import { appendFileSync } from "node:fs";

const stamp = (phase) =>
  appendFileSync(process.env.BENCH_STAMPS, \`\${phase} ${label} \${Date.now()}\\n\`);

stamp("start");
setTimeout(() => {
  stamp("end");
  console.log("Results: 1 passed, 0 failed");
}, ${ms});
`;
}

/**
 * A benchmark fixture that arms itself and then waits for a file to appear.
 *
 * The serialising check needs one run that holds the lock for exactly as long as
 * the fixture wants it to, not for as long as the box happens to take: a run
 * whose length is a timer is a race on a loaded machine, and the race is between
 * the second run's start and the first run's end. The gate is closed by this
 * process and opened by it, so the window is as wide as the check needs.
 */
export function gatedFixture({ label }) {
  return `import { appendFileSync, existsSync } from "node:fs";

const stamp = (phase) =>
  appendFileSync(process.env.BENCH_STAMPS, \`\${phase} ${label} \${Date.now()}\\n\`);

stamp("armed");
for (;;) {
  if (!process.env.BENCH_GATE || existsSync(process.env.BENCH_GATE)) break;
  await new Promise((tick) => setTimeout(tick, 25));
}
stamp("start");
stamp("end");
console.log("Results: 1 passed, 0 failed");
`;
}

/** A benchmark fixture that fails, for the release-on-failure check. */
export const FAILING_FIXTURE = `import { strict as assert } from "node:assert";
assert.equal("got", "wanted", "the bench failure the release has to survive");
`;

/** A benchmark fixture that throws while it loads, for the same check. */
export const THROWING_FIXTURE = `throw new Error("the bench throws before its first case");
`;

/**
 * A benchmark fixture that proves it started and then stays alive, so an
 * interrupt lands on a live file rather than in the runner's spawn window.
 */
export function inFlightFixture({ proofFile }) {
  return `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(proofFile)}, String(process.pid));
setTimeout(() => {}, 60_000);
`;
}

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/**
 * Build the bench described in the header.
 *
 * `files` maps a tree-relative path to its source. `packageManifest` is written
 * as the bench core's own `package.json` when a case needs one, which is only
 * the build path: `--build` runs the manifest's own build script.
 */
export function makeBench({ files = {}, packageManifest = null } = {}) {
  // The physical path: a child's `process.cwd()` reports the resolved one, and a
  // fixture comparing the two spellings of the same directory would fail on the
  // platform whose temp directory is a symlink.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "suite-lock-bench-")));
  const core = join(dir, "packages", "core");
  const tree = join(core, "test", "runtime");
  const runner = join(core, "scripts", "run-tests.mjs");
  mkdirSync(join(core, "scripts", "lib"), { recursive: true });
  mkdirSync(tree, { recursive: true });

  // The runner and the module it imports are copied together: a bench that
  // copies the runner copies what the runner loads, or it does not load.
  writeFileSync(runner, readFileSync(join(SCRIPTS, "run-tests.mjs"), "utf8"));
  writeFileSync(
    join(core, "scripts", "lib", "suite-lock.mjs"),
    readFileSync(join(SCRIPTS, "lib", "suite-lock.mjs"), "utf8"),
  );
  assertFixtureParses(runner);
  assertFixtureParses(join(core, "scripts", "lib", "suite-lock.mjs"));

  for (const [name, source] of Object.entries(files)) {
    const target = join(tree, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
    assertFixtureParses(target);
  }
  if (packageManifest !== null) {
    writeFileSync(join(core, "package.json"), `${JSON.stringify(packageManifest, null, 2)}\n`);
  }

  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "bench@bench.local"]);
  git(dir, ["config", "user.name", "bench"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "bench: a repository for the lock to live in"]);

  // The path is resolved with the bench's own environment: a fixture that is
  // holding PI_SUITE_LOCK_FILE for an in-process case must not bend the bench.
  const savedFile = process.env[FILE_ENV];
  delete process.env[FILE_ENV];
  const target = suiteLockTarget(core);
  if (savedFile !== undefined) process.env[FILE_ENV] = savedFile;
  if (target.file === null) {
    throw new Error(`the bench at ${dir} is not a repository the lock can key on`);
  }
  const expected = target.commonDir ?? join(dir, ".git");
  if (!target.file.startsWith(join(expected, "pi-braid"))) {
    throw new Error(`the bench lock resolved to ${target.file}, outside ${expected}`);
  }

  return {
    dir,
    core,
    tree,
    runner,
    /** The lock file this bench's runs contend for. */
    lockFile: target.file,
    /** The checkout's common git directory, which is where the lock must sit. */
    commonDir: expected,
    /** The short revision a lock taken now carries. */
    revision: git(dir, ["rev-parse", "--short", "HEAD"]),
    git: (args) => git(dir, args),
    /** Write one more tree-relative fixture into the bench. */
    write(name, source) {
      const into = join(tree, name);
      mkdirSync(dirname(into), { recursive: true });
      writeFileSync(into, source);
      assertFixtureParses(into);
    },
    /**
     * A second checkout of this repository, as `git worktree add` makes one.
     * Its `packages/core` is the path a suite would run from there.
     */
    addWorktree(name = "wt") {
      const into = join(dir, name);
      git(dir, ["worktree", "add", "-q", "--detach", into, "HEAD"]);
      return join(into, "packages", "core");
    },
    /** Read the lock file as a record, or null when it is not there. */
    readLock() {
      try {
        return JSON.parse(readFileSync(target.file, "utf8"));
      } catch {
        return null;
      }
    },
    /**
     * Start one run of the bench runner and collect what it printed.
     *
     * The run's environment is the parent's minus the lock knobs, plus `env`:
     * a case that wants contention passes nothing, and a case that wants the
     * holder's child sets PI_SUITE_LOCK_TOKEN.
     */
    start(args = [], env = {}) {
      const base = { ...process.env };
      for (const key of DROPPED_ENV) delete base[key];
      const child = spawn(process.execPath, [runner, ...args], {
        cwd: core,
        env: { ...base, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks = [];
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.stderr.on("data", (chunk) => chunks.push(chunk));
      const startedAt = Date.now();
      const done = new Promise((settle) => {
        child.on("error", (error) =>
          settle({ status: null, signal: null, output: `${chunks.join("")}${error.message}`, ms: 0 }),
        );
        child.on("close", (status, signal) =>
          settle({ status, signal, output: chunks.join(""), ms: Date.now() - startedAt }),
        );
      });
      return { child, pid: child.pid, done, output: () => chunks.join("") };
    },
    remove() {
      try {
        git(dir, ["worktree", "prune"]);
      } catch {
        // A bench with no worktree has nothing to prune; the removal below is
        // what has to happen either way.
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Wait until `predicate` returns something truthy, then return it.
 *
 * A wait that times out names what it was waiting for and what it saw instead:
 * a fixture that gives up after ten seconds has to say whether the lock was
 * never written or the run never started, because those are different defects.
 */
export async function waitFor(what, predicate, { timeoutMs = 15_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`waited ${timeoutMs}ms for ${what}, and it did not happen`);
    }
    await new Promise((tick) => setTimeout(tick, intervalMs));
  }
}

/** The stamps one run wrote, in the order it wrote them: `[{phase, label, ms}]`. */
export function readStamps(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // No stamp file is a run that stamped nothing, which every caller reads as
    // "it never ran" rather than as an error in this helper.
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [phase, label, ms] = line.split(" ");
      return { phase, label, ms: Number(ms) };
    });
}

/** The interval one run's stamps describe, or null when the run stamped nothing. */
export function intervalOf(stamps) {
  const starts = stamps.filter((stamp) => stamp.phase === "start").map((stamp) => stamp.ms);
  const ends = stamps.filter((stamp) => stamp.phase === "end").map((stamp) => stamp.ms);
  if (starts.length === 0) return null;
  return { start: Math.min(...starts), end: Math.max(...ends) };
}
