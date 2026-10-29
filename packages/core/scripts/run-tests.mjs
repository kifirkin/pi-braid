/**
 * pi-braid unified test runner.
 * Run: npm test
 *
 * Files run in a bounded pool of detached child processes, so the suite's wall
 * clock is the slowest file plus the leftovers rather than the sum of all of
 * them. Each file already carries the isolation a pool needs - its own TMPDIR,
 * its own process group, its own cap - so the serialisation was the loop's
 * shape, not a property of the tests.
 *
 * Results print in fixture order, never as they finish: a reader diffing two
 * runs must see the same shape, and a file's own output must stay under its own
 * line. Ordering also means the counts keep their meaning - the `[n/total]`
 * label is the file's position, as it always was. The cost of that order is a
 * slow file at the head: every later line waits behind it, and a run in that
 * state looks exactly like a wedged one from the outside. So a run that has
 * printed no result for STALL_NOTICE_MS says once which file is holding the
 * line, naming it rather than leaving the wait to be guessed at.
 *
 * Reports three categories:
 *
 *   passed     the file exited 0 and its output pipes closed
 *   failed     the file exited non-zero, or died on a signal
 *   timed out  the file's process group held its output open past the
 *              allowance, so the group was killed
 *
 * The verdict settles on stdio close rather than on exit: the captured output
 * is part of the file's result, and a helper that inherits the pipe can still
 * write to it after the file's process exits. A file that exits 0 with a
 * helper still holding its stdout therefore finishes only when that helper
 * lets go; if it never does, the file is a timeout, not a pass.
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
 *     - the environment overrides both without an edit (see readAllowances)
 *   - FAILURE_OUTPUT_CHARS and FAILURE_OUTPUT_LINES bound how much of a failing
 *     file's own output the run prints under it
 *
 * Pool width:
 *   - default is DEFAULT_JOBS, capped by the machine's own parallelism
 *   - `--jobs <n>` or PI_TEST_JOBS overrides it; `--jobs 1` forces the serial
 *     order, which is what a bisect against the loop's behaviour needs
 *
 * Measurements:
 *   - `--timings` prints each file's duration and the slowest files at the end
 *   - `--timings-json=<path>` (or PI_TEST_TIMINGS) writes the same numbers as
 *     a JSON artifact, which is what a pool width has to be argued from
 *
 * Root:
 *   - PI_TEST_ROOT points the runner at another tree of `.mjs` files, so the
 *     runner's own contract can be tested over a bench instead of this suite.
 *     Relative paths are resolved from the working directory; the child is
 *     spawned with an absolute path either way.
 *
 * Population:
 *   - the walk counts every `.mjs` it finds as a passed fixture, so a module
 *     that registers no case and asserts nothing is a pass that cannot fail.
 *     The tree declares those in `fixture-manifest.json`, one reason each, and
 *     a declared module is neither run nor counted (see readNotFixtures)
 *   - `--list` prints the population this run would be over and exits without
 *     running anything, which is how `check-suite-coverage.mjs` reads the same
 *     population rather than walking the tree a second time
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { resolve, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

/**
 * Every file's cap. A cap is a hang detector, not a performance budget, so its
 * value has to exceed the pool's own inflation of the slowest file rather than
 * that file's idle duration.
 *
 * Measured over the ten slowest files, once at the default width and once at
 * `--jobs 1` under the same added load: a file's own duration grows by 1.07x to
 * 2.20x when it runs beside seven others, because the CPU-bound stretch of a
 * file now shares the cores. The slowest file the table has to carry unassisted
 * - the longest unallowanced duration in the pool - takes 32.5s there and 15.4s
 * one at a time, so 60s sits 27.5s above it, and no file in either arm was
 * killed at the cap. That is the detector's job kept - a real hang is still
 * killed inside one cap - with the room the measurement says the pool needs.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Pool width when neither the flag nor the environment says otherwise.
 *
 * The fixtures are spawn- and I/O-bound: nearly every one of them starts child
 * processes (node drivers, git, sqlite) and then waits, so overlapping the
 * waits is most of the available win. Past a handful of files in flight the
 * suite's own work - the box's cores, its disk, and the locks a fixture holds
 * across processes - is the limit, so the cap stays at eight and the machine
 * gets the last word: a two-core container runs two at a time instead of
 * thrashing eight against two cores and timing files out on the way.
 */
