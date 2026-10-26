/**
 * Session scan — the reporting instrument's own arithmetic.
 *
 * The scanner is what turns "skills are barely used" into numbers, so its
 * arithmetic is pinned against synthetic session logs whose answers are known
 * by construction: every fixture states its calls, its paths, its first
 * prompt, and the one skill-surface message it carries, and the expectations
 * below are written by hand from those statements.
 *
 * What is pinned:
 *   1. The three metrics over a fixed population (M1 thin-prompt read rate,
 *      M2 drift latency, M3 injected surface bytes), including the population
 *      each denominator names.
 *   2. The boundaries: a session shorter than LONG_SESSION_CALLS is not long,
 *      a prompt at THIN_PROMPT_CHARS is not thin, and a single work area is
 *      not a drift.
 *   3. The work-area rule: the first two directory segments relative to the
 *      session's own cwd, nothing for repo-root files, top-level directories
 *      or paths outside the project.
 *   4. Malformed input degrades: an unparseable line is skipped, a file with
 *      no session header is not a session.
 *   5. The clock: --since keeps a session by its own recorded start rather
 *      than by the file's modification time, the two filters compose, a log
 *      whose start cannot be read is excluded and counted, and every report
 *      carries the cutoffs it applied.
 *   6. The instrument is not wired into the product: no file under `src/`
 *      imports it, so a metric can never change behavior.
 *
 * Run: node test/runtime/core/test-session-scan.mjs
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE = join(__dirname, "..", "..", "..");

const {
  LONG_SESSION_CALLS,
  THIN_PROMPT_CHARS,
  formatReport,
  scanSessions,
  sessionMetrics,
  startInstant,
  workArea,
} = await import(join(__dirname, "session-scan.mjs"));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${e.message}`);
  }
}

// ── fixtures ───────────────────────────────────────────────────────────────

const ROOT = mkdtempSync(join(tmpdir(), "session-scan-"));
const PROJECT = "/project";
const THIN = "let's pick up recent state and continue work here";
const LONG_PROMPT =
  "Rebuild the pricing page layout so the plan cards line up at every breakpoint and the table headers stay readable on narrow screens.";

/** Fixtures are placed on the clock relative to now, so no case ages out. */
const NOW = Date.now();
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();

/** Every fixture declares when it began: the start clock reads this field. */
const sessionHeader = (id, startedAt = at(-2 * DAY_MS)) => ({
  type: "session",
  version: 3,
  id,
  timestamp: startedAt,
  cwd: PROJECT,
});
const user = (text) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (blocks) => ({ type: "message", message: { role: "assistant", content: blocks } });
const call = (name, path) => ({ type: "toolCall", name, arguments: path ? { path } : {} });
const bash = () => call("bash");
const suggestion = (text) => ({
  type: "custom_message",
  customType: "skills-suggestion",
  content: [{ type: "text", text }],
  display: true,
});
const driftLine = (text) => ({
  type: "custom_message",
  customType: "skills-drift",
  content: [{ type: "text", text }],
  display: true,
});

function writeSession(dir, name, entries) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return file;
}

const GROUP = join(ROOT, "project");
const SUGGESTION_TEXT = "[SKILL SUGGESTION] two rows of advice"; // 38 bytes
const DRIFT_TEXT = "[SKILL INDEX] work is in app/api."; // 34 bytes

// A: thin prompt, long, one SKILL.md read at call 3.
const A = writeSession(GROUP, "a.jsonl", [
  sessionHeader("a"),
  user(THIN),
  assistant([
    bash(),
    bash(),
    call("read", "/project/pack/alpha/SKILL.md"),
    ...Array.from({ length: 22 }, bash),
  ]),
]);

// B: thin prompt, long, no skill read.
const B = writeSession(GROUP, "b.jsonl", [
  sessionHeader("b"),
  user(THIN),
  assistant(Array.from({ length: 25 }, bash)),
]);

// C: long prompt, a second work area at call 3, a suggestion after call 6.
const C = writeSession(GROUP, "c.jsonl", [
  sessionHeader("c"),
  user(LONG_PROMPT),
  assistant([call("read", "/project/app/web/src/a.tsx"), call("edit", "/project/app/web/src/b.tsx")]),
  assistant([call("read", "/project/app/api/src/route.ts"), call("edit", "/project/app/api/src/db.ts")]),
  assistant([bash(), bash()]),
  suggestion(SUGGESTION_TEXT),
  assistant(Array.from({ length: 19 }, bash)),
]);

