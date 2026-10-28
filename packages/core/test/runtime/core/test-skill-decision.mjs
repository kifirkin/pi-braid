/**
 * Test: skills-tool/auto-inject.ts — decision path + adoption counters (E2/E3).
 *
 * The excerpt half is covered by test-skill-excerpt.mjs; this suite pins the
 * DECISION half of the auto-inject whisper:
 *   1. extractKeywords — stop-word/short-word filtering, dedup, one-rule
 *      trailing-s/es stemming ("skills" → "skill" matches singular name
 *      tokens; stemmed noise like "task" from "tasks" stays out).
 *   2. scoreSkill — +3 name exact, +2 name substring, +2 trigger phrase,
 *      +1 desc/path; a match that never touches the name or a trigger
 *      qualifies only at MIN_NON_NAME_SCORE (2).
 *   3. selectSuggestions — mock prompt + mock cache flowing through
 *      extract → score → cooldown (global floor + per-skill loaded
 *      extension) → slot budget over active slots → relevance eviction
 *      (held slots re-scored; a newcomer must outscore the weakest held
 *      skill by EVICT_MARGIN to take its slot).
 *   4. formatWhisper — the read pointer with the reply ritual retired.
 *   5. Adoption counters — recordSkillSuggestion / recordSkillLoad (detected
 *      read) / recordSkillClaim (retired honor-system claim) / getSkillStats
 *      increment and surface per-skill suggested/claimed/actual/loaded.
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
  selectSuggestions,
  formatWhisper,
  MAX_INJECTED,
  COOLDOWN_TURNS,
  LOADED_COOLDOWN_TURNS,
  MAX_EXCERPT_CHARS,
  MIN_NON_NAME_SCORE,
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

const scored = (skill, score) => ({ skill, score });

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

test("scoreSkill: +2 name substring (compound names)", () => {
  assert.equal(scoreSkill(softwareEngineer, ["engine"]), 2);
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

// ── decision path: selectSuggestions ────────────────────────────────────────

test("pins constants (MAX_INJECTED=2, COOLDOWN_TURNS=10 floor, loaded extension)", () => {
  assert.equal(MAX_INJECTED, 2);
  assert.equal(COOLDOWN_TURNS, 10);
  assert.equal(LOADED_COOLDOWN_TURNS, 30);
});

test("pins the non-name qualification bar (MIN_NON_NAME_SCORE=2)", () => {
  assert.equal(MIN_NON_NAME_SCORE, 2);
});

test("selects top-N by score with deterministic name tie-break", () => {
  const out = selectSuggestions(
    [scored(research, 1), scored(softwareEngineer, 3), scored(toneQuality, 3)],
    [],
    1,
  );
  assert.deepEqual(
    out.map((s) => s.skill.name),
    ["software-engineer", "tone-quality"],
  );
});

test("cooldown: a skill injected within COOLDOWN_TURNS is excluded", () => {
  const injected = [
    { name: "software-engineer", turnNumber: 3, filePath: softwareEngineer.filePath },
  ];
  const out = selectSuggestions(
    [scored(research, 1), scored(softwareEngineer, 3), scored(toneQuality, 3)],
    injected,
    6, // turn 6 − turn 3 = 3 < 10 → on cooldown
  );
  // software-engineer has the top score but is on cooldown → excluded;
  // 1 occupied slot → budget 1 → only the top available skill injects.
  assert.deepEqual(
    out.map((s) => s.skill.name),
    ["tone-quality"],
  );
  assert.ok(!out.some((s) => s.skill.name === "software-engineer"));
});

test("cooldown expired: a skill injected ≥ COOLDOWN_TURNS ago is eligible again", () => {
  const injected = [
    { name: "software-engineer", turnNumber: 3, filePath: softwareEngineer.filePath },
  ];
  const out = selectSuggestions(
    [scored(research, 1), scored(softwareEngineer, 3)],
    injected,
    14, // turn 14 − turn 3 = 11 ≥ 10 → eligible
  );
  assert.deepEqual(
    out.map((s) => s.skill.name),
    ["software-engineer"],
  );
});

// ── per-skill cooldown: the loaded extension ────────────────────────────────

test("a loaded skill stays on cooldown after the global floor expires", () => {
  const injected = [
    {
      name: "software-engineer",
      turnNumber: 3,
      filePath: softwareEngineer.filePath,
      loadedTurn: 5, // loaded 2 turns after injection
    },
  ];
  // Floor expired (turn 14), but only 9 turns since the load (< 30) → blocked.
  const out = selectSuggestions(
    [scored(research, 1), scored(softwareEngineer, 3)],
    injected,
    14,
  );
  assert.ok(!out.some((s) => s.skill.name === "software-engineer"));
});

test("a loaded skill is eligible again once LOADED_COOLDOWN_TURNS have passed", () => {
  const injected = [
    {
      name: "software-engineer",
      turnNumber: 3,
      filePath: softwareEngineer.filePath,
      loadedTurn: 5,
    },
  ];
  const out = selectSuggestions(
    [scored(research, 1), scored(softwareEngineer, 3)],
    injected,
    36, // 31 turns since the load ≥ 30 → eligible
  );
  // The loaded entry released its slot at load time, so both slots are free.
  assert.deepEqual(
    out.map((s) => s.skill.name),
    ["software-engineer", "research"],
  );
});

// ── slot budget over ACTIVE slots (loaded slots are released) ─────────────

test("2 occupied slots → no injection", () => {
  const injected = [
    { name: "research", turnNumber: 1, filePath: research.filePath },
    { name: "dox", turnNumber: 2, filePath: "/skills/dox/SKILL.md" },
  ];
  const out = selectSuggestions(
    [scored(softwareEngineer, 5), scored(research, 4)],
    injected,
    5,
  );
  assert.deepEqual(out, []);
});

test("1 occupied slot → injects only the top 1", () => {
  const injected = [{ name: "research", turnNumber: 1, filePath: research.filePath }];
  const out = selectSuggestions(
    [scored(softwareEngineer, 5), scored(toneQuality, 4)],
    injected,
    5,
  );
  assert.deepEqual(
    out.map((s) => s.skill.name),
    ["software-engineer"],
  );
});

test("over-full active slots → no injection (defensive)", () => {
  const injected = [
    { name: "a", turnNumber: 1, filePath: "/skills/a/SKILL.md" },
    { name: "b", turnNumber: 2, filePath: "/skills/b/SKILL.md" },
    { name: "c", turnNumber: 3, filePath: "/skills/c/SKILL.md" },
  ];
  const out = selectSuggestions([scored(softwareEngineer, 5)], injected, 5);
  assert.deepEqual(out, []);
});

test("a loaded skill no longer occupies a slot (release on load)", () => {
  const injected = [
    { name: "a", turnNumber: 1, filePath: "/skills/a/SKILL.md", loadedTurn: 2 },
    { name: "b", turnNumber: 2, filePath: "/skills/b/SKILL.md" },
  ];
  // One active slot (b) — a was loaded and released its slot.
  const out = selectSuggestions(
    [scored(softwareEngineer, 5), scored(toneQuality, 4)],
    injected,
    5,
  );
  assert.deepEqual(
    out.map((s) => s.skill.name),
    ["software-engineer"],
  );
});


test("empty scored → no injection", () => {
  assert.deepEqual(selectSuggestions([], [], 1), []);
});

// ── end-to-end: mock prompt + mock cache ───────────────────────────────────

test("mock prompt + mock cache: full decision path picks the top-2", () => {
  const cache = [research, softwareEngineer, toneQuality, meme];
  const prompt = "run a research pass and then improve the code quality";
  const keywords = extractKeywords(prompt);
  const scored = cache
    .map((s) => ({ skill: s, score: scoreSkill(s, keywords) }))
    .filter((s) => s.score > 0);
  const out = selectSuggestions(scored, [], 1);
  // research (+3 exact name), tone-quality (+3 exact name "quality"),
  // then software-engineer (+1 desc "improving") — top-2 wins.
  assert.deepEqual(
    out.map((s) => s.skill.name),
    ["research", "tone-quality"],
  );
});

// ── scoring retune: name matches dominate, generic hits de-fire ─────────────

const visualCreator = mk(
  "visual-creator",
  "Generate visual assets, illustrations, and images for posts.",
);

test("query naming a skill yields it in slot 1; shared description keywords do not rescue generics", () => {
  const cache = [visualCreator, meme, research];
  const keywords = extractKeywords("generate a meme for the thread");
  const scoredAll = cache
    .map((s) => ({ skill: s, score: scoreSkill(s, keywords) }))
    .filter((s) => s.score > 0);
  const out = selectSuggestions(scoredAll, [], 1);
  // meme: name hit (+3) + desc "generate" (+1) → qualifies in slot 1;
  // visual-creator: desc-only "generate" (+1) → below the bar → dropped.
  assert.deepEqual(
    out.map((s) => s.skill.name),
    ["meme"],
  );
});

test("single-keyword generic match de-fires instead of consuming a slot", () => {
  // Before the qualification bar, a lone "generate" hit in the description
  // suggested visual-creator on nearly any creative prompt.
  const scoredAll = [visualCreator]
    .map((s) => ({ skill: s, score: scoreSkill(s, ["generate"]) }))
    .filter((s) => s.score > 0);
  assert.deepEqual(scoredAll, [], "desc-only single hit must not qualify");
});

test("generic-keyword-only match cannot take the slot of a cooldown-protected name match", () => {
  const injected = [{ name: "meme", turnNumber: 5, filePath: meme.filePath }];
  // visual-creator scores from a lone description keyword → below the bar;
  // meme holds a slot and is still cooling down (7 − 5 < COOLDOWN_TURNS).
  const scoredAll = [visualCreator]
    .map((s) => ({ skill: s, score: scoreSkill(s, ["generate"]) }))
    .filter((s) => s.score > 0);
  const out = selectSuggestions(scoredAll, injected, 7);
  assert.deepEqual(out, []);
});

// ── frontmatter triggers ──────────────────────────────────────────────

const paneTopology = mk("pane-topology", "Terminal topology guidance.");

test("a trigger phrase hit scores +2 and qualifies like a name hit", () => {
  const skill = { ...paneTopology, triggers: ["pane topology"] };
  assert.equal(scoreSkill(skill, [], "split a pane topology for two agents"), 2);
});

test("a trigger hit rescues a skill whose description stays under the bar", () => {
  const skill = { ...paneTopology, triggers: ["terminal topology"] };
  // description never matches; without the trigger the skill would score 0
  assert.equal(scoreSkill(skill, [], "fix my terminal topology mess"), 2);
});

test("trigger matching is word-bounded (no substring bleed)", () => {
  const skill = { ...meme, triggers: ["mem"] };
  assert.equal(scoreSkill(skill, [], "a member of the crew"), 0);
  assert.equal(scoreSkill(skill, [], "post a mem"), 2);
});

test("multiple trigger hits accumulate", () => {
  const skill = { ...paneTopology, triggers: ["pane", "topology"] };
  assert.equal(scoreSkill(skill, [], "pane layout and topology"), 4);
});

test("without a prompt, triggers cannot match (keyword-only callers unchanged)", () => {
  const skill = { ...paneTopology, triggers: ["pane topology"] };
  // `guidance` is description-only for this fixture: the name tokens are
  // `pane` and `topology`, so a lone weak hit stays under the qualification
  // bar whether or not a trigger phrase would have matched a prompt.
  assert.equal(scoreSkill(skill, ["guidance"]), 0, "desc-only lone keyword stays below the bar");
});

test("trigger-qualified skill flows through the full selection", () => {
  const cache = [{ ...paneTopology, triggers: ["terminal topology"] }, meme];
  const prompt = "help me with terminal topology";
  const keywords = extractKeywords(prompt);
  const scoredAll = cache
    .map((s) => ({ skill: s, score: scoreSkill(s, keywords, prompt) }))
    .filter((s) => s.score > 0);
  const out = selectSuggestions(scoredAll, [], 1);
  assert.deepEqual(
    out.map((s) => s.skill.name),
    ["pane-topology"],
  );
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

const { readSkillTriggers, normalizeTriggers, triggerMatches, clearSkillTriggerCache } =
  await import(join(ROOT, "dist", "extensions", "core", "skills-tool", "skill-triggers.js"));

test("normalizeTriggers: lists and comma strings, trimmed, capped, deduped", () => {
  assert.deepEqual(normalizeTriggers([" Pane topology ", "pane topology", 42, ""]), [
    "pane topology",
  ]);
  assert.deepEqual(normalizeTriggers("a, b ,, c"), ["a", "b", "c"]);
  assert.deepEqual(normalizeTriggers(undefined), []);
  assert.equal(normalizeTriggers(["x".repeat(65)]).length, 0, "overlong phrase dropped");
  assert.equal(normalizeTriggers(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, 12);
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