const DEFAULT_JOBS = Math.max(1, Math.min(8, availableParallelism()));

/**
 * How much of a failing file's own output the run prints under its line.
 *
 * The summary line names the file and, when the file printed one, its totals;
 * the assertion text - the only place a failure says why - was dropped with the
 * child's streams. A red run that names a file without its reason costs a second
 * run to read, and on CI that is a round trip through a container to recover a
 * message the process had already printed. Both bounds matter: the character
 * cap keeps a driver that dumps a large payload from burying the totals that
 * follow it, and the line cap keeps a file that logs every step from turning a
 * four-line assertion into a page of progress. Node's own uncaught-assertion
 * dump is about twenty lines, so forty lines carries a failure and its context.
 */
const FAILURE_OUTPUT_CHARS = 4_000;
const FAILURE_OUTPUT_LINES = 40;

/**
 * How long a killed file's pipes may still be draining before the pool takes
 * the slot back. SIGKILL cannot be refused, so this only covers a write
 * already in flight on a pipe whose reader is gone; without the bound one
 * wedged file would hold a slot for the rest of the run.
 */
const DRAIN_MS = 2_000;

/**
 * How long a run may print nothing before it says which file it is waiting on.
 *
 * Printing in fixture order is what makes two runs comparable, and the price is
 * that one slow file at the head stops every line behind it. The threshold sits
 * under the slowest file's own duration (34s at the default width), so a run
 * that reaches that file early does print this line - once, naming it. That is
 * the case the line is for, not an accident: the alternative is a terminal with
 * nothing arriving, which is also what a real wedge looks like. One line per
 * stall rather than a repeating report, because the file's name and the fact
 * that the wait is real are the whole of what it has to say.
 */
const STALL_NOTICE_MS = 30_000;

/** How often the stall check runs, so the notice lands within this of the threshold. */
const STALL_POLL_MS = 2_000;

/**
 * Per-file wall-clock allowances, keyed by path relative to the test root.
 *
 * An entry declares that this file can outlive the default cap on a busy box.
 * State the reason inline: the summary prints it, so a reader can tell a
 * declared slow file from a hang. Without an entry, a file that outlives the
 * cap is reported as a timeout.
 *
 * A file's duration at the default width is what earns an entry, never its
 * duration alone. Work the pool shares out - child processes, packs, installs -
 * stretches with the number of files beside it, while a file that waits on a
 * lock it holds itself costs what it costs on any machine; size an allowance
 * from the alone duration and it is sized for the quietest box in the fleet.
 *
 * The class is "files whose duration at the default width comes within a
 * quarter of DEFAULT_TIMEOUT_MS", i.e. at or above three quarters of it, and
 * the instrument is one run at that width with `--timings-json`, sorted
 * descending and read against the cap. An entry's size comes from the same
 * number: the contended duration plus the room a slower box needs to report its
 * own failure instead of this file's timeout.
 */
