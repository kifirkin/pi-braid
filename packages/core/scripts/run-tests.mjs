/**
 * pi-braid unified test runner.
 * Run: npm test
 *
 * Uses spawnSync with exit codes (no stdout parsing) for robustness, and
 * reports three categories:
 *
 *   passed     the file exited 0
 *   failed     the file exited non-zero, or died on a signal
 *   timed out  the file outlived its allowance and was killed
 *
 * A killed file is not a failure: a hang and a broken assertion call for
 * different reactions, and reporting one as the other is what made a slow
 * file read as a permanent red. Timeouts still exit non-zero, so a real hang
 * stops the suite exactly as a failure does.
 *
 * Caps:
 *   - every file gets DEFAULT_TIMEOUT_MS
 *   - ALLOWANCES gives a specific file a longer declared allowance; the
 *     reason is printed in the summary, so an allowance cannot hide
 *   - the environment overrides both without an edit (see readAllowances)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const testDir = resolve(root, "test/runtime");

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Per-file wall-clock allowances, keyed by path relative to test/runtime.
 *
 * An entry declares that this file is legitimately slower than the default
 * cap. State the reason inline: the summary prints it, so a reader can tell a
 * declared slow file from a hang. Without an entry, a file that outlives the
 * cap is reported as a timeout.
 */
const ALLOWANCES = new Map([
  [
    "loader/test-module-config.mjs",
    {
      ms: 150_000,
      reason:
        "spawns nine child drivers two waves deep; worst case (every driver wedged, 2 x the driver's own 60s cap) has to land inside this allowance, so the file reports the stuck driver by name instead of being killed here as an opaque timeout",
    },
  ],
  [
    "release/test-publish-local-atomic-install.mjs",
    {
      ms: 120_000,
      reason:
        "drives real publish/install swaps at ~10s each on a warm machine; on a busy one it crosses the 30s default cap and reads as a timeout even though every subtest passes",
    },
  ],
  [
    "fleet/test-drain-contention.mjs",
    {
      ms: 60_000,
      reason:
        "three arms hold a real SQLite write lock in a second process for 6.2s, 1.2s and 2.5s, so the file is slow by construction and a loaded box can push it past the 30s default",
    },
  ],
]);

/** Recursively find all .mjs test files in subdirectories too. */
function findTests(dir) {
  const results = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findTests(full));
      } else if (entry.name.endsWith(".mjs") && !SKIP.has(entry.name)) {
        results.push(relative(testDir, full));
      }
    }
  } catch {
    /* */
  }
  return results;
}

const SKIP = new Set([
  "test-all.mjs", // aggregator, duplicates individual
  "test-br1-trap-tasks.mjs", // SLOW - requires API calls, run separately with 300s timeout
]);

