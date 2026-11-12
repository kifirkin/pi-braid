/**
 * Test: design-skill selection — sixteen owner-voiced design prompts, one bar.
 *
 * The labelled relevance set (test-skill-relevance.mjs) samples the
 * repository's work and reads the core catalog; it answers whether the matcher
 * ranks ordinary prompts correctly. It cannot answer the design question,
 * because a design request arrives in a different shape: short,
 * complaint-shaped, naming no skill ("this looks generic and flat"). The words
 * a designer uses to complain are not the words a skill description used to
 * explain itself, so a description can be accurate and still never fire.
 *
 * This fixture is the measurement for that class. Labels were read from each
 * skill's own description and trigger phrases, before the descriptions were
 * rewritten, never from what the matcher returned. The pre-registered bar was
 * written before the rewrite and lives in the report
 * (braid-docs/reports/DESIGN-METHOD-2026-11-12.md):
 *
 *   - at least 10 of 16 design prompts select one of the four design skills;
 *   - the ceiling is 14, because two prompts name no domain a description can
 *     see: `fix the contrast on this` is decided by the file in view, and
 *     `make it better` carries no domain noun at all;
 *   - no prompt in the non-design guardrail may select a design skill;
 *   - the same sixteen against a catalog with the four skills removed must
 *     select none of them — the control that proves the table measures
 *     selection and not scorer noise.
 *
 * The catalog is both shipped trees, as installed: `packages/core/skills` and
 * `packages/skills/skills`. Ranking is the production path — extract, score
 * with the corpus-frequency gate, select — with both slots free on a first
 * turn.
 *
 * Run: npm test -w packages/core
 */

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE = join(__dirname, "..", "..", "..");
const PACK = join(CORE, "..", "skills", "skills");
const DIST = join(CORE, "dist", "extensions", "core", "skills-tool");

const {
  extractKeywords,
  matchSkill,
  selectSuggestions,
  corpusKeywordFrequency,
} = await import(join(DIST, "auto-inject.js"));
const { readSkillTriggers } = await import(join(DIST, "skill-triggers.js"));

// ── the shipped catalog ────────────────────────────────────────────────────

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

/** Every skill in one tree, with the trigger phrases the production reader keeps. */
function readTree(dir) {
  return readdirSync(dir)
    .filter((entry) => {
      try {
        readFileSync(join(dir, entry, "SKILL.md"));
        return true;
      } catch {
        return false;
      }
    })
    .sort()
    .map((entry) => {
      const filePath = join(dir, entry, "SKILL.md");
      const text = readFileSync(filePath, "utf8");
      const front = frontmatterOf(text);
      const description = field(front, "description") ?? "";
      return {
        name: field(front, "name") ?? entry,
        filePath,
        description,
        baseDir: join(dir, entry),
        triggers: readSkillTriggers(filePath, description),
      };
    });
}

const skills = [...readTree(join(CORE, "skills")), ...readTree(PACK)];
const byName = new Map(skills.map((s) => [s.name, s]));

const DESIGN_SKILLS = ["visual-creator", "visual-validator", "design-system", "landing-page"];
const DESIGN = new Set(DESIGN_SKILLS);

/** Run one prompt through the production path: extract → score → select top 2. */
function rank(prompt, catalog = skills) {
  const keywords = extractKeywords(prompt);
  const df = corpusKeywordFrequency(keywords, catalog);
  const scored = catalog
    .map((s) => ({ skill: s, ...matchSkill(s, keywords, prompt, df) }))
    .filter((s) => s.score > 0);
  return selectSuggestions(scored, [], 1).map((s) => s.skill.name);
}

/** The design skills among a selection. */
const designOf = (picks) => picks.filter((name) => DESIGN.has(name));

// ── the prompt set ─────────────────────────────────────────────────────────

/**
 * Sixteen design prompts in the owner's voice: short, complaint-shaped, no
 * skill named. `expected` is the skill that should answer it, read from that
 * skill's description and triggers. `reachable: false` marks the two prompts a
 * description cannot see; they are labelled with the skill that would answer
 * them once the artifact in view is known, and the bar does not count them.
 */
