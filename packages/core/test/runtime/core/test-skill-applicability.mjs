/**
 * skill applicability — the record that separates "applied and ignored" from
 * "never applied".
 *
 * Pins five contracts:
 *
 * 1. The matcher decides the skill's OWN declared condition: a phrase its file
 *    author wrote, in the boundary rule the injector already uses (so the
 *    verdict cannot contradict the whisper), with polarity — a phrase inside a
 *    negated clause is not the condition holding.
 * 2. The verdict is recorded, never enforced: it writes records and its own
 *    state, and touches no suggestion, slot, cooldown, counter or send. A
 *    session that matched nothing is still a recorded observation.
 * 3. The record separates the three classes — read, ignored, not-applicable —
 *    names the skills whose files declare no condition at all, and carries the
 *    evidence behind each verdict.
 * 4. The row joins the sibling compliance record on (sessionId, skill): the
 *    verdict sits beside the four fields that record owns, and this module
 *    writes none of them.
 * 5. The adoption reader is unchanged: applicability lines do not enter the
 *    adoption numbers, and a build that predates the kind reads the same
 *    sessions.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports (the
 * store resolves through braidDir()), so the real agent tree is never touched.
 *
 * Run: npm test -w packages/core
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Isolate braid storage: temp home. MUST precede dist imports.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "skill-applicability-test-"));
process.env.HOME = FAKE_HOME;

const { getSkillsSessionsFilePath } = await import("../../../dist/lib/config/braid-paths.js");
const { NEUTRAL_SESSION_PROFILE } = await import("../../../dist/lib/config/session-profiles.js");
const {
  evaluateApplicability,
  phraseOccurrences,
  skillApplicability,
} = await import("../../../dist/extensions/core/skills-tool/applicability.js");
const {
  readApplicabilityRecords,
  foldApplicabilityRecords,
  getSessionApplicability,
  readSessionRecords,
  foldSessionRecords,
  appendSessionRecord,
} = await import("../../../dist/extensions/core/skills-tool/session-records.js");
const { registerAutoInject, updateSkillCache } = await import(
  "../../../dist/extensions/core/skills-tool/auto-inject.js"
);
const { readSkillTriggerEntries, triggerMatches, clearSkillTriggerCache } = await import(
  "../../../dist/extensions/core/skills-tool/skill-triggers.js"
);

const SESSIONS_FILE = getSkillsSessionsFilePath();
const CORE_SKILLS = join(import.meta.dirname, "..", "..", "..", "skills");
const SHIPPED_SKILLS = join(import.meta.dirname, "..", "..", "..", "..", "skills", "skills");

/** A cached skill shaped exactly as setCachedSkills leaves it for the matcher. */
function cachedSkill(name, phrases, source = "frontmatter") {
  return {
    name,
    triggers: phrases,
    triggerSources: Object.fromEntries(phrases.map((phrase) => [phrase, source])),
  };
}

/** A catalog of three skills that declare conditions, one that declares none. */
const FIXTURE_CATALOG = [
  cachedSkill("research", ["research", "literature review"]),
  cachedSkill("release-pipeline", ["release pipeline", "ship a release"], "heading"),
  cachedSkill("agent-testing", ["agent benchmark", "rpc mode"]),
  { name: "dox", triggers: [], triggerSources: {} },
];

const namesOf = (evaluation) => evaluation.applicable.map((v) => v.name).sort();

