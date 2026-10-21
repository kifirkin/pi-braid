/**
 * Test: skills-tool relevance — corpus-common rarity, ranking, labelled set.
 *
 * The decision path is pinned by test-skill-decision.mjs with mock skills; the
 * trigger reader by test-skill-triggers-body.mjs against the real catalog. This
 * suite covers the scoring side against that same catalog, which is where the
 * relevance defects live: a mock skill carries whatever phrase the test author
 * would write, so it cannot show that generic vocabulary bought a slot on every
 * prompt.
 *
 * Three properties, each with the measurement that produced it:
 *
 *   1. Corpus-common rarity. A keyword carried by COMMON_KEYWORD_DF or more of
 *      the skills cannot tell them apart, so it scores nothing on the weak legs
 *      (description, catalog path). The threshold was measured over the real
 *      prompt corpus, not chosen: see the constant's comment.
 *
 *   2. Ranking. Equal scores compare by more distinct matched signals, then by
 *      rarer evidence, then by name. Alphabetical order alone used to decide.
 *
 *   3. A labelled prompt set. Every prompt is a recorded session prompt, cut
 *      where it carried a private path or an internal identifier; the expected
 *      skills were chosen by reading each skill's own description and trigger
 *      phrases and deciding whether it applies — never by looking at what the
 *      matcher returned. The set reports recall@2 (fraction of expected skills
 *      that appear in the suggested top 2, averaged over prompts) and the count
 *      of slots spent on prompts no skill applies to. Measurement is the first
 *      turn of a session: no cooldown, both slots free, so the number describes
 *      ranking rather than throttling.
 *
 * Run: npm test -w packages/core
 */

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE = join(__dirname, "..", "..", "..");
const DIST = join(CORE, "dist", "extensions", "core", "skills-tool");

const {
  extractKeywords,
  matchSkill,
  scoreSkill,
  selectSuggestions,
  corpusKeywordFrequency,
  skillCorpusDocument,
  COMMON_KEYWORD_DF,
  MIN_NON_NAME_SCORE,
} = await import(join(DIST, "auto-inject.js"));
const { readSkillTriggers, triggerMatches } = await import(join(DIST, "skill-triggers.js"));
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

// ── the real corpus ────────────────────────────────────────────────────────

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
      description,
      baseDir: join(skillsDir, dir),
      triggers: readSkillTriggers(filePath, description),
    };
  });

const byName = new Map(skills.map((s) => [s.name, s]));

/** A synthetic skill for the ranking/gating assertions below. */
const mkSkill = (name, description, filePath = `/catalog/${name}/SKILL.md`) => ({
  name,
  description,
  filePath,
  baseDir: `/catalog/${name}`,
  triggers: [],
});

console.log(`\n— corpus: ${skills.length} skills from skills/ —`);
console.log(
  `  ${skills.filter((s) => s.triggers.length > 0).length} of ${skills.length} skills carry trigger phrases`,
);

// ── 1. corpus-common rarity ────────────────────────────────────────────────

const SAMPLE_PROMPT =
  "prepare the release train on a branch — the four packages that still need a version bump " +
  "so that, once the skills package is out, the rest can follow";
const sampleKeywords = extractKeywords(SAMPLE_PROMPT);
const sampleDf = corpusKeywordFrequency(sampleKeywords, skills);

console.log(
  `\ncorpus document frequency (COMMON_KEYWORD_DF=${COMMON_KEYWORD_DF}), sample prompt keywords:`,
);
for (const kw of sampleKeywords) console.log(`  ${kw.padEnd(12)} df=${sampleDf.get(kw)}`);

test("the corpus document is the skill's own content, not the checkout path", () => {
  // A checkout root puts "private", "wt-…", "packages" in every absolute path;
  // those words describe the machine, not the catalog.
  assert.equal(sampleDf.get("private") ?? 0, 0);
  const doc = skillCorpusDocument(byName.get("research"));
  assert.ok(!doc.includes("/private/"), "absolute path leaked into the corpus document");
  assert.ok(doc.includes("research/skill.md"), "the skill's own directory is part of its document");
});

test("a word the whole catalog carries measures as corpus-common", () => {
  assert.equal(sampleDf.get("skill"), skills.length);
  assert.ok(COMMON_KEYWORD_DF >= 2 && COMMON_KEYWORD_DF <= Math.ceil(skills.length / 2));
});

