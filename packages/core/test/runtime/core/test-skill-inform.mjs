/**
 * inform at use - the timed alternative to a refused call.
 *
 * Pins six contracts:
 *
 * 1. The policy. `braid.skills.inform` resolves to "off" (default) or
 *    "inform"; an unknown or malformed value falls back to "off", because a
 *    typo must never turn a whisper on.
 * 2. The trigger. A COMPLETED (`isError` false) tool_result whose tool name
 *    yields a family token some visible cached skill declares with `governs:`,
 *    and whose obligation record carries no `read` leg, emits exactly one
 *    line. A failed call, another family, a hidden (explicit-invocation-only)
 *    skill, and a skill the session's catalogue does not carry emit nothing.
 * 3. The payload. The file path and the family, both derivable from the
 *    declaration and the catalogue entry: no skill name invented in code, no
 *    tool argument echoed. Shown for two different skills.
 * 4. Once. The suppression is the obligation record's own `informed` leg, and
 *    a read at any point silences the line. A second call in the family writes
 *    nothing and sends nothing.
 * 5. Observation, not enforcement. The handler returns undefined, the tool
 *    result is byte-identical after the handler ran, and the line travels on
 *    the park/steer path. Nothing here can refuse, delay or rewrite a call.
 * 6. The counters and the falsifier. `computeInformRate` reports informs and
 *    read-followed pairs per skill and in total, the channel arm from the same
 *    fold (or the published 18.8% until the store carries suggested pairs),
 *    and the pre-registered verdict: undecided below 20 informs, beats only
 *    when the lower Wilson bound clears the channel, noise otherwise.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports, so the
 * real agent tree is never read or written.
 *
 * Run: npm test -w packages/core
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Isolate braid storage: temp home. MUST precede dist imports.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "skill-inform-test-"));
process.env.HOME = FAKE_HOME;

const { getSkillsSessionsFilePath } = await import("../../../dist/lib/config/braid-paths.js");
const { getSettingsPath } = await import("../../../dist/lib/config/per-tool-settings.js");
const { resolveSkillsInformMode, SKILLS_INFORM_DEFAULT } = await import(
  "../../../dist/lib/config/braid-settings.js"
);
const { registerAutoInject, updateSkillCache, formatInformPayload } = await import(
  "../../../dist/extensions/core/skills-tool/auto-inject.js"
);
const { readGovernedFamilies } = await import(
  "../../../dist/extensions/core/skills-tool/skill-families.js"
);
const {
  readObligationRecords,
  foldObligationRecords,
  recordObligationLegs,
  computeInformRate,
  getInformRate,
  wilsonInterval,
  INFORM_DECISION_MIN_PAIRS,
  CHANNEL_PUBLISHED_CONVERSION,
} = await import("../../../dist/extensions/core/skills-tool/session-records.js");

const SESSIONS_FILE = getSkillsSessionsFilePath();
const SETTINGS_FILE = getSettingsPath();

/** Write settings.json into the fake home (the reader takes no path seam). */
function writeSettings(braid) {
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(braid === undefined ? {} : { braid }), "utf-8");
}

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

/** A real skill file on disk, so the declaration reader has a file to read. */
function skillFixture(tag, name, { governs = [], hidden = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `inform-${tag}-`));
  mkdirSync(join(dir, name), { recursive: true });
  const file = join(dir, name, "SKILL.md");
  const declared = governs.length
    ? `governs:\n${governs.map((family) => `  - ${family}`).join("\n")}\n`
    : "";
  writeFileSync(
    file,
    `---\nname: ${name}\ndescription: ${name} fixture body\n${declared}---\n\nbody\n`,
    "utf-8",
  );
  const cached = {
    name,
    filePath: file,
    description: `${name} fixture body`,
    baseDir: dir,
    triggers: [],
    triggerSources: {},
    families: readGovernedFamilies(file),
  };
  if (hidden) cached.disableModelInvocation = true;
  return { dir, file, cached };
}

/** Drive one finished tool call through the tool_result path. */
function callTool(pi, ctx, toolName, { isError = false, input = { path: "/tmp/whatever" } } = {}) {
  return pi.handlers.tool_result(
    { toolName, isError, input, content: [{ type: "text", text: "ok" }] },
    ctx,
  );
}

