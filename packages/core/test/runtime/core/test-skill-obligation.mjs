/**
 * skill obligation records — the applied leg and the two rates.
 *
 * Pins five contracts:
 *
 * 1. The declaration: a skill file's optional `governs:` key names TOOL
 *    FAMILIES (a tool name's first underscore-delimited segment). Both authored
 *    shapes are read, malformed entries and the detector's own tool are
 *    dropped, and a file that declares nothing governs nothing.
 * 2. The applied leg is ordered, and the order is final. A read then a call in
 *    a declared family is `applied`; a call before the read is not, and the
 *    later read cannot repair it. A call in another family is not a leg. A
 *    session that called the family without ever reading the body has a row —
 *    the violation is recorded, not dropped.
 * 3. The record joins the applicability record on (sessionId, skill) and
 *    restates none of its vocabulary: legs are facts (a read happened, a call
 *    happened), not verdicts (`applicability: "read" | "ignored"`).
 * 4. The session boolean and the two rates: `allSatisfied` is true when every
 *    obligation that applied was satisfied, and `allSatisfied / sessions` is
 *    reported beside the read rate over the SAME population, with the design's
 *    five-point falsifier applied.
 * 5. The reader is additive: a store with no obligation row produces the
 *    payload it always produced, byte for byte; adding rows adds keys and
 *    changes none.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports.
 *
 * Run: npm test -w packages/core
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Isolate braid storage: temp home. MUST precede dist imports.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "skill-obligation-test-"));
process.env.HOME = FAKE_HOME;

const { getSkillsSessionsFilePath } = await import("../../../dist/lib/config/braid-paths.js");
const { recordSkillLoad, registerAutoInject, updateSkillCache, noteObligationListed } =
  await import("../../../dist/extensions/core/skills-tool/auto-inject.js");
const {
  readObligationRecords,
  foldObligationRecords,
  recordObligationLegs,
  recordApplicabilityVerdict,
  obligationSatisfied,
  judgeSessionObligations,
  computeObligationRate,
  getObligationRate,
  FALSIFIER_GAP_POINTS,
} = await import("../../../dist/extensions/core/skills-tool/session-records.js");
const {
  parseGovernedFamilies,
  readGovernedFamilies,
  toolFamilyToken,
  clearGovernedFamilyCache,
  MAX_GOVERNED_FAMILIES,
  DETECTOR_TOOL,
} = await import("../../../dist/extensions/core/skills-tool/skill-families.js");

const SESSIONS_FILE = getSkillsSessionsFilePath();

/** Minimal ExtensionAPI double: captures handlers, tools and deliveries. */
function fakePi() {
  const handlers = {};
  const tools = [];
  const sent = [];
  return {
    handlers,
    tools,
    sent,
    on: (event, handler) => {
      handlers[event] = handler;
    },
    registerTool: (def) => {
      tools.push(def);
    },
    sendMessage: (params, options) => {
      sent.push({ params, options });
    },
  };
}

const fakeCtx = (sessionId) => ({
  sessionManager: { getSessionId: () => sessionId },
  cwd: "/tmp",
});

