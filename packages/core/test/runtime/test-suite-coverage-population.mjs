/**
 * The suite-coverage check judges the population the core runner counts.
 *
 * A bench monorepo carries copies of the runner and of the check, a walked test
 * tree, and the parser the check loads (linked, not installed). Over that bench:
 *
 *   - a module that asserts nothing fails the check by name, and the failure
 *     says what the module was checked for and where to declare it;
 *   - declaring it in the walked tree's manifest, with a reason, passes;
 *   - declaring a real fixture a non-fixture fails, naming what the module does,
 *     because that declaration keeps a test out of the run;
 *   - a declaration with no reason fails, reported as the runner's own refusal;
 *   - a case named through a helper the module declares is counted, not
 *     refused: the hand-rolled harness is a fixture, and reading only a literal
 *     `test(` call would turn most of this suite into non-fixtures;
 *   - a library whose only load-time call sits behind a CLI entry guard is not a
 *     fixture, since that branch is what the module does when it is the program;
 *   - a listed module the check cannot open is reported, not thrown;
 *   - the runner's own run says how many modules it left out of the count.
 *
 * Finally the check is run over the repository's own tree, where it must pass,
 * so a manifest that drifts from the tree cannot sit behind a green bench.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const scriptsDir = join(repoRoot, "packages", "core", "scripts");

const checks = [];
const check = (name, pass, detail = "") =>
  checks.push({ name, pass: Boolean(pass), detail });

/** A module that asserts while it loads: the shape the runner counts as a fixture. */
const ASSERTING_MODULE = [
  'import assert from "node:assert/strict";',
  "",
  'assert.equal(1 + 1, 2, "the module asserts while it is loaded");',
  'console.log("[ok] a module-scope assertion");',
  "",
].join("\n");

/** A shared helper: it asserts nothing when the runner loads it on its own. */
const HELPER_MODULE = [
  "/** A shared helper the fixtures import. */",
  'import { strict as assert } from "node:assert";',
  "",
  "export function assertNamed(value, name) {",
  "  assert.ok(value, name);",
  "  return value;",
  "}",
  "",
].join("\n");

/** A fixture in the hand-rolled shape: it names its cases through a helper it declares. */
const HARNESS_MODULE = [
  'import { strict as assert } from "node:assert";',
  "",
  "let failed = 0;",
  "function named(name, fn) {",
  "  try {",
  "    fn();",
  "    console.log(`  [ok] ${name}`);",
  "  } catch (error) {",
  "    failed += 1;",
  "    console.log(`  [fail] ${name}: ${error.message}`);",
  "  }",
  "}",
  "",
  'named("counts the case it was handed", () => assert.equal(1 + 1, 2));',
  "process.exitCode = failed > 0 ? 1 : 0;",
  "",
].join("\n");

/** A library with a CLI entry: its only load-time call is behind the is-main guard. */
const CLI_MODULE = [
  'import { pathToFileURL } from "node:url";',
  "",
  "export function scan(dir) {",
  "  return [dir];",
  "}",
  "",
  "function main(argv) {",
  "  process.stdout.write(`${scan(argv[0] ?? \".\").join(\"\\n\")}\\n`);",
  "}",
  "",
  "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {",
  "  main(process.argv.slice(2));",
  "}",
  "",
].join("\n");

/**
 * Build a bench monorepo whose `packages/core` carries the real runner and the
 * real check. The parser is linked into the bench because the copy of the check
 * resolves `typescript` from its own tree, exactly as the repository's copy does.
 */