// D: the same drift, no skill surface after it.
const D = writeSession(GROUP, "d.jsonl", [
  sessionHeader("d"),
  user(LONG_PROMPT),
  assistant([call("read", "/project/app/web/src/a.tsx"), call("edit", "/project/app/web/src/b.tsx")]),
  assistant([call("read", "/project/docs/ru/guide.md")]),
  assistant(Array.from({ length: 21 }, bash)),
]);

// E: one work area, short session, one drift line delivered.
const E = writeSession(GROUP, "e.jsonl", [
  sessionHeader("e"),
  user(LONG_PROMPT),
  assistant([call("read", "/project/tools/cli/src/main.ts")]),
  driftLine(DRIFT_TEXT),
  assistant(Array.from({ length: 3 }, bash)),
]);

// F: no session header (not a session) and one truncated line.
const F = writeSession(GROUP, "f.jsonl", [user(LONG_PROMPT), assistant([bash()])]);
writeFileSync(F, `${readFileSync(F, "utf8")}{"type":"message","message":{"role":"assistant"\n`);

// ── 1. the work-area rule ─────────────────────────────────────────────────

test("the work area is the first two directory segments under the session cwd", () => {
  assert.equal(workArea("read", { path: "app/web/src/index.astro" }, PROJECT), "app/web");
  assert.equal(workArea("edit", { path: "/project/app/api/src/route.ts" }, PROJECT), "app/api");
  assert.equal(workArea("write", { path: "/project/docs/ru/guide.md" }, PROJECT), "docs/ru");
});

test("repo-root files, top-level directories and foreign paths name no work area", () => {
  assert.equal(workArea("read", { path: "README.md" }, PROJECT), undefined);
  assert.equal(workArea("write", { path: "/project/package.json" }, PROJECT), undefined);
  assert.equal(workArea("read", { path: "notes/self.md" }, PROJECT), undefined);
  assert.equal(workArea("read", { path: "/elsewhere/app/web/src/x.ts" }, PROJECT), undefined);
  assert.equal(workArea("bash", { path: "app/web/src/x.ts" }, PROJECT), undefined);
});

// ── 2. per-session metrics ────────────────────────────────────────────────

test("M1 fixture: a thin long session with a SKILL.md read counts as read", () => {
  const metrics = sessionMetrics(A);
  assert.equal(metrics.long, true, `A has ${metrics.calls} calls`);
  assert.equal(metrics.thin, true, `A's prompt is ${metrics.promptChars} chars`);
  assert.equal(metrics.skillReads, 1);
  assert.equal(metrics.readSkill, true);
});

test("M1 fixture: the same session without a skill read does not", () => {
  const metrics = sessionMetrics(B);
  assert.equal(metrics.long, true);
  assert.equal(metrics.thin, true);
  assert.equal(metrics.readSkill, false);
});

test("M2 fixture: latency is the calls between the second work area and the next surface", () => {
  const metrics = sessionMetrics(C);
  assert.equal(metrics.drifted, true);
  assert.equal(metrics.driftLatency, 3, "the suggestion landed three calls after the move");
  assert.equal(metrics.driftUncovered, false);
});

test("M2 fixture: a drift with no surface after it is uncovered", () => {
  const metrics = sessionMetrics(D);
  assert.equal(metrics.drifted, true, "D moved from app/web to docs/ru");
  assert.equal(metrics.driftLatency, null);
  assert.equal(metrics.driftUncovered, true);
});

test("M3 fixture: surface bytes are the skill messages only, and a drift line counts", () => {
  const c = sessionMetrics(C);
  assert.equal(c.suggestions, 1);
  assert.equal(c.driftSurfaces, 0);
  assert.equal(c.surfaceBytes, Buffer.byteLength(SUGGESTION_TEXT));
  const e = sessionMetrics(E);
  assert.equal(e.driftSurfaces, 1);
  assert.equal(e.surfaceBytes, Buffer.byteLength(DRIFT_TEXT));
  assert.equal(e.long, false, `E has ${e.calls} calls`);
  assert.equal(e.drifted, false, "one work area is not a drift");
});

