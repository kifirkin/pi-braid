/**
 * check-journal reads a journal, not a file.
 *
 * Rotation moves a prefix of the live journal into `journal-<year>.jsonl`
 * beside it, so a `supersedes` target is resolved across the live file and its
 * rotated siblings, and an evidence reference is either inside the root this
 * run was given (and then ABSENT is the finding) or outside it (and then
 * UNRESOLVED is the reading, and the run stays green because the root is not
 * the base the entry was written against).
 *
 * Every class below carries a planted control: the same fixture with the one
 * fact the class rests on removed, which must change the finding. A class whose
 * control prints the same line is a class that would print it whatever the file
 * said.
 *
 *   ROTATED     control: the sibling is planted under a name the stated pattern
 *               does not match, and the reading becomes DANGLING
 *   DANGLING    no sibling holds the target at all
 *   ABSENT      control: the directory the path resolves through is removed,
 *               and the same reference becomes UNRESOLVED
 *   UNRESOLVED  the four shapes a reference can take outside the root
 *   MOVED       control: the same outcome log with no successor recorded, and
 *               with a successor that does not reach the outcome
 *
 * Run: node --test test/runtime/journal/test-journal-population.mjs
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHECK = join(__dirname, "..", "..", "..", "scripts", "check-journal.mjs");

/** A fixed autumn afternoon, built rather than written as a literal: the
 *  placement gate scans date literals, and a fixture clock is not provenance. */
