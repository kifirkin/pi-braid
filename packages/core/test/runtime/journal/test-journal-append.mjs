/**
 * journal-append: the writer owns what the agent must not.
 *
 * The failure this guards is the diary: a journal whose writer accepts the
 * agent's sequence numbers, timestamps and provenance records what the agent
 * felt like saying in the order it preferred. So each case below is a refusal
 * the writer must make (seq at or below the maximum, a decision without its
 * reason, a constraint with no expiry, evidence [] without the unverified
 * flag, a payload naming its own seat or time) plus the one write the design
 * does require: supersession changes what a subject means without touching a
 * byte of the line it supersedes.
 *
 * The cross-piece case at the end runs the checker over the writer's own
 * output: the two programs are written apart on purpose, so their agreement is
 * a property worth asserting rather than assuming.
 *
 * Run: node test/runtime/journal/test-journal-append.mjs
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, "..", "..", "..");
const APPEND = join(PKG, "scripts", "journal-append.mjs");
const CHECK = join(PKG, "scripts", "check-journal.mjs");

// Isolation before any dist import: BRAID_HOME decides where the journal is,
// and this fixture must never reach a seat's real one.
process.env.BRAID_HOME = mkdtempSync(join(tmpdir(), "journal-append-braid-"));
const PROJECT = mkdtempSync(join(tmpdir(), "journal-append-proj-"));
const SLUG = "append-fixture";
writeFileSync(join(PROJECT, "README.md"), "# fixture project\n");

const { journalFilePath } = await import(
  new URL("../../../dist/lib/config/braid-paths.js", import.meta.url).href
);
const JOURNAL = journalFilePath(SLUG);

console.log("journal-append test\n");

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

function append(payload, extra = []) {
  const result = spawnSync(
    process.execPath,
    [APPEND, "--cwd", PROJECT, "--project", SLUG, ...extra],
    {
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      env: {
        ...process.env,
        BRAID_HOME: process.env.BRAID_HOME,
        PI_SESSION_FILE: "",
        PI_SESSION_ID: "append-fixture-seat",
      },
      encoding: "utf8",
    },
  );
  return result;
}

function lineCount() {
  if (!existsSync(JOURNAL)) return 0;
  return readFileSync(JOURNAL, "utf8").split("\n").filter((line) => line.trim()).length;
}

function intent(over = {}) {
  return {
    kind: "intent",
    subject: "fixture",
    status: "open",
    text: "The fixture writes an intention it can act on, before the action it authorises.",
    evidence: ["README.md"],
    ...over,
  };
}

function tomorrow() {
  return new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ── The happy path, and the tool-owned fields ─────────────────────────────

test("a valid intent is written, printed, and numbered from one", () => {
  const result = append(intent());
  assert.equal(result.status, 0, result.stderr);
  const entry = JSON.parse(result.stdout);
  assert.equal(entry.seq, 1);
  assert.equal(entry.kind, "intent");
  assert.equal(entry.status, "open");
  assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(entry.seat.session, "append-fixture-seat");
  assert.equal(lineCount(), 1);
});

test("seq is assigned monotonically by the writer", () => {
  const entry = JSON.parse(append(intent()).stdout);
  assert.equal(entry.seq, 2);
});

test("a payload naming its own at is refused", () => {
  const result = append(intent({ at: "2026-01-01T00:00:00Z" }));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /at is written by the tool/);
});

test("a payload naming its own seat is refused", () => {
  const result = append(
    intent({ seat: { label: "pretend", session: "pretend", revision: "pretend" } }),
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /seat is written by the tool/);
});

// ── Sequence: regression and duplicate ────────────────────────────────────

test("a seq regression is refused and nothing is written", () => {
  const before = lineCount();
  const result = append(intent({ seq: 1, unverified: true, evidence: [] }));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /seq 1 at or below the current maximum 2/);
  assert.equal(lineCount(), before);
});

test("a duplicate seq is refused by the same rule", () => {
  const result = append(intent({ seq: 2, unverified: true, evidence: [] }));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /at or below the current maximum/);
});

// ── Kind determines fields, and absence is a refusal ──────────────────────

test("an unknown kind is refused", () => {
  const result = append(intent({ kind: "task" }));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown kind "task"/);
});

test("a decision without reason is refused", () => {
  const result = append({ kind: "decision", subject: "fixture", text: "A decision is a judgement: the reason is the part a later seat re-reads.", evidence: ["README.md"] });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /decision without reason/);
});

test("a constraint without expires_at is refused", () => {
  const result = append({ kind: "constraint", subject: "fixture", status: "open", text: "A constraint with no expiry is a preference that never expires.", evidence: ["README.md"] });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /constraint without expires_at/);
});

test("evidence [] without unverified is refused", () => {
  const result = append(intent({ evidence: [] }));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /evidence \[\] requires unverified: true/);
});

test("evidence [] with unverified is accepted, and the flag lands in the line", () => {
  const result = append(intent({ subject: "unverified", evidence: [], unverified: true }));
  assert.equal(result.status, 0, result.stderr);
  const entry = JSON.parse(result.stdout);
  assert.equal(entry.unverified, true);
  assert.deepEqual(entry.evidence, []);
});

test("a field of the wrong kind is refused, not ignored", () => {
  const result = append(intent({ reason: "an intent has no reason field" }));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /reason is not a field of intent/);
});

test("an already-due expiry is refused", () => {
  const result = append({
    kind: "constraint",
    subject: "fixture",
    status: "open",
    text: "A constraint that is already due is a note, and the writer says so.",
    evidence: ["README.md"],
    expires_at: "2020-01-01T00:00:00Z",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /expires_at .* is not in the future/);
});

// ── Supersession: the earlier line is never rewritten ─────────────────────

test("supersession appends, leaves the earlier line byte-identical, and changes the subject", () => {
  const prior = JSON.parse(
    append(intent({ subject: "gate", text: "The gate stays off until the fixture measures it, so no rule ships unmeasured." })).stdout,
  );
  const before = readFileSync(JOURNAL, "utf8");
  const successor = JSON.parse(
    append({
      kind: "decision",
      subject: "gate",
      text: "The gate now ships on, because the fixture that measured it is in the suite.",
      reason: "The measurement it was waiting for exists at the revision that lands it.",
      evidence: ["README.md"],
      supersedes: prior.seq,
    }).stdout,
  );
  const after = readFileSync(JOURNAL, "utf8");
  assert.ok(after.startsWith(before), "the append must be a pure suffix");
  assert.equal(after.slice(0, before.length), before, "the earlier line must be byte-identical");

  const digest = spawnSync(
    process.execPath,
    [CHECK, "--cwd", PROJECT, "--project", SLUG, "--digest"],
    { env: { ...process.env, BRAID_HOME: process.env.BRAID_HOME }, encoding: "utf8" },
  );
  assert.equal(digest.status, 0, digest.stdout + digest.stderr);
  assert.doesNotMatch(
    digest.stdout,
    new RegExp(`#${prior.seq} intent/open gate:`),
    "the superseded intention must stop reading as open",
  );
  assert.equal(successor.supersedes, prior.seq);
});

// ── Linkage the writer refuses to create ──────────────────────────────────

test("supersedes naming an absent seq is refused", () => {
  const result = append(intent({ supersedes: 999, evidence: ["README.md"] }));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /supersedes names 999, which is not in the journal/);
});

test("a fork is refused: one entry cannot have two live successors", () => {
  const target = JSON.parse(append(intent({ subject: "fork" })).stdout);
  append({
    kind: "decision",
    subject: "fork",
    text: "The first successor is the one the journal keeps, so a second is a fork.",
    reason: "Two live successors would make the derived status a coin toss.",
    evidence: ["README.md"],
    supersedes: target.seq,
  });
  const fork = append({
    kind: "decision",
    subject: "fork",
    text: "The second successor arrives late and is refused rather than overwriting.",
    reason: "A single successor is what makes the earlier line's meaning decidable.",
    evidence: ["README.md"],
    supersedes: target.seq,
  });
  assert.equal(fork.status, 2);
  assert.match(fork.stderr, /supersedes \d+ was already superseded by \d+: a fork leaves two live successors/);
});

// ── The two programs agree ────────────────────────────────────────────────

test("the checker accepts the writer's journal", () => {
  const result = spawnSync(
    process.execPath,
    [CHECK, "--cwd", PROJECT, "--project", SLUG],
    { env: { ...process.env, BRAID_HOME: process.env.BRAID_HOME }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /journal .*: \d+ entr(?:y|ies), seq to \d+/);
});

console.log(`\n Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