test("malformed input degrades instead of throwing", () => {
  assert.equal(sessionMetrics(F), undefined, "a file with no session header is not a session");
  const truncated = writeSession(GROUP, "g.jsonl", [sessionHeader("g"), user(THIN)]);
  writeFileSync(truncated, `${readFileSync(truncated, "utf8")}not json at all\n`);
  assert.ok(sessionMetrics(truncated), "one bad line does not discard the session");
  rmSync(truncated, { force: true });
});

// ── 3. the aggregate ──────────────────────────────────────────────────────

const report = scanSessions(ROOT);

test("the population names what it counted", () => {
  assert.equal(report.population.sessions, 5, "five session logs under the root");
  assert.equal(report.population.long, 4, "A, B, C, D are long; E is not");
  assert.equal(report.population.sessionsWithoutStart, 0, "every fixture declares a start");
  assert.deepEqual(report.window, { since: null, mtimeSince: null, days: null }, "no filter, no cutoff");
});

test("M1: one of two thin long sessions read a skill", () => {
  assert.equal(report.m1.thinLong, 2);
  assert.equal(report.m1.thinLongRead, 1);
  assert.equal(report.m1.rate, 0.5);
});

test("M2: one drift covered, one uncovered, latency reported in calls", () => {
  assert.equal(report.m2.drifted, 2);
  assert.equal(report.m2.covered, 1);
  assert.equal(report.m2.uncovered, 1);
  assert.equal(report.m2.medianCalls, 3);
  assert.equal(report.m2.withinWindow, 1, "three calls is inside the twelve-call window");
});

test("M3: bytes are per session, and the suggestion rate is over long sessions", () => {
  assert.equal(report.m3.sessionsWithSurface, 2, "C carries a suggestion, E a drift line");
  assert.equal(report.m3.medianBytes, (Buffer.byteLength(SUGGESTION_TEXT) + Buffer.byteLength(DRIFT_TEXT)) / 2);
  assert.equal(report.m3.driftLines, 1);
  assert.equal(report.m3.suggestionRate, 0.25, "one of four long sessions received a suggestion");
});

test("the human report names every population it divides", () => {
  const text = formatReport(report);
  assert.ok(text.startsWith("window: no cutoff, whole sessions root"), text);
  assert.ok(text.includes("M1 thin-prompt read rate: 1/2"), text);
  assert.ok(text.includes("M2 drift latency: 2 sessions"), text);
  assert.ok(text.includes("M3 injected surface:"), text);
});

// ── 4. the clock ──────────────────────────────────────────────────────────

// A session file's mtime answers a different question than the session's
// recorded start: a resumed session is old work in a fresh file. Each case
// below is built from two instants, one written into the header and one onto
// the file, so the failure it guards is the one where the scanner reads the
// wrong one of the two.

const CLOCK = mkdtempSync(join(tmpdir(), "session-scan-clock-"));
const SCANNER = join(__dirname, "session-scan.mjs");
const clockCase = (name) => join(CLOCK, name);
const runScanner = (args) => spawnSync(process.execPath, [SCANNER, ...args], { encoding: "utf8" });

