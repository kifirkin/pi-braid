/**
 * A skill whose frontmatter declares it retired stops being advertised.
 *
 * Contract:
 *   (a) a `status:` the skills-tool reads as retired (merged, archived,
 *       deprecated) keeps the skill out of the assembled catalog block AND out
 *       of the catalog's own accessor;
 *   (b) the file is not deleted and stays resolvable: the row is still cached,
 *       so an explicit read of the SKILL.md still resolves to its name. The
 *       skill stops being advertised, it does not become unreadable;
 *   (c) the filter is a filter. A skill with no status, one with `status:
 *       active`, and one with any other value still render. A filter that
 *       removes everything satisfies (a) while destroying the catalog, so the
 *       control half is not optional;
 *   (d) over this repository's own two packs, the merged `code-search` is
 *       absent while its successor `code-refactoring` is present, and the
 *       three deprecated pack skills are absent.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports, so the
 * real agent tree is never touched.
 *
 * Run: node test/runtime/lib/test-skill-status.mjs
 */

import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "skill-status-"));
process.env.HOME = FAKE_HOME;

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..", "..", "..");
const REPO = resolve(PKG, "..", "..");
const DIST = join(PKG, "dist", "extensions", "core", "skills-tool");

const skillsTool = await import(join(DIST, "index.js"));
const { setCachedSkills, getCachedVisibleSkillNames, default: skillsToolExtension } = skillsTool;
const { getCachedVisibleSkills, skillNameFromRead } = await import(join(DIST, "auto-inject.js"));
const { skillsLoadingText } = await import(join(DIST, "loading-guidance.js"));

after(() => rmSync(FAKE_HOME, { recursive: true, force: true }));

const SKILLS_DIR = join(FAKE_HOME, "skills");

/** A SKILL.md on disk; the returned row is what pi hands the cache. */
function writeSkill(name, { description = `Handle ${name} work.`, status } = {}) {
  const dir = join(SKILLS_DIR, name);
  mkdirSync(dir, { recursive: true });
  const frontmatter = ["---", `name: ${name}`, `description: "${description}"`];
  if (status !== undefined) frontmatter.push(`status: ${status}`);
  frontmatter.push("---", "", `# ${name}`, "", "Body text.");
  const filePath = join(dir, "SKILL.md");
  writeFileSync(filePath, `${frontmatter.join("\n")}\n`);
  return { name, description, filePath, baseDir: SKILLS_DIR, sourceInfo: { source: "user" } };
}

/** Controls: no status, an explicit active status, and a value the filter ignores. */
const KEPT = [
  writeSkill("plain-topic"),
  writeSkill("active-topic", { status: "active" }),
  writeSkill("experimental-topic", { status: "experimental" }),
];

/** One skill per retired status. */
const RETIRED = [
  writeSkill("merged-topic", { status: "merged" }),
  writeSkill("archived-topic", { status: "archived" }),
  writeSkill("deprecated-topic", { status: "deprecated" }),
];

/**
 * The skills floor as prompt-builder assembles it: the same builder, fed the
 * same visible catalog the prompt gets.
 */
function catalogBlock() {
  return skillsLoadingText(["read", "list_skills", "memory"], getCachedVisibleSkills());
}

/** Row names the block advertises: one `- name: description` line per skill. */
function blockRowNames(block) {
  return [...block.matchAll(/^- ([a-z0-9][a-z0-9-]*):/gm)].map((match) => match[1]);
}