test("a corpus-common word scores nothing on the weak legs", () => {
  // Two weak hits clear the bar; when one of them is catalog vocabulary the
  // skill drops below it again. "skill" is in every document, so it is common;
  // "survey" is the skill's own word.
  const target = mkSkill("zzz-probe", "skill survey", "/catalog/zzz-probe/notes.md");
  const keywords = ["skill", "survey"];
  const df = corpusKeywordFrequency(keywords, skills);
  assert.equal(df.get("skill"), skills.length);
  assert.ok((df.get("survey") ?? 0) < COMMON_KEYWORD_DF);
  const ungated = matchSkill(target, keywords, "");
  const gated = matchSkill(target, keywords, "", df);
  assert.equal(ungated.score, 2, "both weak hits score without the frequency map");
  assert.equal(gated.score, 0, "with the rare word left alone, the match falls under the bar");
  assert.equal(gated.signals, 0);
});

test("a corpus-common word still scores when it is the skill's own name", () => {
  // "skill" is common, but it is an exact token of skill-usage's name: identity
  // vocabulary is never gated.
  const usage = byName.get("skill-usage");
  const df = corpusKeywordFrequency(["skill"], skills);
  assert.ok(df.get("skill") >= COMMON_KEYWORD_DF);
  assert.ok(matchSkill(usage, ["skill"], "", df).score >= 3);
});

test("a generic word buried inside a name is not a name hit", () => {
  // "line" is corpus-common (df 7 of 22) and sits inside two coined names:
  // placement-disc**line** and release-pi**peline**. The name leg used to award
  // both +2 plus the bar exemption for it, so a prompt about a line of install
  // text bought a slot from a skill about packaging. Neither is a name hit now.
  const keywords = ["line"];
  const df = corpusKeywordFrequency(keywords, skills);
  assert.ok((df.get("line") ?? 0) >= COMMON_KEYWORD_DF, "the probe word must be corpus-common");
  for (const name of ["placement-discipline", "release-pipeline"]) {
    const skill = byName.get(name);
    assert.ok(skillCorpusDocument(skill).includes("line"), `${name} no longer contains the probe`);
    assert.equal(matchSkill(skill, keywords, "", df).score, 0, `${name} still scores on "line"`);
  }
});

test("a generic word that only starts a name token is gated too", () => {
  // The token-prefix rule is the name leg's other reachable form ("engine" in
  // software-engineer). It reads as the author's vocabulary only while the
  // word is rare enough to mean something: a prompt's throwaway word that
  // happens to start a token is not identity evidence.
  const skill = mkSkill("liner-notes", "unrelated text");
  const common = corpusKeywordFrequency(["line"], skills);
  assert.ok((common.get("line") ?? 0) >= COMMON_KEYWORD_DF);
  assert.equal(matchSkill(skill, ["line"], "", common).score, 0, "common prefix must not qualify");
  assert.equal(scoreSkill(skill, ["line"]), 2, "without a frequency map the prefix still scores");
  const rareSkill = mkSkill("benchmarking-harness", "unrelated text");
  const rare = corpusKeywordFrequency(["benchmark"], skills);
  assert.ok((rare.get("benchmark") ?? 0) < COMMON_KEYWORD_DF, "the probe word must be rare");
  assert.equal(matchSkill(rareSkill, ["benchmark"], "", rare).score, 2, "a rare prefix qualifies");
});

test("no admission in the sample prompt's turn rests on common words alone", () => {
  // The gate exists so a prompt full of catalog vocabulary cannot buy a slot:
  // every skill that still qualifies must rest on a name, a trigger, or a rare
  // word — never on gated vocabulary alone.
  for (const skill of skills) {
    const match = matchSkill(skill, sampleKeywords, SAMPLE_PROMPT, sampleDf);
    if (match.score === 0) continue;
    const name = skill.name.toLowerCase();
    const strong =
      skill.triggers.some((t) => triggerMatches(t, SAMPLE_PROMPT)) ||
      sampleKeywords.some((kw) => name.includes(kw));
    const rare = sampleKeywords.some(
      (kw) => (sampleDf.get(kw) ?? 0) < COMMON_KEYWORD_DF && skillCorpusDocument(skill).includes(kw),
    );
    assert.ok(strong || rare, `${skill.name} qualified on corpus-common words alone`);
  }
});

// ── 2. ranking ─────────────────────────────────────────────────────────────