/** A long session whose recorded start and file mtime are both stated. */
function clockSession(dir, name, startedAt, mtimeMs) {
  const file = writeSession(dir, `${name}.jsonl`, [
    sessionHeader(name, startedAt),
    user(THIN),
    assistant(Array.from({ length: 21 }, bash)),
  ]);
  if (mtimeMs !== undefined) utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

test("a cutoff with no zone is UTC, and a date the month does not have is not a cutoff", () => {
  const day = new Date(NOW).toISOString().slice(0, 10);
  assert.equal(startInstant(`${day}T07:20:00`), Date.parse(`${day}T07:20:00Z`), "no zone reads as UTC");
  assert.equal(startInstant(`${day}T07:20:00+03:00`), Date.parse(`${day}T04:20:00Z`), "a zone is honoured");
  assert.equal(startInstant(day), Date.parse(`${day}T00:00:00Z`), "a bare date is midnight UTC");
  assert.equal(startInstant(`${day.slice(0, 8)}32`), null, "the engine would roll that into next month");
  assert.equal(startInstant(`${day.slice(0, 5)}13${day.slice(7)}`), null, "there is no month 13");
  assert.equal(startInstant(day.slice(0, 4)), null, "a bare year is not a cutoff");
  assert.equal(startInstant("next tuesday"), null);
  assert.equal(startInstant(undefined), null);
});

test("--since keeps a session by its recorded start, with both logs in one directory", () => {
  const dir = clockCase("since");
  const cutoff = NOW - DAY_MS;
  const recent = clockSession(dir, "began-after", at(-HOUR_MS));
  const old = clockSession(dir, "began-before", at(-3 * DAY_MS));
  const scan = scanSessions(dir, { since: cutoff });
  assert.equal(scan.population.sessions, 1, "one of the two logs began at or after the cutoff");
  assert.equal(scan.sessions[0].file, recent);
  assert.equal(scan.sessions[0].startedAt, at(-HOUR_MS), "the report states the instant it filtered on");
  assert.ok(!scan.sessions.some((session) => session.file === old));
  assert.equal(scan.window.since, new Date(cutoff).toISOString());
});

test("a session that began exactly at the cutoff is kept, one millisecond earlier is not", () => {
  const dir = clockCase("boundary");
  const cutoff = NOW - DAY_MS;
  const onTime = clockSession(dir, "on-time", new Date(cutoff).toISOString());
  clockSession(dir, "one-ms-early", new Date(cutoff - 1).toISOString());
  assert.deepEqual(scanSessions(dir, { since: cutoff }).sessions.map((s) => s.file), [onTime]);
});

test("the clock is the recorded start, not the file's modification time", () => {
  const dir = clockCase("decoy");
  const cutoff = NOW - DAY_MS;
  clockSession(dir, "resumed-today", at(-9 * DAY_MS), NOW);
  assert.equal(
    scanSessions(dir, { since: cutoff }).population.sessions,
    0,
    "a fresh mtime is not a recent start",
  );
  assert.equal(
    scanSessions(dir, { days: 1 }).population.sessions,
    1,
    "the mtime clock still sees the file, which is why the two disagree",
  );
});

test("--since and --days are conjunctive: a session must pass both", () => {
  const dir = clockCase("both");
  const cutoff = NOW - DAY_MS;
  const passes = clockSession(dir, "passes", at(-HOUR_MS), NOW);
  clockSession(dir, "stale-file", at(-HOUR_MS), NOW - 3 * DAY_MS);
  clockSession(dir, "old-start", at(-9 * DAY_MS), NOW);
  const both = scanSessions(dir, { since: cutoff, days: 1 });
  assert.deepEqual(both.sessions.map((s) => s.file), [passes]);
  const shown = formatReport(both);
  assert.ok(shown.includes(`recorded start >= ${new Date(cutoff).toISOString()} and file mtime >=`), shown);
  assert.ok(shown.includes("(a session must pass both)"), shown);
  assert.equal(both.window.since, new Date(cutoff).toISOString());
  assert.equal(both.window.days, 1);
  assert.ok(both.window.mtimeSince !== null, "the days window is reported as the instant it resolved to");
  // Each filter alone keeps what the pair rejects, so the single session above
  // is the conjunction and not one filter doing all the work.
  assert.equal(scanSessions(dir, { since: cutoff }).population.sessions, 2);
  assert.equal(scanSessions(dir, { days: 1 }).population.sessions, 2);
});

test("an unparsable --since exits 2, names the value, and scans nothing", () => {
  const dir = clockCase("refuse");
  clockSession(dir, "reachable", at(-HOUR_MS));
  const values = ["next tuesday", "the last release", new Date(NOW).toISOString().slice(0, 4)];
  for (const value of values) {
    for (const extra of [[], ["--json"]]) {
      const result = runScanner(["--dir", dir, ...extra, "--since", value]);
      assert.equal(result.status, 2, `${value} exited ${result.status}: ${result.stderr}`);
      assert.equal(result.stdout, "", "no report is printed");
      assert.ok(result.stderr.includes(value), `the line names the value: ${result.stderr}`);
      assert.equal(result.stderr.trimEnd().split("\n").length, 1, `one line: ${result.stderr}`);
    }
  }
});

test("a log with no parsable start is excluded and counted, not silently kept", () => {
  const dir = clockCase("dateless");
  const cutoff = NOW - DAY_MS;
  const dateless = clockSession(dir, "dateless", "not a timestamp");
  const started = clockSession(dir, "started", at(-HOUR_MS));
  const scan = scanSessions(dir, { since: cutoff });
  assert.deepEqual(scan.sessions.map((s) => s.file), [started]);
  assert.equal(scan.population.sessionsWithoutStart, 1, "the excluded log is still counted");
  assert.ok(formatReport(scan).includes("logs without a parsable start: 1 (excluded)"), formatReport(scan));
  const unfiltered = scanSessions(dir);
  assert.equal(unfiltered.population.sessions, 2, "without the start clock the log is kept");
  assert.equal(unfiltered.population.sessionsWithoutStart, 1);
  assert.equal(unfiltered.sessions.find((s) => s.file === dateless).startedAtMs, null);
});

test("a --since in the future is legal and selects nothing", () => {
  const dir = clockCase("future");
  clockSession(dir, "started", at(-HOUR_MS));
  const future = new Date(NOW + 30 * DAY_MS).toISOString();
  const result = runScanner(["--dir", dir, "--since", future]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("sessions: 0 read from"), result.stdout);
  assert.ok(result.stdout.includes(`recorded start >= ${future}`), result.stdout);
});

test("the printed report carries the cutoff it used, in both output modes", () => {
  const dir = clockCase("window");
  clockSession(dir, "started", at(-HOUR_MS));
  const cutoff = new Date(NOW - DAY_MS).toISOString();
  const report = scanSessions(dir, { since: cutoff, days: 1 });
  const text = formatReport(report);
  assert.ok(text.startsWith(`window: recorded start >= ${cutoff} and file mtime >=`), text);
  assert.ok(text.includes("(--days 1)"), text);
  const printed = runScanner(["--dir", dir, "--since", cutoff]);
  assert.equal(printed.status, 0, printed.stderr);
  assert.ok(printed.stdout.includes(`recorded start >= ${cutoff}`), printed.stdout);
  assert.ok(printed.stdout.includes("sessions: 1 read from"), printed.stdout);
  const machine = JSON.parse(runScanner(["--dir", dir, "--since", cutoff, "--json"]).stdout);
  assert.equal(machine.window.since, cutoff, "the machine report names the same instant");
  assert.equal(machine.window.mtimeSince, null, "no mtime cutoff was given");
  assert.equal(machine.population.sessions, 1);
  const unfiltered = formatReport(scanSessions(dir));
  assert.ok(unfiltered.startsWith("window: no cutoff, whole sessions root"), unfiltered);
});

// ── 5. the instrument stays an instrument ─────────────────────────────────

test("no production file imports the scanner", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|mjs|js)$/.test(entry.name)) continue;
      const text = readFileSync(full, "utf8");
      if (/from\s+["'][^"']*session-scan/.test(text) || /import\(["'][^"']*session-scan/.test(text)) {
        offenders.push(full);
      }
    }
  };
  walk(join(CORE, "src"));
  assert.deepEqual(offenders, [], "the scanner must not be reachable from production code");
  assert.ok(statSync(join(__dirname, "session-scan.mjs")).isFile());
});

test("the thresholds are the declared constants, not magic numbers", () => {
  assert.equal(LONG_SESSION_CALLS, 20);
  assert.equal(THIN_PROMPT_CHARS, 120);
  // A prompt exactly at the threshold is not thin: "<" is the rule.
  const atThreshold = writeSession(GROUP, "h.jsonl", [
    sessionHeader("h"),
    user("x".repeat(THIN_PROMPT_CHARS)),
    assistant(Array.from({ length: 20 }, bash)),
  ]);
  const metrics = sessionMetrics(atThreshold);
  assert.equal(metrics.promptChars, THIN_PROMPT_CHARS);
  assert.equal(metrics.thin, false);
  assert.equal(metrics.long, true, "exactly the call threshold is long");
  rmSync(atThreshold);
});

// ── report ────────────────────────────────────────────────────────────────

console.log(`\n  scanner over the fixture root:\n${formatReport(report)}`);
rmSync(ROOT, { recursive: true, force: true });
rmSync(CLOCK, { recursive: true, force: true });

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
