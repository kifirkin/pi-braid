#!/usr/bin/env node
/**
 * skills-contract.mjs — the catalog contract for shipped skills.
 *
 * Every `<tree>/skills/<dir>/SKILL.md` opens with frontmatter carrying:
 *   name        the skill's catalog name, equal to its directory name
 *   description a non-empty string that says when the skill applies
 *   validated   an ISO date (YYYY-MM-DD)
 *   verdict     one of KEEP | IMPROVE | MOVE | DEPRECATE | UNVALIDATED
 *
 * and, because a description that cannot fire is indistinguishable from one
 * that fires, it also asserts what the matcher needs:
 *
 *   - at least two trigger phrases the production reader keeps, declared
 *     under `triggers:` (the reader's caps are mirrored below);
 *   - declared in that one form: the reader also accepts a legacy `trigger:`
 *     string and a `## trigger:` body heading, so a file can fire in
 *     production while this contract counts nothing. Those two shapes are
 *     refused by name rather than counted as zero, because the fix differs:
 *     the phrases exist and need moving;
 *   - no `Triggers:` tail in the description: the reader drops a tail longer
 *     than 200 characters, silently, which is how two skills shipped with
 *     zero phrases while this test printed clean;
 *   - a situation clause (`use when ...`), not a topic list;
 *   - pi's own description limit of 1024 characters;
 *   - for `status: deprecated`, a `successor` and a description whose first
 *     word is "Deprecated": a deprecation that reads as a live instruction
 *     is not a boundary, and a user cannot follow a successor that is unnamed.
 *
 * and, because a body that names the tools its advice directs is what makes
 * the obligation rate computable, the optional declaration:
 *
 *   - `governs:` names tool FAMILIES, not tools: the first underscore-delimited
 *     segment of a tool name (`search_things` → `search`), which is the token
 *     the prompt's mechanical trigger already pairs with a skill name. Each
 *     entry must be one of the families the shipped text admits (the TOOLS
 *     table in content-rules.mjs), so a declaration cannot invent a family
 *     that no reader will ever see called.
 *   - absent is admitted and means "this skill directs no tool": most bodies
 *     are advice about prose, a palette or a checklist;
 *   - present with no entries, with a malformed entry, with a duplicate, over
 *     the reader's cap, or naming the read tool itself is refused by name —
 *     the last because a call to the detector IS the read leg, so such a
 *     declaration would let an obligation satisfy itself.
 *
 * TWO POPULATIONS, ONE CONTRACT. The repository ships skills from two trees:
 * this package's `skills/` (the on-demand pack) and the core set beside it
 * (`packages/core/skills`). Every rule above holds for a skill wherever it
 * lives, and the phrase namespace is shared: one phrase governing two skills
 * is refused across the two trees, because the matcher then ranks those two
 * files against each other on every prompt either one matches, and the loser
 * is never suggested.
 *
 * What differs between the trees is ownership. The TOOLS and PROJECTS tables
 * in content-rules.mjs name what a reader of THIS pack can reach, so the scan
 * that applies them runs over the pack alone. A core skill legitimately names
 * tools the pack cannot reach (`bash`, `telegram_send`, `herdr_pane`), and
 * judging it against the pack's table would refuse those files for naming the
 * tools they are written to direct. A core file is therefore judged on
 * frontmatter and phrase uniqueness. The `governs:` family table is the pack's
 * for the same reason, so the family membership test is pack-scoped while the
 * shape rules are not.
 *
 * `--tree core|pack|all` selects the populations; the default is `all`, so the
 * bare command cannot pass by leaving a tree unread. Every run prints the count
 * of every population it read, because a scan that quietly shrank and a scan
 * that found nothing to report look identical otherwise. A tree that is absent
 * is named as absent and not judged — this package is also developed and
 * published standalone, where the core tree is not there to read; a tree that
 * is present and yields no skill fails, because a green run over nothing
 * vouches for nothing.
 *
 * The values are audit evidence; this asserts shape only, never which verdict
 * a skill deserves.
 *
 * Run: npm test -w packages/skills (the pack), and
 *      node packages/skills/test/skills-contract.mjs --tree all from the
 *      repository root (both trees, which is what the chain runs).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanPack } from "./content-rules.mjs";
import { TOOL_FAMILIES } from "./content-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packRoot = join(__dirname, "..");

/**
 * The two populations, in scan order. `at` is the coordinate a failure prints,
 * read from the repository root so the file can be opened without a lookup.
 *
 * `ownsToolTable` is the pack's claim, not a convenience: only the tree that
 * ships the TOOLS table in content-rules.mjs is judged against it.
 */