const ALLOWANCES = new Map([
  [
    "loader/test-module-config.mjs",
    {
      ms: 200_000,
      reason:
        "twelve child drivers, five at a time, each bounded by the fixture's own driver cap: the worst case is three waves, so the allowance has to clear three driver caps, and the file names every stuck driver instead of being killed here as an opaque timeout",
    },
  ],
  [
    "release/test-publish-local-atomic-install.mjs",
    {
      ms: 120_000,
      reason:
        "drives four real publishes, each one an npm pack plus its install and rollback path: 11.2s with the box to itself and 24.6s beside seven other files, so the pool's inflation of this work is already 2x; the allowance is what keeps a loaded box reporting the swap that failed instead of killing the file at the 60s default",
    },
  ],
  [
    "release/test-pack-provenance.mjs",
    {
      ms: 120_000,
      reason:
        "packs real fixtures through npm and then the markdown-only skills workspace, so its cost is a sequence of real packs whose length follows the box: 28.1s one at a time and 48.3s beside seven other files with every core saturated, 1.7x from the pool alone; the allowance is what keeps a box a quarter slower than the one that measured this reporting the provenance failure instead of being killed here at the 60s default",
    },
  ],
  [
    "lib/test-braid-home-containment.mjs",
    {
      ms: 120_000,
      reason:
        "its own work is 9.8s with the box to itself, 21.9s run one at a time with every core saturated and 47.2s beside seven other files, so the other thirty-seven seconds are cores the pool and the load share; that is the shape a CI runner's co-tenants produce, and the allowance is what lets it report the containment assertion that failed instead of being killed here at the 60s default",
    },
  ],
  [
    "fleet/test-drain-contention.mjs",
    {
      ms: 90_000,
      reason:
        "five arms hold a real SQLite write lock in a second process (6.2s, 2.5s, 13s and two at 1.2s) and one of them waits out that 13s from a status command, so at least 24s of the file's 33.7s is lock hold it schedules itself: 33.7s run one at a time and 36.2s beside seven other files, a 1.07x that says the pool barely moves it. Contention is not what threatens this file - an arm wedging inside its own hold is - so the allowance is what lets the file name that arm instead of being killed here as an opaque timeout",
    },
  ],
]);

const argv = process.argv.slice(2);

/** A `--name value` or `--name=value` flag's value; undefined when absent. */
function flagValue(name) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return undefined;
}

function flagOn(name) {
  return argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}

/**
 * The pool width, from the flag, the environment, or DEFAULT_JOBS.
 *
 * A value the runner cannot use is reported and dropped rather than guessed
 * at: a typo that silently became "one" would look like the runner got slower,
 * and a typo that silently became "unbounded" would look like the suite broke.
 */
function readJobs() {
  const raw = flagValue("jobs") ?? process.env.PI_TEST_JOBS ?? "";
  if (raw === "") return DEFAULT_JOBS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`ignoring jobs="${raw}" - expected a positive integer`);
    return DEFAULT_JOBS;
  }
  return value;
}

/**
 * Every .mjs file here and under each real subdirectory, declared non-fixture
 * or not. A symlink to a directory is not a directory entry, so it is never
 * entered; a symlink to an .mjs file is one, so it runs in addition to its
 * target. The declaration is applied by the caller, which is what lets
 * `--list` report a declared module this tree no longer carries.
 */
function findTests(dir) {
  const results = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(testDir, full);
      if (entry.isDirectory()) {
        results.push(...findTests(full));
      } else if (entry.name.endsWith(".mjs")) {
        results.push(rel);
      }
    }
  } catch {
    /* */
  }
  return results;
}

/** The tree's own declaration of the modules in it that are not fixtures. */
const MANIFEST_NAME = "fixture-manifest.json";

/**
 * Modules the walk leaves out of the count, keyed by path relative to the test
 * root - the same coordinate ALLOWANCES uses, so a declaration names one file
 * rather than every file with that name.
 *
 * The declaration lives in the tree rather than in this file because it is a
 * fact about the tree's own modules, and because a bench over this runner's
 * contract carries its own. Every entry states why the module is not a fixture:
 * a walked module is counted as a passed fixture, while a shared helper
 * registers nothing and asserts nothing, so leaving one in the count is how the
 * summary line stops meaning what it says. `check-suite-coverage.mjs` reads the
 * same declaration back and refuses both halves of a disagreement - a counted
 * module that asserts nothing, and a declared one that is a real fixture.
 *
 * A tree without a manifest declares nothing, which is every bench. A manifest
 * that cannot be read is fatal: falling back to "no declarations" would quietly
 * inflate the count, the failure this file exists to prevent.
 */