test("equal scores: more distinct matched signals wins, not the alphabet", () => {
  // Same points, different breadth: aaa-alpha rests on one signal, zzz-zulu on
  // two. The alphabet would take aaa-alpha first.
  const alpha = mkSkill("aaa-alpha", "unrelated text");
  const zulu = mkSkill("zzz-zulu", "unrelated text");
  const picked = selectSuggestions(
    [
      { skill: alpha, score: 2, signals: 1, evidenceDf: 2 },
      { skill: zulu, score: 2, signals: 2, evidenceDf: 2 },
    ],
    [],
    1,
  ).slice(0, 1);
  assert.equal(picked[0].skill.name, "zzz-zulu", "signals outrank the alphabet");
});

test("equal scores and signals: rarer evidence wins", () => {
  const common = mkSkill("aaa-common", "text");
  const rare = mkSkill("zzz-rare", "text");
  const picked = selectSuggestions(
    [
      { skill: common, score: 2, signals: 2, evidenceDf: 8 },
      { skill: rare, score: 2, signals: 2, evidenceDf: 2 },
    ],
    [],
    1,
  ).slice(0, 1);
  assert.equal(picked[0].skill.name, "zzz-rare", "lower summed document frequency outranks the alphabet");
});

test("a score-only caller keeps the name tie-break", () => {
  const a = mkSkill("aaa", "text");
  const b = mkSkill("zzz", "text");
  const picked = selectSuggestions(
    [
      { skill: b, score: 2 },
      { skill: a, score: 2 },
    ],
    [],
    1,
  );
  assert.deepEqual(
    picked.map((s) => s.skill.name),
    ["aaa", "zzz"],
    "without evidence fields the order stays deterministic by name",
  );
});

test("real corpus: the tie that the alphabet used to decide", () => {
  // On the verify-worker prompt, three skills tie at the qualification bar.
  // Alphabetical order picked braid-reference; the rarer match is the skill the
  // prompt is actually about.
  const prompt =
    "You are a verify worker. You review a merged change read-only, at the merge revision, " +
    "in a detached worktree. You change nothing: no edits, no commits, no branch switches " +
    "beyond the checkout.";
  const keywords = extractKeywords(prompt);
  const df = corpusKeywordFrequency(keywords, skills);
  const scored = skills
    .map((s) => ({ skill: s, ...matchSkill(s, keywords, prompt, df) }))
    .filter((s) => s.score > 0);
  const tied = scored.filter((s) => s.score === MIN_NON_NAME_SCORE);
  const picks = selectSuggestions(scored, [], 1).map((s) => s.skill.name);
  assert.ok(tied.length >= 2, `expected a tie at the bar, got ${tied.length}`);
  assert.equal(picks[0], "subagent-verification", `picked ${picks.join(", ")}`);
});

// ── 3. the labelled set ────────────────────────────────────────────────────

/**
 * Prompts recorded from real sessions, cut where they carried a private path or
 * an internal identifier. Labels are the skills whose own description or trigger
 * phrases cover the prompt's task; `[]` means no core skill applies, which is
 * the honest label for status chatter and for operations the seat contract
 * covers rather than a skill.
 */