/** The `description:` value inside a SKILL.md's frontmatter block, unquoted. */
function descriptionOf(filePath) {
  const text = readFileSync(filePath, "utf8");
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const match = block && /^description:\s*(.*)$/m.exec(block[1]);
  return (match?.[1] ?? "").replace(/^["']|["']$/g, "");
}

/** Every skill this repository ships, as pi would hand the cache. */
function repoSkillRows() {
  const packs = [join(REPO, "packages", "core", "skills"), join(REPO, "packages", "skills", "skills")];
  const rows = [];
  for (const pack of packs) {
    for (const entry of readdirSync(pack, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filePath = join(pack, entry.name, "SKILL.md");
      if (!existsSync(filePath)) continue;
      rows.push({
        name: entry.name,
        description: descriptionOf(filePath),
        filePath,
        baseDir: pack,
        sourceInfo: { source: "package" },
      });
    }
  }
  return rows;
}

/** ExtensionAPI double: captures the registered tools. */
function fakePi() {
  const tools = new Map();
  return {
    tools,
    on() {},
    registerTool(def) {
      tools.set(def.name, def);
    },
    sendMessage() {},
  };
}

test("a retired status keeps the skill out of the catalog accessor", () => {
  setCachedSkills([...KEPT, ...RETIRED]);
  const visible = getCachedVisibleSkillNames();

  for (const skill of KEPT) {
    assert.ok(
      visible.includes(skill.name),
      `${skill.name} declares no retiring status and must stay visible`,
    );
  }
  for (const skill of RETIRED) {
    assert.ok(
      !visible.includes(skill.name),
      `${skill.name} declares a retiring status and must not be returned by the accessor`,
    );
  }
});

test("a retired status keeps the skill out of the assembled catalog block", () => {
  setCachedSkills([...KEPT, ...RETIRED]);
  const block = catalogBlock();

  assert.ok(
    block.length > 0,
    "the catalog block must still render: a filter that removes everything is not a filter",
  );
  const rows = blockRowNames(block);
  for (const skill of KEPT) {
    assert.ok(rows.includes(skill.name), `${skill.name} must still have a row in the catalog block`);
  }
  for (const skill of RETIRED) {
    assert.ok(!rows.includes(skill.name), `${skill.name} must not have a row in the catalog block`);
    assert.ok(!block.includes(skill.name), `no part of the catalog block may name ${skill.name}`);
  }
});

test("list_skills omits retired skills and excludes them from the total", async () => {
  setCachedSkills([...KEPT, ...RETIRED]);
  const pi = fakePi();
  skillsToolExtension(pi);
  const tool = pi.tools.get("list_skills");
  assert.ok(tool, "list_skills must be registered");

  const result = await tool.execute(
    "call-1",
    { action: "list", page: 1, pageSize: 50 },
    undefined,
    undefined,
    {},
  );
  const payload = JSON.parse(result.content[0].text);
  const listed = payload.skills.map((skill) => skill.name);
  assert.equal(payload.total, KEPT.length, "total must count only advertised skills");
  assert.equal(result.details.total, KEPT.length);
  for (const skill of KEPT) assert.ok(listed.includes(skill.name), `${skill.name} must be listed`);
  for (const skill of RETIRED) {
    assert.ok(!listed.includes(skill.name), `${skill.name} must not be listed`);
  }
});

test("a retired skill's row is still cached, so an explicit read still resolves", () => {
  setCachedSkills([...KEPT, ...RETIRED]);
  const merged = RETIRED.find((skill) => skill.name === "merged-topic");
  assert.equal(
    skillNameFromRead(merged.filePath, "# merged-topic\n\nBody text."),
    "merged-topic",
    "the read detector must keep resolving a retired skill from the unfiltered cache",
  );
});

test("this repository's packs: code-search is not advertised, code-refactoring is", () => {
  const rows = repoSkillRows();
  assert.ok(rows.length > 0, "the repository must ship skills for this assertion to mean anything");
  setCachedSkills(rows);

  const visible = getCachedVisibleSkillNames();
  const block = catalogBlock();
  const rowNames = blockRowNames(block);

  assert.ok(rowNames.length > 0, "the assembled catalog block must not be empty");
  assert.ok(
    visible.includes("code-refactoring"),
    "code-refactoring is the skill that replaced code-search and must stay visible",
  );
  assert.ok(
    !visible.includes("code-search"),
    "code-search declares status: merged and must not be returned by the catalog accessor",
  );
  assert.ok(
    !rowNames.includes("code-search"),
    "code-search declares status: merged and must not have a row in the assembled catalog block",
  );
  assert.ok(
    !block.includes("code-search"),
    "no part of the assembled catalog block may name code-search",
  );
  for (const name of ["socratic-irony", "twitter", "meme"]) {
    assert.ok(!rowNames.includes(name), `${name} declares status: deprecated and must not be advertised`);
  }

  // History: the merged file is on disk and its row is still in the cache.
  const mergedFile = join(REPO, "packages", "core", "skills", "code-search", "SKILL.md");
  assert.ok(existsSync(mergedFile), "the merged file stays on disk: the exclusion is advertising, not deletion");
  assert.equal(
    skillNameFromRead(mergedFile, readFileSync(mergedFile, "utf8")),
    "code-search",
    "an explicit read of the merged file must still resolve",
  );
});
