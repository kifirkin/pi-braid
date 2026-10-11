#!/usr/bin/env node
/**
 * check-doc-index.mjs — fail when braid's doc index stops telling the truth.
 *
 * The index is the topic table in the skills pack:
 * `skills/braid-reference/SKILL.md`. It answers "which file owns this
 * question" for a reader who has only the installed packages, so a stale row
 * is worse than no row: it sends the reader to a file that moved, or vouches
 * for a doc that lost its authority. This script asserts:
 *
 *   1. Shape — the skill opens with frontmatter (name, description) plus a
 *      trigger line, and carries both tables under headings whose text
 *      contains "Topic index" and "Gaps".
 *   2. Resolution — every repo path the skill names (`packages/<pkg>/….md`)
 *      exists, and every topic-index row names at least one of them.
 *   3. Authority — every named file carries the marker of its kind: a
 *      `<!-- status: … -->` comment in the first 80 lines for a doc, the
 *      frontmatter block for a `SKILL.md`. A doc that loses its marker leaves
 *      the index.
 *   4. Tarball state — the row's Shipped cell (`npm` | `checkout`) agrees with
 *      the owning package.json `files` patterns, so "a reader who installed
 *      the package can open this" is checkable, not a claim.
 *   5. Coverage — a fixed minimum set of domains has a row, so deleting a
 *      topic fails loudly instead of quietly shrinking the index.
 *   6. Gaps stay gaps — gap rows carry no repo path: they are pointers to
 *      sources the index does not vouch for.
 *
 * Exit 0 clean, 1 on any hit:
 *   node packages/core/scripts/check-doc-index.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Script is at packages/core/scripts/ — monorepo root is 3 levels up.
const root = resolve(__dirname, "..", "..", "..");

const SKILL_REL = "packages/core/skills/braid-reference/SKILL.md";

/** Status vocabulary shared with check-doc-status.mjs. */
const VALID_STATUSES = new Set(["current", "forward-looking", "aspirational", "historical"]);
const STATUS_RE = /<!--\s*status:\s*(\S+)\s*-->/;
/** Marker search window, same as check-doc-status.mjs. */
const MARKER_WINDOW_LINES = 80;

/**
 * Domains the index must keep a row for — the questions agents actually ask.
 * A group is satisfied by any one keyword (an "extension" row may cover the
 * polyfill, which is only ever asked about alongside extensions).
 */
const REQUIRED_DOMAINS = [
  ["context"],
  ["timer"],
  ["worker"],
  ["telegram"],
  ["prompt"],
  ["memory"],
  ["skill"],
  ["release"],
  ["health"],
  ["extension", "polyfill"],
];

/** Repo paths the skill names: `packages/<pkg>/<rest>.md`, backticked or not. */
const PATH_RE = /packages\/(core|skills|telegram)\/([A-Za-z0-9._/-]+\.md)/g;

const problems = [];
const fail = (message) => problems.push(message);

/** Set by checkSkillContracts(); reported in the clean line. */
let skillContracts = 0;

const skillPath = resolve(root, SKILL_REL);
let skill;
try {
  skill = readFileSync(skillPath, "utf8");
} catch {
  fail(`${SKILL_REL}: not found — the index has no home`);
  report();
}

const lines = skill.split("\n");

// ── 1. Shape ────────────────────────────────────────────────────────────────

function checkShape() {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(skill);
  if (!front) {
    fail(`${SKILL_REL}: no frontmatter block — the catalog reads name/description from it`);
  } else {
    for (const key of ["name", "description"]) {
      if (!new RegExp(`^${key}\\s*:`, "m").test(front[1])) {
        fail(`${SKILL_REL}: frontmatter is missing '${key}'`);
      }
    }
  }
  const hasTrigger =
    /^##+\s*trigger:/m.test(skill) || /^triggers?\s*:/m.test(front ? front[1] : "");
  if (!hasTrigger) {
    fail(`${SKILL_REL}: no trigger line (a '## trigger:' heading or a 'triggers:' key)`);
  }
}

// ── Table parsing ───────────────────────────────────────────────────────────