/** Wilson score interval for k successes of n — the width that keeps a small N honest. */
function wilson(k, n) {
  if (n === 0) return { low: 0, high: 1 };
  const z = 1.96;
  const p = k / n;
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

const interval = (k, n) =>
  `${k}/${n} [${wilson(k, n).low.toFixed(2)}-${wilson(k, n).high.toFixed(2)}]`;

function readSessionsFile() {
  try {
    return readFileSync(SESSIONS_FILE, "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const mine = (sessionId) =>
  readSessionsFile().filter((r) => r.kind === "applicability" && r.sessionId === sessionId);
const censusOf = (sessionId) => mine(sessionId).filter((r) => !("skill" in r));
const verdictRows = (sessionId) => mine(sessionId).filter((r) => "skill" in r);

const foldedMine = (sessionId) =>
  foldApplicabilityRecords(readApplicabilityRecords(SESSIONS_FILE)).find(
    (r) => r.sessionId === sessionId,
  );

/** Minimal ExtensionAPI double: captures handlers and delivered messages. */
function fakePi() {
  const handlers = {};
  const sent = [];
  return {
    handlers,
    sent,
    on: (event, handler) => {
      handlers[event] = handler;
    },
    registerTool: () => {},
    sendMessage: (params, options) => sent.push({ params, options }),
  };
}

/** A one-skill cache fixture on disk, so the read-detector has a real path. */
function skillFixture(tag, name, phrases) {
  const dir = mkdtempSync(join(tmpdir(), `applicability-${tag}-`));
  mkdirSync(join(dir, name), { recursive: true });
  const file = join(dir, name, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\n---\n\nbody`, "utf-8");
  return { dir, file, cached: { ...cachedSkill(name, phrases), filePath: file, description: name, baseDir: dir } };
}

// ── the six constructed sessions ─────────────────────────────────────────────

/**
 * Three sessions where the labelled skill applies, three where it does not:
 * a phrase that is close but not equal, a phrase in a negated clause, and no
 * phrase at all. The expected set is written down here, before the run.
 */
const CASES = [
  {
    id: "applies-single-word",
    text: "Please research the competing sources and write a short summary.",
    expected: ["research"],
  },
  {
    id: "applies-multi-word",
    text: "Run a literature review of the two tools before I commit.",
    expected: ["research"],
  },
  {
    id: "applies-second-skill",
    text: "Set up an agent benchmark that compares the two configurations.",
    expected: ["agent-testing"],
  },
  {
    id: "close-but-not-equal",
    text: "Let the researcher handle that part of the writeup.",
    expected: [],
  },
  {
    id: "negated",
    text: "Do not research this; answer from what you already know.",
    expected: [],
  },
  {
    id: "no-phrase",
    text: "The weather is fine today and the window is open.",
    expected: [],
  },
];

await test("the six constructed sessions classify as labelled (verdict + evidence printed)", async () => {
  // Confusion counts over (case, skill) pairs for the skills that DECLARE a
  // condition — the population the decision is made over. "dox" declares none,
  // so a call about it is not a prediction at all.
  const declarers = FIXTURE_CATALOG.filter((s) => s.triggers?.length);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const testCase of CASES) {
    const evaluation = evaluateApplicability(FIXTURE_CATALOG, testCase.text);
    const got = namesOf(evaluation);
    const expected = [...testCase.expected].sort();
    const evidence = evaluation.applicable.flatMap((v) =>
      v.evidence.map((e) => `${v.name}<-"${e.phrase}"(${e.source})`),
    );
    console.log(`   ${testCase.id}: expected [${expected}] got [${got}] ${evidence.join(", ")}`);
    for (const skill of declarers) {
      const truth = expected.includes(skill.name);
      const predicted = got.includes(skill.name);
      if (predicted && truth) tp++;
      else if (predicted) fp++;
      else if (truth) fn++;
      else tn++;
    }
    assert.deepEqual(got, expected, `${testCase.id}: verdict set`);
  }
  console.log(
    `   precision ${interval(tp, tp + fp)}  recall ${interval(tp, tp + fn)}  ` +
      `specificity ${interval(tn, tn + fp)}  (pairs: ${tp + fp + fn + tn}, ` +
      `${declarers.length} condition-declaring skills x ${CASES.length} sessions)`,
  );
});

await test("a negated phrase is not the condition holding, whatever its spelling", async () => {
  const negations = [
    "Do not research this.",
    "don't research this now",
    "There is no need to research this.",
    "Never research this question again.",
    "We can skip research here.",
    "Answer without research.",
  ];
  for (const text of negations) {
    const evaluation = evaluateApplicability(FIXTURE_CATALOG, text);
    assert.deepEqual(namesOf(evaluation), [], `"${text}" must not be applicable`);
  }
});

await test("a negation cue stops at its clause, and an asserted occurrence survives", async () => {
  // Semicolon ends the negated clause; the second mention asserts.
  assert.deepEqual(
    namesOf(evaluateApplicability(FIXTURE_CATALOG, "Do not use the catalog; research the topic.")),
    ["research"],
  );
  // Period ends it too.
  assert.deepEqual(
    namesOf(evaluateApplicability(FIXTURE_CATALOG, "Do not skip. Research the topic fully.")),
    ["research"],
  );
  // One negated occurrence does not erase an asserted one in the same text.
  assert.deepEqual(
    namesOf(evaluateApplicability(FIXTURE_CATALOG, "Do not research. Later, research carefully.")),
    ["research"],
  );
});

await test("a double negative reads as negation, so the ignored rate is a lower bound", async () => {
  // The rule is one cue before the phrase: the nearest negation wins, and it is
  // not composed. "would not want you to avoid research" asserts research to a
  // reader and reads as negated here, which means the ignored count can only
  // understate how often a condition held. The bound is deliberate: composing
  // cues needs clause grammar, and a measurer that guesses would be worse than
  // one that under-counts. Pinned so the limitation is discoverable rather than
  // latent, and so a future change to it is a decision rather than a drift.
  assert.deepEqual(
    namesOf(evaluateApplicability(FIXTURE_CATALOG, "I would not want you to avoid research here.")),
    [],
  );
});

await test("phraseOccurrences uses the injector's boundary rule", async () => {
  const lowered = "researching the researcher and a research note";
  assert.deepEqual(phraseOccurrences("research", lowered), [lowered.lastIndexOf("research")]);
  assert.deepEqual(phraseOccurrences("research", "research"), [0]);
  assert.deepEqual(phraseOccurrences("research", "research notes"), [0]);
  assert.deepEqual(phraseOccurrences("", lowered), []);
});

await test("the verdict agrees with triggerMatches over the installed catalog", async () => {
  // Two surfaces, one boundary rule: every phrase the injector fires on must be
  // a phrase a verdict can cite, and vice versa. A disagreement would let the
  // record contradict the whisper it is supposed to explain.
  const texts = [
    "please research the skill applicability for this task",
    "run a code search over the packages instead of grepping",
    "release pipeline check before the tag",
    "do not research this",
    "nothing relevant in this sentence",
    "agent benchmark for two arms with rpc mode",
  ];
  let checked = 0;
  for (const dir of [CORE_SKILLS, SHIPPED_SKILLS]) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(dir, entry.name, "SKILL.md");
      let content;
      try {
        content = readFileSync(file, "utf-8");
      } catch {
        continue; // the shared fragment directory has no SKILL.md
      }
      const entries = readSkillTriggerEntries(file, descriptionOf(content));
      const skill = cachedSkill(
        entry.name,
        entries.map((e) => e.phrase),
      );
      for (const text of texts) {
        for (const { phrase } of entries) {
          const fires = triggerMatches(phrase, text);
          const occurs = phraseOccurrences(phrase, text.toLowerCase()).length > 0;
          assert.equal(fires, occurs, `${entry.name}:"${phrase}" vs "${text}"`);
          checked++;
        }
        for (const item of skillApplicability(skill, text)) {
          assert.ok(triggerMatches(item.phrase, text), "cited evidence is a phrase the injector fires on");
        }
      }
    }
  }
  console.log(`   ${checked} (phrase, text) pairs agree between the two readers`);
  clearSkillTriggerCache();
});

await test("the negated-prompt verdict is a separate answer from the injector's", async () => {
  // The injector fires on the negated prompt (it has no polarity read); the
  // verdict does not. That difference is the instrument, not a defect.
  assert.equal(triggerMatches("research", "Do not research this"), true);
  assert.deepEqual(namesOf(evaluateApplicability(FIXTURE_CATALOG, "Do not research this")), []);
});

// ── the matcher's product: three classes, evidence, undeclared remainder ─────

/** The description a real skill file declares, as the reader receives it. */
function descriptionOf(content) {
  return /^description:\s*(.*)$/m.exec(content.slice(0, 4000))?.[1] ?? "";
}

await test("evaluateApplicability names the skills that declare no condition", async () => {
  const evaluation = evaluateApplicability(FIXTURE_CATALOG, "Please research this.");
  assert.equal(evaluation.evaluated, 3, "three skills declare a condition");
  assert.deepEqual(evaluation.undeclared, ["dox"], "the one that declares none is named");
  assert.deepEqual(evaluation.applicable[0].evidence, [
    { phrase: "research", source: "frontmatter" },
  ]);
});

await test("evidence carries the authored source of the matched phrase", async () => {
  const evaluation = evaluateApplicability(FIXTURE_CATALOG, "Is the release pipeline green?");
  assert.deepEqual(evaluation.applicable, [
    {
      name: "release-pipeline",
      verdict: "ignored",
      evidence: [{ phrase: "release pipeline", source: "heading" }],
    },
  ]);
});

await test("evidence is bounded per skill", async () => {
  const many = cachedSkill(
    "spam",
    ["alpha one", "beta one", "gamma one", "delta one", "epsilon one", "zeta one"],
  );
  const evaluation = evaluateApplicability(
    [many],
    "alpha one, beta one, gamma one, delta one, epsilon one, zeta one",
  );
  assert.equal(evaluation.applicable[0].evidence.length, 4);
});

await test("an unenriched cache yields phrase evidence with no source (never a guessed one)", async () => {
  const evaluation = evaluateApplicability([{ name: "bare", triggers: ["research"] }], "research this");
  assert.deepEqual(evaluation.applicable[0].evidence, [{ phrase: "research" }]);
});

// ── hook wiring: recorded, not enforced ─────────────────────────────────────

await test("a session that matches nothing is still recorded (the population the counters lose)", async () => {
  const fixture = skillFixture("nothing", "solo-skill", []);
  const pi = fakePi();
  registerAutoInject(pi);
  updateSkillCache([fixture.cached]);
  const ctx = { sessionManager: { getSessionId: () => "sess-nothing-applied" }, cwd: "/tmp" };
  const prompt = "the weather is fine today";

  await pi.handlers.before_agent_start({ prompt }, ctx);
  const census = censusOf("sess-nothing-applied");
  assert.equal(census.length, 1, "first evaluation writes one census row");
  assert.equal(census[0].taskChars, prompt.length, "the record states how much text it read");
  // The cache entry declares no phrase, so the census carries it as undeclared:
  // the record says "no condition stated" instead of asserting a negative.
  assert.deepEqual(census[0].undeclared, ["solo-skill"]);
  assert.equal(census[0].evaluated, 0);
  assert.deepEqual(verdictRows("sess-nothing-applied"), [], "no verdict row without a verdict");
  assert.equal(pi.sent.length, 0, "no suggestion was delivered");
  const folded = foldedMine("sess-nothing-applied");
  assert.deepEqual(folded.classes, { read: 0, ignored: 0, notApplicable: 0 });
  rmSync(fixture.dir, { recursive: true, force: true });
});

await test("a later turn does not duplicate the census row", async () => {
  const fixture = skillFixture("census-once", "once-skill", []);
  const pi = fakePi();
  registerAutoInject(pi);
  updateSkillCache([fixture.cached]);
  const ctx = { sessionManager: { getSessionId: () => "sess-census-once" }, cwd: "/tmp" };
  await pi.handlers.before_agent_start({ prompt: "hello there" }, ctx);
  await pi.handlers.before_agent_start({ prompt: "and again" }, ctx);
  await pi.handlers.before_agent_start({ prompt: "one more" }, ctx);
  assert.equal(censusOf("sess-census-once").length, 1, "one census per session");
  rmSync(fixture.dir, { recursive: true, force: true });
});

await test("an applicable skill with no read is `ignored`, and the row carries its evidence", async () => {
  // THE COUNTEREXAMPLE. If a classifier collapsed "applied and ignored" into
  // "did not apply", this fixture is the one that fails: it asserts the row
  // exists, with the phrase and the place in the file that declares it.
  const fixture = skillFixture("ignored", "ignored-skill", ["benchmark the widget"]);
  const pi = fakePi();
  registerAutoInject(pi);
  updateSkillCache([fixture.cached]);
  const ctx = { sessionManager: { getSessionId: () => "sess-ignored" }, cwd: "/tmp" };

  await pi.handlers.before_agent_start(
    { prompt: "Please benchmark the widget before the meeting." },
    ctx,
  );
  assert.deepEqual(verdictRows("sess-ignored"), [
    {
      kind: "applicability",
      sessionId: "sess-ignored",
      role: NEUTRAL_SESSION_PROFILE,
      month: verdictRows("sess-ignored")[0].month,
      updatedAt: verdictRows("sess-ignored")[0].updatedAt,
      skill: "ignored-skill",
      applicability: "ignored",
      evidence: [{ phrase: "benchmark the widget", source: "frontmatter" }],
    },
  ]);
  // The three classes, as the reader reports them: one applicable (ignored),
  // nothing read, and the census says nothing else could have applied.
  const folded = foldedMine("sess-ignored");
  assert.deepEqual(folded.classes, { read: 0, ignored: 1, notApplicable: 0 });
  assert.deepEqual(folded.undeclared, []);
  rmSync(fixture.dir, { recursive: true, force: true });
});

await test("a detected read upgrades the verdict to `read` and keeps the evidence", async () => {
  const fixture = skillFixture("read", "read-skill", ["triage the backlog"]);
  const pi = fakePi();
  registerAutoInject(pi);
  updateSkillCache([fixture.cached]);
  const ctx = { sessionManager: { getSessionId: () => "sess-read" }, cwd: "/tmp" };

  await pi.handlers.before_agent_start({ prompt: "triage the backlog today" }, ctx);
  pi.handlers.tool_result(
    {
      toolName: "read",
      input: { path: fixture.file },
      content: [{ type: "text", text: "---\nname: read-skill\n---\n\nbody" }],
    },
    ctx,
  );
  const rows = verdictRows("sess-read");
  assert.equal(rows.length, 2, "the read appends an upgrade row, never rewrites");
  assert.deepEqual(
    rows.map((r) => r.applicability),
    ["ignored", "read"],
  );
  assert.deepEqual(
    rows[1].evidence,
    [{ phrase: "triage the backlog", source: "frontmatter" }],
    "the evidence survives the upgrade",
  );
  const folded = foldedMine("sess-read");
  assert.equal(folded.verdicts[0].verdict, "read");
  assert.deepEqual(folded.classes, { read: 1, ignored: 0, notApplicable: 0 });
  rmSync(fixture.dir, { recursive: true, force: true });
});

await test("a read of a skill whose condition never held adds no verdict row", async () => {
  const fixture = skillFixture("offtopic", "offtopic-skill", ["quarterly ledger audit"]);
  const pi = fakePi();
  registerAutoInject(pi);
  updateSkillCache([fixture.cached]);
  const ctx = { sessionManager: { getSessionId: () => "sess-offtopic" }, cwd: "/tmp" };

  await pi.handlers.before_agent_start({ prompt: "hello there" }, ctx);
  pi.handlers.tool_result(
    {
      toolName: "read",
      input: { path: fixture.file },
      content: [{ type: "text", text: "---\nname: offtopic-skill\n---\n\nbody" }],
    },
    ctx,
  );
  assert.deepEqual(verdictRows("sess-offtopic"), [], "no row: the read is not a verdict");
  assert.equal(censusOf("sess-offtopic").length, 1, "the census still exists");
  rmSync(fixture.dir, { recursive: true, force: true });
});

await test("the verdict does not move the suggestion: delivery and record are independent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "applicability-independent-"));
  mkdirSync(join(dir, "two-skill"), { recursive: true });
  const file = join(dir, "two-skill", "SKILL.md");
  writeFileSync(file, "---\nname: two-skill\n---\n\nbody instructions", "utf-8");
  const pi = fakePi();
  registerAutoInject(pi);
  updateSkillCache([
    { name: "two-skill", filePath: file, description: "two skill", baseDir: dir, triggers: [], triggerSources: {} },
  ]);
  const ctx = { sessionManager: { getSessionId: () => "sess-independent" }, cwd: "/tmp" };

  // A prompt the SCORER matches (name token) whose file declares no phrase: the
  // whisper fires, the verdict does not. One decision, one record.
  await pi.handlers.before_agent_start({ prompt: "please follow the two-skill guide" }, ctx);
  const suggestion = pi.sent.find((m) => m.params.customType === "skills-suggestion");
  assert.ok(suggestion, "the suggestion path is unchanged");
  assert.deepEqual(suggestion.params.details.skills, ["two-skill"]);
  assert.deepEqual(verdictRows("sess-independent"), [], "no phrase, no verdict");
  assert.deepEqual(censusOf("sess-independent")[0].undeclared, ["two-skill"]);
  rmSync(dir, { recursive: true, force: true });
});

await test("the row is the joint: a suggested skill's name is what the verdict row names", async () => {
  // The value question the report states as its falsifier needs exactly this:
  // the session stream says which skills were SUGGESTED, the record says which
  // were APPLICABLE, and both sides key on the skill name.
  const fixture = skillFixture("joint", "joint-skill", ["inspect the ledger"]);
  const pi = fakePi();
  registerAutoInject(pi);
  updateSkillCache([fixture.cached]);
  const ctx = { sessionManager: { getSessionId: () => "sess-joint" }, cwd: "/tmp" };

  await pi.handlers.before_agent_start({ prompt: "inspect the ledger today" }, ctx);
  const suggested = pi.sent
    .filter((m) => m.params.customType === "skills-suggestion")
    .flatMap((m) => m.params.details.skills);
  const applicable = verdictRows("sess-joint").map((r) => r.skill);
  assert.deepEqual(suggested, applicable, "both surfaces name the same skill, so a delta is computable");
  // And the four sibling fields are NOT written here: the leg belongs to the
  // record that owns it.
  for (const field of ["suggested", "listed", "read", "applied", "allSatisfied"]) {
    assert.equal(field in verdictRows("sess-joint")[0], false, `${field} is not this module's field`);
  }
  rmSync(fixture.dir, { recursive: true, force: true });
});

await test("a ctx without a session records nothing and never throws", async () => {
  const pi = fakePi();
  registerAutoInject(pi);
  await pi.handlers.before_agent_start({ prompt: "research this please" }, {});
  assert.deepEqual(mine(undefined), []);
});

// ── the store: fold, tolerance, and the adoption reader's silence ────────────

const verdictRow = (sessionId, skill, applicability, extra = {}) => ({
  kind: "applicability",
  sessionId,
  role: "worker",
  month: "2026-09",
  updatedAt: "2026-09-01T00:00:00.000Z",
  skill,
  applicability,
  evidence: [{ phrase: `${skill} phrase`, source: "frontmatter" }],
  ...extra,
});

const censusRow = (sessionId, extra = {}) => ({
  kind: "applicability",
  sessionId,
  role: "worker",
  month: "2026-09",
  updatedAt: "2026-09-01T00:00:00.000Z",
  taskChars: 40,
  evaluated: 3,
  undeclared: [],
  ...extra,
});

await test("fold: read beats ignored regardless of line order, evidence unions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "applicability-fold-"));
  const store = join(dir, "sessions.jsonl");
  writeFileSync(
    store,
    [
      JSON.stringify(censusRow("order")),
      JSON.stringify(verdictRow("order", "s", "read", { evidence: [{ phrase: "beta" }] })),
      JSON.stringify(verdictRow("order", "s", "ignored", { evidence: [{ phrase: "alpha" }] })),
    ].join("\n") + "\n",
    "utf-8",
  );
  const folded = foldApplicabilityRecords(readApplicabilityRecords(store));
  assert.equal(folded.length, 1);
  assert.equal(folded[0].verdicts[0].verdict, "read", "a later ignored row cannot downgrade");
  assert.deepEqual(
    folded[0].verdicts[0].evidence.map((e) => e.phrase),
    ["beta", "alpha"],
    "evidence from both writes survives",
  );
  assert.deepEqual(folded[0].classes, { read: 1, ignored: 0, notApplicable: 2 });
  rmSync(dir, { recursive: true, force: true });
});

await test("fold: the newest census carries the session facts, verdict rows keep them intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "applicability-census-"));
  const store = join(dir, "sessions.jsonl");
  writeFileSync(
    store,
    [
      JSON.stringify(censusRow("census", { updatedAt: "2026-09-01T00:00:00.000Z" })),
      JSON.stringify(
        censusRow("census", {
          updatedAt: "2026-09-02T00:00:00.000Z",
          evaluated: 4,
          undeclared: ["plain"],
          taskChars: 120,
        }),
      ),
      // A verdict row written AFTER the census must not erase the census.
      JSON.stringify(
        verdictRow("census", "s", "ignored", { updatedAt: "2026-09-03T00:00:00.000Z" }),
      ),
      JSON.stringify(censusRow("other", { evaluated: 9 })),
    ].join("\n") + "\n",
    "utf-8",
  );
  const folded = foldApplicabilityRecords(readApplicabilityRecords(store));
  assert.equal(folded.length, 2, "one logical record per session");
  const session = folded.find((r) => r.sessionId === "census");
  assert.equal(session.evaluated, 4);
  assert.deepEqual(session.undeclared, ["plain"]);
  assert.equal(session.taskChars, 120);
  assert.deepEqual(session.classes, { read: 0, ignored: 1, notApplicable: 3 });
  rmSync(dir, { recursive: true, force: true });
});

await test("the applicability reader is tolerant: torn lines, junk fields, missing file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "applicability-tolerant-"));
  const store = join(dir, "sessions.jsonl");
  writeFileSync(
    store,
    [
      JSON.stringify(verdictRow("ok", "s", "read")),
      "{ torn line",
      JSON.stringify({ kind: "applicability", sessionId: "no-month", skill: "s", applicability: "read" }),
      JSON.stringify({ kind: "applicability", sessionId: "bad-class", month: "2026-09", skill: "s", applicability: "maybe" }),
      JSON.stringify(
        censusRow("junk", { taskChars: "many", evaluated: -3, undeclared: ["ok", 7, null] }),
      ),
    ].join("\n") + "\n",
    "utf-8",
  );
  const records = readApplicabilityRecords(store);
  assert.deepEqual(
    records.map((r) => r.sessionId).sort(),
    ["junk", "ok"],
    "torn, monthless and wrongly-classed lines are skipped",
  );
  const junk = records.find((r) => r.sessionId === "junk");
  assert.equal(junk.taskChars, 0, "a non-number is coerced, not trusted");
  assert.equal(junk.evaluated, 0);
  assert.deepEqual(junk.undeclared, ["ok"], "only names survive the list");
  assert.deepEqual(readApplicabilityRecords(join(dir, "missing.jsonl")), []);
  rmSync(dir, { recursive: true, force: true });
});

