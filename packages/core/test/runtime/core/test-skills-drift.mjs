/**
 * Skills drift trigger — the floor's re-point when the work moves.
 *
 * The floor puts the catalog in the prompt against the task text in view. A
 * resumed session's first prompt says "continue" in one directory and the
 * work then happens in another; the catalog stays in the prompt and the
 * signal stays away from it. The trigger adds one line when the session's
 * own path-taking calls name a new work area.
 *
 * Contract:
 *   1. A work area is the first two directory segments of a path-taking
 *      call's path, relative to the session's project root. Paths outside the
 *      project, paths with fewer than two directory segments (repo-root
 *      files, top-level directories), and tools that take no path never
 *      name one.
 *   2. Two entries in one work area count as where the work is; one is a
 *      stray read.
 *   3. At most one fire per window of tool calls, at most three per session,
 *      and no fire until the same window has passed since the last skill
 *      surface (a delivered suggestion or a detected SKILL.md read), because
 *      a surface that just landed is the pointer the trigger exists to
 *      supply.
 *   4. A work area is announced once, and the entry counts restart after a
 *      fire, so the budget is spent on areas the session has not been told
 *      about.
 *   5. A fire is spent only when the line was accepted for delivery: the
 *      decision returns the target, delivery happens, and the bookkeeping
 *      follows. A suppressed line drops its counts and retries later.
 *   6. The literal is one line naming the work area and pointing at the
 *      catalog. The path clause comes from the same derivation the floor
 *      uses and is dropped when the catalog has no single root, so the line
 *      never names a path that may not resolve.
 *   7. Nothing about a particular repository is baked in: no directory name,
 *      no owner path, no skill name.
 *
 * Run: node test/runtime/core/test-skills-drift.mjs
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE = join(__dirname, "..", "..", "..");
const DIST = join(CORE, "dist", "extensions", "core", "skills-tool");

const {
  advanceDrift,
  driftDirectoryFor,
  driftPayload,
  initialDrift,
  noteDriftSurface,
  recordDriftDrop,
  recordDriftFire,
  DRIFT_ENTRIES,
  DRIFT_MAX_FIRES,
  DRIFT_WINDOW_CALLS,
} = await import(join(DIST, "loading-guidance.js"));

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

const CWD = "/project";

/** The work area a call names, as the handler derives it. */
function area(tool, path) {
  return driftDirectoryFor(tool, path, CWD);
}

// ── 1. what a call says about where the work is ───────────────────────────

test("the work area is the first two directory segments", () => {
  assert.equal(area("read", "app/web/src/pages/index.astro"), "app/web");
  assert.equal(area("edit", "app/api/src/routes.ts"), "app/api");
  assert.equal(area("write", "/project/docs/ru/guide.md"), "docs/ru");
  assert.equal(area("read", "packages/core/src/index.ts"), "packages/core");
});

test("repo-root files and top-level directories name no work area", () => {
  assert.equal(area("read", "README.md"), undefined);
  assert.equal(area("write", "/project/package.json"), undefined);
  assert.equal(area("read", "notes/to-self.md"), undefined);
});

test("only the path-taking tools are consulted", () => {
  for (const tool of ["bash", "list_skills", "grep", "document_parse"]) {
    assert.equal(area(tool, "app/web/src/index.astro"), undefined, tool);
  }
  assert.equal(area("read", undefined), undefined, "a path-less read");
});

test("a path outside the project names no work area", () => {
  assert.equal(area("read", "/elsewhere/app/web/src/index.astro"), undefined);
  assert.equal(area("read", "../sibling/app/web/src/index.astro"), undefined);
});

// ── 2. the decision ────────────────────────────────────────────────────────

test("two entries in one work area fire; one is a stray read", () => {
  const tracker = initialDrift();
  assert.equal(advanceDrift(tracker, "app/web"), null, "first entry is not a drift");
  assert.equal(advanceDrift(tracker, undefined), null, "a non-path call changes nothing");
  assert.equal(advanceDrift(tracker, "app/web"), "app/web", "second entry is the drift");
});

