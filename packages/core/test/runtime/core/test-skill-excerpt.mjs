/**
 * Test: skills-tool/auto-inject.ts — skill content delivery in the
 * suggestion whisper.
 *
 * Pins the contract:
 *   1. stripSkillFrontmatter removes the YAML block so the excerpt carries
 *      the actual skill instructions, not duplicated metadata.
 *   2. extractSkillExcerpt is bounded (≤ maxChars + ellipsis) — the whisper
 *      stays a whisper.
 *   3. readSkillExcerpt reads a real SKILL.md from disk; unreadable files
 *      return "" (caller falls back to the description).
 *   4. formatWhisper includes bounded SKILL.md CONTENT in the bullet plus an
 *      explicit read pointer to the full file — skill content reaches the
 *      agent's view at the moment a domain matches, not just a description.
 *   5. formatWhisper falls back to the description when the file is missing.
 *
 * Fully deterministic: temp files with known content; no reliance on the
 * installed skill catalog or environment.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  stripSkillFrontmatter,
  extractSkillExcerpt,
  readSkillExcerpt,
  formatWhisper,
  MAX_EXCERPT_CHARS,
} = await import("../../../dist/extensions/core/skills-tool/auto-inject.js");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [fail] ${name}: ${e.message}`);
  }
}

/** Temp dirs created during the run; removed in cleanup below. */
const tempDirs = [];

/** Create a temp dir with a SKILL.md file; returns { dir, skillPath } and registers cleanup. */
function makeTempSkill(name, body, desc = "test skill") {
  const dir = mkdtempSync(join(tmpdir(), "pi-braid-skill-test-"));
  tempDirs.push(dir);
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}`, "utf-8");
  return { dir, skillPath };
}

console.log("skill-excerpt test\n");

// ── frontmatter stripping (pure) ────────────────────────────────────────────

test("stripSkillFrontmatter removes the YAML block and returns the body", () => {
  const body = stripSkillFrontmatter(
    "---\nname: research\ndescription: Research workflows\n---\n\nrecall first, then gather sources.",
  );
  assert.equal(body, "recall first, then gather sources.");
});

test("stripSkillFrontmatter passes through content without frontmatter", () => {
  const body = stripSkillFrontmatter("plain body without yaml");
  assert.equal(body, "plain body without yaml");
});

test("stripSkillFrontmatter returns the whole doc when the delimiter is unclosed", () => {
  const text = "---\nname: broken\n";
  assert.equal(stripSkillFrontmatter(text), text);
});

test("stripSkillFrontmatter handles CRLF line endings", () => {
  const body = stripSkillFrontmatter(
    "---\r\nname: research\r\ndescription: x\r\n---\r\n\r\nbody text",
  );
  assert.equal(body, "body text");
});

// ── bounded excerpt (pure) ──────────────────────────────────────────────────

test("extractSkillExcerpt leaves short bodies untouched", () => {
  const body = "read the target file before editing";
  assert.equal(extractSkillExcerpt(body, 300), body);
});

test("extractSkillExcerpt bounds long bodies with an ellipsis", () => {
  const body = "word ".repeat(200).trim(); // ~1000 chars
  const excerpt = extractSkillExcerpt(body, 300);
  assert.ok(excerpt.length <= 301, `excerpt length ${excerpt.length} exceeds bound`);
  assert.ok(excerpt.endsWith("…"), "truncated excerpt must end with ellipsis");
});

test("extractSkillExcerpt trims the body before bounding", () => {
  assert.equal(extractSkillExcerpt("   hello   ", 300), "hello");
});

// ── disk reading ────────────────────────────────────────────────────────────

const { dir: dir1, skillPath: path1 } = makeTempSkill(
  "research",
  "recall first (memory recall_search) so you build on known context, then gather external sources.",
);

test("readSkillExcerpt reads a real SKILL.md and strips frontmatter", () => {
  const excerpt = readSkillExcerpt(path1);
  assert.equal(
    excerpt,
    "recall first (memory recall_search) so you build on known context, then gather external sources.",
  );
});

test("readSkillExcerpt returns empty string for a missing file", () => {
  assert.equal(readSkillExcerpt(join(dir1, "missing", "SKILL.md")), "");
});

// ── whisper content (the behavioral gap) ────────────────────────────────────

test("formatWhisper carries bounded SKILL.md content plus an explicit read pointer", () => {
  const whisper = formatWhisper([
    { name: "research", filePath: path1, description: "Research workflows", baseDir: dir1 },
  ]);
  assert.ok(
    whisper.includes("recall first (memory recall_search)"),
    "whisper must include the skill body excerpt, not just the description",
  );
  assert.ok(
    whisper.includes(`read \`${path1}\` for the full skill`),
    "whisper must point at the full SKILL.md for the rest",
  );
  assert.ok(whisper.startsWith("[SKILL SUGGESTION]"), "whisper keeps its envelope");
});

test("formatWhisper falls back to description when the SKILL.md is unreadable", () => {
  const whisper = formatWhisper([
    {
      name: "ghost",
      filePath: join(dir1, "does-not-exist", "SKILL.md"),
      description: "Ghost skill with a meaningful description",
      baseDir: dir1,
    },
  ]);
  assert.ok(whisper.includes("Ghost skill with a meaningful description"));
  assert.ok(whisper.includes("read `"), "read pointer still present");
});

test("formatWhisper stays bounded: content excerpt ≤ MAX_EXCERPT_CHARS per bullet", () => {
  const longBody = "instructional content ".repeat(100); // ~2100 chars
  const { dir: dir2, skillPath: path2 } = makeTempSkill("longskill", longBody);
  const whisper = formatWhisper([
    { name: "longskill", filePath: path2, description: "Long skill", baseDir: dir2 },
  ]);
  // The bullet line = "- longskill: <excerpt> — read <path> for the full skill."
  const bullet = whisper.split("\n").find((l) => l.startsWith("- longskill:"));
  assert.ok(bullet, "longskill bullet present");
  const lead = bullet.replace(/^- longskill: /, "");
  const excerptPart = lead.split("— read")[0];
  assert.ok(
    excerptPart.length <= MAX_EXCERPT_CHARS + 2, // + ellipsis + trailing space
    `excerpt part length ${excerptPart.length} exceeds bound`,
  );
});

// ── cleanup ─────────────────────────────────────────────────────────────────

for (const d of tempDirs) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
