/**
 * Test: skills-tool/ranker.ts — the suggestion decision is a utility-model call.
 *
 * Contract:
 *   (a) LANGUAGE: a prompt written in Cyrillic fires a skill. The catalog is
 *       English; the answer names the skill; the whisper says so. A phrase
 *       table could not do it, which is the defect this replaced.
 *   (b) SAME PATH: an English prompt fires through the same call — the system
 *       prompt and the parse are byte-identical, so there is no language
 *       branch anywhere.
 *   (c) NO MATCHER: a prompt carrying another catalog entry's authored trigger
 *       phrases, answered with a different skill, names the answered skill and
 *       not the phrase's. A phrase matcher reachable from the whisper would
 *       fire the phrase's skill; this leg is what makes that measurable.
 *   (d) FAILURE IS SILENCE: a transport error and a missing utility model each
 *       produce zero suggestions, one recorded line naming the reason, and a
 *       `rankedFailed` increment.
 *   (e) STRICT PARSE: an answer naming an unknown skill yields no suggestion
 *       and a recorded reason; it is never repaired into the known rows.
 *   (f) ONE CALL PER TURN: two turns with the same prompt make one call and one
 *       `rankedCached`; a third prompt makes a second call.
 *   (g) DELIVERY STATE: the ranker's order is kept, the slot budget bounds the
 *       whisper, and a skill on cooldown is not re-sent.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports so the real
 * agent tree is never touched, and the model is a stub on the transport seam, so
 * no provider is contacted.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installRanker, rankerRegistry, removeUtilityModel } from "../../helpers/skill-ranker-stub.mjs";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "skill-ranker-"));
process.env.HOME = FAKE_HOME;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIST = join(ROOT, "dist");

const { registerAutoInject, filterRanked } = await import(
  join(DIST, "extensions", "core", "skills-tool", "auto-inject.js")
);
const { setCachedSkills } = await import(
  join(DIST, "extensions", "core", "skills-tool", "index.js")
);
const { getRankerStats } = await import(
  join(DIST, "extensions", "core", "skills-tool", "ranker.js")
);
const skillsToolExtension = (
  await import(join(DIST, "extensions", "core", "skills-tool", "index.js"))
).default;
const { clearLogBuffer, getLogBuffer, setGlobalLogLevel } = await import(
  join(DIST, "lib", "core", "logger.js")
);
const { clearAllBuckets } = await import(join(DIST, "lib", "utils", "injection-tracker.js"));
const { beginTurn } = await import(join(DIST, "lib", "enforcement", "turn-dedup.js"));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [fail] ${name}: ${e.message}`);
  }
}

// ── catalog ─────────────────────────────────────────────────────────────────

const SKILLS_DIR = join(FAKE_HOME, "skills");

/** Write one SKILL.md and return the cache row the extension consumes. */
function skill(name, description, body, triggers) {
  const dir = join(SKILLS_DIR, name);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "SKILL.md");
  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    ...(triggers ? [`triggers:\n${triggers.map((t) => `  - "${t}"`).join("\n")}`] : []),
    "---",
    "",
  ].join("\n");
  writeFileSync(filePath, `${frontmatter}${body}\n`, "utf-8");
  return { name, description, filePath, baseDir: SKILLS_DIR };
}

const WRITING = skill(
  "writing",
  "Rewrite prose so it reads as a person wrote it",
  "Rewrite the draft: keep the argument, replace the machine cadence.",
  ["rewrite the draft", "machine-written prose"],
);
const BOOK = skill(
  "book-craft",
  "Structure a long-form book",
  "Outline chapters, then cut the ones that repeat the argument.",
  ["outline the chapters", "structure my book"],
);

setCachedSkills([WRITING, BOOK]);

// ── harness ─────────────────────────────────────────────────────────────────

function fakePi() {
  const handlers = {};
  const sent = [];
  return {
    handlers,
    sent,
    on: (event, handler) => {
      handlers[event] = handler;
    },
    sendMessage: (params, options) => {
      sent.push({ params, options });
    },
  };
}

let sessions = 0;
function openSession() {
  const pi = fakePi();
  registerAutoInject(pi);
  const sessionId = `ranker-${++sessions}`;
  const ctx = {
    sessionManager: { getSessionId: () => sessionId },
    cwd: join(FAKE_HOME, "ws"),
    modelRegistry: rankerRegistry(),
  };
  beginTurn();
  clearAllBuckets();
  return { pi, ctx };
}

const textOf = (message) => message.params.content.map((c) => c.text ?? "").join("\n");
const suggestions = (pi) => pi.sent.filter((m) => m.params.customType === "skills-suggestion");
const notices = (pi) => pi.sent.filter((m) => m.params.customType === "skills-notice");
const namesOf = (message) => message.params.details?.skills ?? [];
const rankerLogs = () =>
  getLogBuffer().filter((entry) => entry.source === "skills-ranker" && entry.level === "info");

