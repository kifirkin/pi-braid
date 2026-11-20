/**
 * Test: skills-tool/auto-inject.ts — what a compaction does with a lost body.
 *
 * Contract: the harness has the file in hand, so it puts the body back instead
 * of asking for a re-read. A body that fits the delivery cap arrives whole; a
 * body past it is NAMED rather than cut, because a truncated skill file is a
 * paraphrase with extra steps. The two outcomes are counted apart, so a reader
 * can tell a rescue from a summons.
 *
 * Behaviors pinned here:
 *   (a) a body the session read, absent from the model's active context after a
 *       compaction → exactly one message carrying the body whole, and the
 *       skill's `returned` counter moves by one while `reloads` stays put;
 *   (a2) a body past the delivery cap → the pointer line instead, `reloads`
 *       moves and `returned` does not, so the cap is visible in the counters;
 *   (b) the same read, body still in the active context → zero messages,
 *       counters unchanged;
 *   (c) a second compaction with the body still absent → still exactly one
 *       message for that skill, no second count;
 *   (d) a skill whose body never landed → zero messages on any compaction;
 *   (e) the counter is durable: the usage store on disk carries it, a fresh
 *       process reads the same value back, and `skill_stats` reports the field
 *       both per skill and in the totals;
 *   (f) sensitivity: a fresh session delivers, so (b) and (d) measure refusals
 *       and not a dead channel;
 *   (g) the presence check stands on the body head, not on the raw file.
 *
 * The presence check is the thing under test, so the two context shapes below
 * are the whole difference between (a) and (b): the same read, the same
 * compaction event, one projection that carries the body and one that does not.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports, so the
 * real agent tree is never touched. Legs (c) and (e) read state an earlier leg
 * wrote, and a file's top-level tests run one at a time in the order they are
 * declared.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "skill-reload-"));
process.env.HOME = FAKE_HOME;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const AUTO_INJECT = join(ROOT, "dist", "extensions", "core", "skills-tool", "auto-inject.js");

const { registerAutoInject, formatReloadPayload, bodySignature, FULL_BODY_MAX_CHARS } =
  await import(AUTO_INJECT);
const skillsTool = await import(join(ROOT, "dist", "extensions", "core", "skills-tool", "index.js"));
const { clearAllBuckets } = await import(join(ROOT, "dist", "lib", "utils", "injection-tracker.js"));
const { beginTurn } = await import(join(ROOT, "dist", "lib", "enforcement", "turn-dedup.js"));
const { getSkillsUsageFilePath } = await import(
  join(ROOT, "dist", "lib", "config", "braid-paths.js")
);

after(() => {
  try {
    rmSync(FAKE_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ── harness ─────────────────────────────────────────────────────────────────

const WORKSPACE = join(FAKE_HOME, "ws");
const SKILLS_DIR = join(WORKSPACE, "skills");
const STORE = getSkillsUsageFilePath();

/** Minimal ExtensionAPI double: captures handlers, delivered messages, tools. */
function fakePi() {
  const handlers = {};
  const sent = [];
  const tools = new Map();
  return {
    handlers,
    sent,
    tools,
    on: (event, handler) => {
      handlers[event] = handler;
    },
    sendMessage: (params, options) => {
      sent.push({ params, options });
    },
    registerTool: (definition) => {
      tools.set(definition.name, definition);
    },
    getAllTools: () => [{ name: "read" }, { name: "list_skills" }],
    appendEntry: () => {},
  };
}

/**
 * A skill on disk plus the read result that loads it. The body is longer than
 * the signature window and unique per skill, so a projection that carries one
 * skill's body cannot satisfy another's check.
 */
function writeSkill(name, bodyOverride) {
  const filePath = join(SKILLS_DIR, name, "SKILL.md");
  const body =
    bodyOverride ??
    `# ${name} protocol\n\n` +
      `The ${name} procedure: read this body before acting, because the ${name} ` +
      `rules are the only place the ${name} contract is written down and a seat ` +
      `that acts from memory is a seat that acts on a different contract.\n`;
  const content = `---\nname: ${name}\ndescription: "the ${name} protocol"\n---\n\n${body}`;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf-8");
  return { name, filePath, content, body };
}

/** The read tool result that loads a skill body. */
function readResult(skill) {
  return {
    toolName: "read",
    isError: false,
    input: { path: skill.filePath },
    content: [{ text: skill.content }],
  };
}

/**
 * A context whose model-visible projection is exactly `messages`: the same
 * surface pi feeds the model, after compaction and context edits.
 */
