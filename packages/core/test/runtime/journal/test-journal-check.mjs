/**
 * check-journal: the structural and currency instrument.
 *
 * The seat writes the journal about its own honesty, so this program reads the
 * file with its own parser and its own schema rather than reusing the writer's
 * validator. Each case below is one exit-2 shape the design specifies, crafted
 * as a raw line so the failure is in the file and not in the writer: a
 * duplicate seq, a regression, a decision with no reason, a constraint with no
 * expiry, a dangling supersedes, a fork, an evidence path that does not
 * resolve, an empty evidence list without the flag, an unparseable timestamp,
 * an archive boundary that overlaps the live file, and an outcome line newer
 * than every journal entry.
 *
 * The two clean cases matter as much as the failures: a well-formed journal
 * exits 0, and an unverified entry is allowed to carry no evidence. A checker
 * that fails everything guards nothing.
 *
 * Run: node test/runtime/journal/test-journal-check.mjs
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHECK = join(__dirname, "..", "..", "..", "scripts", "check-journal.mjs");

console.log("check-journal test\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (err) {
    console.log(` [x] ${name}: ${err.message}`);
    failed++;
  }
}

/** A fixed September afternoon, built rather than written as a literal: the
 *  repository's placement gate scans date literals, and a fixture clock is not
 *  provenance. */
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