function readNotFixtures(dir) {
  const file = join(dir, MANIFEST_NAME);
  if (!existsSync(file)) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`${file}: ${error.message}`);
    process.exit(1);
  }
  const declared = parsed?.notFixtures;
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
    console.error(`${file}: expected a "notFixtures" object of module path -> reason`);
    process.exit(1);
  }
  const notFixtures = new Map();
  for (const [module, reason] of Object.entries(declared)) {
    if (typeof reason !== "string" || reason.trim() === "") {
      console.error(
        `${file}: "${module}" states no reason - a module stays out of the count with one on record`,
      );
      process.exit(1);
    }
    notFixtures.set(module, reason.trim());
  }
  return notFixtures;
}

/** Durations as printed: 12000 -> "12s", 1500 -> "1.5s". */
function formatMs(ms) {
  const value = Math.round(ms);
  return value % 1000 === 0 ? `${value / 1000}s` : `${(value / 1000).toFixed(1)}s`;
}

/** A whole run's duration: 557000 -> "9m17s", so the summary reads as a clock. */
function formatClock(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? formatMs(ms) : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/**
 * The end of a file's own output, whole lines, under a line and character budget.
 *
 * The end is what carries the failure: a file prints its passes first and the
 * assertion that died last. Lines are kept whole rather than cut at the budget,
 * because a half-line is the one line a reader needs, except when a single line
 * is itself over budget - then its own end is kept and marked. `dropped` counts
 * the lines the budget left out so the printed block can say so.
 *
 * The child's two streams are joined here, since they arrive as separate pipes:
 * their interleaving is lost, which is the price of capturing either at all.
 */
function endOfOutput(output, chars = FAILURE_OUTPUT_CHARS, count = FAILURE_OUTPUT_LINES) {
  const text = String(output ?? "").replace(/\s+$/, "");
  if (text === "") return { lines: [], dropped: 0 };
  const all = text.split("\n");
  const lines = [];
  let used = 0;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const line = all[i];
    if (lines.length >= count) break;
    if (used + line.length + 1 > chars) {
      if (lines.length === 0) lines.unshift(`...${line.slice(-chars)}`);
      break;
    }
    lines.unshift(line);
    used += line.length + 1;
  }
  return { lines, dropped: all.length - lines.length };
}

/**
 * A file's own output under its result line, so the run reads as the failure
 * rather than as its name. Bounded by endOfOutput, and the note names the one
 * command that prints the rest.
 */
function printFileOutput(file, output) {
  const { lines, dropped } = endOfOutput(output);
  if (lines.length === 0) {
    console.log("     it wrote nothing of its own");
    return;
  }
  const omitted = dropped > 0 ? `, ${dropped} earlier line${dropped === 1 ? "" : "s"} omitted` : "";
  console.log(`     its own output (${lines.length} line${lines.length === 1 ? "" : "s"}${omitted}):`);
  for (const line of lines) console.log(`     | ${line}`);
  console.log(`     (all of it: node ${displayPath(file)})`);
}

/**
 * The declared allowances plus any the environment adds:
 *   PI_TEST_TIMEOUT_MS=<ms>               cap for files without an allowance
 *   PI_TEST_ALLOWANCE="<path>=<ms>[,..]"  add or override a per-file allowance
 * Paths are relative to the test root, exactly as printed below.
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
  const rawTimeout = process.env.PI_TEST_TIMEOUT_MS ?? "";
  let fallback = DEFAULT_TIMEOUT_MS;
  if (rawTimeout !== "") {
    const value = Number(rawTimeout);
    if (!Number.isFinite(value) || value <= 0) {
      console.error(`ignoring timeout="${rawTimeout}" - expected a positive number of milliseconds`);
    } else {
      fallback = value;
    }
  }
  return { table, fallback };
}

/**
 * A file's path as a reader can retype it: relative to the repository when it
 * sits inside it, absolute when PI_TEST_ROOT points somewhere else.
 */
function displayPath(file) {
  const absolute = join(testDir, file);
  const rel = relative(root, absolute);
  return rel.startsWith("..") || isAbsolute(rel) ? absolute : rel;
}

