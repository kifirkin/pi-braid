// test-check-regressions.mjs - offline harness for check-regressions.mjs.
//
// Every case builds its own throwaway suite in a temp directory and drives the
// gate over it with --root, so no verdict here depends on the real suite being
// green, on how many fixtures it holds, or on a checkout that happens to exist
// on the machine. The bench is a git repository: the gate records the revision
// a snapshot was taken at, and a case that could not move that revision could
// not tell the refusal from the acceptance.
//
// The bench is two fixtures, one that passes and one that fails before anything
// is flipped. Both states are needed: the failing one is what the baseline has
// to record as red rather than as a pass, and it is what proves a case reports
// the fixture that moved instead of every fixture that is not green.
//
// Eleven cases, one mechanism each. A re-run against its own baseline finds
// nothing; a fixture flipped to failing is caught and named; a fixture deleted
// from the tree is caught; an exemption with a reason silences its row; an
// exemption with no reason is refused; a baseline taken on another line of
// history is refused; a baseline from an ancestor still grounds the comparison
// and prints the distance, which is the merge shape the instrument exists for;
// an exemption that silenced nothing is reported as stale; a run from inside a
// suite refuses the default root rather than re-entering the suite it is
// already in; a baseline whose revision field is present but unreadable is
// refused rather than read as "no revision"; and a fixture that passed in the
// baseline and now times out is named as timing out rather than as failing.
//
// The gate under test defaults to the script three directories up;
// CHECK_REGRESSIONS=<path> overrides it, which is how a RED run is recorded
// against a copy with one mechanism removed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const GATE =
  process.env.CHECK_REGRESSIONS ||
  resolve(import.meta.dirname, "..", "..", "..", "scripts", "check-regressions.mjs");

/** A bench fixture that prints a tally and exits 0. */
const GREEN = 'console.log("case one ok");\nconsole.log("\\n\uD83D\uDCCA Results: 2 passed, 0 failed");\n';
/** The same fixture made red: it prints a tally and sets the exit code. */
const RED =
  'console.log("not ok 1 - the fixture case");\n' +
  'console.log("\\n\uD83D\uDCCA Results: 0 passed, 1 failed");\n' +
  "process.exitCode = 1;\n";