const CASES = [
  {
    label: "cv-polish",
    prompt:
      "let's fire deep review and polish session of my own cv. it looks like ai genereted slop (actually parts added on top of my original cv as a lead frontend software engineer)",
    expected: ["tone-quality"],
  },
  {
    label: "translate-to-russian",
    prompt:
      "Amazing! Let's translate carefully and thoroughly into Russian, then make 2 duplexes for both the EN and RU versions.",
    expected: ["tone-quality"],
  },
  {
    label: "voice-wiring",
    prompt:
      "Read the voice-wiring brief and execute it. Create the branch named in the brief first. Deliver the report to the path the brief gives and end your final message with the seven-field JSON result block.",
    expected: ["voice-replies"],
  },
  {
    label: "mastership-transfer",
    prompt:
      "MASTERSHIP TRANSFER: you are the successor seat and will own this seat, the channel, the fleet and the queue.",
    expected: ["subagent-orchestration"],
  },
  {
    label: "channel-handover",
    prompt:
      "CHANNEL IS FREE. I disabled my poller and the lock file is now ABSENT (verified by reading the path, not by trusting the tool's return). I hold no timers. You now own the channel, the fleet.",
    expected: [],
  },
  {
    label: "verify-worker",
    prompt:
      "You are a verify worker. You review a merged change read-only, at the merge revision, in a detached worktree. You change nothing: no edits, no commits, no branch switches beyond the checkout.",
    expected: ["subagent-verification", "placement-discipline"],
  },
  {
    label: "impl-worker-dispatch",
    prompt:
      "Worker, spec: impl. You are in your worktree on your own branch (do not switch branches). Locked files and test scope are named in your brief; one commit total; do not push, tag, publish, or merge. First, read your brief in full.",
    expected: ["software-engineer"],
  },
  {
    label: "placement-section-repair",
    prompt:
      "check-result on your session failed one check: the report lacks the required `## Placement` section (layer changed / domain literals added to generic layers / what remains unverified), and your result block's 3 claims carry no `predicts` string. Do exactly this, nothing else: (1) append a `## Placement` section",
    expected: ["placement-discipline"],
  },
  {
    label: "npm-trusted-publisher",
    prompt: "i've logged in to npm and we already set up trusted publisher so release is easy.",
    expected: ["release-pipeline"],
  },
  {
    label: "release-train-bump",
    prompt:
      "prepare the release train on a branch — the four packages that still need a version bump so that, once the skills package is out, the rest can follow",
    expected: ["release-pipeline"],
  },
  {
    label: "salary-research",
    prompt:
      "try to research and suggest salary for engineer like me from perspective that you could view from your focus and with everythinng available to you",
    expected: ["research"],
  },
  {
    label: "pre-registered-decision-rule",
    prompt: "the pre-registered decision rule is in your brief — do not move it after you see the data",
    expected: ["probe-evaluation"],
  },
  {
    label: "acceptance-string-probe",
    prompt:
      "Owner decision on the open question: settle the acceptance string by probing which one the judge actually accepts; if both pass, use the string the binary itself prints (ALL PROOFS CHECK).",
    expected: ["probe-evaluation"],
  },
  {
    label: "symbol-rename",
    prompt: "TASK: rename the gateway provider id to `agent-zero`. Spec: impl, one commit on a worker branch.",
    expected: ["code-refactoring"],
  },
  {
    label: "install-docs-surfaces",
    prompt:
      "the npm-first install line must appear on every doc surface that teaches installing braid, in npm-package-page style — the one-line install near the top, not buried mid-file.",
    expected: ["documentation", "tone-quality"],
  },
  {
    label: "herdr-dependency-update",
    prompt:
      "also updates to pi herdr arrives so need to first update then to maintain its changelog and reflect what makes sense in our own codebases",
    expected: [],
  },
  {
    label: "client-agnostic-skill",
    prompt:
      "generalize our tunnel tooling into a skill for three macOS clients. Goal: v2RayTun, Happ and Incy as first-class arms of one client-agnostic mechanism — per-client adapters carry the vendor facts (bundle id, process/extension patterns, URL scheme and routes, scutil profile name); the shared layer carries no vendor name.",
    expected: ["meta-improvement", "placement-discipline"],
  },
  {
    label: "ghost-processes",
    prompt: "we have now a ton of ghost pi processes",
    expected: ["healthcheck"],
  },
  {
    label: "browser-blockers",
    prompt: "let's use browser and assist me resolve all blockers",
    expected: [],
  },
  {
    label: "input-polisher-question",
    prompt:
      "so what to do with input polisher? is it disturbing your flows? I actually see it working good for my few manual porompts",
    expected: ["braid-reference"],
  },
  {
    label: "doc-identifier-audit",
    prompt:
      "the `<!-- doc-ref-exempt: ... -->` annotations are the right shape for the hatch, but the audit that briefed this work measured 24 doc identifiers that exist nowhere and said 10 of them are real defects (a doc naming something that should exist or that was renamed).",
    expected: ["misdirection-audit"],
  },
  { label: "status-chatter", prompt: "whats the latest state here?", expected: [] },
  {
    label: "onboard-and-pick-up",
    prompt: "let's observe, onboard and pick up, then continue work here",
    expected: [],
  },
  {
    label: "provider-route-preference",
    prompt: "be sure that our default provider route is always start with opencode",
    expected: [],
  },
  {
    label: "rewrite-assessment",
    prompt: "Let's see deeply here whats our vibe projects would defenitely benefit from rewrite to bend?",
    expected: [],
  },
  {
    label: "probe-harness",
    prompt:
      "Read your brief in full and follow it: build the wiring probe harness (runner + probes/ + results/) and produce the baseline run. The harness must be idempotent and each probe must state its failure mode.",
    expected: ["agent-testing", "probe-evaluation"],
  },
];