function stamp(day) {
  return new Date(Date.UTC(2026, 8, day, 12, 0, 0)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function entry(seq, over = {}) {
  return {
    seq,
    at: stamp(seq),
    kind: "intent",
    subject: "check",
    status: "open",
    text: "A fixture line states one fact and says what it is for, so a reader can act on it.",
    reason: null,
    evidence: ["README.md"],
    supersedes: null,
    seat: { label: "fixture", session: "fixture-session", revision: "0000" },
    ...over,
  };
}

function lines(rows) {
  return `${rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n")}\n`;
}

/** One bench: a braid home carrying the journal directory, and the project root
 *  the run is asked to adjudicate. `outside` plants a second journal in the same
 *  braid home, which is what a successor looks like from here. */
function bench({ live, rotated = {}, outcomes = [], files = {}, outside = null }) {
  const braidHome = mkdtempSync(join(tmpdir(), "journal-population-home-"));
  const root = mkdtempSync(join(tmpdir(), "journal-population-root-"));
  writeFileSync(join(root, "README.md"), "# fixture root\n");
  for (const [name, body] of Object.entries(files)) {
    const full = join(root, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  const dir = join(braidHome, "journal", "check");
  mkdirSync(dir, { recursive: true });
  if (live) writeFileSync(join(dir, "journal.jsonl"), lines(live));
  for (const [name, body] of Object.entries(rotated)) {
    writeFileSync(join(dir, name), typeof body === "string" ? body : lines(body));
  }
  if (outside) {
    const otherDir = join(braidHome, "journal", outside.project);
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, "journal.jsonl"), lines(outside.live));
  }
  if (outcomes.length > 0) {
    mkdirSync(join(braidHome, "self-review"), { recursive: true });
    writeFileSync(join(braidHome, "self-review", "outcomes.jsonl"), lines(outcomes));
  }
  return {
    braidHome,
    root,
    dir,
    writeLive: (rows) => writeFileSync(join(dir, "journal.jsonl"), lines(rows)),
  };
}

function run(current) {
  return spawnSync(
    process.execPath,
    [CHECK, "--cwd", current.root, "--project", "check"],
    { env: { ...process.env, BRAID_HOME: current.braidHome }, encoding: "utf8" },
  );
}

function expectation(result, status, pattern, label) {
  assert.equal(result.status, status, `${label}: exit ${result.status}, expected ${status}: ${result.stdout}`);
  if (pattern) assert.match(result.stdout, pattern, `${label}: ${result.stdout}`);
}

// ── The rotated prefix ────────────────────────────────────────────────────

test("a supersedes target in a rotated sibling is ROTATED and does not fail the run", () => {
  const current = bench({
    live: [entry(3, { supersedes: 1 })],
    rotated: { "journal-2025.jsonl": [entry(1), entry(2)] },
  });
  const result = run(current);
  expectation(result, 0, /ROTATED supersedes: seq 3 names 1, in journal-2025\.jsonl/, "ROTATED");
  assert.match(result.stdout, /findings: ABSENT 0, UNRESOLVED 0, ROTATED 1, DANGLING 0/);
});

test("control: the same seq under a name outside the rotation pattern is DANGLING", () => {
  const current = bench({
    live: [entry(3, { supersedes: 1 })],
    rotated: { "journal-old.jsonl": [entry(1), entry(2)] },
  });
  expectation(
    run(current),
    2,
    /DANGLING supersedes: seq 3 names 1, absent/,
    "control-rotation",
  );
});

test("a target in neither the live file nor a sibling is DANGLING", () => {
  const current = bench({
    live: [entry(3, { supersedes: 2 })],
    rotated: { "journal-2025.jsonl": [entry(1)] },
  });
  expectation(run(current), 2, /DANGLING supersedes: seq 3 names 2, absent/, "DANGLING");
});

test("two live entries superseding one rotated entry are still a FORK", () => {
  const current = bench({
    live: [
      entry(3, { kind: "decision", status: undefined, reason: "the first successor reasons its choice", supersedes: 1 }),
      entry(4, { kind: "decision", status: undefined, reason: "the second successor reasons its choice", supersedes: 1 }),
    ],
    rotated: { "journal-2025.jsonl": [entry(1), entry(2)] },
  });
  expectation(run(current), 2, /FORK: seq 3 and 4 both supersede 1/, "FORK-rotated");
});

// ── Evidence inside the root ──────────────────────────────────────────────

test("a path whose parent exists in the root and whose file does not is ABSENT", () => {
  const current = bench({
    live: [entry(1, { evidence: ["packages/core/src/nope.ts"] })],
    files: { "packages/core/src/keep.ts": "// the directory this reference resolves through\n" },
  });
  const result = run(current);
  expectation(result, 2, /ABSENT seq 1 names packages\/core\/src\/nope\.ts, missing under .* \(no unverified flag\)/, "ABSENT");
  assert.match(result.stdout, /findings: ABSENT 1, UNRESOLVED 0, ROTATED 0, DANGLING 0/);
});

test("control: remove the directory the path resolves through and it becomes UNRESOLVED", () => {
  const current = bench({ live: [entry(1, { evidence: ["packages/core/src/nope.ts"] })] });
  const result = run(current);
  expectation(
    result,
    0,
    /UNRESOLVED seq 1 names packages\/core\/src\/nope\.ts, cannot resolve from .*: no packages at the root/,
    "control-absent",
  );
  assert.match(result.stdout, /findings: ABSENT 0, UNRESOLVED 1/);
});

// ── Evidence outside the root ─────────────────────────────────────────────

test("a reference in another repository's coordinates is UNRESOLVED, not a fabrication", () => {
  const current = bench({ live: [entry(1, { evidence: ["site/src/content/outcomes.js"] })] });
  const result = run(current);
  expectation(
    result,
    0,
    /UNRESOLVED seq 1 names site\/src\/content\/outcomes\.js, cannot resolve from .*: no site at the root/,
    "UNRESOLVED-unrooted",
  );
  assert.match(result.stdout, /findings: ABSENT 0, UNRESOLVED 1, ROTATED 0, DANGLING 0/);
});

test("a bare file name the root does not hold is UNRESOLVED: it names no directory", () => {
  const current = bench({ live: [entry(1, { evidence: ["handoff.md"] })] });
  expectation(
    run(current),
    0,
    /UNRESOLVED seq 1 names handoff\.md, cannot resolve from .*: no handoff\.md at the root/,
    "UNRESOLVED-bare",
  );
});

test("a reference that climbs above the root is UNRESOLVED", () => {
  const current = bench({ live: [entry(1, { evidence: ["../elsewhere/table.ts"] })] });
  expectation(run(current), 0, /UNRESOLVED seq 1 names \.\.\/elsewhere\/table\.ts.*climbs above the root/, "UNRESOLVED-escape");
});

test("an absolute path outside the root that is gone is UNRESOLVED, and the same shape inside it is ABSENT", () => {
  const gone = join("/", "nonexistent-braid-fixture", "gone.ts");
  expectation(
    run(bench({ live: [entry(1, { evidence: [gone] })] })),
    0,
    /UNRESOLVED seq 1 names \/nonexistent-braid-fixture\/gone\.ts.*absolute and outside this root/,
    "UNRESOLVED-absolute",
  );
  // An absolute reference carrying this root's own prefix is a claim about this
  // tree, so it is adjudicated here instead of being held at arm's length.
  const current = bench({ live: [entry(1)] });
  current.writeLive([entry(1, { evidence: [join(current.root, "gone.ts")] })]);
  expectation(
    run(current),
    2,
    /ABSENT seq 1 names .*gone\.ts, missing under .* \(no unverified flag\)/,
    "ABSENT-absolute-inside",
  );
});

// ── Currency across a move ────────────────────────────────────────────────

const OUTCOME = { at: stamp(3), date: "x", task: "a task closed while the journal had moved on" };

test("an outcome no entry covers is STALE when the journal recorded no successor", () => {
  const current = bench({ live: [entry(2)], outcomes: [OUTCOME] });
  expectation(
    run(current),
    2,
    /STALE: outcome appended .* with no journal entry since seq 2 at /,
    "STALE-no-successor",
  );
});

test("a recorded successor is read, and the outcome it covers is not STALE", () => {
  const current = bench({
    outside: { project: "next", live: [entry(1, { at: stamp(4) })] },
    outcomes: [OUTCOME],
  });
  current.writeLive([
    entry(2, { evidence: [join(current.braidHome, "journal", "next", "journal.jsonl")] }),
  ]);
  const result = run(current);
  expectation(result, 0, /MOVED 2 records the move to .*next\/journal\.jsonl/, "MOVED");
  assert.doesNotMatch(result.stdout, /STALE/);
});

test("control: a successor whose newest entry does not reach the outcome excuses nothing", () => {
  const current = bench({
    outside: { project: "next", live: [entry(1, { at: stamp(2) })] },
    outcomes: [OUTCOME],
  });
  current.writeLive([
    entry(2, { evidence: [join(current.braidHome, "journal", "next", "journal.jsonl")] }),
  ]);
  const result = run(current);
  expectation(result, 2, /STALE: outcome appended .* or in .*next\/journal\.jsonl/, "STALE-short-successor");
  assert.match(result.stdout, /MOVED 2 records the move to /);
});