/** A Russian task: 53 characters, well past the short-prompt floor. */
const RU_PROMPT = "перепиши бизнес-книгу: тон машинный, добавь живые примеры из практики";
const EN_PROMPT = "rewrite the business book: the tone reads machine-written, add live examples";
const WHY = "the task asks for a prose rewrite and the book it sits in";

console.log("skill-ranker test\n");

// ── (a) a Russian prompt fires a skill ──────────────────────────────────────

await test("(a) Cyrillic prompt → the answer's skill is suggested, line quoted", async () => {
  const stub = await installRanker(DIST, () => [{ name: "writing", why: WHY }]);
  try {
    const { pi, ctx } = openSession();
    await pi.handlers.before_agent_start({ prompt: RU_PROMPT }, ctx);

    const sent = suggestions(pi);
    assert.equal(sent.length, 1, `one suggestion for a Cyrillic prompt; sent ${pi.sent.length}`);
    const text = textOf(sent[0]);
    const line = text.split("\n").find((l) => l.includes("[SKILL SUGGESTION]"));
    console.log(`  emitted: ${line}`);
    assert.ok(
      text.includes("[SKILL SUGGESTION] writing is the best match for this task"),
      `the line names the skill:\n${text.slice(0, 300)}`,
    );
    assert.ok(text.includes(WHY), "the line carries the model's clause");
    assert.deepEqual(namesOf(sent[0]), ["writing"], "the counter reads the same name");
    assert.equal(stub.calls.length, 1, "one call");
    assert.ok(
      stub.calls[0].prompt.includes(RU_PROMPT),
      "the prompt reached the model verbatim",
    );
    assert.ok(stub.calls[0].prompt.includes("writing — Rewrite prose"), "the catalog rows reached it");
  } finally {
    stub.restore();
  }
});

// ── (b) the same code path answers an English prompt ────────────────────────

await test("(b) English prompt → same call, byte-identical system prompt", async () => {
  const stub = await installRanker(DIST, () => [{ name: "writing", why: WHY }]);
  try {
    const ru = openSession();
    await ru.pi.handlers.before_agent_start({ prompt: RU_PROMPT }, ru.ctx);
    const en = openSession();
    await en.pi.handlers.before_agent_start({ prompt: EN_PROMPT }, en.ctx);

    assert.equal(suggestions(en.pi).length, 1, "one suggestion for the English prompt");
    assert.ok(
      textOf(suggestions(en.pi)[0]).includes("writing is the best match for this task"),
      "the same line shape",
    );
    assert.equal(stub.calls.length, 2, "one call per turn, two turns");
    assert.equal(
      stub.calls[0].systemPrompt,
      stub.calls[1].systemPrompt,
      "the system prompt is the same for both languages: no language branch",
    );
    assert.notEqual(stub.calls[0].prompt, stub.calls[1].prompt, "only the task text differs");
  } finally {
    stub.restore();
  }
});

// ── (c) the phrase matcher is not in the path ───────────────────────────────

await test("(c) prompt carrying another entry's phrases → the answer wins, not the phrase", async () => {
  // The prompt quotes book-craft's authored phrases word for word. A phrase
  // matcher reachable from the whisper would fire book-craft; the answer names
  // writing, and the whisper must name only that.
  const stub = await installRanker(DIST, () => [{ name: "writing", why: WHY }]);
  try {
    const { pi, ctx } = openSession();
    await pi.handlers.before_agent_start(
      {
        prompt:
          "outline the chapters and structure my book, then rewrite the draft so it reads " +
          "as machine-written prose",
      },
      ctx,
    );
    const sent = suggestions(pi);
    assert.equal(sent.length, 1, "one suggestion");
    assert.deepEqual(namesOf(sent[0]), ["writing"], "the model's answer decided, not the phrases");
    assert.ok(
      !textOf(sent[0]).includes("book-craft"),
      "the phrase's skill is not named anywhere in the message",
    );
  } finally {
    stub.restore();
  }
});

// ── (d) failure is silence with a reason ────────────────────────────────────