function makeBench() {
  const dir = mkdtempSync(join(tmpdir(), "suite-population-bench-"));
  const core = join(dir, "packages", "core");
  const tree = join(core, "test", "runtime");
  mkdirSync(join(core, "scripts"), { recursive: true });
  mkdirSync(tree, { recursive: true });
  for (const name of ["run-tests.mjs", "check-suite-coverage.mjs"]) {
    writeFileSync(join(core, "scripts", name), readFileSync(join(scriptsDir, name), "utf-8"));
  }
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "bench-root",
        private: true,
        workspaces: ["packages/core"],
        scripts: { "ci:check": "npm run test -w packages/core" },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(core, "package.json"),
    JSON.stringify(
      { name: "bench-core", private: true, scripts: { test: "node scripts/run-tests.mjs" } },
      null,
      2,
    ),
  );
  return {
    dir,
    core,
    tree,
    /** Write a module into the walked tree at a tree-relative path. */
    writeModule(rel, source) {
      const target = join(tree, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source);
    },
    /** Declare tree-relative paths as non-fixtures, with their reasons. */
    declare(notFixtures) {
      writeFileSync(
        join(tree, "fixture-manifest.json"),
        JSON.stringify({ notFixtures }, null, 2),
      );
    },
    /** The bench's own copy of the check, run over the bench. */
    runCheck() {
      const run = spawnSync(process.execPath, [join(core, "scripts", "check-suite-coverage.mjs")], {
        cwd: dir,
        encoding: "utf-8",
        timeout: 120_000,
      });
      return { status: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
    },
    /** The bench's own copy of the runner, run over the bench. */
    runRunner(args) {
      const run = spawnSync(process.execPath, [join(core, "scripts", "run-tests.mjs"), ...args], {
        cwd: dir,
        encoding: "utf-8",
        timeout: 120_000,
      });
      return { status: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
    },
  };
}

const HELPER_REASON = "a shared helper: the fixtures import its named assertion, and it asserts nothing alone";

// A helper in the tree with nothing declared: the check must refuse it by name.
{
  const bench = makeBench();
  try {
    bench.writeModule("test-asserting.mjs", ASSERTING_MODULE);
    bench.writeModule("lib/helper.mjs", HELPER_MODULE);
    const run = bench.runCheck();
    check(
      "an undeclared module that asserts nothing fails the check",
      run.status === 1,
      `status=${run.status} output=${JSON.stringify(run.output.trim())}`,
    );
    check(
      "the failure names the module",
      run.output.includes("lib/helper.mjs"),
      run.output.trim(),
    );
    check(
      "the failure says what the module was checked for",
      run.output.includes("node:test") &&
        run.output.includes("node:assert") &&
        run.output.includes("calls no function it declares"),
      run.output.trim(),
    );
    check(
      "the failure says where to declare it",
      run.output.includes("fixture-manifest.json"),
      run.output.trim(),
    );
    check(
      "the counted module is not named as a problem",
      !/test-asserting\.mjs[^\n]*counted as a passed fixture/.test(run.output),
      run.output.trim(),
    );

    // The same tree with the helper declared and argued: the check must pass.
    bench.declare({ "lib/helper.mjs": HELPER_REASON });
    const declared = bench.runCheck();
    check(
      "declaring the helper with a reason passes the check",
      declared.status === 0,
      `status=${declared.status} output=${JSON.stringify(declared.output.trim())}`,
    );
    check(
      "the passing summary states the population",
      /population: 1 module\(s\) counted by the runner, 1 declared a non-fixture/.test(
        declared.output,
      ),
      declared.output.trim(),
    );

    // A declaration that names a real fixture hides a test from the run.
    bench.declare({ "lib/helper.mjs": HELPER_REASON, "test-asserting.mjs": "pretending it is a helper" });
    const hidden = bench.runCheck();
    check(
      "declaring a real fixture a non-fixture fails the check",
      hidden.status === 1 && hidden.output.includes("test-asserting.mjs"),
      `status=${hidden.status} output=${JSON.stringify(hidden.output.trim())}`,
    );
    check(
      "that failure says what the module does",
      hidden.output.includes("asserts with node:assert"),
      hidden.output.trim(),
    );

    // A declaration with no reason is refused by the runner, so the check
    // cannot read a population it would otherwise believe.
    bench.declare({ "lib/helper.mjs": "   " });
    const reasonless = bench.runCheck();
    check(
      "a declaration with no reason fails, as the runner's own refusal",
      reasonless.status === 1 && reasonless.output.includes("states no reason"),
      `status=${reasonless.status} output=${JSON.stringify(reasonless.output.trim())}`,
    );
  } finally {
    rmSync(bench.dir, { recursive: true, force: true });
  }
}

// The hand-rolled harness: cases named through a helper the module declares.
{
  const bench = makeBench();
  try {
    bench.writeModule("test-harness.mjs", HARNESS_MODULE);
    const run = bench.runCheck();
    check(
      "a case named through a declared helper is counted, not refused",
      run.status === 0,
      `status=${run.status} output=${JSON.stringify(run.output.trim())}`,
    );
  } finally {
    rmSync(bench.dir, { recursive: true, force: true });
  }
}

// A library whose only load-time call is behind the CLI entry guard.
{
  const bench = makeBench();
  try {
    bench.writeModule("lib/scanner.mjs", CLI_MODULE);
    const run = bench.runCheck();
    check(
      "a CLI entry is not load-time work, so the library is not a fixture",
      run.status === 1 && run.output.includes("lib/scanner.mjs"),
      `status=${run.status} output=${JSON.stringify(run.output.trim())}`,
    );
  } finally {
    rmSync(bench.dir, { recursive: true, force: true });
  }
}

// A walked path the check cannot open: reported against the tree, not thrown.
{
  const bench = makeBench();
  try {
    bench.writeModule("test-asserting.mjs", ASSERTING_MODULE);
    mkdirSync(join(bench.tree, "lib"), { recursive: true });
    symlinkSync(join(tmpdir(), `no-such-fixture-${process.pid}.mjs`), join(bench.tree, "lib", "gone.mjs"));
    const run = bench.runCheck();
    check(
      "a listed module the check cannot read is reported, not thrown",
      run.status === 1 && run.output.includes("lib/gone.mjs") && run.output.includes("cannot be read"),
      `status=${run.status} output=${JSON.stringify(run.output.trim())}`,
    );
  } finally {
    rmSync(bench.dir, { recursive: true, force: true });
  }
}

// The runner's own run: the number it prints is qualified by what it left out.
{
  const bench = makeBench();
  try {
    bench.writeModule("test-asserting.mjs", ASSERTING_MODULE);
    bench.writeModule("lib/helper.mjs", HELPER_MODULE);
    bench.declare({ "lib/helper.mjs": HELPER_REASON });
    const run = bench.runRunner(["--jobs", "1"]);
    check(
      "the run leaves the declared module out of the count",
      run.status === 0 &&
        /1 passed, 0 failed, 0 timed out/.test(run.output) &&
        !/2 passed/.test(run.output),
      `status=${run.status} output=${JSON.stringify(run.output.trim())}`,
    );
    check(
      "the run says how many modules it did not count, and why",
      run.output.includes("Not counted, not run: 1 module") &&
        run.output.includes(HELPER_REASON),
      run.output.trim().slice(0, 400),
    );
  } finally {
    rmSync(bench.dir, { recursive: true, force: true });
  }
}

// The repository's own tree: a manifest that drifted from it cannot hide here.
{
  const run = spawnSync(
    process.execPath,
    [join(scriptsDir, "check-suite-coverage.mjs")],
    { cwd: repoRoot, encoding: "utf-8", timeout: 120_000 },
  );
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  check(
    "the repository's own population passes the check",
    run.status === 0,
    `status=${run.status} output=${JSON.stringify(output.trim())}`,
  );
  check(
    "the repository's own summary states the population",
    /population: \d+ module\(s\) counted by the runner, \d+ declared a non-fixture/.test(output),
    output.trim(),
  );
}

for (const c of checks) {
  console.log(
    `${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : `  (${c.detail})`}`,
  );
}
const failed = checks.filter((c) => !c.pass).length;
console.log(
  failed === 0
    ? "fixture population pinned: the check refuses a counted module that asserts nothing and a declaration that hides a test"
    : `${failed} fixture-population check(s) failed`,
);
process.exitCode = failed === 0 ? 0 : 1;
