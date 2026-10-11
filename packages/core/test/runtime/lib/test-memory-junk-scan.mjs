/**
 * Test: memory junk scan (scripts/memory-junk-scan.mjs).
 *
 * The script is the read side of §B.6 row 2: it classifies episodes.jsonl
 * into the design's Appendix A.1 partition (sentinel / template-solution /
 * dual-field), measures windowed junk rates against the pre-window baseline,
 * counts exact (task, solution) duplicate groups, and lays out the sentinel
 * timeline. This suite pins the contract by running the real CLI against
 * synthetic fixture stores:
 *
 *   A. CLI: --help, invalid usage (exit 2), inline --flag=value form.
 *   B. Read states, all exit 0: absent file, empty file, malformed lines
 *      (skipped and counted), unreadable path, no new entries in window.
 *   C. Classification: the exact three-class partition and its sum
 *      invariant, sentinel precedence, each template regex, near-misses,
 *      missing task/solution defaults.
 *   D. Windowing: --since / --weeks split window vs baseline, inclusive
 *      start boundary, rates change with the window.
 *   E. Duplicates: groups of 2 and 3, surplus math, stock vs window scope.
 *   F. Alarm: dead-solution share >10% fires, exactly 10% does not; empty
 *      window is no-data, never an alarm.
 *   G. Timeline: per-day UTC buckets, zero-filled gap days, last sentinel
 *      is store-wide.
 *   H. JSON schema: stable key order.
 *
 * Hermetic: every run reads a fixture under a temp dir (`--file` always
 * passed); the live ~/.pi/agent/braid/memory/episodes.jsonl is never read.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "../../../scripts/memory-junk-scan.mjs");
const WORK = mkdtempSync(join(tmpdir(), "memory-junk-scan-"));
const DAY_MS = 86_400_000;

console.log("=== memory junk scan ===\n");

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

let seq = 0;
/** One well-formed store line; epoch-ms timestamp like the real store. */
function ep(tsMs, task = "", solution = "") {
  return JSON.stringify({ id: `ep-test-${++seq}`, task, solution, timestamp: tsMs });
}

/** Write a fixture store; returns its path. */
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

// Fixed fixture timestamps (noon UTC unless noted), around the design's
// live-window boundary (2026-08-13, the day after the sentinel kill).
const AUG05 = Date.UTC(2026, 7, 5, 12);
const AUG12 = Date.UTC(2026, 7, 12, 12);
const AUG13 = Date.UTC(2026, 7, 13, 12);
const AUG15 = Date.UTC(2026, 7, 15, 12);
const SINCE = "2026-08-13";
const SINCE_MS = Date.UTC(2026, 7, 13);

// ── A. CLI ───────────────────────────────────────────────────────────────────

test("--help exits 0 and prints the usage block", () => {
  const r = run("--help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /--json/);
  assert.match(r.stdout, /--since/);
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
  const file = fixture("inline.jsonl", [ep(AUG13, "Task", "A real solution")]);
  const report = runJson([`--file=${file}`, "--since=2026-08-01", "--json"]);
  assert.equal(report.options.weeks, 4);
  assert.equal(report.state, "ok");
});

// ── B. Read states, all exit 0 ───────────────────────────────────────────────

test("absent file: state absent, null window, no alarm, exit 0", () => {
  const missing = join(WORK, "does-not-exist.jsonl");
  const report = runJson(["--file", missing, "--json"]);
  assert.equal(report.state, "absent");
  assert.equal(report.window, null);
  assert.equal(report.baseline, null);
  assert.equal(report.duplicates.stock.groups, 0);
  assert.deepEqual(report.timeline.days, []);
  const text = run("--file", missing);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /no data/);
  assert.equal(text.stdout.includes("ALARM"), false, "absent is not an alarm");
});

test("empty file: state empty, exit 0, no alarm", () => {
  const file = fixture("empty.jsonl", []);
  const report = runJson(["--file", file, "--json"]);
  assert.equal(report.state, "empty");
  assert.equal(report.lines.total, 0);
  const text = run("--file", file);
  assert.equal(text.status, 0);
  assert.equal(text.stdout.includes("ALARM"), false);
});

test("malformed lines are skipped and counted, never fatal", () => {
  const file = fixture("malformed.jsonl", [
    ep(AUG13, "Task A", "A real solution"),
    "not json at all",
    '{"timestamp":"nope"}',
    "[1,2]",
    "null",
    '{"foo":1}',
    ep(AUG13, "Task B", "Another real solution"),
  ]);
  const report = runJson(["--file", file, "--since", "2026-08-01", "--json"]);
  assert.equal(report.lines.total, 7);
  assert.equal(report.lines.usable, 2);
  assert.equal(report.lines.malformed, 5);
  assert.equal(report.window.total, 2);
});