test("a fire restarts the counts and the clock", () => {
  const tracker = initialDrift();
  advanceDrift(tracker, "app/web");
  assert.equal(advanceDrift(tracker, "app/web"), "app/web");
  recordDriftFire(tracker, "app/web");
  assert.equal(tracker.fires, 1);
  assert.deepEqual(tracker.entries, {}, "counts restart");
  assert.equal(advanceDrift(tracker, "app/web"), null, "one entry after a fire is a stray read");
});

test("a suppressed line drops its counts and spends no fire", () => {
  const tracker = initialDrift();
  advanceDrift(tracker, "app/web");
  assert.equal(advanceDrift(tracker, "app/web"), "app/web");
  recordDriftDrop(tracker);
  assert.equal(tracker.fires, 0, "no fire was spent");
  assert.deepEqual(tracker.announced, [], "nothing was announced");
  assert.deepEqual(tracker.entries, {}, "the counts restart, so the line is not retried per call");
});

test("an announced work area is never announced again", () => {
  const tracker = initialDrift();
  advanceDrift(tracker, "app/web");
  advanceDrift(tracker, "app/web");
  recordDriftFire(tracker, "app/web");
  // Open the window, then qualify the same area again.
  for (let i = 0; i < DRIFT_WINDOW_CALLS + 2; i++) advanceDrift(tracker, "app/api");
  advanceDrift(tracker, "app/web");
  assert.equal(advanceDrift(tracker, "app/web"), null, "the area was already named");
});

// ── 3. the guards ─────────────────────────────────────────────────────────

test("the window between fires holds", () => {
  const tracker = initialDrift();
  advanceDrift(tracker, "app/web");
  advanceDrift(tracker, "app/web");
  recordDriftFire(tracker, "app/web");
  const limit = tracker.calls + DRIFT_WINDOW_CALLS + 2;
  let firedAt = null;
  while (tracker.calls < limit) {
    if (advanceDrift(tracker, "app/api") && firedAt === null) firedAt = tracker.calls;
  }
  assert.equal(
    firedAt,
    2 + DRIFT_WINDOW_CALLS,
    `the second fire must wait ${DRIFT_WINDOW_CALLS} calls`,
  );
});

test("a skill surface holds the trigger quiet for the window", () => {
  const tracker = initialDrift();
  noteDriftSurface(tracker);
  advanceDrift(tracker, "app/web");
  const first = advanceDrift(tracker, "app/web");
  assert.equal(first, null, "two entries are not enough inside the quiet window");
  let firedAt = null;
  while (firedAt === null && tracker.calls < 40) {
    if (advanceDrift(tracker, "app/web")) firedAt = tracker.calls;
  }
  assert.equal(firedAt, DRIFT_WINDOW_CALLS, "the fire waits exactly the window after a surface");
});

test(`at most ${DRIFT_MAX_FIRES} fires a session`, () => {
  const tracker = initialDrift();
  const fired = [];
  for (const dir of ["app/web", "app/api", "docs/ru", "tools/cli"]) {
    for (let i = 0; i < DRIFT_WINDOW_CALLS + 2; i++) advanceDrift(tracker, dir);
    advanceDrift(tracker, dir);
    if (advanceDrift(tracker, dir)) {
      recordDriftFire(tracker, dir);
      fired.push(dir);
    }
  }
  assert.equal(fired.length, DRIFT_MAX_FIRES, `fired ${fired.join(", ")}`);
  assert.equal(tracker.fires, DRIFT_MAX_FIRES);
});

// ── 4. the fixed sequence ─────────────────────────────────────────────────

/**
 * A scripted session, one entry per tool call. Filler calls take no path; a
 * `surface` entry lands a skill surface on that call. The expectation table
 * below is written by hand from the rules, not from the implementation's
 * output.
 */
