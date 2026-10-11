/**
 * Test: memory write-log metrics (scripts/memory-write-log-metrics.mjs).
 *
 * The script is the read side of the durable-write gate's measurement hook:
 * it turns write-log.jsonl into the §B.6 readings (per-site weekly writes with
 * the >50% w/w drop check, decision mix, mode split, trailing-7-day silence
 * alarm, rejection sample). This suite pins the report contract by running
 * the real CLI against synthetic fixture logs:
 *
 *   A. CLI: --help, invalid usage (exit 2), inline --flag=value form.
 *   B. Read states, all exit 0: absent file, empty file, malformed lines
 *      (skipped and counted), unreadable path, --since filtering everything.
 *   C. Counting: decision mix + rates, mode split, per-site weekly writes
 *      (accept/repair under enforce; every decision under warn).
 *   D. ISO week bucketing: Monday boundaries, ISO week-year at a year edge,
 *      gap weeks zero-filled, window clamped to the data, partial current
 *      week excluded from week-over-week math.
 *   E. Week-over-week: the §B.6 row 1 flag fires on a complete-week drop
 *      below half (strictly), never at exactly 50%, and never for the
 *      current partial week.
 *   F. Silence: alarm below 1 write/day over the trailing 7 days; ok above;
 *      no-data (not alarm) for absent/empty/filtered logs.
 *   G. Rejection sample: newest first, capped at 10, reasons only.
 *   H. JSON schema: stable top-level key order.
 *
 * Hermetic: every run reads a fixture under a temp dir (`--file` always
 * passed); the live ~/.pi/agent/braid/memory/write-log.jsonl is never read.
 * Fixture weeks for the fixed-date cases (2026-W35..W38) are historical
 * relative to this suite's authorship; the partial-week and silence cases
 * build their timestamps relative to the run clock instead.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "../../../scripts/memory-write-log-metrics.mjs");
const WORK = mkdtempSync(join(tmpdir(), "write-log-metrics-"));
const DAY_MS = 86_400_000;

console.log("=== memory write-log metrics ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  }
}

let hashSeed = 0;
/** One well-formed log line. */
function line(ts, site, decision, mode = "enforce", reason = "accepted") {
  hashSeed++;
  const hash = hashSeed.toString(16).padStart(16, "0");
  return JSON.stringify({ ts, site, decision, reason, taskHash: hash, solutionHash: hash, mode });
}

/** Write a fixture log; returns its path. */
function fixture(name, lines) {
  const file = join(WORK, name);
  writeFileSync(file, lines.length > 0 ? lines.join("\n") + "\n" : "");
  return file;
}

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

function runJson(args) {
  const r = run(...args);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

// Fixed fixture dates (UTC; see the header note on why these are historical).
const W35 = "2026-08-25T10:00:00.000Z"; // Tuesday, ISO week 2026-W35
const W36 = "2026-09-01T10:00:00.000Z"; // Tuesday, ISO week 2026-W36
const W37 = "2026-09-08T10:00:00.000Z"; // Tuesday, ISO week 2026-W37
const W38 = "2026-09-14T10:00:00.000Z"; // Monday, ISO week 2026-W38

const mondayOf = (d) => {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() - (dayNum - 1));
  return x;
};

// ── A. CLI ───────────────────────────────────────────────────────────────────

