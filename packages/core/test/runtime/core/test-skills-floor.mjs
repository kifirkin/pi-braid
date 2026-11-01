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
 *   6. The price printed at the end is the assembled prompt, not a design
 *      estimate and not one pack's share of it. Every pack the tree ships is
 *      discovered from its manifest, each pack's own block prints, and the
 *      total is ONE composition over the union of their entries. Three
 *      controls keep that total a measurement: a row dropped into a priced
 *      pack moves it by exactly that row's bytes, a declared path that holds
 *      no skills gives it nothing, and the union is never the sum of the
 *      separate renders (the rule, the pointer rule and the trigger are
 *      paid once, however many packs the catalog carries).
 *
 * Run: node test/runtime/core/test-skills-floor.mjs
 */

import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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

const REPO_ROOT = join(CORE, "..", "..");
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

/**
 * One composition of a population, with the numbers a price line prints.
 * `count` is the rows the block actually renders, read back out of the text,
 * so a row the renderer dropped cannot be priced as if it were there; the
 * token figure is the crude four-bytes-per-token estimate this gate has
 * always printed.
 */
function price(toolNames, entries) {
  const text = skillsLoadingText(toolNames, entries);
  const bytes = Buffer.byteLength(text, "utf8");
  const count = text.split("\n").filter((line) => line.startsWith("- ")).length;
  return { text, count, bytes, tokens: Math.ceil(bytes / 4) };
}

/** `N skills, B bytes, T est tokens`: the measure triple a price line carries. */
function measure(priced) {
  return `${priced.count} skills, ${priced.bytes} bytes, ${priced.tokens} est tokens`;
}

/** `floor: <measure>`: the line this gate printed before the union existed. */
function legacyFloorLine(priced) {
  return `floor: ${measure(priced)}`;
}

/** Directory headings in a rendered block: one per pack in a grouped catalog. */
function headings(text) {
  return text.split("\n").filter((line) => line.startsWith("/")).length;
}

/**
 * Whether a directory holds at least one `<name>/SKILL.md` child. A path a
 * manifest declares but nothing ships in is not a pack: it renders no row, so
 * it costs no byte, and pricing it as one would print a pack that no agent
 * carries.
 */
function holdsSkills(dir) {
  try {
    return readdirSync(dir).some((name) => existsSync(join(dir, name, "SKILL.md")));
  } catch {
    return false;
  }
}

/**
 * Every skill pack this tree ships, read from the workspace manifests rather
 * than from a list here: a package declares its pack in `pi.skills` (a string
 * or a list of directories, which pi accepts in both forms). Reading the
 * manifests is what prices a pack added tomorrow without an edit: a hand list
 * would keep printing one pack's figure while an agent read two.
 */
