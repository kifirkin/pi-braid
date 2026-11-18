/**
 * Test: skills-tool/auto-inject.ts — the compaction reload line.
 *
 * Contract:
 *   (a) a body the session read, absent from the model's active context after a
 *       compaction → exactly one steer line naming the skill and its file, and
 *       the skill's `reloads` counter moves by one;
 *   (b) the same read, body still in the active context → zero lines, counter
 *       unchanged;
 *   (c) a second compaction with the body still absent → still exactly one line
 *       for that skill, counter still one;
 *   (d) a skill whose body never landed → zero lines on any compaction;
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

const { registerAutoInject, formatReloadPayload, bodySignature } = await import(AUTO_INJECT);
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
function writeSkill(name) {
  const filePath = join(SKILLS_DIR, name, "SKILL.md");
  const body =
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

/** The delivered reload lines naming one skill. */
const reloadLines = (pi, name) =>
  pi.sent.filter(
    (m) => m.params.customType === "skills-reload" && m.params.details?.skill === name,
  );

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

test("(a) read + compaction without the body → one line naming skill and file", async () => {
  const skill = writeSkill("alpha");
  const pi = fakePi();
  registerAutoInject(pi);

  newTurn();
  pi.handlers.tool_result(readResult(skill), ctxFor("reload-a", []));

  newTurn();
  pi.handlers.session_compact({ reason: "manual" }, ctxFor("reload-a", contextWithout()));

  assert.equal(reloadLines(pi, "alpha").length, 1, "exactly one reload line for alpha");
  const { params, options } = reloadLines(pi, "alpha")[0];
  const text = params.content.map((c) => c.text ?? "").join("\n");
  const payload = formatReloadPayload("alpha", skill.filePath);
  assert.ok(text.includes(payload), "the payload is the formatter's line, verbatim");
  assert.ok(!payload.includes("\n"), "the payload is one line");
  assert.ok(payload.includes("alpha"), "the line names the skill");
  assert.ok(payload.includes(skill.filePath), "the line names the file to reload");
  assert.ok(text.includes("[braid-whisper - skills-auto-inject"), "tracked whisper envelope");
  assert.equal(params.customType, "skills-reload");
  assert.equal(params.details._braidInjected, true);
  assert.equal(params.details._braidSource, "skills-auto-inject");
  assert.equal(options.deliverAs, "steer");
  assert.equal(options.triggerTurn, false);
  assert.equal(storedRow("alpha")?.reloads, 1, "the durable counter moved by one");
});

// ── (b) a body still in context says nothing ────────────────────────────────

test("(b) body still in the active context → zero lines, counter unchanged", () => {
  const skill = writeSkill("beta");
  const pi = fakePi();
  registerAutoInject(pi);

  newTurn();
  pi.handlers.tool_result(readResult(skill), ctxFor("reload-b", []));

  newTurn();
  pi.handlers.session_compact({ reason: "threshold" }, ctxFor("reload-b", contextWith(skill)));

  assert.equal(reloadLines(pi, "beta").length, 0, "no line while the body is present");
  assert.equal(pi.sent.length, 0, "the compaction produced no message at all");
  assert.equal(storedRow("beta")?.reloads, 0, "the counter did not move");
});

// ── (c) one line per skill per session, however many compactions ────────────

test("(c) second compaction, body still absent → still one line, count still one", () => {
  const pi = fakePi();
  registerAutoInject(pi);

  newTurn();
  pi.handlers.session_compact({ reason: "threshold" }, ctxFor("reload-a", contextWithout()));

  assert.equal(reloadLines(pi, "alpha").length, 0, "one line per skill per session");
  assert.equal(storedRow("alpha")?.reloads, 1, "the counter did not move again");
});

// ── (d) a skill that never landed has nothing to lose ──────────────────────

test("(d) skill never read → compaction says nothing about it", () => {
  writeSkill("gamma");
  const pi = fakePi();
  registerAutoInject(pi);

  newTurn();
  pi.handlers.session_compact({ reason: "manual" }, ctxFor("reload-d", contextWithout()));

  assert.equal(reloadLines(pi, "gamma").length, 0, "no body landed, so no line");
  assert.equal(pi.sent.length, 0, "nothing was sent");
  assert.equal(storedRow("gamma"), undefined, "no counter row");
});

// ── (e) the counter is durable and reported ─────────────────────────────────

test("(e) usage store carries reloads, a fresh process reads it, skill_stats shows it", async () => {
  const row = storedRow("alpha");
  assert.ok(row, "the skill has a durable row");
  assert.equal(row.reloads, 1, "the store file carries the count");

  const probe = [
    `const { getDurableSkillStats } = await import(${JSON.stringify(AUTO_INJECT)});`,
    `console.log(JSON.stringify(getDurableSkillStats()["alpha"]?.reloads ?? null));`,
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
  assert.equal(stats.text.allTime.alpha.reloads, 1, "skill_stats reports it per skill");
  assert.equal(stats.text.allTimeTotals.reloads, 1, "and in the totals");
  assert.equal(stats.details.allTimeTotals.reloads, 1, "the details block agrees");
});

// ── (f) sensitivity: the channel still delivers for a new session ──────────

test("(f) sensitivity: a fresh session's compaction still delivers its line", () => {
  const skill = writeSkill("delta");
  const pi = fakePi();
  registerAutoInject(pi);

  newTurn();
  pi.handlers.tool_result(readResult(skill), ctxFor("reload-f", []));
  newTurn();
  pi.handlers.session_compact({ reason: "overflow" }, ctxFor("reload-f", contextWithout()));

  assert.equal(reloadLines(pi, "delta").length, 1, "the pipeline delivers for a new session");
});

// ── (g) the signature the check stands on ──────────────────────────────────

test("(g) the signature is the body head, whitespace-flattened", () => {
  const skill = writeSkill("epsilon");
  const signature = bodySignature(skill.body);
  assert.equal(signature, skill.body.replace(/\s+/g, " ").trim().slice(0, 120));
  assert.ok(signature.startsWith("# epsilon protocol"), "frontmatter is not part of a body");
  assert.ok(signature.length > 40, "long enough to identify the body");
});
