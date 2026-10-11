/**
 * test-check-private-data.mjs — the fixture rule accepts a synthetic slug in a
 * test file and refuses a real-looking path everywhere else.
 *
 * The production check scans the working tree of its own repo root, so each
 * case runs a copy of the script against a throwaway git tree it owns and
 * removes afterward. The real checkout is never touched.
 *
 * Cases:
 *   1. synthetic user segment in a test file -> exit 0, counted as allowed
 *   2. the same synthetic segment in a source file -> exit 1 (source has no
 *      allowance; the rule is not a blanket test/ exemption)
 *   3. a non-synthetic segment in a test file -> exit 1
 *   4. a real-looking home path in a source file -> exit 1
 *
 * Path literals are assembled from parts so this file carries none of its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const SCRIPT = join(ROOT, "scripts", "check-private-data.mjs");

const SYNTH_TEST = ["--Users", "tester", "proj--"].join("-");
const SYNTH_SOURCE = ["--Users", "tester", "secret--"].join("-");
const FOREIGN_TEST = ["--Users", "jdoe", "proj--"].join("-");
const REAL_SOURCE = ["/Users", "jdoe", "secret"].join("/");

const GITIGNORE = [".braid/", "*.jsonl", ".tgz", ".env", "dist/", ""].join("\n");

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** Build a throwaway repo with one planted file, run the check, remove it. */
function runCase(relPath, content) {
  const tree = mkdtempSync(join(tmpdir(), "privcheck-"));
  try {
    const scriptsDir = join(tree, "packages/core/scripts");
    mkdirSync(scriptsDir, { recursive: true });
    cpSync(SCRIPT, join(scriptsDir, "check-private-data.mjs"));
    writeFileSync(join(tree, ".gitignore"), GITIGNORE);
    const planted = join(tree, relPath);
    mkdirSync(dirname(planted), { recursive: true });
    writeFileSync(planted, content + "\n");
    git(tree, ["init", "-q"]);
    git(tree, ["add", "-A"]);

    const r = spawnSync("node", [join(scriptsDir, "check-private-data.mjs")], {
      cwd: tree,
      encoding: "utf8",
    });
    return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

test("synthetic slug in a test file is allowed and counted", () => {
  const { status, out } = runCase(
    "packages/core/test/runtime/memory/test-fixture.mjs",
    `const dir = "${SYNTH_TEST}";`,
  );
  assert.equal(status, 0, out);
  assert.match(out, /PASS/);
  assert.match(out, /Synthetic fixtures allowed: 1/);
});

test("the same synthetic slug in a source file is still reported", () => {
  const { status, out } = runCase(
    "packages/core/src/leak.ts",
    `const dir = "${SYNTH_SOURCE}";`,
  );
  assert.equal(status, 1, out);
  assert.match(out, /FAIL/);
  assert.match(out, /packages\/core\/src\/leak\.ts/);
});

test("a non-synthetic slug in a test file is reported (no blanket test/ exemption)", () => {
  const { status, out } = runCase(
    "packages/core/test/runtime/memory/test-leaky.mjs",
    `const dir = "${FOREIGN_TEST}";`,
  );
  assert.equal(status, 1, out);
  assert.match(out, /packages\/core\/test\/runtime\/memory\/test-leaky\.mjs/);
});

test("a real-looking home path in a source file is reported", () => {
  const { status, out } = runCase(
    "packages/core/src/leak2.ts",
    `const dir = "${REAL_SOURCE}";`,
  );
  assert.equal(status, 1, out);
  assert.match(out, /packages\/core\/src\/leak2\.ts/);
});
