/**
 * Test: the catalog read is stable, complete, and the same list the prompt shows.
 *
 * Contract:
 *   (a) STABLE. Two consecutive no-argument `list_skills` calls return the same
 *       order, name for name. A default answer that re-sorts itself call to call
 *       cannot be reasoned about by a reader or cached by an agent.
 *   (b) COMPLETE. A call that names no page and no page size returns every
 *       visible skill. The old default was page 1 of 10, so a 34-skill catalog
 *       answered a bare call with ten rows and a `hasMore: true` its reader had
 *       no reason to chase — from five different tools, five different subsets.
 *   (c) ONE ORDER. The order is `catalogOrder`'s: each pack directory, its rows
 *       by name. That is the order the prompt's skills section renders, so the
 *       page a caller opens is a window over the catalog it already read.
 *   (d) OPT-IN WINDOW. `page`/`pageSize` still work when a caller asks, and
 *       `rank: "relevance"` still answers the ranked view with its verdict.
 *
 * Hermetic: HOME is redirected to a temp dir before the dist imports.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "skill-catalog-order-"));
process.env.HOME = FAKE_HOME;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { setCachedSkills, default: skillsToolExtension } = await import(
  join(ROOT, "dist", "extensions", "core", "skills-tool", "index.js")
);
const { catalogRows, skillsLoadingText } = await import(
  join(ROOT, "dist", "extensions", "core", "skills-tool", "loading-guidance.js")
);

// ── a two-pack catalog, seeded in reverse catalog order ────────────────────

const PACK_A = join(FAKE_HOME, "packs", "alpha");
const PACK_B = join(FAKE_HOME, "packs", "beta");

/** Names chosen so catalog order (by name) differs from the order written. */
const SPECS = [
  { pack: PACK_A, name: "alpha-quiet", description: "A row of the alpha pack." },
  { pack: PACK_A, name: "alpha-amber", description: "A row of the alpha pack." },
  { pack: PACK_A, name: "alpha-zulu", description: "A row of the alpha pack." },
  { pack: PACK_A, name: "alpha-kilo", description: "A row of the alpha pack." },
  { pack: PACK_A, name: "alpha-bravo", description: "A row of the alpha pack." },
  { pack: PACK_A, name: "alpha-yankee", description: "A row of the alpha pack." },
  { pack: PACK_B, name: "beta-violet", description: "A row of the beta pack." },
  { pack: PACK_B, name: "beta-cobalt", description: "A row of the beta pack." },
  { pack: PACK_B, name: "beta-north", description: "A row of the beta pack." },
  { pack: PACK_B, name: "beta-silver", description: "A row of the beta pack." },
  { pack: PACK_B, name: "beta-echo", description: "A row of the beta pack." },
  { pack: PACK_B, name: "beta-jade", description: "A row of the beta pack." },
];

