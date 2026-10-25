/**
 * Test: a fleet command that answered correctly leaves stderr empty, and the
 * one warning the journal costs is answered without answering any other.
 *
 * `node:sqlite` announces itself as experimental at import, once per process, on
 * every 24 release before 24.15 (measured: 24.0.0 and 24.14.0 warn, 24.15.0 and
 * 24.22.1 do not). The fleet's commands are asserted to write nothing to stderr
 * when they succeed (`test-cli`, `test-pack-ships`), so on those releases that
 * single line turned a healthy run red. The answer lives at the import in
 * `journal.mjs`, and these arms hold both halves of it:
 *
 *   - help, a store-less `status`, and a `status` that reads a real journal write
 *     nothing to stderr;
 *   - the control that keeps the first arms from passing vacuously: the runtime's
 *     own unfiltered import is measured first, so a silent fleet on a silent
 *     runtime is reported as the runtime's silence rather than as this
 *     repository's doing;
 *   - a genuine `ExperimentalWarning` and a `DeprecationWarning` from other
 *     modules still reach stderr after the fleet's module has been loaded, while
 *     the SQLite line does not: the answer is the warning's own type and text,
 *     not its class and not the listener;
 *   - the fleet reaches SQLite in one module, so a future import cannot arrive
 *     ahead of the answer and put the line back on every command.
 *
 * Run: node test/runtime/fleet/test-sqlite-warning.mjs
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { openJournal } from "../../../scripts/fleet/journal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FLEET_SCRIPTS = resolve(HERE, "../../../scripts/fleet");
const CLI = join(FLEET_SCRIPTS, "cli.mjs");
const JOURNAL = join(FLEET_SCRIPTS, "journal.mjs");

const SQLITE_TEXT = "SQLite is an experimental feature and might change at any time";
const SQLITE_WARNING = new RegExp(`ExperimentalWarning: ${SQLITE_TEXT}`);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [ok] ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  [fail] ${name}: ${error.message}`);
  }
}

/**
 * Whether this runtime emits the SQLite warning at all, measured rather than
 * tabulated: the answer below cannot make a silent runtime speak, so the first
 * arm records which world the later arms are in. `node:sqlite` is experimental
 * through 24.14 and a release candidate from 24.15, so the answer differs across
 * a supported range and a version table here would age into a lie.
 */
let runtimeWarns = null;

const root = mkdtempSync(join(tmpdir(), "fleet-sqlite-warning-"));

/** One command, its streams captured separately: the assertion is about stderr. */
function fleet(...args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, PI_FLEET_ROOT: root },
    timeout: 30_000,
  });
}

/** A child that runs `source` as an ES module and hands back its streams. */
function runModule(source) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

await check("the control: what this runtime's own unfiltered import does", () => {
  const raw = runModule('await import("node:sqlite");');
  assert.equal(raw.status, 0, `the bare import runs (${raw.stderr})`);
  runtimeWarns = SQLITE_WARNING.test(raw.stderr);
  console.log(
    `  (${process.version} ${runtimeWarns ? "warns" : "is silent"} on a bare import of node:sqlite, so the silence below is ${runtimeWarns ? "this repository's answer" : "the runtime's own"})`,
  );
});

await check("help writes nothing to stderr", () => {
  const out = fleet("--help");
  assert.equal(out.status, 0, `help exits 0 (${out.stderr})`);
  assert.match(out.stdout, /pi-braid-fleet/, "the usage is on stdout");
  assert.equal(out.stderr, "", "a command that answered wrote no warning");
});

await check("a status with no store yet writes nothing to stderr", () => {
  const out = fleet("status", "--root", join(root, "absent"));
  assert.equal(out.status, 0, `status exits 0 (${out.stderr})`);
  assert.equal(out.stderr, "", "the answer came from the root, not a journal, and still wrote no warning");
});

await check("a status that reads a real journal writes nothing to stderr", () => {
  const journal = openJournal(root, {});
  journal.close();
  const out = fleet("status", "--root", root);
  assert.equal(out.status, 0, `status exits 0 (${out.stderr})`);
  assert.match(out.stdout, /fleet store .*fleet\.sqlite/, "the store it read is named in the answer");
  assert.equal(
    out.stderr,
    "",
    runtimeWarns
      ? "opening SQLite is what costs the warning on this runtime, and this arm pays it"
      : "the store was opened and read without writing to stderr",
  );
});

await check("a foreign experimental warning and a deprecation still reach stderr", () => {
  const seat = pathToFileURL(JOURNAL).href;
  const out = runModule(
    `await import(${JSON.stringify(seat)});\n` +
      'process.emitWarning("a foreign experimental feature", "ExperimentalWarning");\n' +
      'process.emitWarning("a foreign deprecation", "DeprecationWarning");\n',
  );
  assert.equal(out.status, 0, `the child loads the fleet's module (${out.stderr})`);
  assert.match(out.stderr, /ExperimentalWarning: a foreign experimental feature/, "another module's experimental warning is not hidden");
  assert.match(out.stderr, /DeprecationWarning: a foreign deprecation/, "a deprecation is not hidden");
  assert.doesNotMatch(out.stderr, SQLITE_WARNING, "the answered warning stays answered");
});

await check("the fleet reaches SQLite in exactly one module", () => {
  const IMPORTS_SQLITE = /from\s+["']node:sqlite["']|import\(\s*["']node:sqlite["']\s*\)/;
  const importers = readdirSync(FLEET_SCRIPTS)
    .filter((name) => name.endsWith(".mjs"))
    .filter((name) => IMPORTS_SQLITE.test(readFileSync(join(FLEET_SCRIPTS, name), "utf8")));
  assert.deepEqual(
    importers,
    ["journal.mjs"],
    `an importer outside journal.mjs arrives before the warning is answered, so every command writes the line again: found ${JSON.stringify(importers)}`,
  );
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