/** A real skill file on disk, so the read detector has a path to match. */
function skillFixture(tag, name, extraFrontmatter = "") {
  const dir = mkdtempSync(join(tmpdir(), `obligation-${tag}-`));
  mkdirSync(join(dir, name), { recursive: true });
  const file = join(dir, name, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\n${extraFrontmatter}---\n\nbody`, "utf-8");
  const cached = { name, filePath: file, description: name, baseDir: dir, triggers: [], triggerSources: {} };
  cached.families = readGovernedFamilies(file);
  return { dir, file, cached };
}

/** Drive a detected read of the fixture's body through the tool_result path. */
function readFixture(pi, ctx, fixture) {
  pi.handlers.tool_result(
    {
      toolName: "read",
      input: { path: fixture.file },
      content: [{ type: "text", text: readFileSync(fixture.file, "utf-8") }],
    },
    ctx,
  );
}

/** Drive a tool call through the tool_result path (the applied-leg trigger). */
function callTool(pi, ctx, toolName) {
  pi.handlers.tool_result({ toolName, input: { path: "/tmp/whatever" }, content: [{ text: "ok" }] }, ctx);
}

const rowsFor = (sessionId) => readObligationRecords(SESSIONS_FILE).filter((r) => r.sessionId === sessionId);
const legsFor = (sessionId, skill) =>
  foldObligationRecords(rowsFor(sessionId))
    .find((rec) => rec.sessionId === sessionId)
    ?.skills.find((legs) => legs.skill === skill);

/** An applicability fold shaped as the previous record leaves it. */
const applicable = (sessionId, skills) => ({
  sessionId,
  role: "tester",
  month: "2026-10",
  updatedAt: "2026-10-29T00:00:00.000Z",
  taskChars: 200,
  evaluated: skills.length,
  undeclared: [],
  verdicts: skills.map((skill) => ({ name: skill, verdict: "ignored", evidence: [] })),
  classes: { read: 0, ignored: skills.length, notApplicable: 0 },
});

const legs = (skill, over = {}) => ({
  skill,
  suggested: false,
  listed: false,
  informed: false,
  read: false,
  called: false,
  applied: false,
  ...over,
});

// ── 1. the declaration ──────────────────────────────────────────────────────

await test("the declaration reads both authored shapes and drops what cannot be a family", () => {
  assert.deepEqual(parseGovernedFamilies(["document", "Browser"]), ["document", "browser"]);
  assert.deepEqual(parseGovernedFamilies("document, browser"), ["document", "browser"]);
  assert.deepEqual(parseGovernedFamilies(["document", "document"]), ["document"], "deduped");
  assert.deepEqual(parseGovernedFamilies(["Document_2", "do cument", "", 7]), [], "malformed dropped");
  assert.deepEqual(
    parseGovernedFamilies([DETECTOR_TOOL]),
    [],
    "the detector's own tool is never a declared family: a call to it IS the read leg",
  );
  assert.equal(parseGovernedFamilies(undefined).length, 0, "an absent key declares nothing");
  assert.equal(parseGovernedFamilies(null).length, 0);
  assert.equal(
    parseGovernedFamilies(["a", "b", "c", "d", "e"]).length,
    MAX_GOVERNED_FAMILIES,
    "the reader's cap bounds the record rows",
  );
});

await test("a family token is the tool name's first segment, so prompt and record agree", () => {
  assert.equal(toolFamilyToken("document_parse"), "document");
  assert.equal(toolFamilyToken("Browser_Navigate"), "browser");
  assert.equal(toolFamilyToken("bash"), "bash");
  assert.equal(toolFamilyToken(""), "");
});

await test("readGovernedFamilies reads the file, and a file without the key governs nothing", () => {
  const withKey = skillFixture("declared", "declared-skill", "governs:\n  - widget\n  - browser\n");
  assert.deepEqual(readGovernedFamilies(withKey.file), ["widget", "browser"]);
  // A changed file is re-read, not served from the memo.
  writeFileSync(withKey.file, "---\nname: declared-skill\ngoverns: widget\n---\n\nbody", "utf-8");
  assert.deepEqual(readGovernedFamilies(withKey.file), ["widget"]);
  const without = skillFixture("undeclared", "undeclared-skill");
  clearGovernedFamilyCache();
  assert.deepEqual(readGovernedFamilies(without.file), [], "no key, no family");
  assert.deepEqual(readGovernedFamilies("/nonexistent/SKILL.md"), [], "a missing file never throws");
  rmSync(withKey.dir, { recursive: true, force: true });
  rmSync(without.dir, { recursive: true, force: true });
});

// ── 2. the applied leg, on the four constructed sessions ────────────────────

await test("read then a call in the declared family: the obligation is applied", async () => {
  const fixture = skillFixture("applied", "applies-skill", "governs:\n  - widget\n");
  const pi = fakePi();
  registerAutoInject(pi);
  updateSkillCache([fixture.cached]);
  const ctx = fakeCtx("sess-applied");

  readFixture(pi, ctx, fixture);
  callTool(pi, ctx, "widget_open");

  assert.deepEqual(legsFor("sess-applied", "applies-skill"), legs("applies-skill", {
    read: true,
    called: true,
    applied: true,
  }));
  assert.equal(rowsFor("sess-applied").length, 2, "one row for the read, one for the call");
  rmSync(fixture.dir, { recursive: true, force: true });
});

await test("a call BEFORE the read is not applied, and the later read cannot repair it", async () => {
  const fixture = skillFixture("before", "before-skill", "governs:\n  - widget\n");
  const pi = fakePi();
  registerAutoInject(pi);
  updateSkillCache([fixture.cached]);
  const ctx = fakeCtx("sess-before");

  callTool(pi, ctx, "widget_open");
  assert.deepEqual(legsFor("sess-before", "before-skill"), legs("before-skill", { called: true }), "the call is recorded, and it came first");

  readFixture(pi, ctx, fixture);
  assert.deepEqual(
    legsFor("sess-before", "before-skill"),
    legs("before-skill", { read: true, called: true, applied: false }),
    "OR-fold must not turn an earlier violation into satisfaction",
  );
  assert.equal(obligationSatisfied(legsFor("sess-before", "before-skill")), false);
  rmSync(fixture.dir, { recursive: true, force: true });
});

await test("a call in another family does not count, and writes no row", async () => {
  const fixture = skillFixture("other", "other-skill", "governs:\n  - widget\n");
  const pi = fakePi();
  registerAutoInject(pi);
  updateSkillCache([fixture.cached]);
  const ctx = fakeCtx("sess-other-family");

  callTool(pi, ctx, "gizmo_open");
  assert.deepEqual(rowsFor("sess-other-family"), [], "no leg for a family the file did not declare");
  // The declared family, spelled with the same token, does count.
  callTool(pi, ctx, "widget_list");
  assert.deepEqual(legsFor("sess-other-family", "other-skill"), legs("other-skill", { called: true }));
  rmSync(fixture.dir, { recursive: true, force: true });
});

await test("a call with no read is recorded rather than dropped", async () => {
  const fixture = skillFixture("noread", "noread-skill", "governs:\n  - widget\n");
  const pi = fakePi();
  registerAutoInject(pi);
  updateSkillCache([fixture.cached]);
  const ctx = fakeCtx("sess-no-read");

  callTool(pi, ctx, "widget_open");
  const rows = rowsFor("sess-no-read");
  assert.equal(rows.length, 1, "the session's leg exists: the violation is data, not silence");
  assert.equal(rows[0].kind, "obligation");
  assert.equal(rows[0].read, false);
  assert.equal(rows[0].called, true);
  assert.equal(rows[0].applied, false);
  rmSync(fixture.dir, { recursive: true, force: true });
});

await test("a skill that declares no family is never a call leg", async () => {
  const fixture = skillFixture("nodecl", "nodecl-skill");
  const pi = fakePi();
  registerAutoInject(pi);
  updateSkillCache([fixture.cached]);
  const ctx = fakeCtx("sess-no-decl");
  callTool(pi, ctx, "widget_open");
  callTool(pi, ctx, "read");
  assert.deepEqual(rowsFor("sess-no-decl"), [], "nothing to call into, so nothing to apply");
  rmSync(fixture.dir, { recursive: true, force: true });
});

await test("listed and read legs land, and a repeated leg writes one row", async () => {
  const fixture = skillFixture("legs", "legs-skill", "governs:\n  - widget\n");
  const pi = fakePi();
  registerAutoInject(pi);
  updateSkillCache([fixture.cached]);
  const ctx = fakeCtx("sess-legs");

  noteObligationListed(ctx, ["legs-skill"]);
  noteObligationListed(ctx, ["legs-skill"]);
  recordSkillLoad(ctx, "legs-skill");
  readFixture(pi, ctx, fixture);
  readFixture(pi, ctx, fixture);

  assert.equal(rowsFor("sess-legs").length, 2, "one row per distinct state, not per event");
  assert.deepEqual(legsFor("sess-legs", "legs-skill"), legs("legs-skill", { listed: true, read: true }));
  rmSync(fixture.dir, { recursive: true, force: true });
});

// ── 3. the fold and the join ───────────────────────────────────────────────

await test("the fold ORs the legs, keeps the newest session facts, and drops malformed rows", () => {
  const base = { kind: "obligation", sessionId: "fold-me", role: "tester", month: "2026-10", updatedAt: "2026-10-01T00:00:00.000Z", skill: "a" };
  const folded = foldObligationRecords([
    { ...base, suggested: true, listed: false, informed: false, read: false, called: false, applied: false },
    { ...base, updatedAt: "2026-10-02T00:00:00.000Z", role: "later", suggested: false, listed: true, informed: false, read: true, called: false, applied: false },
    { ...base, skill: "b", suggested: false, listed: false, informed: false, read: false, called: true, applied: false },
  ]);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].role, "later", "the newest row carries the session facts");
  assert.deepEqual(
    folded[0].skills.map((legs) => [legs.skill, legs.suggested, legs.listed, legs.read, legs.called]),
    [
      ["a", true, true, true, false],
      ["b", false, false, false, true],
    ],
  );
  assert.deepEqual(foldObligationRecords([]), []);
});

await test("the reader keeps the two records' vocabularies apart", () => {
  const row = rowsFor("sess-applied")[0];
  assert.ok(row, "a row exists to inspect");
  assert.equal("applicability" in row, false, "the applicability verdict class is not restated here");
  assert.equal("evidence" in row, false);
  assert.deepEqual(
    Object.keys(row).sort(),
    ["applied", "called", "informed", "kind", "listed", "month", "read", "role", "sessionId", "skill", "suggested", "updatedAt"],
    "the offered surfaces, the call facts, and the session identity - nothing else",
  );
});

// ── 4. the session boolean and the two rates ───────────────────────────────

await test("obligationSatisfied: read is the obligation, and a declared family sharpens it", () => {
  assert.equal(obligationSatisfied(legs("s", { read: true })), true, "no family: reading is enough");
  assert.equal(obligationSatisfied(legs("s", { read: true, called: true, applied: true })), true);
  assert.equal(obligationSatisfied(legs("s", { read: true, called: true })), false, "called before read");
  assert.equal(obligationSatisfied(legs("s", { called: true })), false, "never read");
  assert.equal(obligationSatisfied(legs("s", {})), false);
});

await test("an applicable skill with no leg row is still judged: the ignored population counts", () => {
  const judgement = judgeSessionObligations(applicable("s", ["owed", "paid"]), {
    sessionId: "s",
    role: "tester",
    month: "2026-10",
    updatedAt: "2026-10-29T00:00:00.000Z",
    skills: [legs("paid", { read: true })],
  });
  assert.equal(judgement.obligations, 2);
  assert.equal(judgement.allSatisfied, false);
  assert.deepEqual(
    judgement.skills.map((row) => [row.skill, row.satisfied]).sort(),
    [
      ["owed", false],
      ["paid", true],
    ],
    "a skill nobody recorded is unsatisfied, not absent from the denominator",
  );
});

await test("a leg whose condition never held is not an obligation", () => {
  const judgement = judgeSessionObligations(applicable("s", ["owed"]), {
    sessionId: "s",
    role: "tester",
    month: "2026-10",
    updatedAt: "2026-10-29T00:00:00.000Z",
    skills: [legs("owed", { read: true }), legs("extra", { listed: true })],
  });
  assert.equal(judgement.obligations, 1);
  assert.equal(judgement.allSatisfied, true);
  assert.equal(judgement.skills.find((row) => row.skill === "extra").satisfied, null);
});

/** An obligation fold shaped as the writer leaves it. */
const obligationRecord = (sessionId, skills) => ({
  sessionId,
  role: "tester",
  month: "2026-10",
  updatedAt: "2026-10-29T00:00:00.000Z",
  skills,
});

await test("the two rates share one denominator, and the falsifier reads the gap", () => {
  const rate = computeObligationRate(
    ["r1", "r2", "r3", "r4"].map((id) => applicable(id, ["a"])),
    [
      obligationRecord("r1", [legs("a", { read: true, called: true, applied: true })]),
      obligationRecord("r2", [legs("a", { read: true })]),
      obligationRecord("r3", [legs("a", { read: true, listed: true })]),
      // Called before the read: read and called are both true, applied is not.
      obligationRecord("r4", [legs("a", { read: true, called: true })]),
    ],
  );
  assert.equal(rate.sessions, 4, "sessions with an obligation that applied");
  assert.equal(rate.allSatisfied, 3);
  assert.equal(rate.allSatisfiedRate, 0.75);
  assert.equal(rate.withRead, 4, "the same four sessions, read anywhere in them");
  assert.equal(rate.readRate, 1);
  assert.equal(rate.gapPoints, -25, "percentage points, signed");
  assert.equal(rate.obligations, 4);
  assert.equal(rate.unsatisfied, 1);
  assert.equal(rate.discriminating, true);
  assert.equal(rate.uninstrumented, 0);
  assert.equal(FALSIFIER_GAP_POINTS, 5);
});

await test("a gap under five points makes the metric a copy of the read rate", () => {
  // Eight sessions read and satisfied, two with no read at all: the two rates
  // land on the same number, which is the design's stated reason to delete it.
  const sessions = Array.from({ length: 10 }, (_, i) => applicable(`t${i}`, ["a"]));
  const obligations = Array.from({ length: 10 }, (_, i) =>
    obligationRecord(`t${i}`, [legs("a", { read: i < 8 })]),
  );
  const rate = computeObligationRate(sessions, obligations);
  assert.equal(rate.allSatisfiedRate, 0.8);
  assert.equal(rate.readRate, 0.8);
  assert.equal(rate.gapPoints, 0);
  assert.equal(rate.discriminating, false, "within five points is a duplicate, not a finding");
});

await test("a session with no leg row is counted, not scored", () => {
  const rate = computeObligationRate(
    [applicable("u1", ["a"]), applicable("u2", ["a"])],
    [obligationRecord("u2", [legs("a", { read: true })])],
  );
  assert.equal(rate.sessions, 1);
  assert.equal(rate.uninstrumented, 1, "a zero the instrument did not observe is not a zero it found");
  assert.equal(rate.allSatisfiedRate, 1);
  assert.deepEqual(computeObligationRate([], []), {
    sessions: 0,
    allSatisfied: 0,
    allSatisfiedRate: 0,
    withRead: 0,
    readRate: 0,
    gapPoints: 0,
    obligations: 0,
    unsatisfied: 0,
    discriminating: false,
    uninstrumented: 0,
  });
});

await test("a store with no obligation row reports no rate at all", () => {
  const empty = join(FAKE_HOME, "empty-sessions.jsonl");
  assert.equal(getObligationRate({ storePath: empty }), undefined);
  // The store this file wrote carries rows, so the rate exists there.
  const rate = getObligationRate();
  assert.ok(rate, "a store with rows reports the rate");
  assert.equal(
    rate.sessions,
    0,
    "these rows name skills but no session's condition held, so the population is empty and the denominators say so",
  );
});

// ── 5. the reader is additive ──────────────────────────────────────────────

await test("skill_stats gains the obligation keys, and changes none of the ones it had", async () => {
  const { default: skillsToolExtension } =
    await import("../../../dist/extensions/core/skills-tool/index.js?obligation-stats");
  const pi = fakePi();
  skillsToolExtension(pi);
  const def = pi.tools.find((t) => t.name === "skill_stats");
  assert.ok(def, "skill_stats tool registered");
  const ctx = fakeCtx("sess-stats-obligation");
  // The rate block is store-wide, so the store must hold no obligation row for
  // this test to see what a reader saw before the leg existed.
  rmSync(SESSIONS_FILE, { force: true });
  recordApplicabilityVerdict(ctx, {
    skill: "owed-skill",
    applicability: "ignored",
    evidence: [{ phrase: "owed attestation", source: "frontmatter" }],
  });

  const capture = async () => (await def.execute("id", {}, undefined, undefined, ctx)).content[0].text;
  const before = await capture();
  const beforeObj = JSON.parse(before);
  assert.equal("obligations" in beforeObj, false, "no leg row, no key");
  assert.equal("obligationRate" in beforeObj, false, "no leg row, no rate");
  assert.equal(await capture(), before, "the payload is deterministic for one store state");

  recordObligationLegs(ctx, legs("owed-skill", { listed: true }));
  const afterObj = JSON.parse(await capture());
  assert.deepEqual(
    Object.keys(afterObj).filter((key) => !(key in beforeObj)),
    ["obligations", "obligationRate"],
    "exactly the two new keys",
  );
  for (const key of Object.keys(beforeObj)) {
    assert.deepEqual(afterObj[key], beforeObj[key], `pre-existing key ${key} is unchanged`);
  }
  assert.equal(afterObj.obligations.allSatisfied, false, "the session owed a read and did not take it");
  assert.equal(afterObj.obligations.obligations, 1);
  assert.equal(afterObj.obligationRate.sessions >= 1, true);
  assert.equal(
    typeof afterObj.obligationRate.allSatisfiedRate,
    "number",
    "the rate is reported beside the read rate, not instead of it",
  );
});

// ── the produced store, stated ─────────────────────────────────────────────

await test("the file this test wrote is a JSONL store of two kinds, and reads back", () => {
  const lines = readFileSync(SESSIONS_FILE, "utf-8").split("\n").filter((line) => line.trim());
  const kinds = new Set(lines.map((line) => JSON.parse(line).kind ?? "adoption"));
  assert.ok(kinds.has("obligation"), "obligation rows landed");
  assert.ok(lines.every((line) => typeof JSON.parse(line).sessionId === "string"), "every row is a session row");
  assert.equal(readObligationRecords(SESSIONS_FILE).length > 0, true);
});
