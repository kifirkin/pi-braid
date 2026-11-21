#!/usr/bin/env node
/**
 * adversarial-instruments: does the runner believe a checker?
 *
 * The runner's own failure mode is the one it measures: a checker that exits 0
 * on a world built to be refused must be reported as a failure, and a checker
 * that refuses without naming the declared token must not be reported as a
 * pass. Both are exercised here against three throwaway checkers the test
 * writes, so no verdict depends on the repository's gates: the always-zero
 * checker is the planted control, the silent checker isolates the naming leg,
 * and the one that names the missing input is the passing row.
 *
 * The runner is driven through its command line with an external case table,
 * which is also the surface a new case uses: each leg is one table and one
 * spawn. The legs assert the JSON verdict as well as the exit code, because a
 * runner that exits 1 for the wrong reason would otherwise look correct.
 *
 * Run: node --test packages/core/test/runtime/scripts/test-adversarial-instruments.mjs
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER =
  process.env.ADVERSARIAL_RUNNER || join(HERE, "..", "..", "..", "scripts", "adversarial-instruments.mjs");
const WORK = mkdtempSync(join(tmpdir(), "adversarial-instruments-test-"));
let tables = 0;

/** A checker that never looks at its input and reports success. */
const ALWAYS_ZERO = join(WORK, "always-zero.mjs");
writeFileSync(ALWAYS_ZERO, 'console.log("all good");\n');

/** A checker that refuses without a word. */
const SILENT = join(WORK, "silent.mjs");
writeFileSync(SILENT, "process.exit(1);\n");

/** A checker that refuses and names the path it could not read. */
const NAMES_INPUT = join(WORK, "names-input.mjs");
writeFileSync(
  NAMES_INPUT,
  [
    'const path = process.argv[2] ?? "(no path)";',
    'console.log(`cannot read input ${path}: the file does not exist`);',
    "process.exit(1);",
    "",
  ].join("\n"),
);

/** The path a case names and no checker writes: the token each leg asserts. */
const ABSENT = join(WORK, "absent-input.json");

function row(checker, script, expect) {
  return { checker, case: "one-case", argv: ["node", script, ABSENT], expect };
}

/** Write a table, run the runner on it, and read both surfaces back. */
function runTable(rows, extra = []) {
  tables += 1;
  const tablePath = join(WORK, `table-${tables}.json`);
  writeFileSync(tablePath, JSON.stringify(rows));
  const result = spawnSync(process.execPath, [RUNNER, "--table", tablePath, "--json", ...extra], {
    encoding: "utf8",
  });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = null;
  }
  return { ...result, report, tablePath };
}

test("a checker that exits 0 on a broken world is reported as a silent pass", () => {
  const run = runTable([row("always-zero", ALWAYS_ZERO, { code: 1, names: [ABSENT] })]);
  assert.equal(run.status, 1, `the runner exits non-zero when its row diverges:\n${run.stdout}${run.stderr}`);
  assert.ok(run.report, `the runner prints one JSON report:\n${run.stdout}${run.stderr}`);
  assert.equal(run.report.cases.length, 1);
  const [verdict] = run.report.cases;
  assert.equal(verdict.verdict, "silent-pass", `the zero is named, not believed: ${JSON.stringify(verdict)}`);
  assert.equal(verdict.exit, 0);
  assert.equal(run.report.summary["silent-pass"], 1);
});

test("a checker that refuses without naming the token is reported as unnamed, not as a pass", () => {
  const run = runTable([row("silent", SILENT, { code: 1, names: [ABSENT] })]);
  assert.equal(run.status, 1, `an unnamed refusal still fails the row:\n${run.stdout}${run.stderr}`);
  const [verdict] = run.report.cases;
  assert.equal(verdict.verdict, "unnamed", `the missing token is named: ${JSON.stringify(verdict)}`);
  assert.equal(verdict.exit, 1);
  assert.deepEqual(verdict.missing, [ABSENT]);
  assert.match(verdict.detail, /message did not name/);
});

test("a checker that refuses and names the token passes, and the run exits 0", () => {
  const run = runTable([row("names-input", NAMES_INPUT, { code: 1, names: [ABSENT] })]);
  assert.equal(run.status, 0, `the agreeing row exits 0:\n${run.stdout}${run.stderr}`);
  const [verdict] = run.report.cases;
  assert.equal(verdict.verdict, "pass");
  assert.deepEqual(verdict.missing, []);
  assert.equal(verdict.exit, 1);
});

test("the planted control: the same table without the always-zero row exits 0", () => {
  const rows = [row("names-input", NAMES_INPUT, { code: 1, names: [ABSENT] })];
  const green = runTable(rows);
  assert.equal(green.status, 0, `the control run is green:\n${green.stdout}${green.stderr}`);
  const red = runTable([...rows, row("always-zero", ALWAYS_ZERO, { code: 1, names: [ABSENT] })]);
  assert.equal(red.status, 1, `one green row does not carry a zero row:\n${red.stdout}${red.stderr}`);
  const failing = red.report.cases.filter((entry) => entry.verdict !== "pass");
  assert.equal(failing.length, 1);
  assert.equal(failing[0].checker, "always-zero");
  assert.equal(red.report.summary.pass, 1);
});

test("a command that cannot start is reported as an error, not a crash", () => {
  const run = runTable([
    { checker: "missing", case: "not-a-program", argv: [join(WORK, "not-a-program")], expect: { code: 1, names: [] } },
  ]);
  assert.equal(run.status, 1, `an unstartable checker fails the run:\n${run.stdout}${run.stderr}`);
  assert.ok(run.report, `the report still parses:\n${run.stdout}${run.stderr}`);
  assert.equal(run.report.cases[0].verdict, "error");
  assert.match(run.report.cases[0].detail, /could not run/);
});

test("an unusable table exits 2 and names the table", () => {
  const tablePath = join(WORK, "broken-table.json");
  writeFileSync(tablePath, "{not json");
  const result = spawnSync(process.execPath, [RUNNER, "--table", tablePath], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, new RegExp(tablePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("the human surface prints one line per row and a counted summary", () => {
  tables += 1;
  const tablePath = join(WORK, `table-${tables}.json`);
  writeFileSync(
    tablePath,
    JSON.stringify([
      row("names-input", NAMES_INPUT, { code: 1, names: [ABSENT] }),
      row("always-zero", ALWAYS_ZERO, { code: 1, names: [ABSENT] }),
    ]),
  );
  const result = spawnSync(process.execPath, [RUNNER, "--table", tablePath], { encoding: "utf8" });
  assert.equal(result.status, 1);
  const lines = result.stdout.trim().split("\n");
  assert.match(lines[0], /^PASS names-input one-case \(exit=1, named /);
  assert.match(lines[1], /^FAIL always-zero one-case \(exit=0, expected 1\)$/);
  assert.match(lines.at(-1), /^adversarial-instruments: 2 case\(s\), 1 pass, 1 fail \(1 silent-pass, 0 unnamed/);
});