/** Drive a detected read of a fixture's body through the same path. */
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

const legsFor = (sessionId, skill) => {
  const rows = readObligationRecords(SESSIONS_FILE).filter(
    (row) => row.sessionId === sessionId && row.skill === skill,
  );
  return foldObligationRecords(rows)[0]?.skills.find((row) => row.skill === skill);
};

// 1. The policy

await test("braid.skills.inform resolves off by default and refuses a typo", () => {
  assert.equal(SKILLS_INFORM_DEFAULT, "off");
  assert.equal(resolveSkillsInformMode(undefined), "off");
  assert.equal(resolveSkillsInformMode(""), "off");
  assert.equal(resolveSkillsInformMode("inform"), "inform");
  assert.equal(resolveSkillsInformMode("  INFORM "), "inform");
  assert.equal(resolveSkillsInformMode("on"), "off");
  assert.equal(resolveSkillsInformMode("block"), "off");
  assert.equal(resolveSkillsInformMode(1), "off");
});

// 2. The default: nothing is spoken, nothing is written

await test("inform off (default) emits nothing and writes no informed leg", () => {
  writeSettings({});
  const alpha = skillFixture("alpha", "alpha-skill", { governs: ["widget"] });
  updateSkillCache([alpha.cached]);
  const pi = fakePi();
  registerAutoInject(pi);
  const ctx = fakeCtx("inform-off-session");

  callTool(pi, ctx, "widget_open");

  assert.equal(pi.sent.length, 0, "no whisper with the policy off");
  const legs = legsFor("inform-off-session", "alpha-skill");
  assert.ok(legs, "the applied leg is still recorded with the line off");
  assert.equal(legs.called, true);
  assert.equal(legs.informed, false, "no informed leg was written");
  assert.equal(getInformRate(), undefined, "no inform row, so no inform payload");
});

// 3. The trigger and the payload

await test("a completed call in a governed family emits one line naming the file and the family", () => {
  writeSettings({ skills: { inform: "inform" } });
  const beta = skillFixture("beta", "beta-skill", { governs: ["widget"] });
  const gamma = skillFixture("gamma", "gamma-skill", { governs: ["ledger", "widget"] });
  updateSkillCache([beta.cached, gamma.cached]);
  const pi = fakePi();
  registerAutoInject(pi);
  const ctx = fakeCtx("inform-on-session");

  callTool(pi, ctx, "widget_open");

  assert.equal(pi.sent.length, 2, "both installed skills declare the family");
  const texts = pi.sent.map((entry) => entry.params.content[0].text);
  const betaPayload = formatInformPayload(beta.file, "widget");
  assert.ok(texts[0].includes(betaPayload), "the line carries the payload verbatim");
  assert.ok(texts[0].startsWith("[braid-whisper - "), "the universal envelope, not a bare message");
  assert.ok(texts[0].endsWith(betaPayload), "the payload is the whole body");
  assert.ok(texts[1].endsWith(formatInformPayload(gamma.file, "widget")), "second skill, same shape");
  assert.ok(texts[1].includes(gamma.file), "the second payload names the other file");
  for (const entry of pi.sent) {
    assert.equal(entry.params.customType, "skills-inform");
    assert.equal(entry.options.deliverAs, "steer", "a steer, never a wake or a block");
    assert.equal(entry.options.triggerTurn, false, "the park class: no run is started");
    assert.equal(entry.params.details.family, "widget");
  }
  // Neither payload carries a tool argument or an invented skill name.
  for (const text of texts) {
    assert.ok(!text.includes("/tmp/whatever"), "no tool argument is echoed");
    assert.ok(!text.includes("alpha-skill"), "no other skill is named");
  }

  const betaLegs = legsFor("inform-on-session", "beta-skill");
  assert.equal(betaLegs.informed, true);
  assert.equal(betaLegs.read, false);
  assert.equal(betaLegs.called, true);
});

