#!/usr/bin/env node
/**
 * test-skills-contract.mjs — the catalog contract for the skills shipped with core.
 *
 * Every `skills/<dir>/SKILL.md` opens with frontmatter carrying:
 *   name        the skill's catalog name, equal to its directory name
 *   description a non-empty string (what the model reads to choose a skill)
 *   validated   an ISO date (YYYY-MM-DD)
 *   verdict     one of KEEP | IMPROVE | MOVE | DEPRECATE | UNVALIDATED
 *
 * The values are audit evidence; this asserts shape only, never which verdict
 * a skill deserves. Directories without a SKILL.md are skipped. The same
 * contract guards the on-demand pack (packages/skills/test/skills-contract.mjs).
 *
 * Run: npm test -w packages/core
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(__dirname, "..", "..", "..", "skills");

const VERDICTS = new Set([
  "KEEP",
  "IMPROVE",
  "MOVE",
  "DEPRECATE",
  "UNVALIDATED",
]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const problems = [];
const fail = (message) => problems.push(message);

/** First `key: value` line for `key`, or null. Surrounding quotes stripped. */
function field(front, key) {
  const match = new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(front);
  if (!match) return null;
  const value = match[1].trim();
  return value.replace(/^["']|["']$/g, "");
}

function checkSkill(dirName) {
  const rel = `skills/${dirName}/SKILL.md`;
  let text;
  try {
    text = readFileSync(join(skillsDir, dirName, "SKILL.md"), "utf8");
  } catch {
    return false; // no SKILL.md: not a skill directory
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

  const description = field(front, "description");
  if (!description)
    fail(`${rel}: frontmatter is missing a non-empty 'description'`);

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

  return true;
}

let checked = 0;
for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
  if (checkSkill(entry.name)) checked += 1;
}

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
  `skills-contract: clean (${checked} skill(s) carry name/description/validated/verdict)`,
);
