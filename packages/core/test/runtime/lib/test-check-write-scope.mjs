/**
 * test-check-write-scope.mjs — the production scan refuses a write whose
 * target can resolve into the session's project.
 *
 * The check reads the working tree of its own repo root, so each case runs a
 * copy of the script against a throwaway tree it owns and removes afterward.
 * The real checkout is never touched.
 *
 * Cases:
 *   1. a target resolved through a helper call is neutral -> exit 0
 *   2. `process.cwd()` in the target expression -> exit 1, naming file + line
 *   3. a bare relative literal target -> exit 1
 *   4. a `HOME || "."` fallback chain -> exit 1 (cwd-relative when unset)
 *   5. the same cwd base laundered through a local `const` -> exit 1
 *   6. `openSync(path, "r")` is a read -> exit 0; a write mode -> exit 1
 *   7. a test-tree file with the same cwd write is out of scope -> exit 0
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const SCRIPT = join(ROOT, "scripts", "check-write-scope.mjs");
const COLLECT = join(ROOT, "scripts", "lib", "collect-files.mjs");

/** Build a throwaway repo with one planted file, run the check, remove it. */
function runCase(relPath, content) {
  const tree = mkdtempSync(join(tmpdir(), "writescan-"));
  try {
    const scriptsDir = join(tree, "packages/core/scripts");
    mkdirSync(join(scriptsDir, "lib"), { recursive: true });
    copyFileSync(SCRIPT, join(scriptsDir, "check-write-scope.mjs"));
    copyFileSync(COLLECT, join(scriptsDir, "lib", "collect-files.mjs"));
    const planted = join(tree, relPath);
    mkdirSync(dirname(planted), { recursive: true });
    writeFileSync(planted, content + "\n");

    const r = spawnSync(
      "node",
      [join(scriptsDir, "check-write-scope.mjs")],
      { cwd: tree, encoding: "utf8" },
    );
    return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

const CLEAN = `import { writeFileSync } from "node:fs";
export function save(path: string, text: string): void {
  writeFileSync(path, text);
}`;

test("a caller-supplied path is neutral (exit 0, counts reported)", () => {
  const { status, out } = runCase("packages/core/src/clean.ts", CLEAN);
  assert.equal(status, 0, out);
  assert.match(out, /check-write-scope: clean/);
  assert.match(out, /write sites/);
});

test("a process.cwd() target is reported with file and line", () => {
  const content = `import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
const projectPath = join(process.cwd(), ".pi", "settings.json");
mkdirSync(dirname(projectPath), { recursive: true });`;
  const { status, out } = runCase("packages/core/src/leak.ts", content);
  assert.equal(status, 1, out);
  assert.match(out, /packages\/core\/src\/leak\.ts:4/);
  assert.match(out, /process\.cwd\(\)/);
  assert.match(out, /1 write\(s\) can resolve into the project/);
});

test("a bare relative literal target is reported", () => {
  const content = `import { writeFileSync } from "node:fs";
writeFileSync("settings.json", "{}");`;
  const { status, out } = runCase("packages/core/src/relative.ts", content);
  assert.equal(status, 1, out);
  assert.match(out, /relative-literal/);
  assert.match(out, /settings\.json/);
});

test('a HOME fallback chain ending in "." is reported', () => {
  const content = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.HOME || process.env.USERPROFILE || ".";
writeFileSync(join(home, ".key-ring-state.json"), "{}");`;
  const { status, out } = runCase("packages/core/src/fallback.ts", content);
  assert.equal(status, 1, out);
  assert.match(out, /dot-fallback/);
});

test("a cwd base laundered through a local const is still reported", () => {
  const content = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const out = join(process.cwd(), "stats.json");
writeFileSync(out, "{}");`;
  const { status, out } = runCase("packages/core/src/laundered.ts", content);
  assert.equal(status, 1, out);
  assert.match(out, /packages\/core\/src\/laundered\.ts:4/);
});

test('openSync with a read mode is not a write; a write mode is', () => {
  const readCase = `import { openSync, closeSync } from "node:fs";
import { join } from "node:path";
const fd = openSync(join(process.cwd(), "log.txt"), "r");
closeSync(fd);`;
  const read = runCase("packages/core/src/read-only.ts", readCase);
  assert.equal(read.status, 0, read.out);

  const writeCase = `import { openSync, closeSync } from "node:fs";
import { join } from "node:path";
const fd = openSync(join(process.cwd(), "log.txt"), "w");
closeSync(fd);`;
  const write = runCase("packages/core/src/write-mode.ts", writeCase);
  assert.equal(write.status, 1, write.out);
  assert.match(write.out, /packages\/core\/src\/write-mode\.ts:3/);
});

test("a test-tree file is out of the production scope", () => {
  const { status, out } = runCase(
    "packages/core/test/runtime/leak.test.mjs",
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.cwd(), "x.json"), "{}");`,
  );
  assert.equal(status, 0, out);
  assert.match(out, /check-write-scope: clean/);
});