await test("the payload for two different skills differs only in the file it names", () => {
  const one = skillFixture("payload-one", "payload-one", { governs: ["toolbox"] });
  const two = skillFixture("payload-two", "payload-two", { governs: ["toolbox"] });
  const first = formatInformPayload(one.file, "toolbox");
  const second = formatInformPayload(two.file, "toolbox");
  assert.notEqual(first, second);
  assert.equal(first.split(one.file).length, 2, "the path appears exactly once");
  assert.equal(
    first.replace(one.file, "<file>"),
    second.replace(two.file, "<file>"),
    "the template is the declaration, not the skill",
  );
});

// 4. Once, and the read that silences it

await test("a second call in the family sends nothing and writes nothing", () => {
  const countSession = "inform-once-session";
  const delta = skillFixture("delta", "delta-skill", { governs: ["widget"] });
  updateSkillCache([delta.cached]);
  const pi = fakePi();
  registerAutoInject(pi);
  const ctx = fakeCtx(countSession);

  callTool(pi, ctx, "widget_open");
  assert.equal(pi.sent.length, 1, "first call informs");
  const afterFirst = readObligationRecords(SESSIONS_FILE).filter(
    (row) => row.sessionId === countSession,
  ).length;

  callTool(pi, ctx, "widget_probe");
  assert.equal(pi.sent.length, 1, "second call is silent");
  const afterSecond = readObligationRecords(SESSIONS_FILE).filter(
    (row) => row.sessionId === countSession,
  ).length;
  assert.equal(afterSecond, afterFirst, "no second row was appended");
});

await test("a read before the call silences the line; a read after it counts as conversion", () => {
  const readFirst = skillFixture("read-first", "read-first-skill", { governs: ["widget"] });
  updateSkillCache([readFirst.cached]);
  let pi = fakePi();
  registerAutoInject(pi);
  let ctx = fakeCtx("inform-read-first");
  readFixture(pi, ctx, readFirst);
  callTool(pi, ctx, "widget_open");
  assert.equal(pi.sent.length, 0, "the body is already in context");

  const readAfter = skillFixture("read-after", "read-after-skill", { governs: ["widget"] });
  updateSkillCache([readAfter.cached]);
  pi = fakePi();
  registerAutoInject(pi);
  ctx = fakeCtx("inform-read-after");
  callTool(pi, ctx, "widget_open");
  assert.equal(pi.sent.length, 1, "the call informs first");
  readFixture(pi, ctx, readAfter);
  const legs = legsFor("inform-read-after", "read-after-skill");
  assert.equal(legs.informed, true);
  assert.equal(legs.read, true, "both legs land on one row set");
  callTool(pi, ctx, "widget_probe");
  assert.equal(pi.sent.length, 1, "the read keeps the later call silent");
});

// 5. Observation, not enforcement

await test("a failed call records the applied leg and emits no line", () => {
  writeSettings({ skills: { inform: "inform" } });
  const epsilon = skillFixture("epsilon", "epsilon-skill", { governs: ["widget"] });
  updateSkillCache([epsilon.cached]);
  const pi = fakePi();
  registerAutoInject(pi);
  const ctx = fakeCtx("inform-error-session");
  callTool(pi, ctx, "widget_open", { isError: true });
  assert.equal(pi.sent.length, 0, "a call that did not run is not described as one");
  const legs = legsFor("inform-error-session", "epsilon-skill");
  assert.equal(legs.called, true, "the applied leg still counts a failed call");
  assert.equal(legs.informed, false);
});

await test("the handler returns nothing and the tool result is unchanged", () => {
  const zeta = skillFixture("zeta", "zeta-skill", { governs: ["widget"] });
  updateSkillCache([zeta.cached]);
  const pi = fakePi();
  registerAutoInject(pi);
  const ctx = fakeCtx("inform-observation-session");
  const event = {
    toolName: "widget_open",
    isError: false,
    input: { path: "/tmp/whatever" },
    content: [{ type: "text", text: "result text" }],
  };
  const before = JSON.parse(JSON.stringify(event));
  const returned = pi.handlers.tool_result(event, ctx);
  assert.equal(returned, undefined, "no patch, no replacement result");
  assert.deepEqual(event, before, "the event is byte-identical after the handler");
  assert.equal(pi.sent.length, 1, "the line still went out");
});