const PROMPTS = [
  {
    label: "generic-flat",
    prompt: "this looks generic and flat, like every AI page",
    expected: "visual-creator",
  },
  {
    label: "cheap-dated",
    prompt: "it feels cheap and dated, fix the vibe",
    expected: "visual-creator",
  },
  {
    label: "same-size",
    prompt: "everything is the same size and weight, nothing draws the eye",
    expected: "visual-creator",
  },
  {
    label: "spacing-twitch",
    prompt: "the spacing makes me twitch, nothing sits together",
    expected: "visual-creator",
  },
  {
    label: "phone-looking",
    prompt: "does this page look ok on a phone? screenshot attached",
    expected: "visual-validator",
  },
  {
    label: "why-bad",
    prompt: "look at this screenshot and tell me why it looks bad",
    expected: "visual-validator",
  },
  {
    label: "blob-icon",
    prompt: "the little robot icon turns into a blob when it is small",
    expected: "visual-validator",
  },
  {
    label: "slide-room",
    prompt: "this slide is unreadable in the room",
    expected: "visual-validator",
  },
  {
    label: "different-blue",
    prompt: "every session paints this project a different shade of blue",
    expected: "design-system",
  },
  {
    label: "spec-mismatch",
    prompt: "the styles in the code do not match the spec we wrote",
    expected: "design-system",
  },
  {
    label: "write-the-look",
    prompt: "write down the look so the next session does not invent it",
    expected: "design-system",
  },
  {
    label: "weak-top",
    prompt: "the top of the landing page is weak, nobody would sign up",
    expected: "landing-page",
  },
  {
    label: "no-js",
    prompt: "it has to work without javascript",
    expected: "landing-page",
  },
  {
    label: "tabs-jump",
    prompt: "the tabs jump around and the prices do not line up",
    expected: "landing-page",
  },
  {
    label: "contrast-open-file",
    prompt: "fix the contrast on this",
    expected: "visual-validator",
    reachable: false,
    note: "the file in view decides; a description cannot see it",
  },
  {
    label: "better",
    prompt: "make it better",
    expected: "visual-creator",
    reachable: false,
    note: "bare imperative, no domain noun",
  },
];

/**
 * The non-design guardrail: real prompts from this repository's work, plus two
 * traps that carry a design word in a non-design sense. A design skill among
 * their selections is a false positive the rewrite introduced.
 */
const GUARDRAIL = [
  "prepare the release train on a branch, the four packages need a version bump",
  "rename the gateway provider id to agent-zero",
  "we have now a ton of ghost pi processes",
  "let's observe, onboard and pick up, then continue work here",
  "whats the latest state here?",
  "try to research and suggest salary for engineer like me",
  "the report lacks the required ## Placement section",
  "let's fire deep review and polish session of my own cv",
  "the npm-first install line must appear on every doc surface that teaches installing braid",
  "be sure that our default provider route is always start with opencode",
  "the release notes should read like a person wrote them, not a machine",
  "the error message is generic, rewrite it",
];

const REACHABLE = PROMPTS.filter((c) => c.reachable !== false);

// ── 1. the prompt set and its measurement ──────────────────────────────────

console.log(`\n— catalog: ${skills.length} skills across both shipped trees —`);

const rows = [];
let designSelected = 0;
for (const c of PROMPTS) {
  const picks = rank(c.prompt);
  const design = designOf(picks);
  if (design.length) designSelected++;
  rows.push({
    case: c.label,
    expected: c.expected,
    picked: picks.join(",") || "—",
    design: design.join(",") || "—",
    reachable: c.reachable !== false,
  });
}
console.log("\ndesign prompts (first turn: no cooldown, both slots free):");
console.table(rows);

const guardrailRows = [];
let guardrailHits = 0;
for (const prompt of GUARDRAIL) {
  const picks = rank(prompt);
  const design = designOf(picks);
  if (design.length) guardrailHits++;
  guardrailRows.push({ prompt, picked: picks.join(",") || "—", design: design.join(",") || "—" });
}
console.log("\nnon-design guardrail (a design skill here is a false positive):");
console.table(guardrailRows);

const controlPicks = [];
const withoutDesign = skills.filter((s) => !DESIGN.has(s.name));
for (const c of PROMPTS) {
  controlPicks.push(...designOf(rank(c.prompt, withoutDesign)));
}
console.log(
  `\ndesign prompts selecting a design skill = ${designSelected}/${PROMPTS.length} | ` +
    `guardrail hits = ${guardrailHits}/${GUARDRAIL.length} | ` +
    `control-arm selections = ${controlPicks.length}`,
);