function run({ lines, outcomes, archives = {}, digest = false, home }) {
  const braidHome = home ?? mkdtempSync(join(tmpdir(), "journal-check-braid-"));
  const project = mkdtempSync(join(tmpdir(), "journal-check-proj-"));
  writeFileSync(join(project, "README.md"), "# fixture project\n");
  const dir = join(braidHome, "journal", "check");
  mkdirSync(dir, { recursive: true });
  if (lines) {
    const body = lines
      .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
      .join("\n");
    writeFileSync(join(dir, "journal.jsonl"), `${body}\n`);
  }
  for (const [name, body] of Object.entries(archives)) writeFileSync(join(dir, name), body);
  if (outcomes) {
    mkdirSync(join(braidHome, "self-review"), { recursive: true });
    writeFileSync(
      join(braidHome, "self-review", "outcomes.jsonl"),
      `${outcomes.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
  }
  const result = spawnSync(
    process.execPath,
    [CHECK, "--cwd", project, "--project", "check", ...(digest ? ["--digest"] : [])],
    { env: { ...process.env, BRAID_HOME: braidHome }, encoding: "utf8" },
  );
  return result;
}

function expectFinding(result, pattern, label) {
  assert.equal(result.status, 2, `${label}: expected exit 2, got ${result.status}: ${result.stdout}`);
  assert.match(result.stdout, pattern, `${label}: ${result.stdout}`);
}

// ── Clean ─────────────────────────────────────────────────────────────────

test("a well-formed journal exits 0 with a population line", () => {
  const result = run({ lines: [entry(1), entry(2)] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /journal .*: 2 entries, seq to 2, 1 subject; outcomes absent/);
});

test("an unverified entry may carry no evidence", () => {
  const result = run({ lines: [entry(1, { evidence: [], unverified: true })] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

// ── Instrument A ──────────────────────────────────────────────────────────

test("a line that is not JSON is LINE", () => {
  expectFinding(run({ lines: ["{not json", entry(2)] }), /LINE 1: not JSON/, "LINE");
});

test("a duplicate seq is DUP", () => {
  expectFinding(run({ lines: [entry(1), entry(1)] }), /DUP seq 1/, "DUP");
});

test("a seq regression is ORDER", () => {
  expectFinding(run({ lines: [entry(2), entry(1)] }), /ORDER seq 1 follows 2/, "ORDER");
});

test("a decision without reason is FIELDS", () => {
  expectFinding(
    run({ lines: [entry(1, { kind: "decision", status: undefined, reason: null })] }),
    /decision without reason/,
    "FIELDS-decision",
  );
});

test("a constraint without expires_at is FIELDS", () => {
  expectFinding(
    run({ lines: [entry(1, { kind: "constraint", expires_at: undefined })] }),
    /constraint without expires_at/,
    "FIELDS-constraint",
  );
});

test("an unknown kind is FIELDS", () => {
  expectFinding(run({ lines: [entry(1, { kind: "task" })] }), /unknown kind "task"/, "FIELDS-kind");
});

test("an unparseable at is TIME", () => {
  expectFinding(run({ lines: [entry(1, { at: "yesterday" })] }), /TIME seq 1: at .* is not/, "TIME");
});

test("evidence [] without unverified is EVIDENCE", () => {
  expectFinding(
    run({ lines: [entry(1, { evidence: [] })] }),
    /EVIDENCE: seq 1 evidence \[\] without unverified/,
    "EVIDENCE-empty",
  );
});

test("a repo-relative evidence path that does not resolve is EVIDENCE", () => {
  expectFinding(
    run({ lines: [entry(1, { evidence: ["packages/core/src/nope.ts"] })] }),
    /EVIDENCE: seq 1 names packages\/core\/src\/nope\.ts, absent \(no unverified flag\)/,
    "EVIDENCE-absent",
  );
});

test("a supersedes naming an absent seq is DANGLING", () => {
  expectFinding(
    run({ lines: [entry(1, { supersedes: 9 })] }),
    /DANGLING supersedes: seq 1 names 9, absent/,
    "DANGLING",
  );
});

test("a supersedes naming a later entry is DANGLING as a forward reference", () => {
  expectFinding(
    run({ lines: [entry(1, { supersedes: 5 }), entry(5)] }),
    /DANGLING supersedes: seq 1 names 5, forward/,
    "DANGLING-forward",
  );
});

test("a supersedes naming its own seq is DANGLING", () => {
  expectFinding(
    run({ lines: [entry(1, { supersedes: 1 })] }),
    /DANGLING supersedes: seq 1 names itself/,
    "DANGLING-self",
  );
});

test("two entries superseding one are FORK", () => {
  const lines = [
    entry(1),
    entry(2, { kind: "decision", status: undefined, reason: "the first successor reasons its choice", supersedes: 1 }),
    entry(3, { kind: "decision", status: undefined, reason: "the second successor reasons its choice", supersedes: 1 }),
  ];
  expectFinding(run({ lines }), /FORK: seq 2 and 3 both supersede 1/, "FORK");
});

test("an archive whose last seq reaches the live file is ARCHIVE", () => {
  const archive = `${JSON.stringify(entry(5))}\n${JSON.stringify(entry(6))}\n`;
  expectFinding(
    run({ lines: [entry(3)], archives: { "journal-2025.jsonl": archive } }),
    /ARCHIVE: journal-2025\.jsonl ends at seq 6, live file starts at 3/,
    "ARCHIVE",
  );
});

// ── Instrument B ──────────────────────────────────────────────────────────

test("an outcome newer than every journal entry is STALE", () => {
  const result = run({
    lines: [entry(1)],
    outcomes: [{ at: stamp(2), date: "x", task: "a task closed with no journal entry for it" }],
  });
  expectFinding(result, /STALE: outcome appended .* with no journal entry since seq 1 at .*/, "STALE");
});

test("an outcome older than the newest entry is current", () => {
  const result = run({
    lines: [entry(2)],
    outcomes: [{ at: stamp(1), date: "x", task: "a task closed before the journal entry" }],
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /outcomes current as of/);
});

test("deleting the newest line reddens the next check: the close is now unjournalled", () => {
  const home = mkdtempSync(join(tmpdir(), "journal-check-braid-"));
  const outcomes = [{ at: stamp(2), date: "x", task: "closed with the entry for it on disk" }];
  const before = run({ lines: [entry(1), entry(2)], outcomes, home });
  assert.equal(before.status, 0, before.stdout + before.stderr);
  const after = run({ lines: [entry(1)], outcomes, home });
  assert.equal(after.status, 2, after.stdout);
  assert.match(
    after.stdout,
    /STALE: outcome appended .* with no journal entry since seq 1 at .*/,
    after.stdout,
  );
});

test("an outcome with no journal at all is STALE", () => {
  expectFinding(
    run({ outcomes: [{ at: stamp(3), task: "nothing was journalled" }] }),
    /STALE: outcome appended .* with no journal entry \(journal empty\)/,
    "STALE-empty",
  );
});

// ── The digest ────────────────────────────────────────────────────────────

test("the digest prints an open subject's newest decision", () => {
  const lines = [
    entry(1, { subject: "alpha" }),
    entry(2, {
      subject: "alpha",
      kind: "decision",
      status: undefined,
      reason: "the fixture needed a decision line to read back",
      text: "Alpha keeps its open intention and gains the decision that explains it.",
    }),
  ];
  const result = run({ lines, digest: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /#1 intent\/open alpha:/);
  assert.match(result.stdout, /decision #2: .*\(because: the fixture needed a decision line to read back\)/);
});

test("the digest stops reading a superseded intention as open", () => {
  const lines = [
    entry(1, { subject: "beta" }),
    entry(2, {
      subject: "beta",
      kind: "decision",
      status: undefined,
      reason: "the intention was replaced rather than rewritten",
      supersedes: 1,
    }),
  ];
  const result = run({ lines, digest: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /#1 intent\/open beta:/);
});

console.log(`\n Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
