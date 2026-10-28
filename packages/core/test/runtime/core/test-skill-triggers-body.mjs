/**
 * Test: skills-tool trigger sources — where authors actually wrote the phrases.
 *
 * The suggestion matcher only ever saw frontmatter `triggers:` (a YAML list).
 * Authors wrote the phrases in three places: frontmatter under `trigger:` (5 of
 * core's 22 skills, comma-separated), frontmatter under `triggers:` (1 skill),
 * and a `## trigger: "…"` body heading (9 skills, and nowhere else). This suite
 * pins the reader against the real `skills/` tree, where the gaps live: a mock
 * skill carries whatever phrase the test author would write, so it cannot show
 * that a whole shape of authored phrase never reached the matcher.
 *
 * Matching is pinned here too: phrases are lowercase, prompts are not.
 *
 * Every declaring source is read and the lists MERGE (frontmatter, then body
 * heading, then description tail): source precedence orders the merged list
 * and decides which source the cap cuts last — it never drops an authored
 * phrase on its own. The case that proved it is agent-testing, which declares
 * seven phrases in its description tail and five in its body heading; under
 * first-wins the body heading replaced the tail, so the seven never reached
 * the matcher.
 *
 * Run: npm test -w packages/core
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE = join(__dirname, "..", "..", "..");
const DIST = join(CORE, "dist", "extensions", "core", "skills-tool");

const {
  readSkillTriggers,
  parseBodyTriggers,
  parseDescriptionTriggers,
  normalizeTriggers,
  triggerMatches,
  clearSkillTriggerCache,
  MAX_TRIGGERS,
} = await import(join(DIST, "skill-triggers.js"));

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

const skillsDir = join(CORE, "skills");
const skills = readdirSync(skillsDir)
  .filter((dir) => {
    try {
      readFileSync(join(skillsDir, dir, "SKILL.md"));
      return true;
    } catch {
      return false;
    }
  })
  .sort()
  .map((dir) => {
    const filePath = join(skillsDir, dir, "SKILL.md");
    const text = readFileSync(filePath, "utf8");
    const front = frontmatterOf(text);
    const description = field(front, "description") ?? "";
    return {
      name: field(front, "name") ?? dir,
      filePath,
      text,
      triggers: readSkillTriggers(filePath, description),
      description,
    };
  });

const byName = new Map(skills.map((s) => [s.name, s]));

console.log("\ntrigger phrases read per skill:");
for (const s of skills) {
  console.log(`  ${s.name.padEnd(24)} ${String(s.triggers.length).padStart(2)}  ${s.triggers.slice(0, 2).join(" | ")}`);
}

// ── the body heading ───────────────────────────────────────────────────────

/** The nine skills whose phrases live in a `## trigger:` body heading. */
const BODY_HEADING_SKILLS = [
  "agent-testing",
  "braid-reference",
  "meta-improvement",
  "misdirection-audit",
  "pi-reference",
  "placement-discipline",
  "probe-evaluation",
  "software-engineer",
  "tone-quality",
];

test("every body-heading skill yields its phrases", () => {
  for (const name of BODY_HEADING_SKILLS) {
    const skill = byName.get(name);
    assert.ok(skill, `${name} missing from skills/`);
    assert.ok(
      skill.triggers.length > 0,
      `${name}: no triggers read — its phrases are in a "## trigger:" body heading`,
    );
  }
});

test("the phrases are the ones each heading declares", () => {
  const expected = {
    "agent-testing": "benchmarking",
    "braid-reference": "braid docs",
    "meta-improvement": "creating new skills",
    "misdirection-audit": "hygiene sweep",
    "pi-reference": "extension development",
    "placement-discipline": "placement ledger",
    "probe-evaluation": "pre-registered rubric",
    "software-engineer": "code review",
    "tone-quality": "writing documentation",
  };
  for (const [name, phrase] of Object.entries(expected)) {
    assert.ok(
      byName.get(name).triggers.includes(phrase),
      `${name}: expected "${phrase}", read [${byName.get(name).triggers.join(", ")}]`,
    );
  }
});

test("a skill that declares two sources carries both", () => {
  // agent-testing is the case first-wins hid: seven description phrases (its
  // tail) and five body-heading phrases, one of them shared. Under precedence
  // the body heading replaced the tail and the tail's phrases never existed.
  const agentTesting = byName.get("agent-testing");
  for (const phrase of ["agent benchmark", "rpc mode", "agent event parsing"]) {
    assert.ok(
      agentTesting.triggers.includes(phrase),
      `description-tail phrase "${phrase}" is unread: [${agentTesting.triggers.join(", ")}]`,
    );
  }
  for (const phrase of ["benchmarking", "evaluating agent configurations"]) {
    assert.ok(
      agentTesting.triggers.includes(phrase),
      `body-heading phrase "${phrase}" is unread: [${agentTesting.triggers.join(", ")}]`,
    );
  }
  assert.equal(
    agentTesting.triggers.filter((t) => t === "tool execution verification").length,
    1,
    "a phrase both sources declare is kept once",
  );
});

