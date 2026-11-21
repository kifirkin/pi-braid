#!/usr/bin/env node
/**
 * check-regressions.mjs - the before/after instrument over the runtime suite.
 *
 *   node packages/core/scripts/check-regressions.mjs --baseline <file> [--root <dir>] [--jobs <n>]
 *   node packages/core/scripts/check-regressions.mjs --check <file> [--root <dir>] [--jobs <n>] [--exempt <file>]...
 *
 * The suite answers "is anything broken now". This answers a different
 * question: "did this change break something nobody was looking at". A green
 * suite after a merge cannot show that the merge kept a check it never ran, and
 * the only honest evidence for it is a before-set taken on the tree the change
 * lands onto plus the same enumeration run again afterwards.
 *
 * The enumeration is the runner's own artifact, not a second walk of the tree.
 * `run-tests.mjs --timings-json` writes one row per fixture with the outcome it
 * judged, and that file is the run's attestation: a walk here would be a second
 * opinion about which files exist, and two populations that disagree turn every
 * comparison into a guess. The known cost is that a fixture the runner does not
 * count cannot regress here, which is why the ceiling line prints with every
 * verdict instead of promising coverage it does not have.
 *
 * Exit codes:
 *   0   no fixture that passed in the baseline stopped passing
 *   1   at least one did
 *   2   refused: the baseline cannot ground this comparison, an exemption is
 *       unusable, or the runner could not be read. A refusal says nothing about
 *       the tree.
 *   64  usage
 *
 * The revision rule. A baseline records the revision it was taken at. A
 * baseline from another line of history is refused, because its rows describe a
 * tree this one did not come from. A baseline from an ANCESTOR of the current
 * revision is accepted, with the distance printed: that is the merge gate
 * itself, where the baseline is taken on the base branch, the branch lands, and
 * the comparison runs over the merged tree. Refusing on any movement would
 * refuse exactly the case this file exists for, and a gate that goes red at the
 * moment it is needed is a gate the seat learns to skip.
 *
 * The exemption list is the declared-removal path: a JSON array of
 * `{path, why}` rows, one per fixture a change means to remove or rename. A row
 * with no reason is refused rather than accepted, because the reason is the
 * whole record of why a fixture stopped being watched. An exemption that
 * silenced nothing is reported as stale: it is not a regression, and it is not
 * silently carried either.
 *
 * What this does not do: build, lint, typecheck, format or run the single-run
 * `check:*` scripts. Each of those answers "is this right now", and the answer
 * is the same before and after a change, so running one twice buys nothing. The
 * seat runs them once, on the merged tree. This file exists for the checks
 * whose value is in the comparison.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RUNNER = resolve(import.meta.dirname, "run-tests.mjs");
/** The suite the runner counts when it is given no bench. */
const DEFAULT_ROOT = resolve(import.meta.dirname, "..", "test", "runtime");
const INSTRUMENT = "check-regressions";
const USAGE_LINE =
  "usage: node packages/core/scripts/check-regressions.mjs --baseline <file> [--root <dir>] [--jobs <n>]\n" +
  "       node packages/core/scripts/check-regressions.mjs --check <file> [--root <dir>] [--jobs <n>] [--exempt <file>]...";

const EXIT_CLEAN = 0;
const EXIT_REGRESSION = 1;
const EXIT_REFUSED = 2;
const EXIT_USAGE = 64;
/** EX_TEMPFAIL: the runner's own answer when another suite holds the lock. */
const RUNNER_REFUSED = 75;
/** How much of the child's output is kept for parsing and for a failure tail. */
const CAPTURE_LIMIT = 4 * 1024 * 1024;

/** A verdict this run cannot reach, with the exit code that reports it. */
class Stop extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
const refuse = (message) => {
  throw new Stop(message, EXIT_REFUSED);
};
const usage = (message) => {
  throw new Stop(message, EXIT_USAGE);
};