/**
 * SIGKILL a file's process group.
 *
 * The whole group, not the direct child: a file that started helpers leaves
 * them behind otherwise, and a helper still holding the file's TMPDIR as its
 * cwd is why the scratch remove below would fail. A no-op once the group is
 * empty, which is every path but a kill that left helpers behind.
 */
function killGroup(pid) {
  if (typeof pid !== "number") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: the group is already gone, the common case.
  }
}

/**
 * Remove a scratch dir the runner owns. A file that started helpers can
 * outlive the runner's SIGKILL for a beat with a scratch dir still its cwd;
 * macOS then refuses the recursive remove, and force:true would swallow that
 * and leave the litter. The helpers are short-lived, so retry briefly - then
 * give up rather than hang the suite on a genuinely immortal child.
 *
 * The retry is an await, not a spin: under a pool the event loop has to stay
 * free for the other files in flight, so blocking it here would serialise the
 * run one cleanup at a time from the inside.
 */
async function removeScratchDir(dir, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    rmSync(dir, { recursive: true, force: true });
    if (!existsSync(dir)) return;
    await new Promise((tick) => setTimeout(tick, 100));
  }
}

/** Every detached child group currently alive, so a signal to the runner reaps them. */
const liveGroups = new Set();

/**
 * Run one file to completion, settling with what it did.
 *
 * The cap is the runner's own timer rather than a spawn option, because the
 * kill has to reach the file's process group: a file that traps the signal
 * must still die at its cap, so the signal is SIGKILL to the group.
 */
function runFile(file) {
  const allowance = allowances.get(file);
  const timeout = allowance?.ms ?? defaultTimeoutMs;
  // A file gets its own TMPDIR: the child's own cleanup cannot run when this
  // runner SIGKILLs it at the cap, so the environment it litters in is ours to
  // remove. The removal sits in finish(), so the timeout path is covered like
  // the rest.
  const scratch = mkdtempSync(join(tmpdir(), "pi-braid-test-"));
  const startedAt = process.hrtime.bigint();

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
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const pid = child?.pid;
      killGroup(pid);
      if (typeof pid === "number") liveGroups.delete(pid);
      const stdout = out.join("");
      const stderr = err.join("");
      removeScratchDir(scratch).then(() =>
        settle({ ...payload, timedOut, ms: elapsedMs, stdout, stderr }),
      );
    };

    try {
      child = spawn("node", [join(testDir, file)], {
        cwd: root,
        // Own process group: the cap kill must reach the helpers a file
        // started too, and a helper left holding a scratch dir as its cwd is
        // why the finished file's TMPDIR would otherwise leak.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TMPDIR: scratch },
      });
    } catch (error) {
      finish({ code: null, signal: null, error });
      return;
    }

    if (typeof child.pid === "number") liveGroups.add(child.pid);
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => finish({ code: null, signal: null, error }));
    // Settle on close, not exit: the captured output is part of the file's
    // result, and a helper holding the inherited pipe can still write to it
    // after the file's process exits. The cap bounds that wait.
    child.on("close", (code, signal) => finish({ code, signal }));

    capTimer = setTimeout(() => {
      timedOut = true;
      // SIGKILL, not the default SIGTERM: a file that traps SIGTERM would
      // never die and the cap must be untrappable to mean anything.
      killGroup(child.pid);
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ code: null, signal: "SIGKILL" });
      }, DRAIN_MS);
    }, timeout);
  });
}

const { table: allowances, fallback: defaultTimeoutMs } = readAllowances();
const jobs = readJobs();
const testDir = resolve(process.env.PI_TEST_ROOT ? process.env.PI_TEST_ROOT : join(root, "test/runtime"));
const timings = flagOn("timings");
const timingsPath = flagValue("timings-json") ?? process.env.PI_TEST_TIMINGS ?? "";
const notFixtures = readNotFixtures(testDir);
const walked = findTests(testDir).sort();
const tests = walked.filter((file) => !notFixtures.has(file));

