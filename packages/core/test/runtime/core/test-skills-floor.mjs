/**
 * Skills floor — the visible catalog section.
 *
 * Contract:
 *   1. Every visible skill renders as one row, `- name: description`, and the
 *      description is NOT clipped: the row is the whole reason the floor
 *      works, so the longest description in the pack appears verbatim.
 *   2. The read path is derived from the entries' own file paths, never
 *      hardcoded. A single pack states one root; a catalog installed from
 *      several packs (a package pack plus the user-global directory, which is
 *      what a real session carries) renders a directory heading per pack.
 *      The stated path RESOLVES for every row — the fixture stats each one,
 *      so a derivation that drifts from pi's `<pack>/<name>/SKILL.md` layout
 *      fails here rather than sending a model at a path that does not exist.
 *   3. The obligation sentence survives ("read the WHOLE SKILL.md before
 *      acting in that domain; never act from memory of a skill's contents")
 *      and the superseded pointer instructions are gone: the catalog is in
 *      the prompt, so "call list_skills once to see the catalog" and the
 *      "catalog is paginated" clause are not true any more.
 *   4. An empty catalog renders no section at all: a section claiming to list
 *      every skill while listing none is a lie the model cannot check.
 *   5. The render is a pure function of its inputs: the same catalog in any
 *      order renders byte-identical text, and no install location or skill
 *      name is baked into the module.
 *
 * Run: node test/runtime/core/test-skills-floor.mjs
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE = join(__dirname, "..", "..", "..");
const DIST = join(CORE, "dist", "extensions", "core", "skills-tool");

const {
  catalogGroups,
  catalogRows,
  mechanicalTriggerExamples,
  skillReadRoot,
  skillsLoadingText,
  SKILLS_POINTER_RULE,
} = await import(join(DIST, "loading-guidance.js"));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${e.message}`);
  }
}

// ── fixtures ───────────────────────────────────────────────────────────────

/** First `key: value` line for `key` in a frontmatter block, or null. */
function field(front, key) {
  const match = new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(front);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : null;
}

function frontmatterOf(text) {
  if (!text.startsWith("---")) return "";
  const end = text.indexOf("\n---", 3);
  return end < 0 ? "" : text.slice(4, end);
}

/** Read a pack directory into catalog entries, the way the cache holds them. */
function readPack(packDir) {
  const entries = [];
  for (const dir of readdirSync(packDir).sort()) {
    const filePath = join(packDir, dir, "SKILL.md");
    let text;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const front = frontmatterOf(text);
    entries.push({
      name: field(front, "name") ?? dir,
      description: field(front, "description") ?? "",
      filePath,
    });
  }
  return entries;
}

const REPO_PACK = join(CORE, "skills");
const REPO_ENTRIES = readPack(REPO_PACK);
const TOOLS = [
  "read",
  "write",
  "edit",
  "bash",
  "list_skills",
  "herdr_layout",
  "document_parse",
  "memory_store",
  "fetch_content",
];

/** A temp pack of skills whose names and descriptions the fixture controls. */
function makePack(root, skills) {
  for (const [name, description] of skills) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`);
  }
  return readPack(root);
}

/** Every `<dir>/<name>/SKILL.md` path the section states, by row order. */
function statedPaths(text, entries) {
  const paths = [];
  let currentPack = skillReadRoot(entries) || undefined;
  for (const line of text.split("\n")) {
    if (/^\//.test(line)) {
      currentPack = line;
      continue;
    }
    if (!line.startsWith("- ")) continue;
    const name = line.slice(2).split(":")[0];
    paths.push(currentPack ? join(currentPack, name, "SKILL.md") : undefined);
  }
  return paths;
}

// ── 1. the real pack ───────────────────────────────────────────────────────

const repoText = skillsLoadingText(TOOLS, REPO_ENTRIES);

test("one row per visible skill, in the `- name: description` form", () => {
  const rows = repoText.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(rows.length, REPO_ENTRIES.length, `rows ${rows.length} vs ${REPO_ENTRIES.length}`);
  for (const entry of REPO_ENTRIES) {
    const row = rows.find((l) => l.startsWith(`- ${entry.name}: `) || l === `- ${entry.name}`);
    assert.ok(row, `no row for ${entry.name}`);
  }
});

test("descriptions are not clipped: the longest one renders whole", () => {
  const longest = [...REPO_ENTRIES].sort((a, b) => b.description.length - a.description.length)[0];
  const collapsed = longest.description.replace(/\s+/g, " ").trim();
  assert.ok(
    repoText.includes(`- ${longest.name}: ${collapsed}`),
    `the ${collapsed.length}-char description of ${longest.name} was shortened`,
  );
});

test("the stated read root is the entries' own parent, and every stated path resolves", () => {
  assert.equal(skillReadRoot(REPO_ENTRIES), REPO_PACK, "the single pack must be the stated root");
  assert.ok(
    repoText.includes(`Each row's body is at \`${REPO_PACK}/<name>/SKILL.md\`.`),
    "the rule must state the derived root",
  );
  const paths = statedPaths(repoText, REPO_ENTRIES);
  assert.equal(paths.length, REPO_ENTRIES.length, "every row states a path");
  for (const path of paths) {
    assert.equal(statSync(path).isFile(), true, `stated path does not resolve: ${path}`);
  }
});