/** Run one prompt through the real pipeline: extract → score → select top 2. */
function rank(prompt) {
  const keywords = extractKeywords(prompt);
  const df = corpusKeywordFrequency(keywords, skills);
  const scored = skills
    .map((s) => ({ skill: s, ...matchSkill(s, keywords, prompt, df) }))
    .filter((s) => s.score > 0);
  return {
    admitted: scored.length,
    picks: selectSuggestions(scored, [], 1).map((s) => s.skill.name),
  };
}

let expectedTotal = 0;
let expectedHit = 0;
let emptyCases = 0;
let slotsOnEmpty = 0;
const rows = [];
for (const c of CASES) {
  const { admitted, picks } = rank(c.prompt);
  const hit = c.expected.filter((e) => picks.includes(e)).length;
  expectedTotal += c.expected.length;
  expectedHit += hit;
  if (!c.expected.length) {
    emptyCases++;
    if (picks.length) slotsOnEmpty++;
  }
  rows.push({
    case: c.label,
    expected: c.expected.join(",") || "—",
    picked: picks.join(",") || "—",
    hit: `${hit}/${c.expected.length}`,
    admitted,
  });
}
const recall = (100 * expectedHit) / expectedTotal;

console.log("\nlabelled set (first turn: no cooldown, both slots free):");
console.table(rows);
console.log(
  `recall@2 = ${expectedHit}/${expectedTotal} = ${recall.toFixed(1)}% | slots spent on no-skill prompts = ${slotsOnEmpty}/${emptyCases}`,
);

test("the labelled set has at least 20 prompt→expected-skill pairs", () => {
  assert.ok(CASES.length >= 20, `only ${CASES.length} cases`);
  assert.ok(
    CASES.filter((c) => c.expected.length > 0).length >= 15,
    "too few cases with an expected skill",
  );
});

test("recall@2 holds at or above the measured floor", () => {
  // Floor, not a ceiling: a corpus change that lowers it must move this number
  // deliberately, with the labelled set re-read.
  assert.ok(recall >= 56.5, `recall@2 ${recall.toFixed(1)}% below the 56.5% floor`);
});

const outcome = (label) => {
  const c = CASES.find((x) => x.label === label);
  return rank(c.prompt).picks;
};

test("the prose case stays a miss: the limit is the skill's own text", () => {
  // tone-quality's triggers all name a writing FORM ("writing documentation",
  // "drafting text"); a CV-polish prompt matches none of them, and its
  // description shares only "review" with the prompt. Meanwhile the prompt's
  // job title hits software-engineer's name tokens, which are never gated. The
  // gap is corpus content (a trigger naming cv/resume/prose), not a matcher
  // setting: pin both scores so the day a content change lands, this fails and
  // the labelled set is re-read.
  const c = CASES.find((x) => x.label === "cv-polish");
  const keywords = extractKeywords(c.prompt);
  const df = corpusKeywordFrequency(keywords, skills);
  const prose = matchSkill(byName.get("tone-quality"), keywords, c.prompt, df);
  const code = matchSkill(byName.get("software-engineer"), keywords, c.prompt, df);
  assert.ok(prose.score < MIN_NON_NAME_SCORE, `tone-quality now scores ${prose.score}`);
  assert.ok(code.score > prose.score, "the job title outranks the prose skill, as before");
});

test("a named trigger phrase reaches its skill, whatever the prompt's case", () => {
  assert.deepEqual(outcome("mastership-transfer").slice(0, 1), ["subagent-orchestration"]);
  assert.ok(outcome("npm-trusted-publisher").includes("release-pipeline"));
});

test("the verify-worker prompt reaches the verification skill", () => {
  assert.ok(outcome("verify-worker").includes("subagent-verification"));
});

test("most no-skill prompts spend no slot", () => {
  assert.ok(slotsOnEmpty <= 2, `${slotsOnEmpty} of ${emptyCases} no-skill prompts got a suggestion`);
});

test("scoreSkill and matchSkill agree", () => {
  const keywords = extractKeywords(CASES[0].prompt);
  const df = corpusKeywordFrequency(keywords, skills);
  for (const s of skills) {
    assert.equal(scoreSkill(s, keywords, CASES[0].prompt, df), matchSkill(s, keywords, CASES[0].prompt, df).score);
  }
});

// ── result ─────────────────────────────────────────────────────────────────

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