// ── Arguments ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { mode: "", file: "", root: "", jobs: "", exempt: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) usage(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--baseline" || arg === "--check") {
      if (opts.mode !== "") usage("pass exactly one of --baseline or --check");
      opts.mode = arg.slice(2);
      opts.file = value();
    } else if (arg === "--root") {
      opts.root = value();
    } else if (arg === "--jobs") {
      opts.jobs = value();
      if (!/^[1-9]\d*$/.test(opts.jobs)) usage(`--jobs takes a positive integer, not ${JSON.stringify(opts.jobs)}`);
    } else if (arg === "--exempt") {
      opts.exempt.push(value());
    } else {
      usage(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  if (opts.mode === "") usage("one of --baseline <file> or --check <file> is required");
  if (opts.exempt.length > 0 && opts.mode !== "check") {
    usage("--exempt belongs to --check: a snapshot takes no exemptions");
  }
  const root = resolve(opts.root === "" ? DEFAULT_ROOT : opts.root);
  if (!existsSync(root)) refuse(`there is no tree at ${root}`);
  // A fixture driving this file is already inside the suite it would re-enter,
  // so an unrooted run from there would start a second full suite inside the
  // first, which would start this fixture again. The runner hands every fixture
  // the suite's lock token; the bench path (`--root`) is the way out.
  if (root === DEFAULT_ROOT && process.env.PI_SUITE_LOCK_TOKEN) {
    refuse(
      "this process is inside a suite run, so the default root would re-enter the suite it is already in: " +
        "pass --root <dir> to point this at a bench tree instead",
    );
  }
  return { ...opts, root };
}

// ── Git reads: the revision a snapshot is taken at ──────────────────────────

/** A git command's trimmed stdout, or null when it fails. */
function git(dir, args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

const revisionOf = (dir) => git(dir, ["rev-parse", "HEAD"]);

/** Whether `ancestor` is on the way to `descendant`, which is what makes two snapshots comparable. */
function isAncestor(ancestor, descendant, dir) {
  const result = spawnSync("git", ["-C", dir, "merge-base", "--is-ancestor", ancestor, descendant], {
    encoding: "utf8",
  });
  return result.status === 0;
}

// ── One suite run, read from the runner's artifact ──────────────────────────

/** The last `lines` lines of captured output, on one line. */
function tail(text, lines) {
  const kept = text.trimEnd().split("\n").slice(-lines);
  return kept.length === 0 ? "(no output)" : kept.join(" | ");
}

/**
 * Run the suite once and return the rows the runner judged.
 *
 * The child's output is streamed: a full suite is minutes long, and a gate that
 * prints nothing for minutes is a gate the caller kills. It is captured too, so
 * a refusal can quote the reason the runner gave instead of a bare exit code.
 */
async function runSuite({ root, jobs }) {
  const scratch = mkdtempSync(join(tmpdir(), "check-regressions-"));
  const artifact = join(scratch, "timings.json");
  let captured = "";
  try {
    const args = [RUNNER, `--timings-json=${artifact}`];
    if (jobs !== "") args.push(`--jobs=${jobs}`);
    const env = { ...process.env };
    // The root decides the lock: a bench takes none, the suite takes the
    // repository's lock and refuses beside another run. An inherited
    // PI_TEST_ROOT would silently pick one of those for the wrong tree.
    if (root === DEFAULT_ROOT) delete env.PI_TEST_ROOT;
    else env.PI_TEST_ROOT = root;
    const code = await new Promise((settle, reject) => {
      const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      const keep = (chunk) => {
        captured += chunk;
        if (captured.length > CAPTURE_LIMIT) captured = captured.slice(captured.length - CAPTURE_LIMIT);
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        keep(chunk);
        process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        keep(chunk);
        process.stderr.write(chunk);
      });
      child.on("error", (error) => reject(new Stop(`could not start ${RUNNER}: ${error.message}`, EXIT_REFUSED)));
      child.on("close", (exitCode) => settle(exitCode));
    });
    if (code === RUNNER_REFUSED) {
      refuse(
        `the runner refused this run (exit ${RUNNER_REFUSED}) instead of running beside another suite: ` +
          tail(captured, 4),
      );
    }
    if (!existsSync(artifact)) {
      refuse(
        `the runner exited ${code} without writing its artifact, so this run judged nothing: ${tail(captured, 6)}`,
      );
    }
    let run;
    try {
      run = JSON.parse(readFileSync(artifact, "utf8"));
    } catch (error) {
      refuse(`the runner's artifact is not JSON: ${error.message}`);
    }
    if (!run || !Array.isArray(run.files)) {
      refuse("the runner's artifact carries no files array, so it judged no fixture");
    }
    return { rows: run.files, captured };
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // A scratch tree left behind is litter the machine's temp cleanup owns;
      // it must not replace the exit code this run already reached.
    }
  }
}

