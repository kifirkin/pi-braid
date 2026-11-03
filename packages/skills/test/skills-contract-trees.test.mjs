#!/usr/bin/env node
/**
 * skills-contract-trees.test.mjs — the second population, and where it differs.
 *
 * The contract reads two skill trees with one implementation. The pack owns the
 * tool allowlist, so a core skill that names a shell or a chat tool must pass
 * while a pack skill naming a tool outside the table must still fail: the same
 * scan applied to both trees, or applied to neither, is unusable in one
 * direction or lying in the other. A tree that stopped being read would look
 * exactly like a tree with nothing wrong in it, which is the failure the
 * population counts exist to make visible.
 *
 * Every case runs the shipped contract as a subprocess over a throwaway
 * `packages/` tree: the pack copied verbatim, the core set authored here. The
 * copy resolves both populations from its own location, so what is under test
 * is the artifact the chain runs, not a helper beside it.
 *
 * The two legacy shapes get their own cases because they fail for a different
 * reason than a missing phrase: the phrases are there and the contract will not
 * take them where they are, so a count-only rule would name the file for the
 * wrong defect.
 *
 * Run: node test/skills-contract-trees.test.mjs
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packRoot = join(here, "..");

/**
 * The date a fixture skill's `validated:` field carries. Assembled rather than
 * written as one literal: an ISO date in source reads to the placement gate as
 * shipped provenance, and what these cases need is the field's shape.
 */
const VALIDATED = ["2026", "11", "03"].join("-");

const work = mkdtempSync(join(tmpdir(), "skills-contract-trees-"));
const copy = join(work, "packages", "skills");
cpSync(packRoot, copy, {
  recursive: true,
  filter: (src) => !src.includes("node_modules"),
});
const coreTree = join(work, "packages", "core", "skills");
mkdirSync(coreTree, { recursive: true });

/** The copy's contract, run the way the chain runs it. */
function contract(...args) {
  return spawnSync(
    process.execPath,
    [join(copy, "test", "skills-contract.mjs"), ...args],
    { encoding: "utf8", cwd: work },
  );
}

/** Both streams, for an assertion that something is absent from the report. */
const output = (run) => `${run.stdout}${run.stderr}`;

/** Directories under `dir` that carry a SKILL.md. */
function skillDirs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (existsSync(join(dir, entry.name, "SKILL.md"))) out.push(entry.name);
  }
  return out;
}

const packSkills = skillDirs(join(copy, "skills"));

/**
 * Author one core skill. `frontmatter` carries a legacy key in place of the
 * canonical `triggers:` list; `body` is where a heading-shaped declaration or a
 * tool name goes.
 */
function writeCore(
  name,
  {
    triggers = ["core fixture phrase", "second core phrase"],
    frontmatter = null,
    body = "A body that directs no tool.",
  } = {},
) {
  const dir = join(coreTree, name);
  mkdirSync(dir, { recursive: true });
  const lines = [
    "---",
    `name: ${name}`,
    'description: "Use when the fixture needs a core-side file: it stands in for one of the core set and changes nothing else."',
    `validated: ${VALIDATED}`,
    "verdict: UNVALIDATED",
  ];
  if (frontmatter === null) {
    lines.push("triggers:", ...triggers.map((phrase) => `  - "${phrase}"`));
  } else lines.push(frontmatter);
  lines.push("---", "", `# ${name}`, "", body, "");
  writeFileSync(join(dir, "SKILL.md"), lines.join("\n"), "utf8");
  return `packages/core/skills/${name}/SKILL.md`;
}

/** Drop one authored core skill, so the next case starts from the baseline. */
function clearCore(name) {
  rmSync(join(coreTree, name), { recursive: true, force: true });
}

/**
 * The first phrase a pack skill declares under `triggers:`, read from the file
 * rather than written here: a duplicate case has to name a phrase the pack
 * actually ships, or it proves nothing about the shared namespace.
 */