await test("the adoption reader ignores applicability lines and keeps its own numbers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "applicability-adoption-"));
  const store = join(dir, "sessions.jsonl");
  const adoption = (sessionId, hadSkillLoad) => ({
    sessionId,
    role: "worker",
    month: "2026-09",
    hadSkillLoad,
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
  writeFileSync(
    store,
    [
      JSON.stringify(adoption("a", false)),
      JSON.stringify(censusRow("b")),
      JSON.stringify(adoption("a", true)),
      JSON.stringify(verdictRow("b", "s", "ignored")),
    ].join("\n") + "\n",
    "utf-8",
  );
  const adoptionLines = readSessionRecords(store);
  assert.equal(adoptionLines.length, 2, "two adoption lines, two applicability lines");
  const folded = foldSessionRecords(adoptionLines);
  assert.equal(folded.length, 1, "only the adoption session is in the adoption fold");
  assert.equal(folded[0].sessionId, "a");
  assert.equal(folded[0].hadSkillLoad, true);

  // Forward-compatible half: a build that predates the kind folds every line
  // of this same file. Same sessions, same adoption numbers — no applicability
  // line sets hadSkillLoad, and the session it names had a start record anyway.
  const stripped = readFileSync(store, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const raw = JSON.parse(line);
      if (raw.kind !== "applicability") return raw;
      const rest = { ...raw };
      for (const key of ["kind", "skill", "applicability", "evidence", "taskChars", "evaluated", "undeclared"]) {
        delete rest[key];
      }
      return rest;
    });
  const naive = stripped;
  const naiveFolded = foldSessionRecords(naive);
  assert.deepEqual(
    naiveFolded.map((r) => r.sessionId).sort(),
    ["a", "b"],
    "an older build sees its own record plus the extra session row it would have written anyway",
  );
  assert.equal(naiveFolded.find((r) => r.sessionId === "a").hadSkillLoad, true);

  // An unknown kind is refused rather than folded: fail-closed, so a kind added
  // later cannot quietly become an adoption record.
  const dir2 = mkdtempSync(join(tmpdir(), "applicability-unknown-kind-"));
  const store2 = join(dir2, "sessions.jsonl");
  writeFileSync(
    store2,
    JSON.stringify({ kind: "reminder", sessionId: "z", month: "2026-09", hadSkillLoad: true }) + "\n",
    "utf-8",
  );
  assert.deepEqual(readSessionRecords(store2), []);
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
});

