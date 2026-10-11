/**
 * test-fixture-guard.mjs: the guard refuses a verdict from a fixture that cannot run.
 *
 * Cases:
 *   1. a syntactically broken .mjs fixture is rejected, and the message names the file
 *   2. a broken .ts fixture is rejected with its parse diagnostics
 *   3. a valid fixture of each kind passes and the guard returns its resolved path
 *   4. the type-level mutant: deleting a discriminant from a union parses clean
 *      and is caught only by the typecheck path, which also leaves the fixture's
 *      directory byte-identical (the guard writes nothing)
 *   5. load-bearing: a copy of an adopted arm with the guard removed reads a
 *      broken mutant's exit status as RED and then fails at its own RED
 *      expectation, while the same copy passes with a valid mutant and the
 *      guard rejects the broken mutant by name before any verdict is read
 *
 * Case 5 reads the adopted arm's source and mutates the copy in memory, so the
 * adopted test is not touched: the copy is written into a scratch tree with the
 * same relative depth, which is what its own root resolution needs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertFixtureParses, assertFixtureTypechecks } from "./fixture-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADOPTED_ARM = join(HERE, "test-placement-budget.mjs");
const ADOPTED_SCRIPT = join(HERE, "../../..", "scripts", "check-placement.mjs");

const BROKEN_MJS = "export const broken = (\n";
const BROKEN_TS = "export function broken( { return 1 }\n";
const VALID_MJS = "export const ok = 1;\n";
const VALID_TS = [
  "export type Shape = { kind: \"circle\"; radius: number } | { kind: \"square\"; side: number };",
  "",
  "export function area(shape: Shape): number {",
  "  switch (shape.kind) {",
  "    case \"circle\":",
  "      return Math.PI * shape.radius ** 2;",
  "    case \"square\":",
  "      return shape.side ** 2;",
  "  }",
  "}",
  "",
].join("\n");
/** The same union with the second member's discriminant deleted: still parseable. */
const DISCRIMINANT_MUTANT_TS = [
  "export type Shape = { kind: \"circle\"; radius: number } | { side: number };",
  "",
  "export function area(shape: Shape): number {",
  "  switch (shape.kind) {",
  "    case \"circle\":",
  "      return Math.PI * shape.radius ** 2;",
  "    default:",
  "      return 0;",
  "  }",
  "}",
  "",
].join("\n");

/** A scratch tree holding the named files, plus a tsconfig when asked. */
function fixtureTree(files, { tsconfig = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fixture-guard-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  if (tsconfig) {
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] } }, null, 2),
    );
  }
  return dir;
}

/** Every file under `dir` with its size and mtime, for a before/after compare. */
function treeSnapshot(dir) {
  const entries = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const stat = statSync(full);
      entries.push(`${full} ${stat.size} ${stat.mtimeMs}`);
    }
  };
  walk(dir);
  return entries.sort();
}

