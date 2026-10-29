/**
 * pi-braid/telegram test runner.
 * Run: node test/run-tests.mjs  (or: npm test)
 *
 * 1. Emits the TypeScript sources into packages/telegram/dist (gitignored) so
 *    the node:test files can import plain ESM JS — the .js-extension source
 *    imports (resolved .js -> .ts by pi's loader, not by node's type-stripping)
 *    make direct .ts execution impossible. Mirrors core's build-then-test flow.
 * 2. Spawns `node <file>.test.mjs` for every test file under test/. Each
 *    child gets a normalized env (child-env.mjs): role-relevant ambient
 *    variables stripped, poller lock pinned per file.
 * 3. Gives every child its own TMPDIR and removes it when the file settles,
 *    and on SIGINT/SIGTERM too. The per-case trees a fixture mkdtemps are
 *    therefore inside the sandbox rather than the machine's temp directory,
 *    and the runner takes the whole tree away: a fixture killed at the cap
 *    cannot remove what it made, so the environment it litters in is the
 *    runner's to own.
 * NO npm install, NO network.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { childEnv } from "./child-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

/** Walk up from `from` to find the hoisted typescript tsc bin (monorepo). */
function findTscBin(from) {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", "typescript", "bin", "tsc");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "tsc"; // fall back to PATH
}

// ── 1. Build the test target ────────────────────────────────────────────────
const dist = join(pkgRoot, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const tsc = spawnSync(
  "node",
  [findTscBin(pkgRoot), "-p", "tsconfig.build.json"],
  {
    cwd: pkgRoot,
    encoding: "utf-8",
    env: childEnv("tsc"),
  },
);
if (tsc.status !== 0) {
  process.stderr.write(tsc.stdout);
  process.stderr.write(tsc.stderr);
  console.error("tsc emit to dist/ failed — cannot run tests.");
  process.exit(1);
}

// ── 2. Run every test file ──────────────────────────────────────────────────
const testFiles = readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

/** Every file's cap, carried over from the blocking loop this runner used to be. */
const TIMEOUT_MS = 120_000;

/**
 * How long a killed file's pipes may still drain before the runner moves on.
 * SIGKILL cannot be refused, so this only covers a write already in flight on
 * a pipe whose reader is gone.
 */
const DRAIN_MS = 2_000;

/** The per-file sandbox's name under the temp directory. */
const SCRATCH_PREFIX = "pi-braid-telegram-test-";

/** Every detached child group currently alive, so a signal to the runner reaps them. */
const liveGroups = new Set();

/**
 * Every scratch dir not yet removed, so the signal path can sweep them.
 *
 * A file in flight owns both a process group and a TMPDIR. finish() releases
 * both; the signal handler never reaches finish(), so it reads this set
 * directly. A dir the removal could not take stays registered.
 */
const liveScratchDirs = new Set();

/** SIGKILL a file's process group, so helpers the fixture started die with it. */
function killGroup(pid) {
  if (typeof pid !== "number") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: the group is already gone, the common case.
  }
}

/** Remove a scratch dir; it stays registered until it is really gone. */
function removeScratchDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // The settle path still reports the file; litter never changes a verdict.
  }
  if (!existsSync(dir)) liveScratchDirs.delete(dir);
}

/**
 * Run one file to completion, settling with what it did.
 *
 * The child is spawned async rather than with spawnSync: a signal handler
 * cannot run while spawnSync blocks the loop, so a blocking loop cannot remove
 * a sandbox when Ctrl-C lands in the middle of a file. The cap is this
 * runner's own timer for the same reason it exists in core: the kill has to
 * reach the file's process group, and SIGKILL is the only signal a trapped
 * file cannot refuse.
 */
function runFile(file) {
  // A fresh TMPDIR per file. Everything the fixture makes with tmpdir() - and
  // the pins child-env derives from it - lands inside this tree, which the
  // runner removes whether the file passed, failed, timed out or was killed.
  const scratch = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
  liveScratchDirs.add(scratch);

  return new Promise((settle) => {
    const out = [];
    const err = [];
    let settled = false;
    let timedOut = false;
    let capTimer;
    let drainTimer;
    let child;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(capTimer);
      clearTimeout(drainTimer);
      const pid = child?.pid;
      killGroup(pid);
      if (typeof pid === "number") liveGroups.delete(pid);
      removeScratchDir(scratch);
      settle({
        ...payload,
        timedOut,
        stdout: out.join(""),
        stderr: err.join(""),
      });
    };

    try {
      child = spawn("node", [join("test", file)], {
        cwd: pkgRoot,
        // Own group: the cap and the interrupt both have to reach helpers the
        // fixture started, not just the file's own process.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv(file, { ...process.env, TMPDIR: scratch }),
      });
    } catch (error) {
      finish({ status: null, signal: null, error });
      return;
    }

    if (typeof child.pid === "number") liveGroups.add(child.pid);
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => finish({ status: null, signal: null, error }));
    // Settle on close, not exit: a helper holding the inherited pipe can still
    // write after the file's process exits, and the cap bounds that wait.
    child.on("close", (status, signal) => finish({ status, signal }));

    capTimer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ status: null, signal: "SIGKILL" });
      }, DRAIN_MS);
    }, TIMEOUT_MS);
  });
}

/**
 * A signal must not leave a sandbox behind. The handler kills every live group,
 * sweeps the scratch dirs synchronously, and exits with the code the signal
 * defines.
 *
 * Installed after the build on purpose: the build blocks in spawnSync, and a
 * handler registered before it could not run until tsc returned, which would
 * turn Ctrl-C into a wait. No sandbox exists during the build, so the default
 * action is the whole cleanup there.
 */
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.on(signal, () => {
    const live = [...liveGroups];
    for (const pid of live) killGroup(pid);
    for (const dir of liveScratchDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // The exit code still has to be the signal's.
      }
    }
    console.log(
      `\n  ${signal}: killed ${live.length} running file group${live.length === 1 ? "" : "s"}`,
    );
    process.exit(code);
  });
}

console.log(
  `\n@pi-braid/telegram: ${testFiles.length} test file(s) from dist/ build\n`,
);

let passed = 0;
let failed = 0;
const failures = [];

for (const file of testFiles) {
  const result = await runFile(file);
  const label = `[${file}]`;
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.timedOut) {
    failed++;
    failures.push(file);
    console.error(`${label} FAIL (timeout after ${TIMEOUT_MS / 1000}s)`);
  } else if (result.status === 0) {
    passed++;
    console.log(`${label} PASS`);
  } else {
    failed++;
    failures.push(file);
    const reason = result.error
      ? result.error.message
      : (result.status ?? result.signal ?? "unknown");
    console.error(`${label} FAIL (exit ${reason})`);
  }
  console.log("");
}

// A removal that failed at settle gets one more try now that every group is
// gone. A dir that survives both is named rather than left silent.
for (const dir of [...liveScratchDirs]) {
  removeScratchDir(dir);
  if (existsSync(dir)) console.error(`warning: sandbox not removed: ${dir}`);
}

console.log(`telegram: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