test("an entry missing task/solution but carrying a timestamp is usable and dual-field", () => {
  const file = fixture("bare.jsonl", [JSON.stringify({ timestamp: AUG13 })]);
  const report = runJson(["--file", file, "--since", "2026-08-01", "--json"]);
  assert.equal(report.lines.usable, 1);
  assert.equal(report.lines.malformed, 0);
  assert.deepEqual(report.window.classes, { sentinel: 0, template: 0, dual: 1 });
});

test("unreadable path (a directory) exits 0 with an unreadable state", () => {
  const r = run("--file", WORK);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /unreadable/);
  const report = runJson(["--file", WORK, "--json"]);
  assert.equal(report.state, "unreadable");
  assert.ok(report.error.length > 0, "the read error is reported");
});

test("no new entries in the window: no-new-entries state, alarm no-data", () => {
  const file = fixture("no-new.jsonl", [ep(AUG12, "Task", "A real solution")]);
  const report = runJson(["--file", file, "--since", "2027-01-01", "--json"]);
  assert.equal(report.state, "no-new-entries");
  assert.equal(report.window.total, 0);
  assert.equal(report.window.alarm.status, "no-data");
  assert.equal(report.baseline.total, 1);
  const text = run("--file", file, "--since", "2027-01-01");
  assert.equal(text.status, 0);
  assert.match(text.stdout, /no new entries in the window/);
  assert.equal(text.stdout.includes("ALARM"), false, "an empty window is not an alarm");
});

// ── C. Classification ────────────────────────────────────────────────────────

test("exact three-class partition; classes sum to total", () => {
  const file = fixture("partition.jsonl", [
    ep(AUG13, "session_outcome", "Outcome: success"),
    ep(AUG13, "session_outcome", "Complete task: session_outcome"),
    ep(AUG13, "Task A", "Outcome: success"),
    ep(AUG13, "Task B", "Outcome: partial"),
    ep(AUG13, "Task C", "Outcome: failure"),
    ep(AUG13, "Task D", "Complete task: session_outcome"),
    ep(AUG13, "Task E", "Use Other-Understand approach to X"),
    ep(AUG13, "Task F", "  Use X approach to Y"),
    ep(AUG13, "Task G", "A real solution"),
    ep(AUG13, "", ""),
  ]);
  const report = runJson(["--file", file, "--since", "2026-08-01", "--json"]);
  assert.deepEqual(report.window.classes, { sentinel: 2, template: 6, dual: 2 });
  assert.equal(report.window.total, 10);
  assert.equal(
    report.window.classes.sentinel + report.window.classes.template + report.window.classes.dual,
    report.window.total,
    "classes sum to total",
  );
  assert.equal(report.window.rates.sentinel, 20);
  assert.equal(report.window.rates.template, 60);
  assert.equal(report.window.rates.dual, 20);
  assert.equal(report.window.rates.junk, 80);
});

test("sentinel precedence: a sentinel task with a template solution stays sentinel", () => {
  const file = fixture("precedence.jsonl", [ep(AUG13, "session_outcome", "Outcome: success")]);
  const report = runJson(["--file", file, "--since", "2026-08-01", "--json"]);
  assert.deepEqual(report.window.classes, { sentinel: 1, template: 0, dual: 0 });
});

test("template near-misses stay dual-field", () => {
  const file = fixture("near-miss.jsonl", [
    ep(AUG13, "T1", "Outcome: done"),
    ep(AUG13, "T2", "Complete tasking"),
    ep(AUG13, "T3", "Use approach"),
    ep(AUG13, "T4", "Prefixed Outcome: success"),
    ep(AUG13, "T5", "outcome: success"),
  ]);
  const report = runJson(["--file", file, "--since", "2026-08-01", "--json"]);
  assert.deepEqual(report.window.classes, { sentinel: 0, template: 0, dual: 5 });
});

// ── D. Windowing ─────────────────────────────────────────────────────────────