/** Rows of the first table under a heading whose text matches `headingRe`. */
function tableRows(headingRe) {
  const start = lines.findIndex((line) => /^##+\s/.test(line) && headingRe.test(line));
  if (start === -1) return null;
  const rows = [];
  let headerDropped = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##+\s/.test(line)) break;
    if (!line.trim().startsWith("|")) continue;
    if (/^\|[\s:|-]+\|$/.test(line.trim())) {
      // Separator: the row above it is the header, not a topic.
      if (!headerDropped) {
        rows.pop();
        headerDropped = true;
      }
      continue;
    }
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    rows.push(cells);
  }
  return rows;
}

const pathsIn = (text) => [...text.matchAll(PATH_RE)].map((m) => `packages/${m[1]}/${m[2]}`);

// ── 2. Resolution + 3. Authority ────────────────────────────────────────────

function authorityProblem(text, rel) {
  if (rel.endsWith("SKILL.md")) {
    const front = /^---\n([\s\S]*?)\n---/.exec(text);
    if (!front) return "no frontmatter block";
    const missing = ["name", "description"]
      .concat("trigger")
      .filter((key) => {
        if (key === "trigger") {
          return !(/^triggers?\s*:/m.test(front[1]) || /^##+\s*trigger:/m.test(text));
        }
        return !new RegExp(`^${key}\\s*:`, "m").test(front[1]);
      });
    return missing.length > 0 ? `frontmatter/trigger missing ${missing.join(", ")}` : null;
  }
  const head = text.split("\n").slice(0, MARKER_WINDOW_LINES).join("\n");
  const match = head.match(STATUS_RE);
  if (!match) return `no '<!-- status: … -->' marker in the first ${MARKER_WINDOW_LINES} lines`;
  if (!VALID_STATUSES.has(match[1])) return `unknown status '${match[1]}'`;
  return null;
}

/** Does a package's `files` list ship this package-relative path? */
function shippedIn(patterns, rel) {
  const hit = (pattern) =>
    pattern.endsWith("/") ? rel.startsWith(pattern) : globToRe(pattern).test(rel);
  const positives = patterns.filter((p) => !p.startsWith("!"));
  const negatives = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  return positives.some(hit) && !negatives.some(hit);
}

function globToRe(pattern) {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${body}$`);
}

const filesCache = new Map();
function packageFiles(pkg) {
  if (!filesCache.has(pkg)) {
    const manifest = JSON.parse(readFileSync(resolve(root, "packages", pkg, "package.json"), "utf8"));
    filesCache.set(pkg, Array.isArray(manifest.files) ? manifest.files : []);
  }
  return filesCache.get(pkg);
}

const claimed = new Map(); // rel path -> Set of Shipped cells that named it

function checkPaths(indexRows) {
  for (const [pkg, rel] of [...skill.matchAll(PATH_RE)].map((m) => [m[1], m[2]])) {
    const full = `packages/${pkg}/${rel}`;
    let text;
    try {
      text = readFileSync(resolve(root, full), "utf8");
    } catch {
      fail(`${SKILL_REL}: names ${full}, which does not exist`);
      continue;
    }
    const problem = authorityProblem(text, full);
    if (problem) fail(`${SKILL_REL}: ${full} — ${problem}`);
  }

  for (const row of indexRows) {
    const [topic, docCell, shippedCell] = row;
    if (!docCell || !shippedCell) {
      fail(`${SKILL_REL}: topic row '${topic}' needs Doc and Shipped cells`);
      continue;
    }
    if (shippedCell !== "npm" && shippedCell !== "checkout") {
      fail(`${SKILL_REL}: topic row '${topic}' — Shipped must be 'npm' or 'checkout', got '${shippedCell}'`);
      continue;
    }
    const paths = pathsIn(docCell);
    if (paths.length === 0) {
      fail(`${SKILL_REL}: topic row '${topic}' names no repo path — give it a doc or move it to the gaps table`);
      continue;
    }
    for (const full of paths) {
      if (!claimed.has(full)) claimed.set(full, new Set());
      claimed.get(full).add(shippedCell);
      const pkg = full.split("/")[1];
      const rel = full.slice(`packages/${pkg}/`.length);
      const shipped = shippedIn(packageFiles(pkg), rel);
      if (shipped && shippedCell === "checkout") {
        fail(`${SKILL_REL}: ${full} is in the ${pkg} tarball, but row '${topic}' marks it checkout`);
      }
      if (!shipped && shippedCell === "npm") {
        fail(`${SKILL_REL}: ${full} is not in the ${pkg} tarball (package.json files), but row '${topic}' marks it npm`);
      }
    }
  }
}

// ── 5. Coverage ─────────────────────────────────────────────────────────────

function checkCoverage(indexRows) {
  const topics = indexRows.map((row) => (row[0] ?? "").toLowerCase()).join("\n");
  for (const group of REQUIRED_DOMAINS) {
    if (!group.some((keyword) => topics.includes(keyword))) {
      fail(
        `${SKILL_REL}: no topic row covers '${group.join("' or '")}' — every domain the index promises needs a row`,
      );
    }
  }
}

// ── 6. Gaps stay gaps ───────────────────────────────────────────────────────

function checkGaps(gapRows) {
  for (const row of gapRows) {
    const [topic, fallback] = row;
    if (!topic || !fallback) {
      fail(`${SKILL_REL}: gap row '${topic ?? ""}' needs both a topic and a fallback`);
      continue;
    }
    const paths = pathsIn(row.join(" "));
    if (paths.length > 0) {
      fail(
        `${SKILL_REL}: gap row '${topic}' names the repo path ${paths[0]} — a path belongs in the topic table, where it is checked`,
      );
    }
  }
}

// ── 7. Skill frontmatter contract ───────────────────────────────────────────

/** Verdict values a shipped skill may declare. */
const SKILL_VERDICTS = new Set(["KEEP", "IMPROVE", "UNVALIDATED", "DEPRECATE", "MOVE"]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The catalog contract: every shipped `SKILL.md` carries `name`,
 * `description`, an ISO `validated:` date, and a `verdict:` from the enum.
 * The values are the audit's evidence; this asserts shape only, never which
 * verdict a skill deserves.
 */
function checkSkillContracts() {
  const dir = resolve(root, "packages/skills/skills");
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    fail("packages/skills/skills: not found, so there are no skills to check");
    return 0;
  }
  let checked = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const rel = `packages/skills/skills/${entry.name}/SKILL.md`;
    let text;
    try {
      text = readFileSync(resolve(root, rel), "utf8");
    } catch {
      continue; // _shared and other non-skill directories carry no SKILL.md
    }
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!front) {
      fail(`${rel}: no frontmatter block`);
      continue;
    }
    const body = front[1];
    for (const key of ["name", "description"]) {
      if (!new RegExp(`^${key}\\s*:\\s*\\S`, "m").test(body)) {
        fail(`${rel}: frontmatter is missing '${key}'`);
      }
    }
    const validated = /^validated\s*:\s*(\S+)\s*$/m.exec(body);
    if (!validated) fail(`${rel}: frontmatter is missing 'validated' (ISO date)`);
    else if (!ISO_DATE_RE.test(validated[1]))
      fail(`${rel}: validated '${validated[1]}' is not an ISO date (YYYY-MM-DD)`);
    const verdict = /^verdict\s*:\s*(\S+)\s*$/m.exec(body);
    if (!verdict) fail(`${rel}: frontmatter is missing 'verdict'`);
    else if (!SKILL_VERDICTS.has(verdict[1]))
      fail(`${rel}: verdict '${verdict[1]}' is not one of ${[...SKILL_VERDICTS].join(" / ")}`);
    checked += 1;
  }
  return checked;
}

// ── Report ──────────────────────────────────────────────────────────────────

function report() {
  if (problems.length > 0) {
    console.error(`check-doc-index: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  const checkout = [...claimed.values()].filter((states) => states.has("checkout")).length;
  console.log(
    `check-doc-index: clean (${claimed.size} path(s) resolved, ${checkout} checkout-only, ` +
      `${claimed.size - checkout} in the published tarballs; ` +
      `${skillContracts} skill frontmatter contract(s) verified)`,
  );
}

checkShape();
skillContracts = checkSkillContracts();
const indexRows = tableRows(/topic index/i);
const gapRows = tableRows(/gaps/i);
if (!indexRows) fail(`${SKILL_REL}: no '## … Topic index …' section found`);
if (!gapRows) fail(`${SKILL_REL}: no '## Gaps …' section found`);
if (indexRows) checkPaths(indexRows);
if (indexRows) checkCoverage(indexRows);
if (gapRows) checkGaps(gapRows);
report();