// 6. The boundary of the trigger

await test("another family, a hidden skill, and an uncatalogued file all emit nothing", () => {
  const eta = skillFixture("eta", "eta-skill", { governs: ["widget"] });
  const theta = skillFixture("theta", "theta-skill", { governs: ["widget"], hidden: true });
  const iota = skillFixture("iota", "iota-skill", { governs: ["widget"] });
  updateSkillCache([eta.cached, theta.cached]);
  const pi = fakePi();
  registerAutoInject(pi);
  const ctx = fakeCtx("inform-boundary-session");

  callTool(pi, ctx, "ledger_append");
  assert.equal(pi.sent.length, 0, "a family no installed file declares");

  callTool(pi, ctx, "widget_open");
  assert.equal(pi.sent.length, 1, "only the visible skill with the family");

  // The file on disk declares the family, but the session's catalogue does not
  // carry it: the path the payload needs does not exist here, so the line does
  // not invent one.
  const uncataloguedBefore = pi.sent.length;
  updateSkillCache([eta.cached, theta.cached]);
  callTool(pi, ctx, "widget_probe");
  assert.equal(pi.sent.length, uncataloguedBefore, "iota's declaration is not in the catalogue");

  // Install it: the same call now fires, which proves the trigger works and
  // that the catalogue entry was the only missing input.
  updateSkillCache([eta.cached, theta.cached, iota.cached]);
  callTool(pi, ctx, "widget_probe");
  assert.equal(pi.sent.length, uncataloguedBefore + 1, "catalogued, the same call informs");
});

// 7. The counters and the pre-registered verdict

await test("wilsonInterval brackets the published channel figure", () => {
  const interval = wilsonInterval(95, 506);
  assert.ok(Math.abs(interval.lower - 0.156) < 0.001, `lower ${interval.lower}`);
  assert.ok(Math.abs(interval.upper - 0.224) < 0.001, `upper ${interval.upper}`);
  assert.deepEqual(wilsonInterval(0, 0), { lower: 0, upper: 0 });
});

await test("computeInformRate reports per skill, total, and the channel arm from one fold", () => {
  const session = (id, skills) => ({
    sessionId: id,
    role: "neutral",
    month: "2026-10",
    updatedAt: "2026-10-30T00:00:00.000Z",
    skills,
  });
  const legs = (skill, over) => ({
    skill,
    suggested: false,
    listed: false,
    informed: false,
    read: false,
    called: false,
    applied: false,
    ...over,
  });
  const folds = [
    session("s1", [legs("a", { informed: true, called: true }), legs("b", { informed: true, read: true })]),
    session("s2", [legs("a", { informed: true, read: true })]),
    session("s3", [legs("c", { suggested: true, read: true })]),
    session("s4", [legs("c", { suggested: true })]),
  ];

  const rate = computeInformRate(folds);
  assert.equal(rate.informs, 3);
  assert.equal(rate.readFollowed, 2);
  assert.equal(rate.conversion, 0.6667);
  assert.deepEqual(
    rate.skills.map((row) => [row.skill, row.informs, row.readFollowed]),
    [
      ["a", 2, 1],
      ["b", 1, 1],
    ],
  );
  // Two suggested pairs are a sample, not a baseline: the arm stays published.
  assert.equal(rate.channel.pairs, 2);
  assert.equal(rate.channel.source, "published");
  assert.equal(rate.channel.conversion, CHANNEL_PUBLISHED_CONVERSION);
  assert.equal(rate.decidable, false, `${INFORM_DECISION_MIN_PAIRS} informs are the floor`);
  assert.equal(rate.verdict, "undecided");

  // At the floor the store answers for itself: 5 of 20 suggested pairs read.
  const storeArm = computeInformRate([
    session(
      "s5",
      Array.from({ length: INFORM_DECISION_MIN_PAIRS }, (_, i) =>
        legs(`c${i}`, { suggested: true, read: i < 5 }),
      ),
    ),
  ]);
  assert.equal(storeArm.channel.source, "store");
  assert.equal(storeArm.channel.pairs, INFORM_DECISION_MIN_PAIRS);
  assert.equal(storeArm.channel.conversion, 0.25);
});