test("--since splits window vs baseline; rates follow the split", () => {
  const file = fixture("window.jsonl", [
    ep(AUG12, "Pre 1", "Outcome: success"),
    ep(AUG12, "Pre 2", "Outcome: partial"),
    ep(AUG12, "session_outcome", "Complete task: session_outcome"),
    ep(AUG12, "Pre 4", "Old real solution"),
    ep(AUG13, "Post 1", "Outcome: success"),
    ep(AUG13, "Post 2", "New real solution A"),
    ep(AUG13, "Post 3", "New real solution B"),
    ep(AUG13, "Post 4", "New real solution C"),
  ]);
  const report = runJson(["--file", file, "--since", SINCE, "--json"]);
  assert.equal(report.window.source, "since");
  assert.equal(report.window.start, SINCE);
  assert.equal(report.window.total, 4);
  assert.deepEqual(report.window.classes, { sentinel: 0, template: 1, dual: 3 });
  assert.equal(report.window.rates.template, 25);
  assert.equal(report.window.rates.junk, 25);
  assert.equal(report.baseline.total, 4);
  assert.deepEqual(report.baseline.classes, { sentinel: 1, template: 2, dual: 1 });
  assert.equal(report.baseline.rates.junk, 75);
});

test("--weeks builds a trailing window; older entries land in the baseline", () => {
  const file = fixture("weeks.jsonl", [
    ep(Date.now() - 10 * DAY_MS, "Old task", "A real solution"),
    ep(Date.now() - 1 * DAY_MS, "New task", "Outcome: success"),
  ]);
  const report = runJson(["--file", file, "--weeks", "1", "--json"]);
  assert.equal(report.options.weeks, 1);
  assert.equal(report.window.source, "weeks");
  assert.equal(report.window.total, 1);
  assert.deepEqual(report.window.classes, { sentinel: 0, template: 1, dual: 0 });
  assert.equal(report.window.alarm.status, "alarm");
  assert.equal(report.baseline.total, 1);
  assert.deepEqual(report.baseline.classes, { sentinel: 0, template: 0, dual: 1 });
  const daySum = report.timeline.days.reduce((sum, day) => sum + day.total, 0);
  assert.equal(
    daySum,
    report.window.total,
    "the timeline covers every window entry even when the --weeks start is mid-day",
  );
});

test("the window start is inclusive: exactly midnight counts as new", () => {
  const file = fixture("boundary.jsonl", [
    ep(SINCE_MS - 1, "Just before", "A real solution"),
    ep(SINCE_MS, "At midnight", "Another real solution"),
  ]);
  const report = runJson(["--file", file, "--since", SINCE, "--json"]);
  assert.equal(report.window.total, 1);
  assert.equal(report.baseline.total, 1);
});

// ── E. Duplicates ────────────────────────────────────────────────────────────

test("duplicate groups of 2 and 3: group count, surplus, per-group sizes", () => {
  const file = fixture("dups.jsonl", [
    ep(AUG13, "Pair A", "Solution A"),
    ep(AUG13, "Pair A", "Solution A"),
    ep(AUG13, "Triple B", "Solution B"),
    ep(AUG13, "Triple B", "Solution B"),
    ep(AUG13, "Triple B", "Solution B"),
    ep(AUG13, "Unique", "Solution C"),
  ]);
  const report = runJson(["--file", file, "--since", "2026-08-01", "--json"]);
  const stock = report.duplicates.stock;
  assert.equal(stock.groups, 2);
  assert.equal(stock.groupedEntries, 5);
  assert.equal(stock.surplus, 3, "surplus = total minus one per group");
  assert.deepEqual(stock.bySize, { 2: 1, 3: 1 });
  assert.equal(stock.largest.length, 2);
  assert.equal(stock.largest[0].size, 3, "largest group first");
  assert.equal(stock.largest[1].size, 2);
  assert.notEqual(stock.largest[0].id, stock.largest[1].id);
  for (const group of stock.largest) assert.match(group.id, /^[0-9a-f]{12}$/);
  // The window covers every entry here, so the window scope sees the same.
  assert.equal(report.duplicates.window.surplus, 3);
});

test("stock duplicates include entries outside the window; window scope does not", () => {
  const file = fixture("dup-scope.jsonl", [
    ep(AUG05, "Old pair", "Old solution"),
    ep(AUG05, "Old pair", "Old solution"),
    ep(AUG13, "New task", "New solution"),
  ]);
  const report = runJson(["--file", file, "--since", SINCE, "--json"]);
  assert.equal(report.duplicates.stock.groups, 1);
  assert.equal(report.duplicates.stock.surplus, 1);
  assert.equal(report.duplicates.window.groups, 0);
  assert.equal(report.duplicates.window.surplus, 0);
});

// ── F. Alarm (§B.6 row 2) ────────────────────────────────────────────────────