/**
 * `--list` prints the population this run would be over and exits without
 * running anything: `counted` for a module the run would judge, `skipped` for a
 * declared non-fixture and the reason it is one, `absent` for a declaration
 * this tree no longer carries. The population check reads this instead of
 * walking the tree a second time, so the gate and the runner cannot disagree
 * about which files exist.
 */
if (flagOn("list")) {
  for (const file of tests) console.log(`counted\t${file}`);
  for (const [file, reason] of notFixtures) {
    console.log(`${walked.includes(file) ? "skipped" : "absent"}\t${file}\t${reason}`);
  }
  process.exit(0);
}

/**
 * An empty walk is a hard failure, not a green run: an override that resolved
 * to the wrong directory, or a tree this runner was pointed at by accident,
 * would otherwise report "0 passed, 0 failed, 0 timed out" and exit 0.
 */
if (tests.length === 0) {
  console.error(`no test files under ${testDir} - refusing to report an empty run as green`);
  process.exit(1);
}

let passed = 0;
let failed = 0;
let timedOut = 0;
const failures = [];
const timeouts = [];

/**
 * A signal to the runner must not orphan the pool: every live file group is
 * killed before the exit, because each one is detached and would otherwise
 * keep running with nobody left to read or reap it.
 */
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.on(signal, () => {
    const live = [...liveGroups];
    for (const pid of live) killGroup(pid);
    console.log(`\n  ${signal}: killed ${live.length} running file group${live.length === 1 ? "" : "s"}`);
    process.exit(code);
  });
}

console.log(
  `Running ${tests.length} tests from ${testDir}` +
    `${jobs > 1 ? `, ${jobs} at a time` : ""}\n`,
);
if (notFixtures.size > 0) {
  // Printed where the count is introduced, because this is what the count is
  // not: the tree carries the module, the run does not judge it.
  console.log(
    `  Not counted, not run: ${notFixtures.size} module${notFixtures.size === 1 ? "" : "s"} the tree declares not a fixture (${MANIFEST_NAME})`,
  );
  for (const [file, reason] of notFixtures) console.log(`    ${file} - ${reason}`);
  console.log("");
}

/** One file's duration as it prints beside its line, when timings are asked for. */
function durationNote(result) {
  return timings ? ` (${formatMs(result.ms)})` : "";
}

/**
 * One file's line, plus its own output when it failed or timed out.
 *
 * Called in fixture order, never in completion order, so the run reads the
 * same way twice and a file's output stays under its own line.
 */
function report(index, result) {
  const file = tests[index];
  const allowance = allowances.get(file);
  const timeout = allowance?.ms ?? defaultTimeoutMs;
  const label = `[${index + 1}/${tests.length}]`;
  const note = durationNote(result);

  if (result.timedOut) {
    const declared = allowance
      ? ` (declared allowance ${formatMs(allowance.ms)}: ${allowance.reason})`
      : "";
    console.log(`  \u23F1 TIMEOUT ${label} ${file}${note} \u2014 killed after ${formatMs(timeout)}${declared}`);
    printFileOutput(file, `${result.stdout}${result.stderr}`);
    result.outcome = "timed out";
    timedOut += 1;
    timeouts.push(file);
    return;
  }

  if (result.code === 0) {
    const lines = result.stdout.split("\n");
    const summary = lines.find((l) => l.includes("\uD83D\uDCCA") || l.includes("Results"))?.trim();
    console.log(`  \u2705 ${label} ${file}${note}${summary ? " \u2014 " + summary : ""}`);
    result.outcome = "passed";
    passed += 1;
    return;
  }

  // Killed by a signal is a failure, not a timeout: the cap did not do this,
  // so name what did.
  const lines = (result.stdout + "\n" + result.stderr).split("\n");
  const summary = lines.find((l) => l.includes("\uD83D\uDCCA") || l.includes("passed"))?.trim();
  let outcome = `exit code ${result.code}`;
  if (result.code === null) {
    outcome = result.signal
      ? `killed by ${result.signal}`
      : `spawn failed: ${result.error?.code ?? "unknown"}`;
  }
  console.log(`  \u274C ${label} ${file}${note} \u2014 ${summary || outcome}`);
  printFileOutput(file, result.stdout + "\n" + result.stderr);
  result.outcome = "failed";
  failed += 1;
  failures.push(file);
}

