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
 *   5. The instrument is not wired into the product: no file under `src/`
 *      imports it, so a metric can never change behavior.
 *
 * Run: node test/runtime/core/test-session-scan.mjs
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const sessionHeader = (id) => ({
  type: "session",
  version: 3,
  id,
  timestamp: "fixture",
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
  assert.ok(text.includes("M1 thin-prompt read rate: 1/2"), text);
  assert.ok(text.includes("M2 drift latency: 2 sessions"), text);
  assert.ok(text.includes("M3 injected surface:"), text);
});

// ── 4. the instrument stays an instrument ─────────────────────────────────

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

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