// ── The rows a snapshot carries ─────────────────────────────────────────────

// The runner prints one line per fixture in the form
// `  ✅ [12/389] path — <the fixture's own summary line>`, and drops the dash
// and the summary when the fixture prints no line the runner recognizes. The
// line is read for one thing only: the tally a fixture printed about itself, so
// a file that stays green while a case it used to run has vanished is visible.
// The outcome itself is never read from here; it comes from the artifact.
const FILE_LINE = /^ {2}(?:\u2705|\u274C|\u23F1 TIMEOUT) \[\d+\/\d+\] (\S+?)(?: \([^)]*\))?(?: \u2014 (.*))?$/u;
const TALLY = /(\d+) passed, (\d+) failed/;

/**
 * The summary tail each fixture's own line carries, by path.
 *
 * A file the runner judged green cannot carry a failing tally: a match found
 * there came from prose in the line rather than the fixture's own summary, and
 * a wrong count is worse than no count.
 */
function talliesByPath(captured, rows) {
  const outcomes = new Map(rows.map((row) => [row.file, row.outcome]));
  const tallies = new Map();
  for (const line of captured.split("\n")) {
    const match = FILE_LINE.exec(line);
    if (!match || tallies.has(match[1]) || !outcomes.has(match[1])) continue;
    const tally = TALLY.exec(match[2] ?? "");
    if (!tally) continue;
    const counts = { passed: Number(tally[1]), failed: Number(tally[2]) };
    if (outcomes.get(match[1]) === "passed" && counts.failed > 0) continue;
    tallies.set(match[1], counts);
  }
  return tallies;
}

/** The runner's counts over its own rows. */
function tallyRows(rows) {
  const counts = { fixtures: rows.length, passed: 0, failed: 0, timedOut: 0 };
  for (const row of rows) {
    if (row.outcome === "passed") counts.passed += 1;
    else if (row.outcome === "timed out") counts.timedOut += 1;
    else counts.failed += 1;
  }
  return counts;
}