function discoverSkillPacks(root) {
  const packs = [];
  let workspaces;
  try {
    workspaces = readdirSync(join(root, "packages")).sort();
  } catch {
    return packs;
  }
  for (const workspace of workspaces) {
    const workspaceDir = join(root, "packages", workspace);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(workspaceDir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const declared = manifest?.pi?.skills;
    const declaredDirs = typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : [];
    for (const declaredDir of declaredDirs) {
      const packDir = resolve(workspaceDir, declaredDir);
      if (packs.includes(packDir) || !holdsSkills(packDir)) continue;
      packs.push(packDir);
    }
  }
  return packs;
}

/**
 * The packs the layout alone finds: every directory holding `<name>/SKILL.md`
 * children. It reads no manifest, so it is the second instrument for the
 * discovery - a pack the manifest walk misses, and a manifest pointing at a
 * directory that ships nothing, both surface as a disagreement instead of as a
 * smaller price.
 */
function layoutPackDirs(dir, found = [], depth = 0) {
  let children;
  try {
    children = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  const subdirs = children.filter(
    (child) => child.isDirectory() && child.name !== "node_modules" && child.name !== "dist",
  );
  if (subdirs.some((child) => existsSync(join(dir, child.name, "SKILL.md")))) found.push(dir);
  if (depth >= 4) return found;
  for (const child of subdirs) layoutPackDirs(join(dir, child.name), found, depth + 1);
  return found;
}

/**
 * A temp repo root whose `packages/<name>/package.json` manifests declare
 * whatever the fixture needs, for the discovery controls.
 */
function makeRepo(manifests) {
  const root = mkdtempSync(join(tmpdir(), "skills-price-"));
  tempRoots.push(root);
  for (const [workspace, manifest] of Object.entries(manifests)) {
    const workspaceDir = join(root, "packages", workspace);
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, "package.json"), JSON.stringify(manifest));
  }
  return root;
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

test("the mechanical trigger renders derived pairs, and stands bare when none derive", () => {
  const lead =
    "Mechanical trigger, no judgment call: about to use a tool family whose word appears in a skill's name";
  const tail = "→ read that SKILL.md before the first call in the family.";

  // Positive control: a skill whose name spells a tool family's word must pair
  // with that family's tool. Without this, the repo assertions below could pass
  // on a derivation that silently computes nothing, because this repository's
  // own names happen not to pair (no shipped skill spells "read", "write",
  // "bash", "memory" and so on).
  const control = mechanicalTriggerExamples(TOOLS, ["herdr-notes", "pane-topology"]);
  assert.deepEqual(control, ["`herdr_layout` → herdr"], "the derivation pairs a tool family with the skill token that spells it");

  const examples = mechanicalTriggerExamples(
    TOOLS,
    REPO_ENTRIES.map((s) => s.name),
  );
  assert.ok(repoText.includes(lead), "the trigger renders");
  if (examples.length > 0) {
    assert.ok(repoText.includes(`${lead} (${examples.join(", ")}) ${tail}`), "with pairs, the sentence prints exactly them");
  } else {
    assert.ok(
      repoText.includes(`${lead} ${tail}`),
      "with no derivable pair the sentence stands bare rather than printing an empty pair list",
    );
    assert.ok(!repoText.includes("()"), "a bare sentence carries no empty parentheses");
  }
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

// ── 4. the union price ─────────────────────────────────────────────────────
//
// An agent reads the union of everything installed, so the price that matters
// is one composition over that union. The figures below are printed, and the
// controls keep them a measurement rather than a constant: a constant does not
// move when an entry is added, and it does not shrink when the framing is
// shared.

const DISCOVERED = discoverSkillPacks(REPO_ROOT);
const PRICED = DISCOVERED.map((dir) => {
  const entries = readPack(dir);
  return { dir, label: relative(REPO_ROOT, dir), entries, price: price(TOOLS, entries) };
});
const PRIMARY = PRICED.find((pack) => pack.dir === REPO_PACK);
const UNION_ENTRIES = PRICED.flatMap((pack) => pack.entries);
const UNION_PRICE = price(TOOLS, UNION_ENTRIES);
const SEPARATE_BYTES = PRICED.reduce((total, pack) => total + pack.price.bytes, 0);
/** The core pack's own block, computed from the entries every assertion above prices. */
const LEGACY_PRICE = price(TOOLS, REPO_ENTRIES);

test("every pack the tree ships is discovered from its manifest, and the layout agrees", () => {
  assert.ok(PRIMARY, `the core pack ${REPO_PACK} is not discovered: a manifest stopped declaring it`);
  const layout = layoutPackDirs(join(REPO_ROOT, "packages")).sort();
  assert.deepEqual(
    [...DISCOVERED].sort(),
    layout,
    "the manifests price a different set of packs than the tree ships",
  );
  assert.ok(
    PRICED.length >= 2,
    `the catalog carries ${PRICED.length} pack(s), so this gate prices one pack's block and not the union an agent reads`,
  );
  assert.equal(
    UNION_PRICE.count,
    UNION_ENTRIES.length,
    "the union renders one row per entry: no pack dropped, none duplicated",
  );
});

test("a declared pack that holds no skills contributes nothing", () => {
  const root = makeRepo({
    empty: { name: "empty", pi: { skills: ["./empty", "./absent"] } },
    real: { name: "real", pi: { skills: "./skills" } },
  });
  const emptyDir = join(root, "packages", "empty", "empty");
  mkdirSync(emptyDir, { recursive: true });
  const realPack = join(root, "packages", "real", "skills");
  const real = makePack(realPack, [["gamma-skill", "The only skill that ships."]]);

  assert.deepEqual(
    discoverSkillPacks(root),
    [realPack],
    "a declared directory with no SKILL.md child is not a pack, and an absent one is not either",
  );
  const text = price(TOOLS, [...real, ...readPack(emptyDir)]).text;
  assert.equal(headings(text), 0, "a pack holding no skills renders no heading of its own");
  assert.ok(!text.includes(emptyDir), "the empty pack's path never enters the block");
});

test("a row added to a priced pack moves the total by exactly that row's bytes", () => {
  const anchor = tempPack([["anchor-skill", "An anchor row, so the pack is already priced."]]);
  const packDir = dirname(dirname(anchor[0].filePath));
  const baseline = price(TOOLS, [...UNION_ENTRIES, ...anchor]);

  // The row carries a non-ASCII glyph on purpose: a price that counted
  // characters where it says bytes would move by one less than this row is.
  const description = "Synthetic row, measured by its own bytes: \u2605.";
  const synthetic = makePack(packDir, [["synthetic-skill", description]]);
  const after = price(TOOLS, [...UNION_ENTRIES, ...synthetic]);
  const rowBytes = Buffer.byteLength(`- synthetic-skill: ${description}\n`, "utf8");

  assert.equal(after.count, baseline.count + 1, "exactly one row was added");
  assert.equal(headings(after.text), headings(baseline.text), "the pack's heading was already priced: the delta is a row");
  assert.ok(after.bytes > baseline.bytes, "a price that cannot move is a constant");
  assert.equal(
    after.bytes - baseline.bytes,
    rowBytes,
    `the total moved by ${after.bytes - baseline.bytes} bytes for a ${rowBytes}-byte row`,
  );
});

test("the total is one composition over the union, not the sum of the per-pack renders", () => {
  assert.equal(headings(UNION_PRICE.text), PRICED.length, "one heading per pack");
  assert.equal(
    UNION_PRICE.text.split(SKILLS_POINTER_RULE).length - 1,
    1,
    "the pointer rule is stated once for the union, not once per pack",
  );
  assert.equal(
    UNION_PRICE.text.split("Mechanical trigger, no judgment call").length - 1,
    1,
    "the trigger renders once for the union",
  );
  assert.ok(
    UNION_PRICE.bytes < SEPARATE_BYTES,
    `the total (${UNION_PRICE.bytes}) must be below the separate renders (${SEPARATE_BYTES}): the framing is paid once`,
  );
  for (const pack of PRICED) {
    assert.ok(
      UNION_PRICE.bytes >= pack.price.bytes,
      `the total (${UNION_PRICE.bytes}) sits below ${pack.label}'s own block (${pack.price.bytes})`,
    );
  }
});

test("the floor line still prints one pack's block, in the shape it has always had", () => {
  const line = legacyFloorLine(LEGACY_PRICE);
  assert.match(line, /^floor: \d+ skills, \d+ bytes, \d+ est tokens$/, `the legacy line changed shape: ${line}`);
  assert.equal(
    line,
    `floor: ${REPO_ENTRIES.length} skills, ${LEGACY_PRICE.bytes} bytes, ${LEGACY_PRICE.tokens} est tokens`,
    "the legacy line prices the core pack's entries, not the union's",
  );
  assert.equal(
    LEGACY_PRICE.bytes,
    PRIMARY.price.bytes,
    "the discovered core pack and the entries the assertions above read must be one block",
  );
});

// ── report ─────────────────────────────────────────────────────────────────
//
// The `floor:` line keeps its exact printed shape and its subject (the core
// pack priced above), because something may read it. Every pack prints under
// `pack:` so no parser mistakes a second pack for a second floor, and the
// union prints once under `total:`: the per-pack figures add up to more than
// the total on purpose, and a reader who added them would price the framing
// once per pack.

console.log(`\n  ${legacyFloorLine(LEGACY_PRICE)}`);
for (const pack of PRICED) console.log(`  pack ${pack.label}: ${measure(pack.price)}`);
console.log(`  total across ${PRICED.length} packs: ${measure(UNION_PRICE)}`);
console.log(
  `  (one composition: the rule, the pointer rule and the trigger render once, which is ${SEPARATE_BYTES - UNION_PRICE.bytes} bytes below the separate prices)`,
);
for (const root of tempRoots) rmSync(root, { recursive: true, force: true });

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