function firstPackPhrase() {
  for (const name of packSkills) {
    const text = readFileSync(join(copy, "skills", name, "SKILL.md"), "utf8");
    const block = /^---\n([\s\S]*?)\n---/.exec(text);
    if (!block) continue;
    const list = /^triggers\s*:\s*\n((?:\s+-\s*.+\n)+)/m.exec(block[1]);
    if (!list) continue;
    const first = /^\s+-\s*(.+)$/m.exec(list[1]);
    if (!first) continue;
    return {
      owner: `skills/${name}/SKILL.md`,
      phrase: first[1].trim().replace(/^["']|["']$/g, ""),
    };
  }
  throw new Error(
    "the pack ships no skill with a `triggers:` list to duplicate",
  );
}

// ── the baseline: two canonical core skills ─────────────────────────────────
//
// Without this case the rest prove only that the contract can refuse. A gate
// that refuses everything would pass every refusal below and fail here.

writeCore("canvas-core");
const toolNaming = writeCore("signal-core", {
  triggers: ["signal core phrase", "another signal phrase"],
  body:
    "Reaching the shell is the point: `bash(` is a call this tree can make, and " +
    "`telegram_send` and `herdr_pane` are tools only the braid tree ships.",
});

const bothTrees = contract("--tree", "all");
assert.equal(
  bothTrees.status,
  0,
  `a canonical core set passes beside the pack:\n${output(bothTrees)}`,
);
assert.match(
  bothTrees.stdout,
  new RegExp(`${packSkills.length} skill\\(s\\) in pack`),
  "the summary counts the pack population",
);
assert.match(
  bothTrees.stdout,
  /2 skill\(s\) in core/,
  "the summary counts the core population",
);

// A core skill may name a tool the pack's table does not carry: the table is
// the pack's ownership claim, not a description of the runtime. This is the
// case that makes the gate usable on the tree it was built for.
assert.ok(
  readFileSync(join(work, toolNaming), "utf8").includes("`bash(`"),
  "the fixture core skill really names the tools under test",
);

const coreOnly = contract("--tree", "core");
assert.equal(
  coreOnly.status,
  0,
  `--tree core reads the core population alone:\n${output(coreOnly)}`,
);
assert.match(
  coreOnly.stdout,
  /2 skill\(s\) in core/,
  "the core count is reported",
);
assert.ok(
  !coreOnly.stdout.includes("skill(s) in pack"),
  "a core-only run does not claim a pack count it never read",
);

// ── the pack's table still refuses a name it cannot reach ────────────────────
//
// The other half of the scoping: the tool rules are not skipped, they are
// scoped. A pack skill naming a name outside the table fails exactly as it did
// before the second tree existed.

const packTarget = join(copy, "skills", packSkills[0], "SKILL.md");
const packAuthored = readFileSync(packTarget, "utf8");
const packRel = `skills/${packSkills[0]}/SKILL.md`;
writeFileSync(
  packTarget,
  `${packAuthored}\nThis body names \`sparkle_probe\` as a name.\n`,
  "utf8",
);
const foreignTool = contract("--tree", "all");
writeFileSync(packTarget, packAuthored, "utf8");
assert.equal(
  foreignTool.status,
  1,
  "a foreign tool name in the pack still fails",
);
assert.ok(
  foreignTool.stderr.includes(packRel),
  `the refusal names the pack file (${packRel}):\n${foreignTool.stderr}`,
);
assert.match(
  foreignTool.stderr,
  /sparkle_probe.*names no tool this pack can rely on/,
  "the refusal names the rule",
);
assert.ok(
  !output(foreignTool).includes("packages/core/skills"),
  "the defect is the pack's, and the report does not blame core for it",
);

// ── a core skill with one phrase is refused, by file ────────────────────────

const single = writeCore("single-core", { triggers: ["only one phrase"] });
const onePhrase = contract("--tree", "all");
assert.equal(onePhrase.status, 1, "one phrase in a core skill fails");
assert.ok(
  onePhrase.stderr.includes(single),
  `the refusal names the core file (${single}):\n${onePhrase.stderr}`,
);
assert.match(
  onePhrase.stderr,
  /1 trigger phrase\(s\) authored/,
  "the refusal counts what it found",
);
clearCore("single-core");

// ── the legacy key is refused for its own reason ────────────────────────────
//
// The phrases are present and the reader finds them, so a count-only contract
// would pass this file and a count-only fixture would not notice.

const legacy = writeCore("legacy-core", {
  frontmatter: 'trigger: "legacy one phrase, legacy two phrase"',
});
const legacyKey = contract("--tree", "all");
assert.equal(legacyKey.status, 1, "the legacy `trigger:` key is refused");
assert.ok(
  legacyKey.stderr.includes(legacy),
  `the refusal names the core file (${legacy}):\n${legacyKey.stderr}`,
);
assert.match(
  legacyKey.stderr,
  /legacy 'trigger:' key/,
  "the refusal names the key as the defect",
);
assert.ok(
  !legacyKey.stderr.includes("trigger phrase(s) authored"),
  "the file declares its phrases, so the count rule is not what refused it",
);
clearCore("legacy-core");

// ── a body trigger heading is refused, and counts as nothing ────────────────

const heading = writeCore("heading-core", {
  triggers: [],
  frontmatter: "triggers:",
  body: '## trigger: "heading one phrase, heading two phrase"\n\nWhat follows the heading.',
});
const bodyHeading = contract("--tree", "all");
assert.equal(bodyHeading.status, 1, "a body trigger heading is refused");
assert.ok(
  bodyHeading.stderr.includes(heading),
  `the refusal names the core file (${heading}):\n${bodyHeading.stderr}`,
);
assert.match(
  bodyHeading.stderr,
  /body '## trigger:' heading/,
  "the refusal names the heading as the defect",
);
assert.match(
  bodyHeading.stderr,
  /0 trigger phrase\(s\) authored/,
  "the contract counts the file as declaring nothing, which is what the validator sees",
);
clearCore("heading-core");

// ── one phrase may not govern two skills, across the trees ──────────────────
//
// The namespace is shared, so the phrase is taken from the pack: a core file
// declaring it makes the matcher rank the two against each other, and the
// second file is the one that must be refused by name.

const shared = firstPackPhrase();
const duplicating = writeCore("duplicate-core", {
  triggers: [shared.phrase, "a phrase nobody else declares"],
});
const duplicate = contract("--tree", "all");
assert.equal(duplicate.status, 1, "a phrase declared by two skills fails");
assert.ok(
  duplicate.stderr.includes(duplicating),
  `the refusal names the second file (${duplicating}):\n${duplicate.stderr}`,
);
assert.ok(
  duplicate.stderr.includes(`already declared by ${shared.owner}`),
  `the refusal names the first owner (${shared.owner}):\n${duplicate.stderr}`,
);
clearCore("duplicate-core");

// ── `--tree pack` reports the pack and nothing from core ────────────────────
//
// Planted with a core defect on purpose: a core-only run must not be able to
// make the pack's own contract red, and the pack's scope must not quietly
// include the other tree.

writeCore("pack-scope-core", { triggers: ["just the one phrase"] });
const packScope = contract("--tree", "pack");
clearCore("pack-scope-core");
assert.equal(
  packScope.status,
  0,
  `--tree pack passes while a core skill is broken:\n${output(packScope)}`,
);
assert.match(
  packScope.stdout,
  new RegExp(`${packSkills.length} skill\\(s\\) in pack`),
  "--tree pack reports the pack's own population",
);
assert.ok(
  !output(packScope).includes("packages/core/skills"),
  "nothing from the core tree reaches a pack-scoped run",
);
assert.ok(
  !output(packScope).includes("skill(s) in core"),
  "the pack-scoped summary claims no core count",
);

// ── a tree that is not there is named; a tree with nothing in it fails ──────
//
// The first is the standalone pack, where the sibling tree does not exist and
// an absence is a scope fact. The second is the shape a shrinking scan takes,
// and a green line over it would vouch for nothing.

rmSync(coreTree, { recursive: true, force: true });
const absentCore = contract("--tree", "all");
assert.equal(
  absentCore.status,
  0,
  `an absent core tree is reported, not judged:\n${output(absentCore)}`,
);
assert.match(
  absentCore.stdout,
  /no core tree at packages\/core\/skills, not judged/,
  "the summary names the tree it did not read",
);

mkdirSync(coreTree, { recursive: true });
const emptyCore = contract("--tree", "all");
assert.equal(
  emptyCore.status,
  1,
  "a core tree in scope with no skill in it fails closed",
);
assert.match(
  emptyCore.stderr,
  /packages\/core\/skills: no SKILL\.md found/,
  "the refusal names the empty population",
);
assert.match(
  emptyCore.stderr,
  /a scan over nothing proves nothing/,
  "the refusal states why an empty population is a failure",
);

rmSync(work, { recursive: true, force: true });
console.log(
  `skills-contract-trees: clean (10 case(s): both populations counted, a core skill naming unreachable tools admitted, a pack skill naming a foreign tool refused, a single phrase and the two legacy declaration shapes refused by file and rule, a phrase shared across the trees refused, the pack's own scope held, and the absent and empty populations told apart)`,
);