await test("appendSessionRecord still writes the adoption shape it always did", async () => {
  const dir = mkdtempSync(join(tmpdir(), "applicability-append-"));
  const store = join(dir, "sessions.jsonl");
  appendSessionRecord(
    {
      sessionId: "plain",
      role: "worker",
      month: "2026-09",
      hadSkillLoad: false,
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
    store,
  );
  const raw = JSON.parse(readFileSync(store, "utf-8").trim());
  assert.equal(raw.kind, undefined, "an adoption record carries no kind");
  assert.equal(raw.sessionId, "plain");
  rmSync(dir, { recursive: true, force: true });
});

await test("getSessionApplicability reads the context's own session only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "applicability-own-"));
  const store = join(dir, "sessions.jsonl");
  writeFileSync(store, JSON.stringify(verdictRow("mine", "s", "ignored")) + "\n", "utf-8");
  const ctx = { sessionManager: { getSessionId: () => "mine" }, cwd: "/tmp" };
  assert.equal(getSessionApplicability(ctx, { storePath: store }).sessionId, "mine");
  const other = { sessionManager: { getSessionId: () => "theirs" }, cwd: "/tmp" };
  assert.equal(getSessionApplicability(other, { storePath: store }), undefined);
  rmSync(dir, { recursive: true, force: true });
});