const SEQUENCE = [
  ["read", "app/web/src/x.ts"], // 1
  ["edit", "app/web/src/y.ts"], // 2  fire 1: app/web (two entries)
  ...Array.from({ length: 11 }, () => ["read", "app/api/src/x.ts"]), // 3..13
  ["read", "app/api/src/y.ts"], // 14 fire 2: app/api (12 calls after call 2)
  ...Array.from({ length: 13 }, () => ["bash"]), // 15..27
  ["read", "app/web/src/z.ts"], // 28
  ["write", "app/web/src/w.ts"], // 29 already announced: no fire
  ...Array.from({ length: 5 }, () => ["bash"]), // 30..34, a surface lands on 30
  ["read", "docs/ru/x.md"], // 35
  ["read", "docs/ru/y.md"], // 36 inside the surface window: no fire
  ...Array.from({ length: 6 }, () => ["bash"]), // 37..42
  ["read", "docs/ru/z.md"], // 43 fire 3: docs/ru (12 calls after the surface on 30)
  ...Array.from({ length: 15 }, () => ["bash"]), // 44..58
  ["read", "tools/cli/x.ts"], // 59
  ["read", "tools/cli/y.ts"], // 60 session cap spent: no fire
];

const EXPECTED_FIRES = [
  [2, "app/web"],
  [14, "app/api"],
  [43, "docs/ru"],
];

test("the fixed sequence fires exactly where the rules say, and nowhere else", () => {
  const tracker = initialDrift();
  const fired = [];
  SEQUENCE.forEach(([tool, path], index) => {
    const call = index + 1;
    const target = advanceDrift(tracker, area(tool, path));
    if (call === 30) noteDriftSurface(tracker); // a suggestion was delivered here
    if (!target) return;
    fired.push([call, target]);
    recordDriftFire(tracker, target);
  });
  assert.deepEqual(fired, EXPECTED_FIRES, `fired ${JSON.stringify(fired)}`);
  assert.equal(tracker.fires, DRIFT_MAX_FIRES);
  assert.equal(DRIFT_ENTRIES, 2, "the sequence is written against two entries");
});

// ── 5. the line ───────────────────────────────────────────────────────────

test("the line names the work area and points at the catalog", () => {
  const line = driftPayload("app/web", "/packs/skills");
  assert.equal(
    line,
    "[SKILL INDEX] work is in app/web. Catalog above; read `/packs/skills/<name>/SKILL.md`.",
  );
  assert.equal(line.split("\n").length, 1, "one line");
  assert.ok(Buffer.byteLength(line, "utf8") < 160, "a whisper, not a report");
});

test("with no single catalog root the path clause is dropped, not guessed", () => {
  const line = driftPayload("app/web", "");
  assert.equal(
    line,
    "[SKILL INDEX] work is in app/web. Catalog above; read the matching skill's SKILL.md.",
  );
});

// ── 6. nothing repository-specific ────────────────────────────────────────

test("no directory name, owner path, or skill name is baked into the trigger", () => {
  const sources = ["loading-guidance.js", "auto-inject.js"].map((file) =>
    readFileSync(join(DIST, file), "utf8"),
  );
  const forbidden = [
    "app/web",
    "app/api",
    "docs/ru",
    "tools/cli",
    "/Users/",
    "/home/",
    "pane-topology",
    "tone-quality",
    "placement-discipline",
  ];
  for (const source of sources) {
    for (const token of forbidden) {
      assert.ok(!source.includes(token), `the module names ${token}`);
    }
  }
});

// ── report ────────────────────────────────────────────────────────────────

console.log(
  `\n  trigger: ${DRIFT_ENTRIES} entries, ${DRIFT_WINDOW_CALLS}-call window, ${DRIFT_MAX_FIRES} fires a session`,
);
console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
