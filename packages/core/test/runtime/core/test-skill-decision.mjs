/**
 * Test: skills-tool/auto-inject.ts — the catalog scorer, the whisper render,
 * and the adoption counters.
 *
 *  1. extractKeywords — stop-word/short-word filtering, dedup, one-rule
 *     trailing-s/es stemming ("skills" → "skill" matches singular name
 *     tokens; stemmed noise like "task" from "tasks" stays out).
 *  2. scoreSkill — +3 name exact, +2 name substring, +2 trigger phrase,
 *     +1 desc/path; a match that never touches the identity part of the name
 *     or a trigger qualifies only at MIN_NON_NAME_SIGNALS (2), and the whole
 *     final token of a compound name (the class noun) is ranked but never
 *     counted as evidence.
 *  3. formatWhisper — the read pointer with the reply ritual retired.
 *  4. Adoption counters — recordSkillSuggestion / recordSkillLoad (detected
 *     read) / recordSkillClaim (retired honor-system claim) / getSkillStats
 *     increment and surface per-skill suggested/claimed/actual/loaded.
 *  5. The throttle constants the delivery path reads (MAX_INJECTED,
 *     COOLDOWN_TURNS, LOADED_COOLDOWN_TURNS).
 *
 * The whisper's own decision is a utility-model call and is pinned by
 * test-skill-ranker.mjs; the scorer below answers the `list_skills` catalog
 * read only.
 *
 * Fully deterministic: mock skills + mock ctx; no environment dependence.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const {
  extractKeywords,
  stemKeyword,
  scoreSkill,
  formatWhisper,
  MAX_INJECTED,
  COOLDOWN_TURNS,
  LOADED_COOLDOWN_TURNS,
  MAX_EXCERPT_CHARS,
  MIN_NON_NAME_SIGNALS,
  getSkillStats,
  recordSkillSuggestion,
  recordSkillLoad,
  recordSkillClaim,
  skillNameFromRead,
  updateSkillCache,
} = await import(join(ROOT, "dist", "extensions", "core", "skills-tool", "auto-inject.js"));

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

// ── fixtures ─────────────────────────────────────────────────────────────────

const mk = (name, description, filePath = `/skills/${name}/SKILL.md`) => ({
  name,
  filePath,
  description,
  baseDir: "/skills",
});

const research = mk("research", "Research topics, verify facts, and find information online.");
const softwareEngineer = mk("software-engineer", "Use when writing, reviewing, or improving code.");
const toneQuality = mk("tone-quality", "Read this skill before writing any text.");
const meme = mk("meme", "Generate memes programmatically.");


console.log("skill-decision test\n");

// ── keyword extraction ──────────────────────────────────────────────────────

test("extractKeywords filters stop words and short words", () => {
  const kw = extractKeywords("research the facts and then improve quality");
  assert.deepEqual(kw, ["research", "fact", "improve", "quality"]);
});

// ── stemming: one trailing-s/es rule ─────────────────────────────────────���

test("stemKeyword strips trailing s/es plurals", () => {
  assert.equal(stemKeyword("skills"), "skill");
  assert.equal(stemKeyword("memes"), "meme");
  assert.equal(stemKeyword("classes"), "class");
  assert.equal(stemKeyword("boxes"), "box");
  assert.equal(stemKeyword("watches"), "watch");
  assert.equal(stemKeyword("uses"), "use");
  assert.equal(stemKeyword("process"), "process", "ss never loses its s");
  assert.equal(stemKeyword("research"), "research", "non-plurals pass through");
});

test("stemmed keywords match singular name tokens (+3 instead of a desc hit)", () => {
  // "skills" previously missed "skill-usage" entirely (plural vs token);
  // both "skill" and "usage" hit name tokens → 3 + 3.
  const usage = mk("skill-usage", "Measure skill adoption from durable counters.");
  assert.equal(scoreSkill(usage, extractKeywords("count my skills usage")), 7);
});

test("stemming that lands on a stop word stays filtered out", () => {
  // "tasks" stems to "task", a noise word — it must not re-enter the list.
  assert.deepEqual(extractKeywords("update the tasks list"), ["update", "list"]);
});

test("extractKeywords dedupes while preserving order", () => {
  assert.deepEqual(extractKeywords("research research research"), ["research"]);
});

test("stemming dedupes plural and singular forms of one word", () => {
  assert.deepEqual(extractKeywords("count the skills and every skill"), ["count", "skill", "every"]);
});

test("extractKeywords returns [] for empty/noise input", () => {
  assert.deepEqual(extractKeywords("the and then"), []);
  assert.deepEqual(extractKeywords(""), []);
});

// ── scoring ─────────────────────────────────────────────────────────────────

test("scoreSkill: +3 exact name token", () => {
  assert.equal(scoreSkill(research, ["research"]), 3);
});

test("scoreSkill: a name prefix is ranked, never qualifying on its own", () => {
  // "engine" starts "engineer", and that is precisely the shape the bar refuses:
  // an ordinary word that happens to start a longer one. The prefix adds points
  // to a match another signal carries (see the relevance fixture); alone it is
  // no match, so the score is zero rather than two.
  assert.equal(scoreSkill(softwareEngineer, ["engine"]), 0);
});

test("scoreSkill: single description keyword stays below the qualification bar", () => {
  // One description hit is too weak a signal to suggest a skill.
  assert.equal(scoreSkill(softwareEngineer, ["code"]), 0);
});

test("scoreSkill: two description keywords qualify a non-name match", () => {
  assert.equal(scoreSkill(softwareEngineer, ["writing", "reviewing"]), 2);
});

test("scoreSkill: single filePath keyword stays below the qualification bar", () => {
  const s = mk("x", "nothing here", "/skills/research/SKILL.md");
  assert.equal(scoreSkill(s, ["research"]), 0);
});

test("scoreSkill: path + description hits combine to qualify a non-name match", () => {
  const s = mk("x", "nothing here", "/skills/research/SKILL.md");
  assert.equal(scoreSkill(s, ["research", "nothing"]), 2);
});

test("scoreSkill: 0 on no match", () => {
  assert.equal(scoreSkill(meme, ["research"]), 0);
});

// ── the throttle the delivery path reads ───────────────────────────────────

test("pins constants (MAX_INJECTED=2, COOLDOWN_TURNS=10 floor, loaded extension)", () => {
  assert.equal(MAX_INJECTED, 2);
  assert.equal(COOLDOWN_TURNS, 10);
  assert.equal(LOADED_COOLDOWN_TURNS, 30);
});

test("pins the non-name qualification bar (MIN_NON_NAME_SIGNALS=2)", () => {
  assert.equal(MIN_NON_NAME_SIGNALS, 2);
});

// ── the read pointer (reply ritual retired) ─────────────────────────────

test("formatWhisper points at the read and carries no reply ritual", () => {
  const whisper = formatWhisper([research]);
  assert.ok(!/Open it and apply it/.test(whisper), "the solicited reply ask is retired");
  assert.ok(!/say in one line/.test(whisper), "no one-line-why ritual");
  assert.ok(/read `[^`]+` for the full skill/.test(whisper), "the read pointer stays");
  assert.ok(
    whisper.endsWith("read a SKILL.md file for full context.)"),
    "ends on the discovery pointer",
  );
  assert.ok(!/LOADED/.test(whisper), "the LOADED reply ritual is retired");
});

test("formatWhisper excerpt stays bounded beside the read pointer (≤ MAX_EXCERPT_CHARS)", () => {
  const longBody = "instructional content ".repeat(100); // ~2100 chars
  const longSkill = mk("longskill", "Long skill", `/skills/longskill/SKILL.md`);
  // write a real file so the excerpt is bounded content, not the description
  const dir = mkdtempSync(join(tmpdir(), "pi-braid-decision-"));
  const skillDir = join(dir, "longskill");
  mkdirSync(skillDir, { recursive: true });
  const path = join(skillDir, "SKILL.md");
  writeFileSync(path, `---\nname: longskill\ndescription: Long skill\n---\n\n${longBody}`, "utf-8");
  try {
    const whisper = formatWhisper([{ ...longSkill, filePath: path }]);
    const bullet = whisper.split("\n").find((l) => l.startsWith("- longskill:"));
    assert.ok(bullet, "longskill bullet present");
    const lead = bullet.replace(/^- longskill: /, "");
    const excerptPart = lead.split("— read")[0];
    assert.ok(
      excerptPart.length <= MAX_EXCERPT_CHARS + 2,
      `excerpt part length ${excerptPart.length} exceeds bound`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── frontmatter triggers: the file side ──────────────────────────────

const {
  readSkillTriggers,
  normalizeTriggers,
  triggerMatches,
  clearSkillTriggerCache,
  MAX_TRIGGERS,
  MAX_TRIGGER_CHARS,
} = await import(join(ROOT, "dist", "extensions", "core", "skills-tool", "skill-triggers.js"));

test("normalizeTriggers: lists and comma strings, trimmed, capped, deduped", () => {
  assert.deepEqual(normalizeTriggers([" Pane topology ", "pane topology", 42, ""]), [
    "pane topology",
  ]);
  assert.deepEqual(normalizeTriggers("a, b ,, c"), ["a", "b", "c"]);
  assert.deepEqual(normalizeTriggers(undefined), []);
  // Both bounds come from the reader, so a moved cap moves this check with it
  // instead of leaving a fixture asserting a number the code no longer has.
  assert.equal(
    normalizeTriggers(["x".repeat(MAX_TRIGGER_CHARS + 1)]).length,
    0,
    "overlong phrase dropped",
  );
  assert.equal(
    normalizeTriggers(Array.from({ length: MAX_TRIGGERS + 8 }, (_, i) => `t${i}`)).length,
    MAX_TRIGGERS,
  );
});

test("readSkillTriggers parses the frontmatter list; missing frontmatter → none", () => {
  clearSkillTriggerCache();
  const dir = mkdtempSync(join(tmpdir(), "pi-braid-triggers-"));
  mkdirSync(join(dir, "trig"), { recursive: true });
  const withTriggers = join(dir, "trig", "SKILL.md");
  writeFileSync(
    withTriggers,
    "---\nname: trig\ndescription: d\ntriggers:\n  - pane topology\n  - herdr\n---\n\nbody",
    "utf-8",
  );
  assert.deepEqual(readSkillTriggers(withTriggers), ["pane topology", "herdr"]);
  const plain = join(dir, "plain.md");
  writeFileSync(plain, "no frontmatter at all", "utf-8");
  assert.deepEqual(readSkillTriggers(plain), []);
  const malformed = join(dir, "bad.md");
  writeFileSync(malformed, "---\n: : [[broken\n", "utf-8");
  assert.deepEqual(readSkillTriggers(malformed), [], "malformed YAML → no triggers, no throw");
  rmSync(dir, { recursive: true, force: true });
});

test("readSkillTriggers memoizes by mtime and picks up rewrites", () => {
  clearSkillTriggerCache();
  const dir = mkdtempSync(join(tmpdir(), "pi-braid-triggers-mtime-"));
  const p = join(dir, "SKILL.md");
  writeFileSync(p, "---\ntriggers:\n  - one\n---\nbody", "utf-8");
  assert.deepEqual(readSkillTriggers(p), ["one"]);
  // unchanged re-read serves from the memo (same result, no parse)
  assert.deepEqual(readSkillTriggers(p), ["one"]);
  writeFileSync(p, "---\ntriggers:\n  - two\n---\nbody", "utf-8");
  assert.deepEqual(readSkillTriggers(p), ["two"], "a changed file re-reads");
  rmSync(dir, { recursive: true, force: true });
});

test("triggerMatches: word boundaries, hyphen tokens, multi-word phrases", () => {
  assert.ok(triggerMatches("pane", "split the pane right"));
  assert.ok(!triggerMatches("pane", "paneledd display"));
  assert.ok(triggerMatches("pane-topology", "check the pane-topology doc"));
  assert.ok(triggerMatches("pane topology", "fix my pane topology now"));
  assert.ok(!triggerMatches("pane topology", "pane topologyx"));
  assert.ok(triggerMatches("mem", "post a mem"));
  assert.ok(!triggerMatches("mem", "a member"));
});

// ── adoption counters (E3) ──────────────────────────────────────────────────

const mockCtx = { cwd: process.cwd() }; // shared ctx → same state bucket

test("recordSkillSuggestion increments suggested per skill", () => {
  recordSkillSuggestion(mockCtx, ["research", "software-engineer"]);
  recordSkillSuggestion(mockCtx, ["research"]);
  const stats = getSkillStats(mockCtx);
  assert.equal(stats["research"].suggested, 2);
  assert.equal(stats["software-engineer"].suggested, 1);
});

test("recordSkillLoad increments loaded; unknown names are ignored", () => {
  recordSkillLoad(mockCtx, "research");
  recordSkillLoad(mockCtx, "");
  recordSkillLoad(mockCtx, undefined);
  const stats = getSkillStats(mockCtx);
  assert.equal(stats["research"].loaded, 1);
  assert.equal(stats["research"].actual, 1, "a detected read counts as actual");
  assert.equal(stats["software-engineer"].loaded, 0);
});

test("recordSkillClaim increments claimed+loaded but not actual", () => {
  const ctx = {};
  recordSkillClaim(ctx, "research");
  const s = getSkillStats(ctx)["research"];
  assert.equal(s.claimed, 1, "claim counted");
  assert.equal(s.loaded, 1, "loaded sums claims and reads");
  assert.equal(s.actual, 0, "no detected read");
  assert.equal(s.suggested, 0);
});

test("recordSkillLoad counts as an actual read (claimed stays 0)", () => {
  const ctx = {};
  recordSkillLoad(ctx, "tone-quality");
  const s = getSkillStats(ctx)["tone-quality"];
  assert.equal(s.actual, 1);
  assert.equal(s.claimed, 0);
  assert.equal(s.loaded, 1);
});

test("claims and reads accumulate independently in one session", () => {
  const ctx = {};
  recordSkillClaim(ctx, "software-engineer");
  recordSkillClaim(ctx, "software-engineer");
  recordSkillLoad(ctx, "software-engineer");
  const s = getSkillStats(ctx)["software-engineer"];
  assert.equal(s.claimed, 2);
  assert.equal(s.actual, 1);
  assert.equal(s.loaded, 3);
});

test("recordSkillClaim ignores an empty name", () => {
  const ctx = {};
  recordSkillClaim(ctx, "");
  recordSkillClaim(ctx, undefined);
  assert.deepEqual(getSkillStats(ctx), {});
});

test("getSkillStats returns the full per-skill map", () => {
  const stats = getSkillStats(mockCtx);
  assert.ok(stats["research"], "research tracked");
  assert.equal(typeof stats["research"].suggested, "number");
  assert.equal(typeof stats["research"].loaded, "number");
});

// ── read-detector: the list→read load path (E3) ────────────────────────────

// Seed the module-level cache the way setCachedSkills() does at session start.
const CACHE = [research, softwareEngineer, toneQuality, meme];
updateSkillCache(CACHE);

const SKILL_MD = `---\nname: research\ndescription: Research topics\n---\n\nrecall first, then gather sources.`;

const readEvent = (path, text) => ({
  toolName: "read",
  input: { path },
  content: [{ type: "text", text }],
});

// The exact dispatch the tool_result handler performs.
function detectLoad(event) {
  if (event?.toolName !== "read") return undefined;
  const text = (event.content ?? []).map((c) => c.text ?? "").join("\n");
  return skillNameFromRead(event.input?.path, text);
}

test("read-detector: SKILL.md frontmatter name wins over path", () => {
  const name = detectLoad(readEvent("/skills/research/SKILL.md", SKILL_MD));
  assert.equal(name, "research");
});

test("read-detector: file path match against the cached catalog", () => {
  const name = detectLoad(readEvent("/skills/software-engineer/SKILL.md", "no frontmatter here"));
  assert.equal(name, "software-engineer");
});

test("read-detector: SKILL.md in a dir whose name matches a cached skill", () => {
  const name = detectLoad(readEvent("/somewhere/else/tone-quality/SKILL.md", "plain body"));
  assert.equal(name, "tone-quality");
});

test("read-detector: non-SKILL.md reads return undefined (not a load)", () => {
  const name = detectLoad(readEvent("/src/main.ts", "const x = 1;"));
  assert.equal(name, undefined);
});

test("read-detector: unknown SKILL.md path + no frontmatter → undefined", () => {
  const name = detectLoad(readEvent("/skills/ghost/SKILL.md", "no frontmatter"));
  assert.equal(name, undefined);
});

test("read-detector: non-read tool results are ignored", () => {
  const name = detectLoad({ toolName: "grep", input: { path: "/x" }, content: [] });
  assert.equal(name, undefined);
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
