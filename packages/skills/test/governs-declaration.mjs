#!/usr/bin/env node
/**
 * governs-declaration.mjs — the `governs:` key, admitted and refused.
 *
 * The declaration is optional authored data, so "the contract accepts it" is
 * not one behaviour but two: a file that declares no family must pass (most
 * bodies direct no tool), and a file that declares one must pass only when the
 * entry is a family the pack admits. A contract that admitted everything would
 * let a skill claim a family no reader can ever see called; one that required
 * the key would force every prose skill to invent a family to stay green.
 *
 * Every case runs the shipped contract as a subprocess over a throwaway copy of
 * the pack, so the assertions are about the artifact a release ships rather
 * than about an exported helper the contract might not call. The copy resolves
 * its own `skills/` directory — no path override, no test-only seam.
 *
 * Run: npm test -w packages/skills
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packRoot = join(here, "..");

const work = mkdtempSync(join(tmpdir(), "governs-declaration-"));
cpSync(packRoot, work, {
  recursive: true,
  filter: (src) => !src.includes("node_modules"),
});

/** The copied pack's skill files, in directory order (a fragment dir has none). */
function skillFiles(dir = join(work, "skills")) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const file = join(dir, entry.name, "SKILL.md");
    if (existsSync(file)) out.push(file);
  }
  return out;
}

/** Run the copy's contract as a release would. */
function runContract() {
  return spawnSync(
    process.execPath,
    [join(work, "test", "skills-contract.mjs")],
    {
      encoding: "utf8",
    },
  );
}

/** The frontmatter block, and the file with it replaced. */
function splitFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, "fixture file opens with a frontmatter block");
  return { front: match[1], whole: match[0] };
}

/** Drop the `governs:` key and its block-list items, keeping every other line. */
function stripGoverns(front) {
  const lines = front.split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^governs\s*:/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) j++;
      i = j - 1;
      continue;
    }
    kept.push(lines[i]);
  }
  return kept.join("\n");
}

/** The file with `governs:` set to `declaration` (null removes the key). */
function withGoverns(text, declaration) {
  const { front, whole } = splitFrontmatter(text);
  let next = stripGoverns(front);
  if (declaration) next = `${next}\n${declaration}`;
  return text.replace(whole, `---\n${next}\n---\n`);
}

/** Write one mutated file and run the contract against the copy. */
function contractOn(file, text) {
  const original = readFileSync(file, "utf8");
  writeFileSync(file, text, "utf8");
  try {
    return runContract();
  } finally {
    writeFileSync(file, original, "utf8");
  }
}

const files = skillFiles();
assert.ok(files.length > 0, "the pack ships at least one skill");
const declared = files.find((file) =>
  /^governs\s*:/m.test(splitFrontmatter(readFileSync(file, "utf8")).front),
);
const target = declared ?? files[0];
const rel = relative(work, target);
const original = readFileSync(target, "utf8");

// The authored pack, held so a mutated copy can be restored between cases.
const authored = new Map(
  files.map((file) => [file, readFileSync(file, "utf8")]),
);

// ── admitted ─────────────────────────────────────────────────────────────────

const shipped = runContract();
assert.equal(
  shipped.status,
  0,
  `the shipped pack passes its contract:\n${shipped.stderr}`,
);
assert.match(shipped.stdout, /clean \(\d+ skill\(s\)/);

for (const [file, text] of authored)
  writeFileSync(file, withGoverns(text, null), "utf8");
const withoutDeclaration = runContract();
assert.equal(
  withoutDeclaration.status,
  0,
  `a file that declares no family is admitted:\n${withoutDeclaration.stderr}`,
);
assert.match(
  withoutDeclaration.stdout,
  new RegExp(
    `0 family declaration\\(s\\) over 0 file\\(s\\), ${files.length} declaring none`,
  ),
  "the summary states how many files declare nothing instead of staying silent about them",
);
// Restore the authored pack for the refusal cases below.
for (const [file, text] of authored) writeFileSync(file, text, "utf8");

// ── refused, by name ────────────────────────────────────────────────────────

const REFUSALS = [
  {
    id: "absent-value",
    declaration: "governs:",
    expect: "'governs:' names no family",
  },
  {
    id: "malformed-token",
    declaration: "governs:\n  - Document_2",
    expect: "governs entry 'Document_2' is not a tool-family token",
  },
  {
    id: "detector-tool",
    declaration: "governs:\n  - read",
    expect: "governs entry 'read' is the read detector's own tool",
  },
  {
    id: "unknown-family",
    declaration: "governs:\n  - sparkle",
    expect: "governs entry 'sparkle' is no family this pack admits",
  },
  {
    id: "duplicate",
    declaration: "governs:\n  - document\n  - document",
    expect: "governs entry 'document' is declared twice",
  },
  {
    id: "over-cap",
    declaration:
      "governs:\n  - document\n  - browser\n  - widget\n  - gadget\n  - gizmo",
    expect: "5 declared families; the reader keeps the first 4",
  },
];

for (const { id, declaration, expect } of REFUSALS) {
  const run = contractOn(target, withGoverns(original, declaration));
  assert.equal(run.status, 1, `${id}: the contract refuses it (exit 1)`);
  assert.ok(
    run.stderr.includes(expect),
    `${id}: the refusal names the entry. Expected "${expect}", got:\n${run.stderr}`,
  );
  assert.ok(
    run.stderr.includes(rel),
    `${id}: the refusal names the file (${rel})`,
  );
}

// The comma-string form is the other shape the runtime reader accepts; a pack
// that admitted one form and not the other would ship a declaration with no
// reader in production.
const commaString = contractOn(
  target,
  withGoverns(original, "governs: document, browser"),
);
assert.equal(
  commaString.status,
  0,
  `the comma-string form is admitted like the block list:\n${commaString.stderr}`,
);

rmSync(work, { recursive: true, force: true });
console.log(
  `governs-declaration: clean (${files.length} file(s): absent admitted, block list and comma string admitted, ${REFUSALS.length} malformed declaration(s) refused by name and file)`,
);