await test("(d1) transport error → no suggestion, one reason line, rankedFailed", async () => {
  setGlobalLogLevel("info");
  clearLogBuffer();
  const stub = await installRanker(DIST, () => ({ error: "stub cannot answer" }));
  try {
    const { pi, ctx } = openSession();
    await pi.handlers.before_agent_start({ prompt: RU_PROMPT }, ctx);

    assert.equal(suggestions(pi).length, 0, "no suggestion");
    assert.equal(notices(pi).length, 0, "no notice either: there is no phrase fallback");
    const stats = getRankerStats(ctx);
    assert.equal(stats.ranked, 1, "the call was counted");
    assert.equal(stats.rankedFailed, 1, "the failure was counted");
    assert.ok(stats.lastFailure, "the failure carries a reason");
    const reasons = rankerLogs().filter((entry) => entry.message.includes("no skill suggestion"));
    assert.equal(reasons.length, 1, `exactly one recorded reason; got ${rankerLogs().length} lines`);
    console.log(`  recorded: ${reasons[0].message}`);
    assert.ok(
      stub.calls[0].prompt.includes("book-craft"),
      "the catalog was sent, so silence is not 'nothing to rank'",
    );
  } finally {
    stub.restore();
  }
});

await test("(d2) no utility model → no suggestion, the reason names the setting", async () => {
  clearLogBuffer();
  await installRanker(DIST, () => [{ name: "writing", why: WHY }]).then((s) => s.restore());
  await removeUtilityModel(DIST);
  const { pi, ctx } = openSession();
  await pi.handlers.before_agent_start({ prompt: RU_PROMPT }, ctx);

  assert.equal(suggestions(pi).length, 0, "no suggestion without a model");
  const stats = getRankerStats(ctx);
  assert.equal(stats.rankedFailed, 1, "counted as a failure");
  assert.equal(stats.ranked, 0, "no call was made: there was nothing to call");
  assert.match(stats.lastFailure, /utility model/, "the reason names the missing setting");
  const reasons = rankerLogs().filter((entry) => entry.message.includes("no skill suggestion"));
  assert.equal(reasons.length, 1, "one recorded reason");
});

// ── (e) strict parse ────────────────────────────────────────────────────────

await test("(e) an answer naming an unknown skill yields no suggestion", async () => {
  clearLogBuffer();
  const stub = await installRanker(DIST, () => [{ name: "not-a-skill", why: WHY }]);
  try {
    const { pi, ctx } = openSession();
    await pi.handlers.before_agent_start({ prompt: RU_PROMPT }, ctx);
    assert.equal(suggestions(pi).length, 0, "nothing is suggested");
    const stats = getRankerStats(ctx);
    assert.equal(stats.rankedFailed, 1, "a failed answer");
    assert.match(stats.lastFailure, /unknown skill/, "the reason names the parse failure");
    assert.equal(rankerLogs().length, 1, "one recorded reason");
  } finally {
    stub.restore();
  }
});

// ── (f) one call per turn, and the cache ────────────────────────────────────

await test("(f) same prompt twice → one call and one rankedCached; a third prompt → a second call", async () => {
  const stub = await installRanker(DIST, () => [{ name: "writing", why: WHY }]);
  try {
    const { pi, ctx } = openSession();
    await pi.handlers.before_agent_start({ prompt: RU_PROMPT }, ctx);
    let stats = getRankerStats(ctx);
    assert.deepEqual(
      { ranked: stats.ranked, cached: stats.rankedCached, failed: stats.rankedFailed },
      { ranked: 1, cached: 0, failed: 0 },
      "first turn: one call",
    );

    beginTurn();
    clearAllBuckets();
    await pi.handlers.before_agent_start({ prompt: RU_PROMPT }, ctx);
    stats = getRankerStats(ctx);
    assert.deepEqual(
      { ranked: stats.ranked, cached: stats.rankedCached, failed: stats.rankedFailed },
      { ranked: 1, cached: 1, failed: 0 },
      "second turn, same prompt: no second call",
    );
    assert.equal(stub.calls.length, 1, "the transport saw one call");
    // The repeat still delivered nothing new: the skill is on cooldown.
    assert.equal(suggestions(pi).length, 1, "one suggestion in the session");

    beginTurn();
    clearAllBuckets();
    await pi.handlers.before_agent_start(
      { prompt: `${EN_PROMPT}, and keep the chapter order` },
      ctx,
    );
    stats = getRankerStats(ctx);
    assert.equal(stats.ranked, 2, "a different prompt is a second call");
    assert.equal(stub.calls.length, 2, "the transport saw two calls");
  } finally {
    stub.restore();
  }
});

// ── (g) delivery state ──────────────────────────────────────────────────────