/** A git command in the bench, asserted rather than swallowed: a broken bench makes every verdict here meaningless. */
function git(dir, ...args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * A bench suite in its own temp home: `tree/` is the fixture tree the gate
 * enumerates, and the baseline and exemption files sit beside it so the gate's
 * own inputs are never inside the population it walks.
 */
function harness() {
  const home = mkdtempSync(join(tmpdir(), "check-regressions-test-"));
  const tree = join(home, "tree");
  mkdirSync(tree);
  git(tree, "init", "-q", "-b", "main");
  git(tree, "config", "user.email", "fixture@example.test");
  git(tree, "config", "user.name", "fixture");
  writeFileSync(join(tree, "green.mjs"), GREEN);
  writeFileSync(join(tree, "red.mjs"), RED);
  git(tree, "add", "-A");
  git(tree, "commit", "-q", "-m", "a bench suite with one green and one red fixture");
  return { home, tree, baseline: join(home, "baseline.json"), exemptions: join(home, "exemptions.json") };
}

/** Run the gate and return its exit code with everything it printed. */
function gate(args, env = {}) {
  const result = spawnSync(process.execPath, [GATE, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** Take the baseline every case starts from, over a bench that is still intact. */
function snapshot(spot) {
  const written = gate(["--baseline", spot.baseline, "--root", spot.tree]);
  assert.equal(written.status, 0, `taking a baseline failed: ${written.out}`);
  return JSON.parse(readFileSync(spot.baseline, "utf8"));
}

test("a re-run against its own baseline finds nothing, and the snapshot records both states", () => {
  const spot = harness();
  try {
    const taken = snapshot(spot);
    const rows = new Map(taken.fixtures.map((row) => [row.path, row]));
    assert.equal(rows.get("green.mjs").outcome, "passed");
    assert.equal(rows.get("red.mjs").outcome, "failed", "a red fixture is recorded as red, not as a pass");
    assert.deepEqual(rows.get("green.mjs").counts, { passed: 2, failed: 0 }, "the tally the fixture printed is kept");
    assert.match(taken.revision ?? "", /^[0-9a-f]{40}$/, "the snapshot records the revision it was taken at");

    const checked = gate(["--check", spot.baseline, "--root", spot.tree]);
    assert.equal(checked.status, 0, checked.out);
    assert.match(checked.out, /2 fixture\(s\) compared against the baseline, 0 regression/);
    assert.match(checked.out, /OK: no fixture that passed in the baseline stopped passing/);
    assert.match(checked.out, /A behaviour with no fixture is outside what this reads/);
  } finally {
    rmSync(spot.home, { recursive: true, force: true });
  }
});

test("a fixture flipped to failing is caught, and only that fixture is named", () => {
  const spot = harness();
  try {
    snapshot(spot);
    writeFileSync(join(spot.tree, "green.mjs"), RED);

    const checked = gate(["--check", spot.baseline, "--root", spot.tree]);
    assert.equal(checked.status, 1, checked.out);
    assert.match(checked.out, /FAIL green\.mjs: passed in the baseline and fails now\./);
    assert.doesNotMatch(checked.out, /FAIL red\.mjs/, "the fixture that was already red is not a regression");
    assert.match(checked.out, /FAILED: 1 fixture\(s\) that passed in the baseline no longer pass/);
  } finally {
    rmSync(spot.home, { recursive: true, force: true });
  }
});

test("a fixture deleted from the tree is caught", () => {
  const spot = harness();
  try {
    snapshot(spot);
    unlinkSync(join(spot.tree, "green.mjs"));

    const checked = gate(["--check", spot.baseline, "--root", spot.tree]);
    assert.equal(checked.status, 1, checked.out);
    assert.match(checked.out, /FAIL green\.mjs: passed in the baseline and this tree does not carry it/);
  } finally {
    rmSync(spot.home, { recursive: true, force: true });
  }
});

test("an exemption with a reason silences its row", () => {
  const spot = harness();
  try {
    snapshot(spot);
    unlinkSync(join(spot.tree, "green.mjs"));
    writeFileSync(
      spot.exemptions,
      JSON.stringify([{ path: "green.mjs", why: "the case moved into red.mjs under its own name" }]),
    );

    const checked = gate(["--check", spot.baseline, "--root", spot.tree, "--exempt", spot.exemptions]);
    assert.equal(checked.status, 0, checked.out);
    assert.match(checked.out, /EXEMPT green\.mjs: the case moved into red\.mjs under its own name/);
    assert.doesNotMatch(checked.out, /FAIL green\.mjs/);
    assert.match(checked.out, /0 regression\(s\), 1 exempt/);
  } finally {
    rmSync(spot.home, { recursive: true, force: true });
  }
});

test("an exemption with no reason is refused", () => {
  const spot = harness();
  try {
    snapshot(spot);
    writeFileSync(spot.exemptions, JSON.stringify([{ path: "green.mjs" }]));

    const checked = gate(["--check", spot.baseline, "--root", spot.tree, "--exempt", spot.exemptions]);
    assert.equal(checked.status, 2, checked.out);
    assert.match(checked.out, /no why/);
    assert.match(checked.out, /unwatched fixture with no record at all/);
  } finally {
    rmSync(spot.home, { recursive: true, force: true });
  }
});

test("a baseline taken on another line of history is refused", () => {
  const spot = harness();
  try {
    // The baseline is taken on a side branch, so its revision is one this tree
    // does not descend from once the checkout returns to the base branch.
    git(spot.tree, "checkout", "-q", "-b", "side");
    writeFileSync(join(spot.tree, "side-only.mjs"), GREEN);
    git(spot.tree, "add", "-A");
    git(spot.tree, "commit", "-q", "-m", "a fixture this line carries and the base line does not");
    snapshot(spot);
    git(spot.tree, "checkout", "-q", "main");

    const checked = gate(["--check", spot.baseline, "--root", spot.tree]);
    assert.equal(checked.status, 2, checked.out);
    assert.match(checked.out, /not one this tree descends from/);
    assert.match(checked.out, /Take a new baseline over/);
  } finally {
    rmSync(spot.home, { recursive: true, force: true });
  }
});

test("a baseline from an ancestor still grounds the comparison, and the distance is printed", () => {
  const spot = harness();
  try {
    const taken = snapshot(spot);
    // The merge shape: the tree moves by one commit and a fixture appears.
    writeFileSync(join(spot.tree, "added-later.mjs"), GREEN);
    git(spot.tree, "add", "-A");
    git(spot.tree, "commit", "-q", "-m", "a fixture that lands after the baseline was taken");

    const checked = gate(["--check", spot.baseline, "--root", spot.tree]);
    assert.equal(checked.status, 0, checked.out);
    assert.match(
      checked.out,
      new RegExp(`${taken.revision}, 1 commit\\(s\\) behind [0-9a-f]{40}`),
      "the baseline is placed relative to the current revision instead of refused",
    );
    assert.match(checked.out, /1 fixture\(s\) new since the baseline/);
    assert.match(checked.out, /0 regression/);
  } finally {
    rmSync(spot.home, { recursive: true, force: true });
  }
});

test("an exemption that silenced nothing is reported as stale", () => {
  const spot = harness();
  try {
    snapshot(spot);
    writeFileSync(spot.exemptions, JSON.stringify([{ path: "red.mjs", why: "the case it named moved into green.mjs" }]));

    const checked = gate(["--check", spot.baseline, "--root", spot.tree, "--exempt", spot.exemptions]);
    assert.equal(checked.status, 0, checked.out);
    assert.match(checked.out, /STALE exemption red\.mjs: the case it named moved into green\.mjs \(this fixture did not regress\)/);
    assert.match(checked.out, /0 regression\(s\), 0 exempt, 1 stale exemption\(s\)/);
  } finally {
    rmSync(spot.home, { recursive: true, force: true });
  }
});

test("a run from inside a suite refuses the default root instead of re-entering the suite", () => {
  // The runner hands every fixture the suite's lock token. A default-root run
  // from there would start a second full suite inside the first, which would
  // start this fixture again; the refusal is what stops the recursion.
  const checked = gate(["--check", "/nonexistent-baseline.json"], { PI_SUITE_LOCK_TOKEN: "fixture-token" });
  assert.equal(checked.status, 2, checked.out);
  assert.match(checked.out, /inside a suite run, so the default root would re-enter the suite it is already in/);
  assert.match(checked.out, /pass --root <dir>/);
  assert.doesNotMatch(checked.out, /cannot read the baseline/, "the refusal arrives before any input is read");
});

test("a baseline whose revision is unreadable is refused rather than read as no revision", () => {
  // "No revision" and "a revision this file cannot read" are different facts.
  // Reading the second as the first would place a foreign baseline against this
  // tree on a guess, so the value is refused where it is found.
  const spot = harness();
  try {
    const taken = snapshot(spot);
    writeFileSync(spot.baseline, JSON.stringify({ ...taken, revision: "" }));

    const checked = gate(["--check", spot.baseline, "--root", spot.tree]);
    assert.equal(checked.status, 2, checked.out);
    assert.match(checked.out, /records a revision that is not one/);
  } finally {
    rmSync(spot.home, { recursive: true, force: true });
  }
});

test("a fixture that passed in the baseline and now times out is caught", () => {
  // A file that never finishes and a file that fails are different findings
  // with different fixes, so the comparison keeps them apart. The cap comes from
  // the runner's own PI_TEST_TIMEOUT_MS so the case costs a second, not a
  // minute.
  const spot = harness();
  try {
    snapshot(spot);
    writeFileSync(join(spot.tree, "green.mjs"), "setTimeout(() => {}, 8000);\n");

    const checked = gate(["--check", spot.baseline, "--root", spot.tree], { PI_TEST_TIMEOUT_MS: "800" });
    assert.equal(checked.status, 1, checked.out);
    assert.match(checked.out, /FAIL green\.mjs: passed in the baseline and times out now\./);
  } finally {
    rmSync(spot.home, { recursive: true, force: true });
  }
});
