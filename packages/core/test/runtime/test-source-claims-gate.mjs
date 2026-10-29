/**
 * The source-claims gate re-derives the counts a document states.
 *
 * A bench tree carries a document, the file its command reads, and a registry
 * written per case, so each case states one thing about the gate and nothing
 * about the repository's own documents. Over that bench:
 *
 *   - a count the command reproduces passes, and the summary says what it
 *     re-derived;
 *   - a count the tree contradicts fails, naming the file, the line, both
 *     numbers and the command that produced the second one;
 *   - a stale entry beside a true one fails alone: the true entry is verified
 *     and never reported, so one problem does not mask the rest;
 *   - a command that cannot run is refused, not skipped, which is the failure a
 *     gate that passed over what it could not execute would print green
 *     through;
 *   - a command that exits 0 without printing a number is refused the same way;
 *   - a claim that moved off its recorded line is reported with the line it is
 *     actually on;
 *   - an entry with no command is refused as malformed rather than read as
 *     nothing to do;
 *   - a registry that enrolls nothing is refused, because it would print green
 *     over any document at all.
 *
 * Finally the gate is run over the repository's own registry, where it must
 * pass, so a registry that has drifted from the documents it governs cannot sit
 * behind a green bench.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..", "..");
const GATE = join(packageRoot, "scripts", "check-source-claims.mjs");

const DOC = "# Bench\n\nThe bench holds 2 rows.\n";
const TALLY = "alpha\nbeta\n";

/** One claim that the bench's tally reproduces. */
const TRUE_ENTRY = {
  id: "bench-rows",
  claim: "how many rows the bench tally holds",
  stated: { file: "doc.md", line: 3, pattern: "holds (\\S+) rows" },
  derived: { cmd: "awk 'END{print NR}' tally.txt", pattern: "^(\\d+)$" },
};

/**
 * A bench tree with its registry: `doc.md` states the bench's row count on line
 * 3, `tally.txt` is the file the command reads, and `doc2.md` gives the
 * multi-entry case a second document to point at.
 */
function bench(claims, { doc = DOC, doc2 = "doc2 records 2 rows.\n" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "source-claims-"));
  writeFileSync(join(dir, "doc.md"), doc);
  writeFileSync(join(dir, "doc2.md"), doc2);
  writeFileSync(join(dir, "tally.txt"), TALLY);
  const registryPath = join(dir, "registry.json");
  writeFileSync(registryPath, `${JSON.stringify({ claims }, null, 2)}\n`);
  return { dir, registryPath };
}

/** The gate over a bench, with the tree and registry it is pointed at. */
function gateOn(dir, registryPath) {
  return spawnSync(process.execPath, [GATE, "--root", dir, "--registry", registryPath], {
    encoding: "utf8",
  });
}

test("a count the command reproduces passes", () => {
  const { dir, registryPath } = bench([TRUE_ENTRY]);
  try {
    const result = gateOn(dir, registryPath);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clean - 1 stated count\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a count the tree contradicts fails with the file, line, both numbers and the command", () => {
  const { dir, registryPath } = bench([TRUE_ENTRY], { doc: "# Bench\n\nThe bench holds 3 rows.\n" });
  try {
    const result = gateOn(dir, registryPath);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /1 problem\(s\)/);
    assert.match(result.stderr, /doc\.md:3/);
    assert.match(result.stderr, /states 3, the command derives 2/);
    assert.match(result.stderr, /awk 'END\{print NR\}' tally\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale entry beside a true one fails alone", () => {
  const stale = {
    id: "bench-rows-second-doc",
    claim: "how many rows the second document claims",
    stated: { file: "doc2.md", line: 1, pattern: "records (\\S+) rows" },
    derived: { cmd: "awk 'END{print NR}' tally.txt", pattern: "^(\\d+)$" },
  };
  const { dir, registryPath } = bench([TRUE_ENTRY, stale], {
    doc2: "doc2 records 4 rows.\n",
  });
  try {
    const result = gateOn(dir, registryPath);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /1 problem\(s\)/);
    assert.match(result.stderr, /doc2\.md:1/);
    assert.doesNotMatch(result.stderr, /doc\.md/, "the verified entry must not be reported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a command that cannot run is refused, not skipped", () => {
  const entry = {
    ...TRUE_ENTRY,
    derived: { cmd: "source-claims-no-such-command --rows", pattern: "^(\\d+)$" },
  };
  const { dir, registryPath } = bench([entry]);
  try {
    const result = gateOn(dir, registryPath);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /cannot run/);
    assert.match(result.stderr, /source-claims-no-such-command --rows/);
    assert.doesNotMatch(result.stdout, /clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a command that exits 0 without printing a number is refused", () => {
  const entry = { ...TRUE_ENTRY, derived: { cmd: "true", pattern: "^(\\d+)$" } };
  const { dir, registryPath } = bench([entry]);
  try {
    const result = gateOn(dir, registryPath);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /printed no number/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a claim that moved off its recorded line is reported with the line it is on", () => {
  const { dir, registryPath } = bench([TRUE_ENTRY], {
    doc: "# Bench\n\nA paragraph the claim did not have above it.\n\nThe bench holds 2 rows.\n",
  });
  try {
    const result = gateOn(dir, registryPath);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /doc\.md:5: the claim is on this line/);
    assert.match(result.stderr, /records line 3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an entry with no command is refused as malformed", () => {
  const entry = { ...TRUE_ENTRY, derived: { pattern: "^(\\d+)$" } };
  const { dir, registryPath } = bench([entry]);
  try {
    const result = gateOn(dir, registryPath);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /derived\.cmd is missing/);
    assert.match(result.stderr, /claim #1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a registry that enrolls nothing is refused", () => {
  const { dir, registryPath } = bench([]);
  try {
    const result = gateOn(dir, registryPath);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /enrolls no claim/);
    assert.doesNotMatch(result.stdout, /clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the repository's own registry re-derives", () => {
  const result = spawnSync(process.execPath, [GATE], { cwd: packageRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