/** Durations as printed: 12000 -> "12s", 1500 -> "1.5s". */
function formatMs(ms) {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The declared allowances plus any the environment adds:
 *   PI_TEST_TIMEOUT_MS=<ms>               cap for files without an allowance
 *   PI_TEST_ALLOWANCE="<path>=<ms>[,..]"  add or override a per-file allowance
 * Paths are relative to test/runtime, exactly as printed below.
 */
function readAllowances() {
  const table = new Map(ALLOWANCES);
  for (const item of (process.env.PI_TEST_ALLOWANCE ?? "").split(",")) {
    if (!item.trim()) continue;
    const [file, ms] = item.split("=").map((part) => part.trim());
    const value = Number(ms);
    if (!file || !Number.isFinite(value) || value <= 0) {
      console.error(`ignoring PI_TEST_ALLOWANCE entry "${item.trim()}" - expected "<path>=<ms>"`);
      continue;
    }
    table.set(file, { ms: value, reason: "PI_TEST_ALLOWANCE" });
  }
  const fallback = Number(process.env.PI_TEST_TIMEOUT_MS);
  return {
    table,
    fallback: Number.isFinite(fallback) && fallback > 0 ? fallback : DEFAULT_TIMEOUT_MS,
  };
}

const { table: allowances, fallback: defaultTimeoutMs } = readAllowances();
const tests = findTests(testDir).sort();

let passed = 0;
let failed = 0;
let timedOut = 0;
const failures = [];
const timeouts = [];

console.log(`Running ${tests.length} tests from ${testDir}\n`);

/**
 * Remove a scratch dir the runner owns. A file that started helpers can
 * outlive the runner's SIGKILL for a beat with a scratch dir still its cwd;
 * macOS then refuses the recursive remove, and force:true would swallow that
 * and leave the litter. The helpers are short-lived, so retry briefly — then
 * give up rather than hang the suite on a genuinely immortal child.
 */
function removeScratchDir(dir, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    rmSync(dir, { recursive: true, force: true });
    if (!existsSync(dir)) return;
    // spawnSync has returned, so there is no event-loop turn to await on;
    // block this process briefly instead.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

for (const t of tests) {
  const allowance = allowances.get(t);
  const timeout = allowance?.ms ?? defaultTimeoutMs;
  const label = `[${String(passed + failed + timedOut + 1)}/${tests.length}]`;
  // A file gets its own TMPDIR: the child's own cleanup cannot run when this
  // runner SIGKILLs it at the cap, so the environment it litters in is ours to
  // remove. The removal sits before every branch, so the timeout path is
  // covered like the rest.
  const testTmpDir = mkdtempSync(join(tmpdir(), "pi-braid-test-"));
  const result = spawnSync("node", [`test/runtime/${t}`], {
    cwd: root,
    timeout,
    // SIGKILL, not the default SIGTERM: a file that traps SIGTERM would never
    // die and spawnSync would block past the cap, so the cap must be
    // untrappable to mean anything.
    killSignal: "SIGKILL",
    // Own process group: the cap kill must reach the helpers a file started
    // too. spawnSync signals only the direct child, and a helper left holding
    // a scratch dir as its cwd is why the remove below would otherwise leak.
    detached: true,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TMPDIR: testTmpDir },
  });
  // Reap the file's process group. A no-op once the group is empty, which is
  // every path but a kill that left helpers behind; then the scratch remove
  // can actually succeed.
  if (typeof result.pid === "number") {
    try {
      process.kill(-result.pid, "SIGKILL");
    } catch {
      // ESRCH: the group is already gone, the common case.
    }
  }
  removeScratchDir(testTmpDir);

  if (result.error?.code === "ETIMEDOUT") {
    const declared = allowance
      ? ` (declared allowance ${formatMs(allowance.ms)}: ${allowance.reason})`
      : "";
    console.log(`  \u23F1 TIMEOUT ${label} ${t} \u2014 killed after ${formatMs(timeout)}${declared}`);
    timedOut++;
    timeouts.push(t);
    continue;
  }

  if (result.status === 0) {
    const lines = (result.stdout ?? "").split("\n");
    const summary = lines.find((l) => l.includes("\uD83D\uDCCA") || l.includes("Results"))?.trim();
    console.log(`  \u2705 ${label} ${t}${summary ? " \u2014 " + summary : ""}`);
    passed++;
    continue;
  }

  // Killed by a signal is a failure, not a timeout: the cap did not do this,
  // so name what did.
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const lines = (stdout + "\n" + stderr).split("\n");
  const summary = lines.find((l) => l.includes("\uD83D\uDCCA") || l.includes("passed"))?.trim();
  let outcome = `exit code ${result.status}`;
  if (result.status === null) {
    outcome = result.signal
      ? `killed by ${result.signal}`
      : `spawn failed: ${result.error?.code ?? "unknown"}`;
  }
  console.log(`  \u274C ${label} ${t} \u2014 ${summary || outcome}`);
  failed++;
  failures.push(t);
}

console.log(
  `\n\uD83D\uDCCA ${passed} passed, ${failed} failed, ${timedOut} timed out` +
    (failures.length > 0 ? "\n  Failed: " + failures.join(", ") : ""),
);
if (timeouts.length > 0) {
  console.log(`  Timed out: ${timeouts.join(", ")}`);
}
if (allowances.size > 0) {
  const declared = [...allowances].map(([file, a]) => `${file} ${formatMs(a.ms)} (${a.reason})`);
  console.log(`  Allowances: ${declared.join("; ")}`);
}
process.exit(failed > 0 || timedOut > 0 ? 1 : 0);