test("the obligation sentence survives and the superseded pointer text is gone", () => {
  assert.ok(
    repoText.includes(
      "When the task enters a listed skill's domain, read the WHOLE SKILL.md before acting in that domain; never act from memory of a skill's contents.",
    ),
    "the obligation is the sentence that turns an index into a protocol",
  );
  assert.ok(repoText.includes(SKILLS_POINTER_RULE), "the pointer rule renders");
  assert.ok(
    !repoText.includes("call list_skills once to see the catalog"),
    "the catalog is in the prompt, so the redemption instruction is superseded",
  );
  assert.ok(
    !repoText.includes("paginated"),
    "the pagination caveat described the tool page, not the floor",
  );
  assert.ok(repoText.includes("This catalog is every installed skill"), "the catalog is announced");
});

test("the mechanical trigger still renders with derived pairs", () => {
  const examples = mechanicalTriggerExamples(
    TOOLS,
    REPO_ENTRIES.map((s) => s.name),
  );
  assert.ok(examples.length > 0, "the fixture tools and pack must compute a pair");
  assert.ok(
    repoText.includes(`Mechanical trigger, no judgment call: about to use a tool family`),
    "the trigger renders",
  );
  assert.ok(repoText.includes(`(${examples.join(", ")})`), "the trigger renders the computed pairs");
});

// ── 2. derivation, not a hardcoded location ───────────────────────────────

const tempRoots = [];
function tempPack(skills) {
  const root = mkdtempSync(join(tmpdir(), "skills-floor-"));
  tempRoots.push(root);
  return makePack(root, skills);
}

test("the same skills under another root render that root", () => {
  const pack = tempPack([
    ["alpha-skill", "First fixture skill."],
    ["beta-skill", "Second fixture skill."],
  ]);
  const text = skillsLoadingText(["read", "list_skills"], pack);
  assert.ok(text.includes(`Each row's body is at \`${pack[0].filePath.replace(/\/alpha-skill\/SKILL.md$/, "")}/<name>/SKILL.md\`.`), "the fixture root must be stated");
  assert.ok(!text.includes(REPO_PACK), "the real pack must not leak into a fixture render");
});

test("a catalog installed from two packs groups its rows under each pack, and every stated path resolves", () => {
  const first = tempPack([["alpha-skill", "First pack skill."]]);
  const second = tempPack([["beta-skill", "Second pack skill."]]);
  const entries = [...first, ...second];
  const text = skillsLoadingText(["read", "list_skills"], entries);
  const firstPack = dirname(dirname(first[0].filePath));
  const secondPack = dirname(dirname(second[0].filePath));

  assert.equal(catalogGroups(entries).length, 2, "two packs are two groups");
  assert.equal(skillReadRoot(entries), "", "two packs share no root worth stating");
  assert.ok(text.includes(firstPack), "the first pack heads its group");
  assert.ok(text.includes(secondPack), "the second pack heads its group");
  assert.ok(
    text.includes("where `<dir>` is the row's directory heading"),
    "the rule points at the headings instead of a root that does not exist",
  );
  assert.ok(
    !text.includes("Each row's body is at `/"),
    "no single root is stated for a multi-pack catalog",
  );

  // The row's pack is the heading above it: each stated path must resolve.
  const checked = statedPaths(text, entries);
  assert.equal(checked.length, 2, "both rows render");
  for (const path of checked) {
    assert.equal(statSync(path).isFile(), true, `stated path does not resolve: ${path}`);
  }
});

// ── 3. purity ──────────────────────────────────────────────────────────────

test("an empty catalog renders no section", () => {
  assert.equal(skillsLoadingText(TOOLS, []), "", "no catalog, no floor");
});

test("the render is order-independent", () => {
  const shuffled = [...REPO_ENTRIES].reverse();
  assert.equal(skillsLoadingText(TOOLS, shuffled), repoText, "cache order must not change the text");
  assert.deepEqual(catalogRows(shuffled), catalogRows(REPO_ENTRIES), "rows are sorted by name");
});

test("a row without a description renders bare, not with a dangling colon", () => {
  const pack = tempPack([["bare-skill", ""]]);
  const text = skillsLoadingText(["read", "list_skills"], pack);
  assert.ok(text.includes("\n- bare-skill\n"), "the row is the name alone");
  assert.ok(!text.includes("- bare-skill:"), "no dangling colon");
});

test("the module hardcodes no install location and no skill name", () => {
  const source = readFileSync(join(DIST, "loading-guidance.js"), "utf8");
  for (const home of ["/Users/", "/home/", REPO_PACK]) {
    assert.ok(!source.includes(home), `a machine path is baked into the module: ${home}`);
  }
  for (const entry of REPO_ENTRIES) {
    assert.ok(
      !source.includes(`"${entry.name}"`) && !source.includes(`'${entry.name}'`),
      `a skill name is baked into the prompt text: ${entry.name}`,
    );
  }
});

// ── report ─────────────────────────────────────────────────────────────────

const bytes = Buffer.byteLength(repoText, "utf8");
console.log(
  `\n  floor: ${REPO_ENTRIES.length} skills, ${bytes} bytes, ${Math.ceil(bytes / 4)} est tokens`,
);
for (const root of tempRoots) rmSync(root, { recursive: true, force: true });

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