await test("(g) the slot budget bounds the whisper and the order is the answer's", async () => {
  const stub = await installRanker(DIST, () => [
    { name: "writing", why: WHY },
    { name: "book-craft", why: "the task also names the book's structure" },
  ]);
  try {
    const { pi, ctx } = openSession();
    await pi.handlers.before_agent_start({ prompt: RU_PROMPT }, ctx);
    const sent = suggestions(pi);
    assert.equal(sent.length, 1, "one message");
    assert.deepEqual(namesOf(sent[0]), ["writing", "book-craft"], "both rows, in the answer's order");
  } finally {
    stub.restore();
  }

  // Three rows from the model, two slots to spend.
  const byName = new Map([WRITING, BOOK].map((s) => [s.name, s]));
  const third = skill("drafting", "Draft from notes", "Turn notes into a draft.");
  byName.set(third.name, third);
  const rows = filterRanked(
    [
      { name: "writing", why: "a" },
      { name: "book-craft", why: "b" },
      { name: "drafting", why: "c" },
    ],
    byName,
    [],
    1,
  );
  assert.deepEqual(
    rows.map((r) => r.skill.name),
    ["writing", "book-craft"],
    "at most MAX_INJECTED rows, in the answer's order",
  );
});

await test("(g2) a skill on cooldown is not re-sent; a loaded one keeps the longer cooldown", () => {
  const byName = new Map([WRITING, BOOK].map((s) => [s.name, s]));
  const entries = [
    { name: "writing", why: "a" },
    { name: "book-craft", why: "b" },
  ];
  const injected = [{ name: "writing", turnNumber: 5, filePath: WRITING.filePath }];
  const rows = filterRanked(entries, byName, injected, 6);
  assert.deepEqual(
    rows.map((r) => r.skill.name),
    ["book-craft"],
    "the injected skill is inside its floor cooldown",
  );

  // The floor expired, but the unloaded entry still holds its slot: one free
  // slot, and the skill that just left cooldown is the one it admits.
  const afterFloor = filterRanked(entries, byName, injected, 5 + 10);
  assert.deepEqual(
    afterFloor.map((r) => r.skill.name),
    ["writing"],
    "a held slot bounds the batch even after the floor expires",
  );

  const loaded = [{ name: "writing", turnNumber: 1, filePath: WRITING.filePath, loadedTurn: 5 }];
  assert.deepEqual(
    filterRanked(entries, byName, loaded, 5 + 10).map((r) => r.skill.name),
    ["book-craft"],
    "a loaded skill stays on cooldown past the floor",
  );
  const reloaded = filterRanked(entries, byName, loaded, 5 + 30);
  assert.deepEqual(
    reloaded.map((r) => r.skill.name),
    ["writing", "book-craft"],
    "and is eligible again once its own cooldown expires, its slot released by the load",
  );
});

// ── (i) the counter surface ─────────────────────────────────────────────────

await test("(i) skill_stats reports the ranker's three counters and the reason", async () => {
  const stub = await installRanker(DIST, (prompt) =>
    prompt.includes("machine-written") ? { error: "stub cannot answer" } : [{ name: "writing", why: WHY }],
  );
  try {
    const tools = new Map();
    const pi = fakePi();
    pi.registerTool = (definition) => tools.set(definition.name, definition);
    skillsToolExtension(pi);
    const ctx = {
      sessionManager: { getSessionId: () => "ranker-stats" },
      cwd: join(FAKE_HOME, "ws"),
      modelRegistry: rankerRegistry(),
    };
    beginTurn();
    clearAllBuckets();
    await pi.handlers.before_agent_start({ prompt: RU_PROMPT }, ctx);
    beginTurn();
    clearAllBuckets();
    await pi.handlers.before_agent_start({ prompt: `${EN_PROMPT}, keep the order` }, ctx);

    const definition = tools.get("skill_stats");
    assert.ok(definition, "skill_stats is registered");
    const reply = await definition.execute("stats", {}, undefined, undefined, ctx);
    const payload = JSON.parse(reply.content[0].text);
    console.log(`  skill_stats.ranker: ${JSON.stringify(payload.ranker)}`);
    assert.deepEqual(payload.ranker, {
      ranked: 2,
      rankedCached: 0,
      rankedFailed: 1,
      lastFailure: "stub cannot answer",
    });
    assert.equal(reply.details.ranker.rankedFailed, 1, "the details block agrees");
  } finally {
    stub.restore();
  }
});

// ── sensitivity ─────────────────────────────────────────────────────────────

await test("(h) sensitivity: a fresh session still suggests after every leg above", async () => {
  const stub = await installRanker(DIST, () => [{ name: "book-craft", why: "structural work" }]);
  try {
    const { pi, ctx } = openSession();
    await pi.handlers.before_agent_start({ prompt: EN_PROMPT }, ctx);
    assert.equal(suggestions(pi).length, 1, "the pipeline still delivers");
    assert.deepEqual(namesOf(suggestions(pi)[0]), ["book-craft"], "and names the answer");
  } finally {
    stub.restore();
  }
});

// ── cleanup ─────────────────────────────────────────────────────────────────

try {
  rmSync(FAKE_HOME, { recursive: true, force: true });
} catch {
  /* best-effort */
}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