await test("the verdict is undecided below the floor, beats when the bound clears, noise otherwise", () => {
  const pair = (informed, read, suggested = false) => ({
    skill: `k${Math.random().toString(36).slice(2, 8)}`,
    suggested,
    listed: false,
    informed,
    read,
    called: false,
    applied: false,
  });
  const session = (id, skills) => ({
    sessionId: id,
    role: "neutral",
    month: "2026-10",
    updatedAt: "2026-10-30T00:00:00.000Z",
    skills,
  });
  const build = (n, converted) => [
    session(
      "only",
      Array.from({ length: n }, (_, i) => pair(true, i < converted)),
    ),
  ];

  const short = computeInformRate(build(INFORM_DECISION_MIN_PAIRS - 1, 15));
  assert.equal(short.verdict, "undecided");
  assert.equal(short.channel.source, "published");
  assert.equal(short.channel.conversion, CHANNEL_PUBLISHED_CONVERSION);

  const beats = computeInformRate(build(INFORM_DECISION_MIN_PAIRS, 8));
  assert.equal(beats.decidable, true);
  assert.equal(beats.verdict, "beats", "8 of 20: lower bound 21.9% > 18.8%");
  assert.ok(beats.ci.lower > CHANNEL_PUBLISHED_CONVERSION);

  const noise = computeInformRate(build(INFORM_DECISION_MIN_PAIRS, 3));
  assert.equal(noise.verdict, "noise", "15% at N=20 does not beat the channel");
  assert.equal(noise.gapPoints, -3.8);
});

await test("getInformRate is the absent record until an informed leg lands", () => {
  // An isolated store, so the order of the wiring tests above cannot decide
  // what this one observes: the absent record is a property of the store.
  const storePath = join(mkdtempSync(join(tmpdir(), "inform-store-")), "sessions.jsonl");
  assert.equal(getInformRate({ storePath }), undefined, "no inform row yet");

  recordObligationLegs(
    fakeCtx("inform-rate-session"),
    { skill: "rate-skill", suggested: true, listed: false, informed: true, read: true, called: true, applied: true },
    storePath,
  );
  const after = getInformRate({ storePath });
  assert.ok(after, "one inform row is enough to report");
  assert.equal(after.informs, 1);
  assert.equal(after.readFollowed, 1);
  assert.equal(after.channel.pairs, 1);
  assert.equal(after.verdict, "undecided");
  assert.deepEqual(after.skills, [{ skill: "rate-skill", informs: 1, readFollowed: 1 }]);
});

await test("skill_stats carries the inform block only when the mode or a row asks for it", async () => {
  const { default: skillsToolExtension } = await import(
    "../../../dist/extensions/core/skills-tool/index.js"
  );
  const pi = fakePi();
  skillsToolExtension(pi);
  const def = pi.tools.find((tool) => tool.name === "skill_stats");
  assert.ok(def, "skill_stats registered");
  const read = async (sessionId) =>
    JSON.parse(
      (await def.execute("id", {}, undefined, undefined, fakeCtx(sessionId))).content[0].text,
    );

  // Start from a store with no inform row, so the three states are the mode
  // and the row, not the order the earlier cases happened to run in.
  rmSync(SESSIONS_FILE, { force: true });

  writeSettings({ skills: { inform: "off" } });
  const withoutAnything = await read("inform-stats-none");
  assert.equal(withoutAnything.inform, undefined, "mode off and no row: the block is absent");

  writeSettings({ skills: { inform: "inform" } });
  const withMode = await read("inform-stats-on");
  assert.deepEqual(withMode.inform, { mode: "inform" }, "mode on, no row: the mode alone");

  recordObligationLegs(
    fakeCtx("inform-stats-row"),
    { skill: "stats-skill", suggested: false, listed: false, informed: true, read: false, called: true, applied: false },
    SESSIONS_FILE,
  );
  writeSettings({ skills: { inform: "off" } });
  const withRow = await read("inform-stats-off");
  assert.equal(withRow.inform.mode, "off", "a store row is reported even with the mode off");
  assert.equal(withRow.inform.informs, 1);
  assert.equal(withRow.inform.verdict, "undecided");
});