const TREES = [
  {
    id: "pack",
    dir: join(packRoot, "skills"),
    at: "skills",
    ownsToolTable: true,
  },
  {
    // The sibling workspace: `packages/core/skills` in this repository, and the
    // one path that says which second tree this contract is about.
    id: "core",
    dir: resolve(packRoot, "..", "core", "skills"),
    at: "packages/core/skills",
    ownsToolTable: false,
  },
];
const TREE_IDS = TREES.map((tree) => tree.id);
const EVERY_TREE = "all";
const USAGE = `usage: skills-contract.mjs [--tree ${[...TREE_IDS, EVERY_TREE].join("|")}]`;

const VERDICTS = new Set([
  "KEEP",
  "IMPROVE",
  "MOVE",
  "DEPRECATE",
  "UNVALIDATED",
]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Mirrors skill-triggers.ts: the reader keeps this many phrases per skill. */
const MAX_TRIGGERS = 16;
/** Mirrors skill-triggers.ts: a longer phrase is dropped by the reader. */
const MAX_TRIGGER_CHARS = 66;
/** pi's own cap on a skill description; longer loads with a warning nobody reads. */
const MAX_DESCRIPTION_CHARS = 1024;
/** A description that names a situation an agent can be in, not just a topic. */
const SITUATION =
  /\buse (?:when|if|for|only|this|it|these)\b|\bwhen (?:a|an|the|you|there|it|someone|work)\b/i;
/** The skill-name shape pi accepts. */
const NAME_SHAPE = /^[a-z0-9-]+$/;

/** The legacy frontmatter key the reader still accepts and the contract does not. */
const LEGACY_TRIGGER_KEY = /^trigger\s*:/m;
/** The legacy body heading the reader still accepts and the contract does not. */
const BODY_TRIGGER_HEADING = /^##\s*triggers?\s*:/im;

/** Mirrors skill-families.ts: the reader keeps this many families per file. */
const MAX_GOVERNED_FAMILIES = 4;
/** Mirrors skill-families.ts: the shape a family token must have. */
const FAMILY_SHAPE = /^[a-z][a-z0-9]*$/;
/** The detector's own tool: never a declarable family (see skill-families.ts). */
const DETECTOR_TOOL = "read";

const declared = new Set();
/** skill files that declare at least one family (the rest are admitted as-is). */
const declaringFiles = new Set();

const problems = [];
const fail = (message) => problems.push(message);

/** First `key: value` line for `key`, or null. Surrounding quotes stripped. */
function field(front, key) {
  const match = new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(front);
  if (!match) return null;
  const value = match[1].trim();
  return value.replace(/^["']|["']$/g, "");
}

/**
 * Phrases authored under `triggers:` (or `trigger:`), in file order. Reads the
 * block-list and the comma-string forms; a phrase keeps its authored spelling.
 * Pure.
 */
function authoredTriggers(front) {
  const lines = front.split(/\r?\n/);
  const start = lines.findIndex((line) => /^triggers?\s*:/.test(line));
  if (start < 0) return [];
  const inline = lines[start].replace(/^triggers?\s*:/, "").trim();
  if (inline !== "")
    return inline
      .replace(/^["']|["']$/g, "")
      .split(",")
      .map((part) => part.trim())
      .filter((phrase) => phrase !== "");
  const phrases = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s*(.+)$/.exec(line);
    if (!item) {
      if (/^\s*$/.test(line)) continue;
      break;
    }
    const phrase = item[1].trim().replace(/^["']|["']$/g, "");
    if (phrase !== "") phrases.push(phrase);
  }
  return phrases;
}

/**
 * Entries authored under `governs:`, in file order, and whether the key exists
 * at all. Both the block-list and the comma-string forms are read, matching the
 * runtime reader; the distinction between "absent" and "present and empty" is
 * what decides whether a file declares no family or fails to declare one.
 * Pure.
 */
function authoredFamilies(front) {
  const lines = front.split(/\r?\n/);
  const start = lines.findIndex((line) => /^governs\s*:/.test(line));
  if (start < 0) return { present: false, entries: [] };
  const inline = lines[start].replace(/^governs\s*:/, "").trim();
  if (inline !== "")
    return {
      present: true,
      entries: inline
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((part) => part.trim().replace(/^["']|["']$/g, ""))
        .filter((entry) => entry !== ""),
    };
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (!item) {
      if (/^\s*$/.test(line)) continue;
      break;
    }
    const entry = item[1].trim().replace(/^["']|["']$/g, "");
    if (entry !== "") entries.push(entry);
  }
  return { present: true, entries };
}

/** One `field: value` argument pair read without touching the filesystem. */
function valueAfter(argv, index) {
  const value = argv[index + 1];
  return typeof value === "string" && !value.startsWith("-") ? value : "";
}

/**
 * The trees a run is over: `--tree all` (the default), or one named tree.
 * Returns the population list, or the one-line reason the flag was refused.
 * Pure.
 */
function treeScope(argv) {
  let requested = EVERY_TREE;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tree") {
      requested = valueAfter(argv, i);
      i += 1;
      if (requested === "")
        return { problem: `--tree needs a value; ${USAGE}` };
      continue;
    }
    if (arg.startsWith("--tree=")) {
      requested = arg.slice("--tree=".length);
      if (requested === "")
        return { problem: `--tree needs a value; ${USAGE}` };
      continue;
    }
    return { problem: `unknown argument '${arg}'; ${USAGE}` };
  }
  if (requested === EVERY_TREE) return { trees: TREES };
  const named = TREES.filter((tree) => tree.id === requested);
  if (named.length === 0)
    return {
      problem: `--tree '${requested}' is not one of ${[...TREE_IDS, EVERY_TREE].join(", ")}`,
    };
  return { trees: named };
}

/**
 * The directories under a tree that carry a SKILL.md, in directory order. A
 * directory without one is not a skill (the pack's shared fragment directory),
 * so it is not part of the population. Pure over a readable tree.
 */
function skillDirs(tree) {
  const dirs = [];
  for (const entry of readdirSync(tree.dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (existsSync(join(tree.dir, entry.name, "SKILL.md")))
      dirs.push(entry.name);
  }
  return dirs;
}

function checkSkill(tree, dirName) {
  const rel = `${tree.at}/${dirName}/SKILL.md`;
  let text;
  try {
    text = readFileSync(join(tree.dir, dirName, "SKILL.md"), "utf8");
  } catch (error) {
    fail(
      `${rel}: cannot be read (${error.code}) — a skill file the scan cannot open is a hole in the population`,
    );
    return;
  }

  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!block) {
    fail(`${rel}: no frontmatter block (must open with "---")`);
    return;
  }
  const front = block[1];
  const body = text.slice(block[0].length);

  const name = field(front, "name");
  if (!name) fail(`${rel}: frontmatter is missing 'name'`);
  else if (name !== dirName)
    fail(`${rel}: name '${name}' does not match its directory '${dirName}'`);
  else if (!NAME_SHAPE.test(name))
    fail(
      `${rel}: name '${name}' is not the shape pi accepts (a-z, 0-9, hyphen)`,
    );

  const description = field(front, "description");
  if (!description)
    fail(`${rel}: frontmatter is missing a non-empty 'description'`);
  else {
    if (description.length > MAX_DESCRIPTION_CHARS)
      fail(
        `${rel}: description is ${description.length} chars; pi keeps ${MAX_DESCRIPTION_CHARS}`,
      );
    if (/triggers\s*:/i.test(description))
      fail(
        `${rel}: the description carries a 'Triggers:' tail; the reader drops a tail over 200 chars and reports nothing, so declare the phrases under 'triggers:'`,
      );
    if (!SITUATION.test(description))
      fail(
        `${rel}: the description names no situation ('use when ...'); a topic list does not tell an agent when to open the skill`,
      );
  }

  if (LEGACY_TRIGGER_KEY.test(front))
    fail(
      `${rel}: the phrases are declared under the legacy 'trigger:' key; declare them as a 'triggers:' list, the one form the matcher and this contract share`,
    );
  if (BODY_TRIGGER_HEADING.test(body))
    fail(
      `${rel}: the phrases sit in a body '## trigger:' heading, which this contract refuses; move them under 'triggers:' in the frontmatter, where the validator counts them`,
    );

  const phrases = [
    ...new Set(authoredTriggers(front).map((p) => p.toLowerCase())),
  ];
  if (phrases.length < 2)
    fail(
      `${rel}: ${phrases.length} trigger phrase(s) authored — declare at least 2 under 'triggers:' so the matcher has something to match`,
    );
  if (phrases.length > MAX_TRIGGERS)
    fail(
      `${rel}: ${phrases.length} trigger phrases; the reader keeps the first ${MAX_TRIGGERS}`,
    );
  for (const phrase of phrases) {
    if (phrase.length > MAX_TRIGGER_CHARS)
      fail(
        `${rel}: trigger "${phrase}" is ${phrase.length} chars; the reader drops phrases over ${MAX_TRIGGER_CHARS}`,
      );
    const owner = phraseOwners.get(phrase);
    if (owner)
      fail(
        `${rel}: trigger "${phrase}" is already declared by ${owner} — one phrase must name one skill`,
      );
    else phraseOwners.set(phrase, rel);
  }

  if (field(front, "status") === "deprecated") {
    const successor = field(front, "successor");
    if (!successor)
      fail(
        `${rel}: status 'deprecated' with no 'successor' — say what to do instead, in terms a user can act on`,
      );
    if (description && !/^deprecated\b/i.test(description))
      fail(
        `${rel}: status 'deprecated' but the description reads as a live instruction — open it with "Deprecated:" and name the successor`,
      );
  }

  const validated = field(front, "validated");
  if (!validated) fail(`${rel}: frontmatter is missing 'validated' (ISO date)`);
  else if (!ISO_DATE.test(validated) || Number.isNaN(Date.parse(validated)))
    fail(`${rel}: validated '${validated}' is not an ISO date (YYYY-MM-DD)`);

  const verdict = field(front, "verdict");
  if (!verdict) fail(`${rel}: frontmatter is missing 'verdict'`);
  else if (!VERDICTS.has(verdict))
    fail(
      `${rel}: verdict '${verdict}' is not one of ${[...VERDICTS].join(" / ")}`,
    );

  const families = authoredFamilies(front);
  if (families.present) {
    if (families.entries.length > 0) declaringFiles.add(rel);
    if (families.entries.length === 0)
      fail(
        `${rel}: 'governs:' names no family — declare a tool family the body directs, or delete the key`,
      );
    if (families.entries.length > MAX_GOVERNED_FAMILIES)
      fail(
        `${rel}: ${families.entries.length} declared families; the reader keeps the first ${MAX_GOVERNED_FAMILIES}`,
      );
    const seen = new Set();
    for (const entry of families.entries) {
      if (!FAMILY_SHAPE.test(entry))
        fail(
          `${rel}: governs entry '${entry}' is not a tool-family token — use the first underscore-delimited segment of a tool name, lowercase (a-z, 0-9)`,
        );
      else if (entry === DETECTOR_TOOL)
        fail(
          `${rel}: governs entry '${DETECTOR_TOOL}' is the read detector's own tool — a call to it IS the read leg, so declaring it would let the obligation satisfy itself`,
        );
      else if (tree.ownsToolTable && !TOOL_FAMILIES.has(entry))
        fail(
          `${rel}: governs entry '${entry}' is no family this pack admits — declare one of ${[...TOOL_FAMILIES].sort().join(", ")}, or drop it`,
        );
      if (seen.has(entry))
        fail(`${rel}: governs entry '${entry}' is declared twice`);
      seen.add(entry);
      declared.add(`${rel}:${entry}`);
    }
  }
}

/** Scan one population; returns what the summary reports about it. */
function scanTree(tree) {
  if (!existsSync(tree.dir))
    return { id: tree.id, at: tree.at, skills: 0, absent: true };
  const dirs = skillDirs(tree);
  for (const dirName of dirs) checkSkill(tree, dirName);
  return { id: tree.id, at: tree.at, skills: dirs.length, absent: false };
}

/**
 * How one population reads in a summary line: its count, or the fact that there
 * was no tree to count. The second form is the one that keeps a shrunken run
 * from reading like a clean one. Pure.
 */
function populationLabel(population) {
  if (population.absent)
    return `no ${population.id} tree at ${population.at}, not judged`;
  return `${population.skills} skill(s) in ${population.id}`;
}

const phraseOwners = new Map();

const scope = treeScope(process.argv.slice(2));
if (scope.problem) {
  console.error(`skills-contract: ${scope.problem}`);
  process.exit(1);
}

const populations = scope.trees.map(scanTree);

// Fail closed on a tree that is there and declares nothing: a population of
// zero is the shape a shrinking scan takes, and it would otherwise print as a
// clean line over no file at all.
for (const population of populations) {
  if (population.absent || population.skills > 0) continue;
  fail(
    `${population.at}: no SKILL.md found — a scan over nothing proves nothing; this tree is in scope and declared no skill`,
  );
}

// The shipped text, not just the frontmatter: a skill may only name a tool or
// a project a reader of this package can reach. Scoped to the pack on purpose —
// its tables, its population (see the header).
const pack = populations.find((population) => population.id === "pack");
let content = null;
if (pack && !pack.absent) {
  content = scanPack();
  if (content.scanned === 0)
    fail(
      "content-rules: read no shipped file — a scan over nothing proves nothing",
    );
  for (const problem of content.problems) fail(problem);
}

/** The pack's population, which the family sentence below counts over. */
const checked = pack && !pack.absent ? pack.skills : 0;

if (problems.length > 0) {
  console.error(
    `skills-contract: ${problems.length} problem(s) — population: ${populations.map(populationLabel).join(", ")}`,
  );
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const parts = [
  populations.map(populationLabel).join(", "),
  "name/description/validated/verdict, >=2 trigger phrase(s) under 'triggers:' each, one phrase per skill across every tree read",
];
if (pack && !pack.absent) {
  parts.push(
    `${declared.size} family declaration(s) over ${declaringFiles.size} file(s), ${checked - declaringFiles.size} declaring none`,
  );
  parts.push(
    `${content.scanned} shipped file(s) name only declared tools and projects`,
  );
}
console.log(`skills-contract: clean (${parts.join("; ")})`);