const runStartedAt = process.hrtime.bigint();
const results = new Array(tests.length);
let cursor = 0;
let printed = 0;

/**
 * The stall notice's state: when a result line last printed, and whether this
 * silence has already been reported. Both are written by flush(), below.
 */
let lastResultAt = Date.now();
let stallReported = false;

/** Print every finished file whose turn has come; a later one waits its turn. */
function flush() {
  const before = printed;
  while (printed < tests.length && results[printed]) {
    report(printed, results[printed]);
    printed += 1;
  }
  if (printed > before) {
    lastResultAt = Date.now();
    stallReported = false;
  }
}

/**
 * Say which file is holding the line when nothing has printed for a while.
 *
 * The file to name is tests[printed]: it is the one whose result the next line
 * waits on, and because slots take files in order it is always in flight while
 * results are outstanding. Each tick re-arms itself rather than running on an
 * interval, so it stops once the last result is in, and every timer is unref'd
 * so an idle runner's exit is never delayed by the watch.
 */
let stallTimer = null;
function watchForStall() {
  if (printed >= tests.length) return;
  const silence = Date.now() - lastResultAt;
  if (!stallReported && silence >= STALL_NOTICE_MS) {
    stallReported = true;
    console.log(
      `\n  no result for ${formatMs(silence)}: ${tests[printed]} has not finished, ` +
        `and every later line prints after it`,
    );
  }
  stallTimer = setTimeout(watchForStall, STALL_POLL_MS);
  stallTimer.unref();
}
watchForStall();

/**
 * One pool slot: take the next file, run it to completion, print what is now
 * in order, repeat until the queue is empty. The cursor is taken before the
 * first await, so two slots never claim the same file.
 */
async function slot() {
  for (;;) {
    const index = cursor;
    cursor += 1;
    if (index >= tests.length) return;
    results[index] = await runFile(tests[index]);
    flush();
  }
}

await Promise.all(Array.from({ length: Math.min(jobs, tests.length) }, () => slot()));
clearTimeout(stallTimer);
const totalMs = Number(process.hrtime.bigint() - runStartedAt) / 1e6;

console.log(
  `\n\uD83D\uDCCA ${passed} passed, ${failed} failed, ${timedOut} timed out` +
    ` in ${formatClock(totalMs)}` +
    (failures.length > 0 ? "\n  Failed: " + failures.join(", ") : ""),
);
if (timeouts.length > 0) {
  console.log(`  Timed out: ${timeouts.join(", ")}`);
}
if (allowances.size > 0) {
  const declared = [...allowances].map(([file, a]) => `${file} ${formatMs(a.ms)} (${a.reason})`);
  console.log(`  Allowances: ${declared.join("; ")}`);
}

if (timings) {
  const listed = results
    .map((result, index) => ({ file: tests[index], ms: result.ms }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 12)
    .map((entry) => `${entry.file} ${formatMs(entry.ms)}`);
  console.log(`  Slowest: ${listed.join("; ")}`);
}

if (timingsPath) {
  const artifact = {
    jobs,
    totalMs: Math.round(totalMs),
    files: results.map((result, index) => ({
      file: tests[index],
      outcome: result.outcome,
      ms: Math.round(result.ms),
    })),
  };
  try {
    writeFileSync(timingsPath, `${JSON.stringify(artifact, null, 2)}\n`);
  } catch (error) {
    // A measurement that could not be written is reported, never silently
    // dropped: the run's own verdict does not depend on the artifact.
    console.error(`could not write timings to ${timingsPath}: ${error.message}`);
  }
}

process.exit(failed > 0 || timedOut > 0 ? 1 : 0);