test("--help exits 0 and prints the usage block", () => {
  const r = run("--help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /--json/);
});

test("invalid usage exits 2 with an error and usage on stderr", () => {
  for (const args of [
    ["--weeks", "0"],
    ["--weeks", "abc"],
    ["--bogus"],
    ["--since", "2026-13-45"],
  ]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(" ")} should exit 2`);
    assert.match(r.stderr, /error:/);
    assert.match(r.stderr, /Usage:/);
  }
});

test("--flag=value inline form is accepted", () => {
  const file = fixture("inline.jsonl", [line(W38, "finalize", "accept")]);
  const report = runJson([`--file=${file}`, "--weeks=1", "--json"]);
  assert.equal(report.weeks, 1);
  assert.equal(report.weekly.length, 1);
});

// ── B. Read states, all exit 0 ───────────────────────────────────────────────

test("absent file: state absent, silence no-data, no alarm", () => {
  const missing = join(WORK, "does-not-exist.jsonl");
  const report = runJson(["--file", missing, "--json"]);
  assert.equal(report.state, "absent");
  assert.equal(report.silence.status, "no-data");
  const text = run("--file", missing);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /no data/);
  assert.equal(text.stdout.includes("ALARM"), false, "absent is not an alarm");
});

test("empty file: state empty, silence no-data, no alarm", () => {
  const file = fixture("empty.jsonl", []);
  const report = runJson(["--file", file, "--json"]);
  assert.equal(report.state, "empty");
  assert.equal(report.silence.status, "no-data");
  const text = run("--file", file);
  assert.equal(text.status, 0);
  assert.equal(text.stdout.includes("ALARM"), false);
});

test("malformed lines are skipped and counted, never fatal", () => {
  const file = fixture("malformed.jsonl", [
    line(W38, "finalize", "accept"),
    "not json at all",
    '{"ts":"nope"',
    JSON.stringify({ ts: W38, site: "", decision: "accept" }),
    JSON.stringify({ ts: W38, site: "finalize", decision: "exploded" }),
    line(W38, "finalize", "accept"),
  ]);
  const report = runJson(["--file", file, "--json"]);
  assert.equal(report.lines.total, 6);
  assert.equal(report.lines.usable, 2);
  assert.equal(report.lines.malformed, 4);
  assert.equal(report.decisions.counts.accept, 2);
});

test("unreadable path (a directory) exits 0 with an unreadable state", () => {
  const r = run("--file", WORK);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /unreadable/);
  const report = runJson(["--file", WORK, "--json"]);
  assert.equal(report.state, "unreadable");
  assert.ok(report.error.length > 0, "the read error is reported");
});

test("--since filtering everything: no-lines-in-window, silence no-data, exit 0", () => {
  const file = fixture("since-all.jsonl", [line(W35, "finalize", "accept")]);
  const report = runJson(["--file", file, "--since", "2027-01-01", "--json"]);
  assert.equal(report.state, "no-lines-in-window");
  assert.equal(report.lines.inWindow, 0);
  assert.equal(report.silence.status, "no-data");
  const text = run("--file", file, "--since", "2027-01-01");
  assert.equal(text.status, 0);
  assert.match(text.stdout, /no usable lines in window/);
});

// ── C. Counting ──────────────────────────────────────────────────────────────

test("decision mix, rates, and mode split over a mixed fixture", () => {
  const file = fixture("mix.jsonl", [
    line(W35, "finalize", "accept"),
    line(W35, "finalize", "accept"),
    line(W35, "finalize", "accept"),
    line(W36, "finalize", "accept"),
    line(W36, "finalize", "accept"),
    line(W36, "finalize", "accept"),
    line(W36, "finalize", "accept"),
    line(W36, "finalize", "accept"),
    line(W36, "episodesAdd", "repair", "enforce", "dead solution field repaired from task"),
    line(W37, "finalize", "accept"),
    line(W37, "finalize", "accept"),
    line(W37, "finalize", "reject", "enforce", "task carries no signal"),
    line(W37, "finalize", "skip-dup", "enforce", "duplicate (exact, similarity 1.00)"),
    line(W37, "mars", "reject", "enforce", "solution carries no signal and no evidence"),
    line(W37, "mars", "accept", "warn"),
  ]);
  const report = runJson(["--file", file, "--json"]);
  assert.deepEqual(report.decisions.counts, {
    "accept": 11,
    "repair": 1,
    "reject": 2,
    "skip-dup": 1,
  });
  assert.equal(report.decisions.total, 15);
  assert.equal(report.decisions.rates.accept, Math.round((11 / 15) * 100 * 100) / 100);
  assert.deepEqual(report.modes.counts, { enforce: 14, warn: 1, unknown: 0 });
});

test("per-site weekly writes: accept+repair under enforce, all decisions under warn", () => {
  const file = fixture("writes.jsonl", [
    line(W36, "finalize", "accept"),
    line(W36, "finalize", "accept"),
    line(W36, "finalize", "reject"),
    line(W36, "finalize", "skip-dup"),
    line(W37, "finalize", "accept"),
    line(W37, "mars", "accept", "warn"),
    line(W37, "mars", "reject"),
  ]);
  const report = runJson(["--file", file, "--json"]);
  const finalize = report.wow.find((row) => row.site === "finalize");
  const mars = report.wow.find((row) => row.site === "mars");
  assert.deepEqual(finalize.counts, { "2026-W36": 2, "2026-W37": 1 });
  assert.deepEqual(mars.counts, { "2026-W36": 0, "2026-W37": 1 });
  assert.deepEqual(report.activeSites, ["finalize", "mars"]);
  assert.equal(
    report.weekly.reduce((sum, w) => sum + w.writes, 0),
    4,
    "writes exclude reject/skip-dup under enforce",
  );
});

// ── D. ISO week bucketing ────────────────────────────────────────────────────

test("ISO week boundaries: Monday 00:00Z starts a new week", () => {
  const file = fixture("boundary.jsonl", [
    line("2026-09-13T23:59:59.000Z", "finalize", "accept"), // Sunday -> W37
    line("2026-09-14T00:00:00.000Z", "finalize", "accept"), // Monday -> W38
  ]);
  const report = runJson(["--file", file, "--json"]);
  assert.deepEqual(report.wow[0].counts, { "2026-W37": 1, "2026-W38": 1 });
});

test("ISO week-year differs from calendar year at the December edge", () => {
  const file = fixture("year-edge.jsonl", [
    line("2025-12-28T12:00:00.000Z", "finalize", "accept"), // Sunday -> 2025-W52
    line("2025-12-29T12:00:00.000Z", "finalize", "accept"), // Monday -> 2026-W01
  ]);
  const report = runJson(["--file", file, "--json"]);
  assert.deepEqual(
    report.weekly.map((w) => w.week),
    ["2025-W52", "2026-W01"],
  );
});

test("gap weeks are zero-filled and the window never extends before the first data week", () => {
  const gap = fixture("gap.jsonl", [
    line(W35, "finalize", "accept"),
    line(W38, "finalize", "accept"),
  ]);
  const report = runJson(["--file", gap, "--json"]);
  assert.deepEqual(
    report.weekly.map((w) => [w.week, w.bySite.finalize]),
    [
      ["2026-W35", 1],
      ["2026-W36", 0],
      ["2026-W37", 0],
      ["2026-W38", 1],
    ],
  );

  const single = fixture("single-week.jsonl", [line(W38, "finalize", "accept")]);
  const clamped = runJson(["--file", single, "--json"]);
  assert.equal(clamped.weekly.length, 1, "the range clamps at the first data week");
});

test("the current partial week is flagged and excluded from week-over-week math", () => {
  const monday = mondayOf(new Date());
  const lastMonday = new Date(monday.getTime() - 7 * DAY_MS);
  const file = fixture("partial.jsonl", [
    line(new Date(lastMonday.getTime() + 10 * 3600 * 1000).toISOString(), "finalize", "accept"),
    line(new Date().toISOString(), "finalize", "accept"),
  ]);
  const report = runJson(["--file", file, "--json"]);
  assert.equal(report.weekly.length, 2);
  assert.equal(report.weekly[0].partial, false);
  assert.equal(report.weekly[1].partial, true);
  assert.equal(
    report.wow[0].latestChange,
    null,
    "with one complete week there is no complete pair, even though two rows exist",
  );
});

// ── E. Week-over-week drop check (§B.6 row 1) ────────────────────────────────

test("a complete-week drop below half flags the site and renders an ALARM", () => {
  const file = fixture("drop.jsonl", [
    line(W36, "finalize", "accept"),
    line(W36, "finalize", "accept"),
    line(W36, "finalize", "accept"),
    line(W36, "finalize", "accept"),
    line(W37, "finalize", "accept"),
  ]);
  const report = runJson(["--file", file, "--json"]);
  assert.deepEqual(report.wow[0].latestChange, { prev: 4, cur: 1, change: -3, changePct: -75 });
  assert.equal(report.wow[0].flags.length, 1);
  assert.deepEqual(report.wow[0].flags[0], {
    from: "2026-W36",
    to: "2026-W37",
    fromCount: 4,
    toCount: 1,
    changePct: -75,
  });
  const text = run("--file", file);
  assert.match(text.stdout, /ALARM finalize: writes dropped from 4 \(2026-W36\) to 1 \(2026-W37\)/);
});

test("a drop of exactly 50% does not flag (threshold is strictly over half)", () => {
  const file = fixture("at-threshold.jsonl", [
    line(W36, "finalize", "accept"),
    line(W36, "finalize", "accept"),
    line(W37, "finalize", "accept"),
  ]);
  const report = runJson(["--file", file, "--json"]);
  assert.deepEqual(report.wow[0].latestChange, { prev: 2, cur: 1, change: -1, changePct: -50 });
  assert.deepEqual(report.wow[0].flags, []);
  const text = run("--file", file);
  assert.equal(text.stdout.includes("ALARM finalize"), false);
});

// ── F. Silence detector (§B.6 row 3) ─────────────────────────────────────────

test("silence alarm: no writes in the trailing 7 days", () => {
  const file = fixture("silence.jsonl", [
    line(new Date(Date.now() - 20 * DAY_MS).toISOString(), "finalize", "accept"),
  ]);
  const report = runJson(["--file", file, "--json"]);
  assert.equal(report.silence.status, "alarm");
  assert.equal(report.silence.windowWrites, 0);
  assert.equal(report.silence.trailingAverage, 0);
  const text = run("--file", file);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /ALARM: fewer than 1 write\/day over the trailing 7 days/);
});

test("silence ok when the trailing average reaches one write per day", () => {
  const today = new Date().toISOString();
  const lines = Array.from({ length: 14 }, () => line(today, "finalize", "accept"));
  const file = fixture("silence-ok.jsonl", lines);
  const report = runJson(["--file", file, "--json"]);
  assert.equal(report.silence.status, "ok");
  assert.equal(report.silence.trailingAverage, 2);
  const text = run("--file", file);
  assert.equal(text.stdout.includes("ALARM"), false);
});

// ── G. Rejection sample ──────────────────────────────────────────────────────

test("rejection sample: newest first, capped at 10, reasons only", () => {
  const lines = [];
  for (let i = 0; i < 12; i++) {
    const day = new Date(Date.UTC(2026, 8, 1 + i, 10)).toISOString();
    lines.push(line(day, "finalize", "reject", "enforce", `task carries no signal #${i}`));
  }
  const file = fixture("sample.jsonl", lines);
  const report = runJson(["--file", file, "--json"]);
  assert.equal(report.sample.length, 10);
  assert.equal(report.sample[0].reason, "task carries no signal #11", "newest first");
  const ts = report.sample.map((entry) => entry.ts);
  assert.deepEqual(ts, [...ts].sort().reverse(), "descending timestamps");
  for (const entry of report.sample) {
    assert.deepEqual(Object.keys(entry), ["ts", "site", "decision", "reason", "mode"]);
    assert.equal(
      "taskHash" in entry || "solutionHash" in entry,
      false,
      "hashes stay out of the sample",
    );
  }
});

// ── H. JSON schema ───────────────────────────────────────────────────────────

test("--json emits the stable top-level key order", () => {
  const file = fixture("schema.jsonl", [line(W38, "finalize", "accept")]);
  const report = runJson(["--file", file, "--json"]);
  assert.deepEqual(Object.keys(report), [
    "file",
    "state",
    "error",
    "generatedAt",
    "weeks",
    "since",
    "lines",
    "window",
    "activeSites",
    "decisions",
    "modes",
    "weekly",
    "wow",
    "silence",
    "sample",
    "sampleLimit",
  ]);
});

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== write-log metrics tests passed ===");