test("the catalog is the shipped pair of trees and carries all four design skills", () => {
  assert.ok(skills.length >= 30, `only ${skills.length} skills read`);
  for (const name of DESIGN_SKILLS) {
    assert.ok(byName.has(name), `${name} is not in the catalog the fixture scores`);
  }
});

test("the prompt set keeps its measured shape: sixteen design prompts, two unreachable", () => {
  assert.equal(PROMPTS.length, 16, `the set holds ${PROMPTS.length} prompts`);
  assert.equal(REACHABLE.length, 14, `${REACHABLE.length} reachable prompts, not the registered 14`);
  for (const c of PROMPTS) {
    assert.ok(DESIGN.has(c.expected), `${c.label} is labelled with ${c.expected}, not a design skill`);
  }
});

test("design prompts that select a design skill clear the pre-registered bar", () => {
  // The bar was 10 of 16 before the descriptions were rewritten; the measured
  // number is printed above so a regression reports itself as a number.
  assert.ok(
    designSelected >= 10,
    `${designSelected}/${PROMPTS.length} design prompts select one of the four`,
  );
});

test("every reachable prompt reaches its labelled skill", () => {
  for (const c of REACHABLE) {
    const picks = rank(c.prompt);
    assert.ok(picks.includes(c.expected), `${c.label}: expected ${c.expected}, picked ${picks.join(",") || "—"}`);
  }
});

test("the two unreachable prompts stay unreachable, which is the registered ceiling", () => {
  // 14 is the ceiling because two prompts name no domain a description can
  // see. A fifteenth selection would mean a trigger or a description word now
  // guesses from the artifact, and this fixture must be re-read rather than
  // celebrated.
  for (const c of PROMPTS.filter((x) => x.reachable === false)) {
    const design = designOf(rank(c.prompt));
    assert.deepEqual(design, [], `${c.label} now selects ${design.join(",")}; ${c.note}`);
  }
  assert.equal(designSelected, REACHABLE.length, `${designSelected} selections over ${REACHABLE.length} reachable prompts`);
});

test("no non-design prompt selects a design skill", () => {
  assert.equal(guardrailHits, 0, `${guardrailHits} of ${GUARDRAIL.length} guardrail prompts selected a design skill`);
});

test("the control arm selects no design skill", () => {
  assert.deepEqual(controlPicks, [], `control selections: ${controlPicks.join(",")}`);
});

// ── 2. the four skills name the ruler and the loop ─────────────────────────

const FILES = new Map(
  DESIGN_SKILLS.map((name) => [name, readFileSync(byName.get(name).filePath, "utf8")]),
);
const squash = (text) => text.replace(/\s+/g, " ");

/** The ruler field each skill is responsible for (see its own section). */
const OWNED_NUMBERS = {
  "visual-creator": ["`inventory`", "`colors[].coverage`"],
  "visual-validator": ["`contrast.failures[]`", "`overflow[]`", "`tapTargets[]`"],
  "design-system": ["`inventory.fontSizes`", "`inTokens`", "`findings.offGrid`"],
  "landing-page": ["`overflow[]`", "`findings.total`"],
};

test("each design skill names the ruler, the widths and the numbers it owns", () => {
  for (const name of DESIGN_SKILLS) {
    const text = FILES.get(name);
    assert.ok(text.includes("design_audit"), `${name} does not name design_audit`);
    assert.ok(
      squash(text).includes("320, 390, 768, 1440"),
      `${name} does not name the measured widths`,
    );
    for (const fieldName of OWNED_NUMBERS[name]) {
      assert.ok(text.includes(fieldName), `${name} does not name ${fieldName}`);
    }
  }
});

test("the loop is written once, in visual-validator, and the other three point at it", () => {
  assert.ok(
    FILES.get("visual-validator").includes("## The loop (owned here)"),
    "visual-validator no longer owns the loop heading",
  );
  for (const name of DESIGN_SKILLS.filter((n) => n !== "visual-validator")) {
    assert.ok(!FILES.get(name).includes("## The loop (owned here)"), `${name} restates the loop`);
    assert.ok(FILES.get(name).includes("visual-validator"), `${name} does not point at the loop's owner`);
  }
});
