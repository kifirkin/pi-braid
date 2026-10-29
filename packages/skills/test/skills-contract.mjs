#!/usr/bin/env node
/**
 * skills-contract.mjs — the catalog contract for shipped skills.
 *
 * Every `skills/<dir>/SKILL.md` opens with frontmatter carrying:
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
 * The content-rules fixture runs from here too, so `npm test` covers the
 * shipped text as well as the frontmatter.
 *
 * The values are audit evidence; this asserts shape only, never which verdict
 * a skill deserves. Directories without a SKILL.md (the shared fragment dir)
 * are skipped.
 *
 * Run: npm test -w packages/skills
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanPack } from "./content-rules.mjs";
import { TOOL_FAMILIES } from "./content-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(__dirname, "..", "skills");

const VERDICTS = new Set([
  "KEEP",
  "IMPROVE",
  "MOVE",
  "DEPRECATE",
  "UNVALIDATED",
]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Mirrors skill-triggers.ts: the reader keeps this many phrases per skill. */
const MAX_TRIGGERS = 12;
/** Mirrors skill-triggers.ts: a longer phrase is dropped by the reader. */
const MAX_TRIGGER_CHARS = 64;
/** pi's own cap on a skill description; longer loads with a warning nobody reads. */
const MAX_DESCRIPTION_CHARS = 1024;
/** A description that names a situation an agent can be in, not just a topic. */
const SITUATION =
  /\buse (?:when|if|for|only|this|it|these)\b|\bwhen (?:a|an|the|you|there|it|someone|work)\b/i;
/** The skill-name shape pi accepts. */
const NAME_SHAPE = /^[a-z0-9-]+$/;

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

function checkSkill(dirName) {
  const rel = `skills/${dirName}/SKILL.md`;
  let text;
  try {
    text = readFileSync(join(skillsDir, dirName, "SKILL.md"), "utf8");
  } catch {
    return false; // no SKILL.md: the shared fragment directory
  }

  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!block) {
    fail(`${rel}: no frontmatter block (must open with "---")`);
    return true;
  }
  const front = block[1];

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
      else if (!TOOL_FAMILIES.has(entry))
        fail(
          `${rel}: governs entry '${entry}' is no family this pack admits — declare one of ${[...TOOL_FAMILIES].sort().join(", ")}, or drop it`,
        );
      if (seen.has(entry))
        fail(`${rel}: governs entry '${entry}' is declared twice`);
      seen.add(entry);
      declared.add(`${rel}:${entry}`);
    }
  }

  return true;
}

let checked = 0;
const phraseOwners = new Map();
for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
  if (checkSkill(entry.name)) checked += 1;
}

// The shipped text, not just the frontmatter: a skill may only name a tool or
// a project a reader of this package can reach. Fail closed on an empty run.
const content = scanPack();
if (content.scanned === 0)
  fail(
    "content-rules: read no shipped file — a scan over nothing proves nothing",
  );
for (const problem of content.problems) fail(problem);

if (problems.length > 0) {
  console.error(`skills-contract: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
if (checked === 0) {
  console.error("skills-contract: no SKILL.md found under skills/");
  process.exit(1);
}
console.log(
  `skills-contract: clean (${checked} skill(s): name/description/validated/verdict, >=2 trigger phrase(s) each; ${declared.size} family declaration(s) over ${declaringFiles.size} file(s), ${checked - declaringFiles.size} declaring none; ${content.scanned} shipped file(s) name only declared tools and projects)`,
);