/** One snapshot row per fixture, sorted so two snapshots diff cleanly. */
function snapshotRows(rows, captured) {
  const tallies = talliesByPath(captured, rows);
  return rows
    .map((row) => {
      const entry = { path: row.file, outcome: row.outcome };
      const counts = tallies.get(row.file);
      if (counts) entry.counts = counts;
      return entry;
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

// ── The comparison ─────────────────────────────────────────────────────────

/**
 * One fixture, before and after. A row is a regression when the baseline had it
 * green and this run does not, in any of the three ways that can happen, or when
 * it is still green but runs fewer cases than it did.
 */
function regressionOf(prior, now) {
  if (prior.outcome !== "passed") return null;
  if (!now) return { path: prior.path, kind: "gone" };
  if (now.outcome === "timed out") return { path: prior.path, kind: "timed out" };
  if (now.outcome !== "passed") return { path: prior.path, kind: "failed" };
  if (prior.counts && now.counts && now.counts.passed < prior.counts.passed) {
    return { path: prior.path, kind: "cases", before: prior.counts.passed, after: now.counts.passed };
  }
  return null;
}

function regressionLine(finding) {
  switch (finding.kind) {
    case "gone":
      return (
        `FAIL ${finding.path}: passed in the baseline and this tree does not carry it. ` +
        "A rename or a removal is declared with --exempt, which needs the reason on record."
      );
    case "timed out":
      return `FAIL ${finding.path}: passed in the baseline and times out now.`;
    case "cases":
      return (
        `FAIL ${finding.path}: passed ${finding.before} case(s) in the baseline and passes ${finding.after} now. ` +
        "The file is green and a case it used to run is not in it."
      );
    case "failed":
      return `FAIL ${finding.path}: passed in the baseline and fails now.`;
    default:
      return `FAIL ${finding.path}: passed in the baseline and does not now (${finding.kind}).`;
  }
}

/**
 * Every baseline row against its current counterpart. Exemptions are applied
 * last, so an exemption only ever silences a finding that exists: one that
 * silences nothing comes back as stale, which is the difference between a
 * declared removal and a list that has outlived its reason.
 */
function compare(before, after, exemptions) {
  const now = new Map(after.map((row) => [row.path, row]));
  const declared = new Map(exemptions.map((row) => [row.path, row]));
  const regressions = [];
  const excused = [];
  let countsCompared = 0;
  for (const prior of before) {
    const current = now.get(prior.path);
    if (prior.counts && current && current.counts) countsCompared += 1;
    const finding = regressionOf(prior, current);
    if (!finding) continue;
    const exemption = declared.get(prior.path);
    if (exemption) excused.push({ finding, why: exemption.why });
    else regressions.push(finding);
  }
  const silenced = new Set([...regressions, ...excused.map((row) => row.finding)].map((row) => row.path));
  const stale = exemptions.filter((row) => !silenced.has(row.path));
  const known = new Set(before.map((row) => row.path));
  const added = after.filter((row) => !known.has(row.path));
  return { regressions, excused, stale, added, countsCompared };
}

// ── Inputs this file reads back ────────────────────────────────────────────

function readBaseline(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    refuse(`cannot read the baseline ${file}: ${error.message}. Take one with --baseline.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    refuse(`the baseline ${file} is not JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.fixtures)) {
    refuse(`the baseline ${file} carries no fixtures array, so it cannot ground a comparison`);
  }
  if (parsed.fixtures.length === 0) {
    // A baseline with no row is not a weaker comparison, it is no comparison:
    // every fixture the tree carries reads as new, nothing is ever compared, and
    // the run exits 0 over any tree at all. The suite runner refuses the same
    // shape one file away and for the same reason, so the two instruments agree.
    refuse(
      `the baseline ${file} holds no fixture row, so it grounds nothing: every fixture this tree carries would read as new ` +
        "and no comparison would be made. Take a new baseline with --baseline.",
    );
  }
  return parsed;
}

/** The declared removals, each with the reason it has to carry. */
function readExemptions(files) {
  const rows = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      refuse(`cannot read the exemption file ${file}: ${error.message}`);
    }
    if (!Array.isArray(parsed)) {
      refuse(`the exemption file ${file} must hold a JSON array of {"path", "why"} rows`);
    }
    parsed.forEach((row, index) => {
      const where = `${file}[${index}]`;
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        refuse(`${where}: an exemption is an object with path and why, not ${JSON.stringify(row)}`);
      }
      if (typeof row.path !== "string" || row.path.trim() === "") refuse(`${where}: no path`);
      if (typeof row.why !== "string" || row.why.trim() === "") {
        refuse(
          `${where} (${row.path}): no why. An exemption is the record of why a fixture stopped being watched, ` +
            "and a row without one is an unwatched fixture with no record at all.",
        );
      }
      rows.push({ path: row.path.trim(), why: row.why.trim() });
    });
  }
  return rows;
}

/**
 * The revision a baseline records, or null when it records none.
 *
 * A value that is present and unreadable is refused rather than read as "no
 * revision": the two say different things about where the tree came from, and a
 * baseline from a hand-edited or foreign file has to say so instead of being
 * placed against this tree on a guess.
 */
function readRevision(value, file) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  refuse(`the baseline ${file} records a revision that is not one: ${JSON.stringify(value)}`);
}

/**
 * Whether the baseline can ground this comparison, and the line that says at
 * what distance. Refuses rather than warns: a baseline from another line of
 * history would be compared row by row against a population it never described.
 */
function revisionVerdict(recorded, current, root) {
  const shown = recorded === null ? "no revision" : recorded;
  if (recorded === current) return `at ${shown}`;
  if (recorded && current && isAncestor(recorded, current, root)) {
    const distance = git(root, ["rev-list", "--count", `${recorded}..${current}`]);
    return `at ${recorded}, ${distance ?? "some"} commit(s) behind ${current}`;
  }
  refuse(
    `the baseline was taken at ${shown} and this tree is at ${current === null ? "no revision" : current}. ` +
      (recorded && current
        ? "That revision is not one this tree descends from, so the baseline describes a tree this one did not come from."
        : "One of the two was read inside a git tree and the other outside one, so neither can be placed against the other.") +
      ` Take a new baseline over ${root}.`,
  );
}

// ── The two modes ──────────────────────────────────────────────────────────

