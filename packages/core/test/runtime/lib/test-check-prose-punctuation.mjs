/**
 * check-prose-punctuation.mjs — the gate fails on a planted U+2014 and passes a
 * clean tree.
 *
 * The production script scans the tracked tree of its own repo root, so each
 * case runs a copy of the script against a throwaway git tree it owns and
 * removes afterward. The real checkout is never touched.
 *
 * The glyph is written as an escape, never as a literal, so this file cannot
 * plant itself.
 *
 * Cases:
 *   1. clean tree -> exit 0, PASS
 *   2. U+2014 on a body line -> exit 1, FAIL, the file and line named
 *   3. U+2014 inside a fenced code block -> exit 0 (code, not prose)
 *   4. U+2014 in YAML frontmatter -> exit 0 (machine-read catalog field)
 *   5. U+2014 in an EXCLUSIONS path -> exit 0 (documented allowance)
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
const SCRIPT = join(ROOT, "scripts", "check-prose-punctuation.mjs");
/** The gate imports ./lib/doc-text.mjs; the throwaway tree needs that module too. */
const SCRIPT_LIB = join(ROOT, "scripts", "lib");

const EM = "\u2014";

/** Build a throwaway repo with one planted file, run the gate, remove it. */
function runCase(files) {
  const tree = mkdtempSync(join(tmpdir(), "prosegate-"));
  try {
    const scriptsDir = join(tree, "packages/core/scripts");
    mkdirSync(scriptsDir, { recursive: true });
    cpSync(SCRIPT, join(scriptsDir, "check-prose-punctuation.mjs"));
    cpSync(SCRIPT_LIB, join(scriptsDir, "lib"), { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
      const planted = join(tree, relPath);
      mkdirSync(dirname(planted), { recursive: true });
      writeFileSync(planted, content);
    }
    git(tree, ["init", "-q"]);
    git(tree, ["add", "-A"]);

    const r = spawnSync("node", [join(scriptsDir, "check-prose-punctuation.mjs")], {
      cwd: tree,
      encoding: "utf8",
    });
    return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

test("a clean tree passes", () => {
  const { status, out } = runCase({ "README.md": "# Title\n\nA plain sentence.\n" });
  assert.equal(status, 0, out);
  assert.match(out, /Prose punctuation gate: PASS/);
});

test("U+2014 on a body line fails and names the file and line", () => {
  const { status, out } = runCase({
    "README.md": `# Title\n\nA sentence with a dash ${EM} here.\n`,
  });
  assert.equal(status, 1, out);
  assert.match(out, /Prose punctuation gate: FAIL/);
  assert.match(out, /README\.md:3/);
});

test("U+2014 inside a fenced code block does not fail", () => {
  const { status, out } = runCase({
    "README.md": `# Title\n\n\`\`\`\nconst dash = "${EM}";\n\`\`\`\n`,
  });
  assert.equal(status, 0, out);
  assert.match(out, /gate: PASS/);
});

test("U+2014 in YAML frontmatter does not fail", () => {
  const { status, out } = runCase({
    "skill.md": `---\ndescription: a dash ${EM} in the catalog field\n---\n\n# Title\n\nBody.\n`,
  });
  assert.equal(status, 0, out);
  assert.match(out, /gate: PASS/);
});

test("U+2014 in an excluded path does not fail", () => {
  const { status, out } = runCase({
    "CHANGELOG.md": `# Changelog\n\nA release note with a dash ${EM} kept.\n`,
  });
  assert.equal(status, 0, out);
  assert.match(out, /gate: PASS/);
  assert.match(out, /Excluded files\+hits: 1/);
});

test("no tracked .md is an error, not a passing scan", () => {
  const { status, out } = runCase({ "notes.txt": "no markdown here\n" });
  assert.equal(status, 2, out);
  assert.match(out, /ERROR/);
});