function writeSkill(pack, name, description) {
  const dir = join(pack, name);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "SKILL.md");
  writeFileSync(
    filePath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody of ${name}.\n`,
    "utf8",
  );
  return { name, description, filePath, baseDir: dir };
}

const ROWS = SPECS.map((s) => writeSkill(s.pack, s.name, s.description));
// Seeded in a deliberately non-catalog order, so an implementation that hands
// the cache order back cannot pass by accident.
const SEEDED = [...ROWS].reverse();

// ── the tool double ────────────────────────────────────────────────────────

function fakePi() {
  const tools = [];
  return {
    tools,
    on: () => {},
    registerTool: (tool) => tools.push(tool),
    getAllTools: () => tools.map((t) => ({ name: t.name })),
    sendMessage: () => {},
  };
}

const ctx = { sessionManager: { getSessionId: () => "catalog-order" }, cwd: join(FAKE_HOME, "ws") };

async function callList(pi, args = {}) {
  const tool = pi.tools.find((t) => t.name === "list_skills");
  assert.ok(tool, "list_skills is registered");
  const result = await tool.execute("call-1", { action: "list", ...args }, undefined, () => {}, ctx);
  return {
    payload: JSON.parse(result.content[0].text),
    details: result.details,
    text: result.content[0].text,
  };
}

function openTool() {
  const pi = fakePi();
  skillsToolExtension(pi);
  setCachedSkills(SEEDED);
  return pi;
}

// ── (a) two no-arg calls agree ─────────────────────────────────────────────

test("(a) two consecutive no-arg calls return the same order", async () => {
  const pi = openTool();
  const first = await callList(pi);
  const second = await callList(pi);
  const firstNameList = first.payload.skills.map((s) => s.name);
  const secondNameList = second.payload.skills.map((s) => s.name);
  assert.deepEqual(secondNameList, firstNameList, "the order moved between two identical calls");
  assert.equal(first.text, second.text, "the whole payload is byte-identical");
  console.log(`  order: ${firstNameList.join(", ")}`);
});

// ── (b) a bare call is the whole catalog ──────────────────────────────────

test("(b) a bare call returns every visible skill, with no page to chase", async () => {
  const pi = openTool();
  const { payload, details } = await callList(pi);
  assert.equal(payload.total, ROWS.length, "total counts the catalog");
  assert.equal(payload.skills.length, ROWS.length, "every row is in the answer");
  assert.equal(payload.hasMore, false, "nothing is left out");
  assert.equal(details.returned, ROWS.length, "the details agree");
  assert.equal(payload.page, 1, "an unpaginated answer reports its only page");
  assert.equal(payload.pageSize, ROWS.length, "and its size is the catalog's");
});

// ── (c) the order is the prompt's ─────────────────────────────────────────

test("(c) the order is the one the prompt's catalog section renders", async () => {
  const pi = openTool();
  const { payload } = await callList(pi);
  const answered = payload.skills.map((s) => s.name);
  // Derived here, not read from the module under test: each pack directory in
  // byte order, its rows by name in byte order. That is the order the prompt's
  // skills section renders.
  const expected = [...new Set(ROWS.map((r) => r.baseDir))]
    .sort()
    .flatMap((dir) =>
      ROWS.filter((r) => r.baseDir === dir)
        .map((r) => r.name)
        .sort(),
    );
  assert.deepEqual(answered, expected, "the page is not a window over the prompt's catalog");
  // And the prompt's own renderer agrees: same rows, same order, top to bottom.
  const section = skillsLoadingText([], ROWS)
    .split("\n")
    .filter((line) => line.startsWith("- "));
  assert.deepEqual(
    section.map((line) => line.slice(2).split(":")[0]),
    expected,
    "the prompt section and the catalog read disagree",
  );
  assert.deepEqual(catalogRows(ROWS).length, ROWS.length, "every row renders exactly once");
});

// ── (d) the window and the ranked view are opt-in and still work ──────────

test("(d) page and pageSize answer a window when they are asked for", async () => {
  const pi = openTool();
  const { payload, details } = await callList(pi, { page: 2, pageSize: 2 });
  assert.equal(payload.page, 2, "the asked-for page is the page");
  assert.equal(payload.pageSize, 2, "the asked-for size is the size");
  assert.equal(payload.skills.length, 2, "two rows, as asked");
  assert.equal(payload.hasMore, true, "and there is more behind it");
  assert.equal(details.returned, 2, "the details describe this page");
});

test("(d) rank: relevance still answers the ranked view, with its verdict", async () => {
  const pi = openTool();
  const { payload } = await callList(pi, { rank: "relevance" });
  assert.ok(payload.ranking, "the ranked view carries its report");
  assert.equal(payload.ranking.tier, "keyword", "the deterministic tier is the only tier");
  assert.equal(typeof payload.ranking.basis, "string", "the verdict is stated");
  assert.equal(payload.skills.length, ROWS.length, "a ranked read is still the whole catalog");
});