// ── cost: the characters and milliseconds one session adds ───────────────────

/** The installed catalog, resolved the way setCachedSkills resolves it. */
function installedCatalog() {
  const catalog = [];
  for (const dir of [CORE_SKILLS, SHIPPED_SKILLS]) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(dir, entry.name, "SKILL.md");
      let content;
      try {
        content = readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      const entries = readSkillTriggerEntries(file, descriptionOf(content));
      catalog.push(
        cachedSkill(
          entry.name,
          entries.map((e) => e.phrase),
        ),
      );
    }
  }
  return catalog;
}

await test("cost: a full catalog over a 100k-character task, measured", async () => {
  const catalog = installedCatalog();
  const phrases = catalog.reduce((n, s) => n + (s.triggers?.length ?? 0), 0);
  const big = "the weather is fine today and the window is open. ".repeat(2400);
  assert.ok(big.length >= 100_000, `fixture must exceed 100k chars (got ${big.length})`);

  const started = process.hrtime.bigint();
  const evaluation = evaluateApplicability(catalog, big);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  console.log(
    `   ${catalog.length} skills, ${phrases} phrases, ${big.length} task chars: ` +
      `${elapsedMs.toFixed(1)} ms, applicable=${evaluation.applicable.length}, ` +
      `evaluated=${evaluation.evaluated}, undeclared=${evaluation.undeclared.length}`,
  );
  assert.equal(evaluation.applicable.length, 0, "a weather sentence applies nothing");
  assert.equal(evaluation.evaluated + evaluation.undeclared.length, catalog.length);
  // Generous bound: the point is that a pathological prompt cannot stall a
  // turn, not a benchmark of the machine this runs on.
  assert.ok(elapsedMs < 500, `100k chars must stay under 500ms (measured ${elapsedMs.toFixed(1)})`);
});

