/**
 * check-doc-dates.mjs — the gate fails on a planted ISO date and passes a clean
 * tree.
 *
 * The production script scans the tracked tree of its own repo root, so each
 * case runs a copy of the script against a throwaway git tree it owns and
 * removes afterward. The real checkout is never touched.
 *
 * The date is assembled from parts, so this file carries no date literal of
 * its own and cannot plant itself.
 *
 * Cases:
 *   1. clean tree -> exit 0, PASS
 *   2. ISO date in body prose -> exit 1, FAIL, the file and line named
 *   3. ISO date under a History heading -> exit 0 (the documented dated-row seat)
 *   4. ISO date inside a fenced code block -> exit 0 (documented format example)
 *   5. ISO date in an EXCLUSIONS path -> exit 0 (documented allowance)
 *   6. no tracked .md at all -> exit 2 (an empty scan is an error, not a pass)
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
const SCRIPT = join(ROOT, "scripts", "check-doc-dates.mjs");
/** The gate imports ./lib/doc-text.mjs; the throwaway tree needs that module too. */
const SCRIPT_LIB = join(ROOT, "scripts", "lib");

const DATE = ["2026", "10", "01"].join("-");

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** Build a throwaway repo with one planted file, run the gate, remove it. */
function runCase(files) {
  const tree = mkdtempSync(join(tmpdir(), "dategate-"));
  try {
    const scriptsDir = join(tree, "packages/core/scripts");
    mkdirSync(scriptsDir, { recursive: true });
    cpSync(SCRIPT, join(scriptsDir, "check-doc-dates.mjs"));
    cpSync(SCRIPT_LIB, join(scriptsDir, "lib"), { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
      const planted = join(tree, relPath);
      mkdirSync(dirname(planted), { recursive: true });
      writeFileSync(planted, content);
    }
    git(tree, ["init", "-q"]);
    git(tree, ["add", "-A"]);

    const r = spawnSync("node", [join(scriptsDir, "check-doc-dates.mjs")], {
      cwd: tree,
      encoding: "utf8",
    });
    return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

test("a clean tree passes", () => {
  const { status, out } = runCase({ "README.md": "# Title\n\nA plain sentence.\n" });
  assert.equal(status, 0, out);
  assert.match(out, /Doc dates gate: PASS/);
});

test("an ISO date in body prose fails and names the file and line", () => {
  const { status, out } = runCase({
    "README.md": `# Title\n\nThis landed ${DATE} for reasons a reader cannot act on.\n`,
  });
  assert.equal(status, 1, out);
  assert.match(out, /Doc dates gate: FAIL/);
  assert.match(out, /README\.md:3/);
});

test("an ISO date under a History heading does not fail", () => {
  const { status, out } = runCase({
    "README.md": `# Title\n\n## Migration history\n\n| old | new | when |\n| - | - | ${DATE} |\n`,
  });
  assert.equal(status, 0, out);
  assert.match(out, /gate: PASS/);
});

test("an ISO date inside a fenced code block does not fail", () => {
  const { status, out } = runCase({
    "CONTRIBUTING.md": `# Title\n\n\`\`\`\n${DATE} - example range\n\`\`\`\n`,
  });
  assert.equal(status, 0, out);
  assert.match(out, /gate: PASS/);
});

test("an ISO date in an excluded path does not fail", () => {
  const { status, out } = runCase({
    "CHANGELOG.md": `# Changelog\n\n## Release\n\n- Something landed on ${DATE}.\n`,
  });
  assert.equal(status, 0, out);
  assert.match(out, /gate: PASS/);
});

test("no tracked .md is an error, not a passing scan", () => {
  const { status, out } = runCase({ "notes.txt": "no markdown here\n" });
  assert.equal(status, 2, out);
  assert.match(out, /ERROR/);
});