async function takeBaseline(opts) {
  const { rows, captured } = await runSuite(opts);
  const fixtures = snapshotRows(rows, captured);
  const counts = tallyRows(fixtures);
  const snapshot = {
    instrument: INSTRUMENT,
    root: opts.root,
    revision: revisionOf(opts.root),
    counts,
    fixtures,
  };
  try {
    writeFileSync(opts.file, `${JSON.stringify(snapshot, null, 2)}\n`);
  } catch (error) {
    refuse(`cannot write the baseline to ${opts.file}: ${error.message}`);
  }
  const failing = fixtures.filter((row) => row.outcome !== "passed").map((row) => row.path);
  console.log(
    `\nbaseline: ${opts.file} at ${snapshot.revision ?? "no revision (not a git tree)"} over ${opts.root}`,
  );
  console.log(
    `  ${counts.fixtures} fixture(s): ${counts.passed} passed, ${counts.failed} failed, ${counts.timedOut} timed out`,
  );
  if (failing.length > 0) {
    const shown = failing.slice(0, 8).join(", ");
    console.log(`  already not passing at snapshot time: ${shown}${failing.length > 8 ? `, +${failing.length - 8} more` : ""}`);
    console.log(
      "  A check against this baseline can only see the fixtures that were green in it: " +
        "anything already red is outside what the comparison reads.",
    );
  }
  return EXIT_CLEAN;
}

async function checkAgainst(opts) {
  const baseline = readBaseline(opts.file);
  const exemptions = readExemptions(opts.exempt);
  if (typeof baseline.root === "string" && resolve(baseline.root) !== opts.root) {
    refuse(
      `the baseline was taken over ${baseline.root} and this run reads ${opts.root}. ` +
        "Its rows name fixtures by their path in that tree, so a comparison across two trees compares two populations.",
    );
  }
  // Both refusals above and the revision read below happen before the suite
  // runs: a baseline that cannot ground the comparison is not worth four
  // minutes of the caller's machine to discover.
  const distance = revisionVerdict(readRevision(baseline.revision, opts.file), revisionOf(opts.root), opts.root);
  console.log(`check-regressions: baseline ${opts.file}, ${distance}`);
  const { rows, captured } = await runSuite(opts);
  const before = baseline.fixtures;
  const after = snapshotRows(rows, captured);
  const result = compare(before, after, exemptions);

  for (const finding of result.regressions) console.log(regressionLine(finding));
  for (const row of result.excused) console.log(`EXEMPT ${row.finding.path}: ${row.why}`);
  for (const row of result.stale) {
    const known = before.some((prior) => prior.path === row.path);
    console.log(
      `STALE exemption ${row.path}: ${row.why} ` +
        (known ? "(this fixture did not regress)" : "(no fixture of this path is in the baseline)"),
    );
  }

  console.log(
    `\ncheck-regressions: ${before.length} fixture(s) compared against the baseline, ` +
      `${result.regressions.length} regression(s), ${result.excused.length} exempt, ` +
      `${result.stale.length} stale exemption(s), ${result.added.length} fixture(s) new since the baseline`,
  );
  if (result.countsCompared < before.length) {
    console.log(
      `  both sides print a tally for ${result.countsCompared} of ${before.length} fixture(s); ` +
        "the rest were compared on the runner's outcome alone",
    );
  }
  console.log(
    result.regressions.length === 0
      ? "OK: no fixture that passed in the baseline stopped passing."
      : `FAILED: ${result.regressions.length} fixture(s) that passed in the baseline no longer pass.`,
  );
  console.log("A behaviour with no fixture is outside what this reads.");
  return result.regressions.length === 0 ? EXIT_CLEAN : EXIT_REGRESSION;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // The exit code is set, never forced: a process.exit() after writes to a pipe
  // truncates the lines a reader needs, and this file's whole output is a report.
  process.exitCode = opts.mode === "baseline" ? await takeBaseline(opts) : await checkAgainst(opts);
}

main().catch((error) => {
  if (error instanceof Stop) {
    console.error(`check-regressions: ${error.message}`);
    if (error.code === EXIT_USAGE) console.error(USAGE_LINE);
    process.exitCode = error.code;
    return;
  }
  console.error(`check-regressions: ${error.stack ?? error.message}`);
  process.exitCode = EXIT_REFUSED;
});