function ctxFor(sessionId, messages) {
  return {
    cwd: WORKSPACE,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(FAKE_HOME, "sessions", `${sessionId}.jsonl`),
      buildSessionProjection: () => ({ messages, entries: [] }),
      getEntries: () => [],
    },
  };
}

/** The projection that keeps the loaded body in context. */
const contextWith = (skill) => [
  { role: "system", content: "compaction summary: the session continued." },
  { role: "toolResult", content: [{ type: "tool_use_id" }, { type: "text", text: skill.content }] },
];

/** The projection that no longer carries the body. */
const contextWithout = () => [
  { role: "system", content: "compaction summary: the skill bodies read earlier were summarized." },
];

/** Simulate a real turn boundary plus fresh cross-call (reprime) state. */
function newTurn() {
  beginTurn();
  clearAllBuckets();
}

/** Every delivery about one skill, whichever outcome it carries. */
const skillDeliveries = (pi, name) =>
  pi.sent.filter(
    (m) => m.params.customType === "skills-reload" && m.params.details?.skill === name,
  );

/** The deliveries that only point at the file: the cap and vanished-file outcome. */
const pointerLines = (pi, name) =>
  skillDeliveries(pi, name).filter((m) => m.params.details?.returned !== true);

/** The deliveries that carry the body itself. */
const returnedBodies = (pi, name) =>
  skillDeliveries(pi, name).filter((m) => m.params.details?.returned === true);

/** What the durable store on disk says about one skill. */
function storedRow(name) {
  try {
    return JSON.parse(readFileSync(STORE, "utf-8"))[name];
  } catch {
    return undefined;
  }
}

/** The skill_stats reply, text payload and details block. */
async function statsFor(ctx, pi) {
  const definition = pi.tools.get("skill_stats");
  assert.ok(definition, "skill_stats is registered");
  const reply = await definition.execute("stats", {}, undefined, undefined, ctx);
  return { text: JSON.parse(reply.content[0].text), details: reply.details };
}

// ── (a) a body the compaction took away gets one line, and one count ────────

test("(a) read + compaction without the body → the body returns whole", async () => {
  const skill = writeSkill("alpha");
  const pi = fakePi();
  registerAutoInject(pi);

  newTurn();
  pi.handlers.tool_result(readResult(skill), ctxFor("reload-a", []));

  newTurn();
  pi.handlers.session_compact({ reason: "manual" }, ctxFor("reload-a", contextWithout()));

  assert.equal(skillDeliveries(pi, "alpha").length, 1, "exactly one delivery for alpha");
  const { params, options } = returnedBodies(pi, "alpha")[0];
  const text = params.content.map((c) => c.text ?? "").join("\n");
  assert.ok(text.includes(skill.body.trim()), "the body is returned, not summarized");
  assert.ok(text.includes(skill.filePath), "the message names the file the body came from");
  assert.equal(
    pointerLines(pi, "alpha").length,
    0,
    "a returned body is not also a re-read line: one loss, one delivery",
  );
  assert.ok(text.includes("[braid-whisper - skills-auto-inject"), "tracked whisper envelope");
  assert.equal(params.customType, "skills-reload");
  assert.equal(params.details._braidInjected, true);
  assert.equal(params.details._braidSource, "skills-auto-inject");
  assert.equal(params.details.returned, true, "the delivery is marked as a return");
  assert.equal(options.deliverAs, "steer");
  assert.equal(options.triggerTurn, false);
  assert.equal(storedRow("alpha")?.reloads, 0, "the durable reload counter did not move");
});

// ── (a2) a body past the cap is named, never cut ──────────────────────────

test("(a2) a body past the delivery cap → the pointer line, counted reloads", () => {
  // The cap is the delivery budget, not a rewrite budget: a body it cannot
  // carry whole is named, and the reader decides whether to spend the turn.
  const skill = writeSkill("omega", "omega rule line\n".repeat(Math.ceil(FULL_BODY_MAX_CHARS / 10)));
  assert.ok(skill.body.length > FULL_BODY_MAX_CHARS, "the fixture body exceeds the cap");
  const pi = fakePi();
  registerAutoInject(pi);

  newTurn();
  pi.handlers.tool_result(readResult(skill), ctxFor("reload-a2", []));
  newTurn();
  pi.handlers.session_compact({ reason: "threshold" }, ctxFor("reload-a2", contextWithout()));

  assert.equal(skillDeliveries(pi, "omega").length, 1, "one delivery for omega");
  const { params } = pointerLines(pi, "omega")[0];
  const text = params.content.map((c) => c.text ?? "").join("\n");
  assert.ok(text.includes(formatReloadPayload("omega", skill.filePath)), "the pointer line, verbatim");
  assert.ok(!text.includes(skill.body.slice(0, 200).trim()), "no part of the body is cut into it");
  assert.ok(!formatReloadPayload("omega", skill.filePath).includes("\n"), "the pointer is one line");
  assert.equal(storedRow("omega")?.reloads, 1, "the durable reload counter moved by one");
});