await test("census: the installed packs, measured from their files", async () => {
  const packs = { core: CORE_SKILLS, shipped: SHIPPED_SKILLS };
  const census = {};
  for (const [pack, dir] of Object.entries(packs)) {
    const skills = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(dir, entry.name, "SKILL.md");
      let content;
      try {
        content = readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      const entries = readSkillTriggerEntries(file, descriptionOf(content));
      skills.push(cachedSkill(entry.name, entries.map((e) => e.phrase)));
    }
    census[pack] = evaluateApplicability(skills, "no condition meets this sentence");
    console.log(
      `   ${pack}: ${skills.length} skills, ${census[pack].evaluated} declare a condition, ` +
        `${census[pack].undeclared.length} declare none`,
    );
    assert.equal(
      census[pack].evaluated + census[pack].undeclared.length,
      skills.length,
      `${pack}: every installed skill is in exactly one census bucket`,
    );
  }
  // The shipped pack's contract requires two authored phrases per skill, so
  // nothing there may sit outside the decision.
  assert.deepEqual(census.shipped.undeclared, []);
  // The core pack's undeclared set is a fact about the files, not a threshold:
  // if a skill gains a phrase this assertion tells the next author to update the
  // report's count rather than letting a stale number travel.
  assert.deepEqual(census.core.undeclared.sort(), [
    "code-refactoring",
    "code-search",
    "documentation",
    "dox",
    "meta-cognition",
    "research",
    "skill-usage",
  ]);
});

// ── cleanup ──────────────────────────────────────────────────────────────────

try {
  rmSync(FAKE_HOME, { recursive: true, force: true });
} catch {
  /* best-effort */
}
