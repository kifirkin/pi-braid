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
 *     over any document at all;
 *   - a line that states a number no entry proves is refused, naming the number,
 *     the line and both repairs, even when the entry beside it re-derives
 *     cleanly - and a line whose numbers are all proved passes, whether one
 *     entry proves them or two;
 *   - a number the matched sentence carries but the pattern does not capture is
 *     refused: the capture is what the gate compares, so the shape of a
 *     sentence proves no value;
 *   - a number outside every sentence the line's entries match is refused too,
 *     because the line as a whole is what an entry governs;
 *   - the census reads numerals, so a number word no capture contains is left
 *     alone rather than refused on a count no entry states;
 *   - every digit run is counted and none is exempted, so a digit inside an
 *     identifier on a governed line is refused while no exemption exists.
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
    doc2: "The second document records 4 rows.\n",
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

test("a governed line that states a number no entry proves is refused", () => {
  const pair = { ...TRUE_ENTRY, stated: { file: "doc.md", line: 3, pattern: "holds (\\S+) of" } };
  const { dir, registryPath } = bench([pair], { doc: "# Bench\n\nThe bench holds 2 of 41 rows.\n" });
  try {
    const result = gateOn(dir, registryPath);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /doc\.md:3/);
    assert.match(result.stderr, /states 41, which no entry proves/);
    assert.match(result.stderr, /enrol 41 with an entry/);
    assert.match(result.stderr, /keep 41 off the governed line/);
    assert.doesNotMatch(result.stdout, /clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second entry on the same line proves the number the first one does not", () => {
  const second = {
    id: "bench-rows-of-leaves",
    claim: "how many of the bench's rows the same sentence names",
    stated: { file: "doc.md", line: 3, pattern: "of (\\S+) rows" },
    derived: { cmd: "printf '41\\n'", pattern: "^(\\d+)$" },
  };
  const pair = { ...TRUE_ENTRY, stated: { file: "doc.md", line: 3, pattern: "holds (\\S+) of" } };
  const { dir, registryPath } = bench([pair, second], {
    doc: "# Bench\n\nThe bench holds 2 of 41 rows.\n",
  });
  try {
    const result = gateOn(dir, registryPath);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clean - 2 stated count\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a line whose every number an entry captures passes", () => {
  const entry = { ...TRUE_ENTRY, stated: { file: "doc.md", line: 3, pattern: "holds (\\S+) rows" } };
  const { dir, registryPath } = bench([entry]);
  try {
    const result = gateOn(dir, registryPath);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clean - 1 stated count\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A pattern proves the shape of a sentence; only its capture carries a value the
// gate compares. So a number the match spans but no group captures is stated by
// the document and proved by nothing, and it is refused: a pattern that moves
// over a number is not a check on it.
test("a number the matched sentence carries but no capture group takes is refused", () => {
  const entry = {
    ...TRUE_ENTRY,
    stated: { file: "doc.md", line: 3, pattern: "holds (\\S+) of \\S+ rows" },
  };
  const { dir, registryPath } = bench([entry], { doc: "# Bench\n\nThe bench holds 2 of 41 rows.\n" });
  try {
    const result = gateOn(dir, registryPath);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /doc\.md:3/);
    assert.match(result.stderr, /states 41, which no entry proves/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a number outside every sentence the line's entries match is refused", () => {
  const { dir, registryPath } = bench([TRUE_ENTRY], {
    doc: "# Bench\n\nThe bench holds 2 rows, 7 of them new.\n",
  });
  try {
    const result = gateOn(dir, registryPath);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /doc\.md:3/);
    assert.match(result.stderr, /states 7, which no entry proves/);
    assert.match(result.stderr, /prove 2 \(entry "bench-rows"\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The census is of numerals, which is the only way a digit run can be found
// without reading prose for meaning. A number word is still read as a value when
// an entry captures it; a word no capture contains is outside what this rule
// counts, and is left to the entry that states it.
test("the census reads numerals, so a number word no capture contains passes", () => {
  const { dir, registryPath } = bench([TRUE_ENTRY], {
    doc: "# Bench\n\nThe bench holds 2 rows, two of them new.\n",
  });
  try {
    const result = gateOn(dir, registryPath);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The census takes every digit run on a governed line and exempts none, so a
// digit that is part of an identifier is refused like a count: the rule reads
// numerals, and telling a filename from a figure is a judgement no cheap scan
// makes. A governed line therefore keeps identifiers that end in digits off it.
// An exemption for this class would be a recorded decision, not a silent one.
test("a digit inside an identifier on a governed line is refused like a count", () => {
  const { dir, registryPath } = bench([TRUE_ENTRY], {
    doc: "# Bench\n\nThe bench holds 2 rows in doc7.\n",
  });
  try {
    const result = gateOn(dir, registryPath);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /doc\.md:3/);
    assert.match(result.stderr, /states 7, which no entry proves/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the repository's own registry re-derives", () => {
  const result = spawnSync(process.execPath, [GATE], { cwd: packageRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