test("dead-solution share above 10% alarms in JSON and text", () => {
  const lines = [];
  for (let i = 0; i < 3; i++) lines.push(ep(AUG13, `Template ${i}`, "Outcome: success"));
  for (let i = 0; i < 18; i++) lines.push(ep(AUG13, `Dual ${i}`, `Real solution ${i}`));
  const file = fixture("alarm.jsonl", lines);
  const report = runJson(["--file", file, "--since", "2026-08-01", "--json"]);
  assert.equal(report.window.total, 21);
  assert.equal(report.window.alarm.status, "alarm");
  assert.equal(report.window.alarm.deadSolutionRate, Math.round((3 / 21) * 100 * 100) / 100);
  const text = run("--file", file, "--since", "2026-08-01");
  assert.match(text.stdout, /ALARM: dead-solution share of new writes/);
});

test("dead-solution share of exactly 10% does not alarm", () => {
  const lines = [];
  for (let i = 0; i < 2; i++) lines.push(ep(AUG13, `Template ${i}`, "Outcome: success"));
  for (let i = 0; i < 18; i++) lines.push(ep(AUG13, `Dual ${i}`, `Real solution ${i}`));
  const file = fixture("at-threshold.jsonl", lines);
  const report = runJson(["--file", file, "--since", "2026-08-01", "--json"]);
  assert.equal(report.window.total, 20);
  assert.equal(report.window.alarm.status, "ok");
  assert.equal(report.window.alarm.deadSolutionRate, 10);
  const text = run("--file", file, "--since", "2026-08-01");
  assert.equal(text.stdout.includes("ALARM"), false);
});

// ── G. Timeline ──────────────────────────────────────────────────────────────

test("timeline buckets by UTC day, zero-fills gaps, and reports the store-wide last sentinel", () => {
  const lateAug13 = Date.UTC(2026, 7, 13, 23, 59);
  const earlyAug15 = Date.UTC(2026, 7, 15, 0, 0, 30);
  const file = fixture("timeline.jsonl", [
    ep(AUG05, "session_outcome", "Complete task: session_outcome"),
    ep(lateAug13, "Task A", "A real solution"),
    ep(earlyAug15, "Task B", "Another real solution"),
  ]);
  const report = runJson(["--file", file, "--since", SINCE, "--json"]);
  assert.deepEqual(
    report.timeline.days.map((day) => [day.date, day.total, day.sentinel]),
    [
      ["2026-08-13", 1, 0],
      ["2026-08-14", 0, 0],
      ["2026-08-15", 1, 0],
    ],
    "23:59 buckets into the 13th, 00:00 into the 15th, the gap day is zero-filled",
  );
  assert.equal(report.timeline.lastSentinel.ts, new Date(AUG05).toISOString());
  assert.ok(report.timeline.lastSentinel.ageDays > 0);
});

test("a window with sentinels reports the peak sentinel day", () => {
  const file = fixture("peak.jsonl", [
    ep(AUG13, "session_outcome", "Complete task: session_outcome"),
    ep(AUG13, "session_outcome", "Use X approach to Y"),
    ep(AUG15, "session_outcome", "Outcome: success"),
  ]);
  const report = runJson(["--file", file, "--since", SINCE, "--json"]);
  assert.deepEqual(report.timeline.maxSentinelPerDay, { date: "2026-08-13", count: 2 });
});

// ── H. JSON schema ───────────────────────────────────────────────────────────

test("--json emits the stable top-level key order and window shape", () => {
  const file = fixture("schema.jsonl", [ep(AUG13, "Task", "A real solution")]);
  const report = runJson(["--file", file, "--since", "2026-08-01", "--json"]);
  assert.deepEqual(Object.keys(report), [
    "file",
    "state",
    "error",
    "generatedAt",
    "options",
    "lines",
    "window",
    "baseline",
    "duplicates",
    "timeline",
  ]);
  assert.deepEqual(Object.keys(report.window), [
    "start",
    "startTs",
    "source",
    "total",
    "classes",
    "rates",
    "alarm",
  ]);
  assert.deepEqual(Object.keys(report.window.classes), ["sentinel", "template", "dual"]);
  assert.deepEqual(Object.keys(report.window.rates), ["sentinel", "template", "dual", "junk"]);
  assert.deepEqual(Object.keys(report.duplicates), ["stock", "window"]);
  assert.deepEqual(Object.keys(report.options), ["since", "weeks"]);
});

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== memory junk scan tests passed ===");