// ── (b) a body still in context says nothing ────────────────────────────────

test("(b) body still in the active context → nothing sent, counters unchanged", () => {
  const skill = writeSkill("beta");
  const pi = fakePi();
  registerAutoInject(pi);

  newTurn();
  pi.handlers.tool_result(readResult(skill), ctxFor("reload-b", []));

  newTurn();
  pi.handlers.session_compact({ reason: "threshold" }, ctxFor("reload-b", contextWith(skill)));

  assert.equal(skillDeliveries(pi, "beta").length, 0, "no message while the body is present");
  assert.equal(pi.sent.length, 0, "the compaction produced no message at all");
  assert.equal(storedRow("beta")?.reloads, 0, "the counter did not move");
});

// ── (c) one line per skill per session, however many compactions ────────────

test("(c) second compaction, body still absent → no second delivery, no second count", () => {
  const pi = fakePi();
  registerAutoInject(pi);

  newTurn();
  pi.handlers.session_compact({ reason: "threshold" }, ctxFor("reload-a", contextWithout()));

  assert.equal(skillDeliveries(pi, "alpha").length, 0, "one delivery per skill per session");
  assert.equal(storedRow("alpha")?.reloads, 0, "the reload counter never moved at all");
});

// ── (d) a skill that never landed has nothing to lose ──────────────────────

test("(d) skill never read → compaction says nothing about it", () => {
  writeSkill("gamma");
  const pi = fakePi();
  registerAutoInject(pi);

  newTurn();
  pi.handlers.session_compact({ reason: "manual" }, ctxFor("reload-d", contextWithout()));

  assert.equal(skillDeliveries(pi, "gamma").length, 0, "no body landed, so nothing is sent");
  assert.equal(pi.sent.length, 0, "nothing was sent");
  assert.equal(storedRow("gamma"), undefined, "no counter row");
});

// ── (e) the counter is durable and reported ─────────────────────────────────

test("(e) usage store carries reloads, a fresh process reads it, skill_stats shows it", async () => {
  const row = storedRow("omega");
  assert.ok(row, "the skill has a durable row");
  assert.equal(row.reloads, 1, "the store file carries the count");

  const probe = [
    `const { getDurableSkillStats } = await import(${JSON.stringify(AUTO_INJECT)});`,
    `console.log(JSON.stringify(getDurableSkillStats()["omega"]?.reloads ?? null));`,
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    env: process.env,
    encoding: "utf-8",
  });
  assert.equal(child.status, 0, `fresh process reads the store (stderr: ${child.stderr})`);
  assert.equal(child.stdout.trim(), "1", "the value survives a process restart");

  const pi = fakePi();
  skillsTool.default(pi);
  const stats = await statsFor(ctxFor("reload-e", []), pi);
  assert.equal(stats.text.allTime.omega.reloads, 1, "skill_stats reports it per skill");
  assert.equal(stats.text.allTimeTotals.reloads, 1, "and in the totals");
  assert.equal(stats.details.allTimeTotals.reloads, 1, "the details block agrees");
});

// ── (f) sensitivity: the channel still delivers for a new session ──────────

test("(f) sensitivity: a fresh session's compaction still delivers", () => {
  const skill = writeSkill("delta");
  const pi = fakePi();
  registerAutoInject(pi);

  newTurn();
  pi.handlers.tool_result(readResult(skill), ctxFor("reload-f", []));
  newTurn();
  pi.handlers.session_compact({ reason: "overflow" }, ctxFor("reload-f", contextWithout()));

  assert.equal(skillDeliveries(pi, "delta").length, 1, "the pipeline delivers for a new session");
  assert.equal(returnedBodies(pi, "delta").length, 1, "and it delivers the body itself");
});

// ── (g) the signature the check stands on ──────────────────────────────────

test("(g) the signature is the body head, whitespace-flattened", () => {
  const skill = writeSkill("epsilon");
  const signature = bodySignature(skill.body);
  assert.equal(signature, skill.body.replace(/\s+/g, " ").trim().slice(0, 120));
  assert.ok(signature.startsWith("# epsilon protocol"), "frontmatter is not part of a body");
  assert.ok(signature.length > 40, "long enough to identify the body");
});