test("parseBodyTriggers reads the first heading, strips quotes, takes both spellings", () => {
  assert.deepEqual(parseBodyTriggers('intro\n\n## trigger: "alpha, beta"\n\n## trigger: "gamma"'), [
    "alpha",
    "beta",
  ]);
  assert.deepEqual(parseBodyTriggers("## Triggers: one, two"), ["one", "two"]);
  assert.deepEqual(parseBodyTriggers("## trigger:\n"), []);
  assert.deepEqual(parseBodyTriggers("### trigger: ignored, not a level-two heading"), []);
  assert.deepEqual(parseBodyTriggers("no heading here"), []);
});

test("frontmatter outranks a body heading, and every declaring source is read", () => {
  clearSkillTriggerCache();
  const dir = mkdtempSync(join(tmpdir(), "braid-trigger-body-"));
  try {
    const both = join(dir, "both.md");
    writeFileSync(
      both,
      '---\nname: both\ndescription: d\ntrigger: "from frontmatter"\n---\n\n## trigger: "from body"\n',
      "utf-8",
    );
    // Merged, frontmatter first: precedence decides ORDER and which source the
    // cap cuts last, never whether an authored phrase is read at all.
    assert.deepEqual(readSkillTriggers(both), ["from frontmatter", "from body"]);

    const bodyOnly = join(dir, "body.md");
    writeFileSync(bodyOnly, '---\nname: body\ndescription: d\n---\n\n## trigger: "only body"\n', "utf-8");
    assert.deepEqual(readSkillTriggers(bodyOnly), ["only body"]);

    const neither = join(dir, "neither.md");
    writeFileSync(neither, "---\nname: neither\ndescription: d\n---\n\nbody text", "utf-8");
    assert.deepEqual(readSkillTriggers(neither), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the frontmatter fields and the description tail ──────────────────────

test("a frontmatter `trigger:` string is read as well as a `triggers:` list", () => {
  // Five skills declare the singular key: a comma-separated string, not a list.
  assert.ok(byName.get("subagent-orchestration").triggers.includes("mastership transfer"));
  assert.ok(byName.get("release-pipeline").triggers.includes("npm publish"));
  assert.ok(byName.get("subagent-verification").triggers.length > 0);
  assert.ok(byName.get("voice-replies").triggers.includes("text-to-speech"));
  assert.ok(byName.get("healthcheck").triggers.includes("tool diagnostics"));
  // One declares the plural key as a YAML list.
  assert.ok(byName.get("pane-topology").triggers.includes("driving panes"));
});

test("the description's Triggers: tail still works when nothing else is declared", () => {
  assert.deepEqual(parseDescriptionTriggers("Use when X. Triggers: meme, image macro."), [
    "meme",
    "image macro",
  ]);
  assert.deepEqual(parseDescriptionTriggers("no segment here"), []);
  assert.deepEqual(normalizeTriggers([" Pane topology ", "pane topology", 42, ""]), ["pane topology"]);
});

test("most of the catalog now carries phrases", () => {
  const carrying = skills.filter((s) => s.triggers.length > 0).length;
  console.log(`         ${carrying} of ${skills.length} skills carry trigger phrases`);
  assert.ok(carrying >= 15, `only ${carrying} skills carry phrases`);
});

test("the phrase cap holds, and the three lists that reach it are named", () => {
  // Merging the sources made every authored phrase visible, so three lists now
  // spend the whole budget (braid-reference 16 and pi-reference 15 are cut;
  // voice-replies fills it exactly). agent-testing lands on 11 because its two
  // sources share "tool execution verification" — the dedup keeps one copy.
  assert.ok(skills.every((s) => s.triggers.length <= MAX_TRIGGERS));
  const atCap = skills
    .filter((s) => s.triggers.length === MAX_TRIGGERS)
    .map((s) => s.name)
    .sort();
  assert.deepEqual(atCap, ["braid-reference", "pi-reference", "voice-replies"]);
});

// ── matching ───────────────────────────────────────────────────────────────

test("trigger matching folds case: prompts arrive capitalized", () => {
  assert.equal(triggerMatches("mastership transfer", "MASTERSHIP TRANSFER: you own the seat"), true);
  assert.equal(triggerMatches("terminal topology", "Fix my Terminal Topology please"), true);
  assert.equal(triggerMatches("pane", "the panelled room"), false, "word-bounded");
  assert.equal(triggerMatches("pane", "split a pane for two agents"), true);
});

test("a real capitalized prompt reaches its skill's phrase", () => {
  const prompt = "MASTERSHIP TRANSFER: you are the successor seat and own the fleet.";
  const hits = skills.filter((s) => s.triggers.some((t) => triggerMatches(t, prompt)));
  assert.deepEqual(
    hits.map((s) => s.name),
    ["subagent-orchestration"],
  );
});

// ── result ────────────────────────────────────────────────────────────────

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