test("a broken .mjs fixture is rejected and the message names the file", () => {
  const dir = fixtureTree({ "broken.mjs": BROKEN_MJS }, { tsconfig: false });
  try {
    const broken = join(dir, "broken.mjs");
    assert.throws(
      () => assertFixtureParses(broken),
      (error) => {
        assert.ok(
          error.message.startsWith(`fixture does not parse: ${broken}`),
          `the first line must name the fixture, got: ${error.message.split("\n")[0]}`,
        );
        assert.match(error.message, /SyntaxError/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a broken .ts fixture is rejected with its parse diagnostics", () => {
  const dir = fixtureTree({ "broken.ts": BROKEN_TS });
  try {
    const broken = join(dir, "broken.ts");
    assert.throws(
      () => assertFixtureParses(broken),
      (error) => {
        assert.ok(
          error.message.startsWith(`fixture does not parse: ${broken}`),
          `the first line must name the fixture, got: ${error.message.split("\n")[0]}`,
        );
        assert.match(error.message, /TS1\d{3}/, "the parse diagnostics must be reported");
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a valid fixture of each kind passes and returns its resolved path", () => {
  const dir = fixtureTree({ "ok.mjs": VALID_MJS, "ok.ts": VALID_TS });
  try {
    for (const name of ["ok.mjs", "ok.ts"]) {
      const file = join(dir, name);
      assert.equal(assertFixtureParses(file), file, `${name} must pass and return its path`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mutant that only removes a discriminant is caught by the typecheck path", () => {
  const dir = fixtureTree({ "mutant.ts": DISCRIMINANT_MUTANT_TS });
  try {
    const mutant = join(dir, "mutant.ts");
    // The parse path is blind to this class by construction, which is why the
    // typecheck path exists: the mutant parses, and cannot compile.
    assert.equal(assertFixtureParses(mutant), mutant);

    const before = treeSnapshot(dir);
    assert.throws(
      () => assertFixtureTypechecks(mutant),
      (error) => {
        assert.ok(
          error.message.startsWith(`fixture does not typecheck: ${mutant}`),
          `the first line must name the fixture, got: ${error.message.split("\n")[0]}`,
        );
        assert.match(error.message, /TS2339/, "the missing discriminant must be the reported error");
        return true;
      },
    );
    assert.deepEqual(treeSnapshot(dir), before, "the typecheck path must not write to the fixture tree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mutant in a tree with no tsconfig above it is caught by the default flags", () => {
  const dir = fixtureTree({ "mutant.ts": DISCRIMINANT_MUTANT_TS }, { tsconfig: false });
  try {
    const mutant = join(dir, "mutant.ts");
    assert.throws(
      () => assertFixtureTypechecks(mutant),
      (error) => {
        assert.ok(error.message.includes(mutant), "the message must name the fixture");
        assert.match(error.message, /TS2339/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a guard-free copy of an adopted arm reads a broken mutant as RED", () => {
  const bench = mkdtempSync(join(tmpdir(), "fixture-guard-arm-"));
  try {
    const scriptsDir = join(bench, "packages", "core", "scripts");
    const libDir = join(bench, "packages", "core", "test", "runtime", "lib");
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(libDir, { recursive: true });
    // The copy resolves its own root from its location, so it needs the script
    // it mutates at the same relative depth.
    writeFileSync(join(scriptsDir, "check-placement.mjs"), readFileSync(ADOPTED_SCRIPT, "utf8"));

    const arm = readFileSync(ADOPTED_ARM, "utf8");
    /** The adopted arm with the guard removed; optionally building a broken mutant. */
    const copyOfArm = (name, { breakFixture }) => {
      const withoutImport = arm.replace(
        /^import \{ assertFixtureParses \} from "\.\/fixture-guard\.mjs";\n/m,
        "",
      );
      assert.notEqual(withoutImport, arm, "the adopted arm must import the guard");
      const withoutCall = withoutImport.replace("\n    assertFixtureParses(copy);", "");
      assert.notEqual(withoutCall, withoutImport, "the adopted arm must guard the mutant it builds");
      const source = breakFixture
        ? withoutCall.replace(
            "  return mutated;",
            '  return mutated + "\\n/* mutant left unterminated";',
          )
        : withoutCall;
      if (breakFixture) {
        assert.notEqual(source, withoutCall, "the copy must break the mutant it builds");
      }
      const copyPath = join(libDir, name);
      writeFileSync(copyPath, source);
      return copyPath;
    };

    const control = copyOfArm("arm-copy.mjs", { breakFixture: false });
    const treatment = copyOfArm("arm-copy-broken.mjs", { breakFixture: true });
    for (const gitArgs of [["init", "-q"], ["add", "-A"]]) {
      const git = spawnSync("git", gitArgs, { cwd: bench, encoding: "utf8" });
      assert.equal(git.status, 0, `git ${gitArgs.join(" ")} failed: ${git.stderr}`);
    }

    // Control: the same copy, guard removed, builds a mutant that runs.
    const controlRun = spawnSync("node", [control], { cwd: bench, encoding: "utf8" });
    assert.equal(
      controlRun.status,
      0,
      `the copy must pass when the mutant it builds is valid:\n${controlRun.stdout ?? ""}${controlRun.stderr ?? ""}`,
    );

    const run = spawnSync("node", [treatment], { cwd: bench, encoding: "utf8" });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    assert.notEqual(run.status, 0, `the guard-free copy must fail:\n${output}`);
    assert.match(
      output,
      /budget failure message missing/,
      "the copy must fail at the RED arm's own expectation",
    );
    assert.match(output, /SyntaxError/, "the run it read as RED was a mutant that could not parse");

    // The same mutant, through the guard the copy dropped: rejected by name,
    // before any verdict is read.
    const mutant = join(bench, "mutant.mjs");
    writeFileSync(mutant, `${readFileSync(ADOPTED_SCRIPT, "utf8")}\n/* mutant left unterminated`);
    assert.throws(
      () => assertFixtureParses(mutant),
      (error) => {
        assert.ok(
          error.message.startsWith(`fixture does not parse: ${mutant}`),
          `the guard must name the mutant, got: ${error.message.split("\n")[0]}`,
        );
        return true;
      },
    );
  } finally {
    rmSync(bench, { recursive: true, force: true });
  }
});
