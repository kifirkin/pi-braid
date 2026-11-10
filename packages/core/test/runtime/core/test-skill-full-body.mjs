/**
 * Test: skills auto-injection — the best match's BODY arrives, once.
 *
 * Contract:
 *   (a) WHOLE: the best-ranked match's SKILL.md body (frontmatter stripped)
 *       arrives in the whisper in full when it fits FULL_BODY_MAX_CHARS, and
 *       the message says plainly that no read call is needed for it. An
 *       8,000-character body is the sized case a real skill occupies.
 *   (b) CAPPED: a body past the cap is cut ONCE, at a word boundary, marked,
 *       and the message names the file and says the rest is there. A silent
 *       cut fails the fixture: the agent would believe it had read the skill.
 *   (c) BOUNDED RANKS: every row below the top stays inside MAX_EXCERPT_CHARS
 *       of body plus its read pointer, however many rows the caller hands in.
 *   (d) ONCE PER SESSION: the same skill is not delivered first-class twice.
 *       It matches again after its cooldown, and that message is a pointer.
 *   (e) COUNTED: `fullBody` moves when the body landed and not otherwise. A
 *       suppressed whisper moves neither counter, and the load counter stays
 *       apart from it, in the session state and in the durable store.
 *   (f) PAYLOAD: the added bytes are measured from the module's own output
 *       (characters and the pack's own estTokens divisor), not assumed. The
 *       measurement is printed so a report can quote it.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports, so the
 * real agent tree is never touched.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "skill-full-body-"));
process.env.HOME = FAKE_HOME;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const {
  registerAutoInject,
  getSkillStats,
  getDurableSkillStats,
  formatWhisper,
  formatWhisperContent,
  pickFullBodySkill,
  FULL_BODY_MAX_CHARS,
  MAX_EXCERPT_CHARS,
} = await import(join(ROOT, "dist", "extensions", "core", "skills-tool", "auto-inject.js"));
const { CHARS_PER_TOKEN } = await import(
  join(ROOT, "dist", "extensions", "core", "skills-tool", "reach.js")
);
const { setCachedSkills } = await import(
  join(ROOT, "dist", "extensions", "core", "skills-tool", "index.js")
);
const { clearAllBuckets } = await import(
  join(ROOT, "dist", "lib", "utils", "injection-tracker.js")
);
const { beginTurn } = await import(join(ROOT, "dist", "lib", "enforcement", "turn-dedup.js"));

const estTokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);

// ── fixture files ───────────────────────────────────────────────────────────

const SKILLS_DIR = join(FAKE_HOME, "skills");
const FRONTMATTER = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n`;

/** Write a skill file whose body is `body`, and return its cached row. */
function writeSkill(name, body, description = `${name} skill`) {
  const dir = join(SKILLS_DIR, name);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "SKILL.md");
  writeFileSync(filePath, FRONTMATTER(name, description) + body, "utf-8");
  return { name, description, filePath, baseDir: SKILLS_DIR };
}

/** ~8,000 characters: the size a real skill body occupies. */
function eightThousandCharBody(tag) {
  const rules = [];
  let chars = 0;
  let i = 0;
  while (chars < 7_900) {
    const line = `Rule ${i}: ${tag} keeps the containment model straight, and this sentence exists to carry the body to its measured length.`;
    rules.push(line);
    chars += line.length + 1;
    i++;
  }
  return `# ${tag} rules\n\n${rules.join("\n")}\n\nLAST-LINE-OF-${tag}`;
}

/** ~14,000 characters of single-token words, so a cut is testable at any offset. */
function longWordBody(count = 2_000) {
  return Array.from({ length: count }, (_, i) => `word${i}`).join(" ");
}

const BIG_BODY = eightThousandCharBody("BIGSKILL");
const BIG = writeSkill("big-match", BIG_BODY, "Big body skill");

const LONG_BODY = longWordBody();
const LONG = writeSkill("long-match", LONG_BODY, "Long body skill");

const SECOND = writeSkill(
  "second-match",
  `# Second\n\n${"second body text ".repeat(60)}\nEND-OF-SECOND`,
);
const THIRD = writeSkill(
  "third-match",
  `# Third\n\n${"third body text ".repeat(60)}\nEND-OF-THIRD`,
);

const PANE = writeSkill(
  "pane-topology",
  "Create panes, split them right or down, and wait for an agent to settle.\n",
  "Terminal pane topology",
);

// ── pi double (see test-skill-delivery-honest: reaching sendMessage is reaching
//    the stream, and a suppression upstream lands nowhere) ────────────────────

function fakePi() {
  const handlers = {};
  const stream = [];
  return {
    handlers,
    stream,
    on: (event, handler) => {
      handlers[event] = handler;
    },
    sendMessage: (params, options) => {
      if (options?.triggerTurn) {
        stream.push(params);
        return;
      }
      if (options?.deliverAs !== "nextTurn") stream.push(params);
    },
  };
}

const ctxFor = (sessionId) => ({
  sessionManager: { getSessionId: () => sessionId },
  cwd: join(FAKE_HOME, "ws"),
});

function openTurn() {
  beginTurn();
  clearAllBuckets();
}

const suggestionsIn = (pi) => pi.stream.filter((m) => m.customType === "skills-suggestion");
const textOf = (message) => message.content.map((c) => c.text ?? "").join("\n");

/** The one-line pointer row for a skill, or undefined when the row is absent. */
const pointerRowOf = (text, name) =>
  text.split("\n").find((line) => line.startsWith(`- ${name}: `));

/** The lead part of a pointer row: the excerpt between the name and the pointer. */
function leadOf(row) {
  return row.replace(/^- [^:]+: /, "").split(" — read")[0];
}

const SKILL_PROMPT = "create a herdr pane and split it right, then wait for it to settle";

// ── (a) the body arrives whole, frontmatter stripped ─────────────────────────

test("(a) an 8,000-character body arrives in the whisper in full", () => {
  assert.ok(
    BIG_BODY.length >= 7_800 && BIG_BODY.length <= 8_400,
    `the sized case must be about 8,000 chars; this body is ${BIG_BODY.length}`,
  );
  const { text, body } = formatWhisperContent([BIG], BIG.name);
  assert.ok(text.includes(BIG_BODY), "the whole body is in the message, byte for byte");
  assert.ok(!text.includes("description: Big body skill"), "frontmatter is stripped");
  assert.ok(
    text.includes(`## ${BIG.name} (full text, \`${BIG.filePath}\`)`),
    "the body is introduced in full, with its file named",
  );
  assert.ok(
    text.includes("no read call is needed for it"),
    "the message says the read call is unnecessary",
  );
  assert.ok(body && body.name === BIG.name && body.truncated === false, "the delivery reports a whole body");
});

// ── (b) a body past the cap is cut once, marked, and the file is named ──────

test("(b) a body past the cap is truncated once, at a word boundary, with the rest named", () => {
  assert.ok(LONG_BODY.length > FULL_BODY_MAX_CHARS, "the case body exceeds the cap");
  const { text, body } = formatWhisperContent([LONG], LONG.name);
  assert.ok(!text.includes(LONG_BODY), "the message does not carry the whole body");
  assert.ok(
    text.includes(`included below up to ${FULL_BODY_MAX_CHARS} characters`),
    "the message states where it stops",
  );
  assert.ok(
    text.includes(`The rest of ${LONG.name} is in \`${LONG.filePath}\``),
    "an explicit line names the file and says the rest is there",
  );
  const start = text.indexOf(`## ${LONG.name} (first ${FULL_BODY_MAX_CHARS} characters`);
  const end = text.indexOf(`The rest of ${LONG.name} is in`);
  assert.ok(start >= 0 && end > start, "the body sits between its title and its remainder line");
  const carried = text.slice(text.indexOf("\n", start) + 1, end).trim();
  assert.ok(carried.length <= FULL_BODY_MAX_CHARS + 1, `carried ${carried.length} chars at the cap`);
  assert.ok(carried.endsWith("…"), "the cut is marked");
  assert.ok(carried.includes(" "), "the cut keeps whole words");
  assert.ok(LONG_BODY.startsWith(carried.slice(0, -1)), "the carried text is the body's own prefix");
  assert.ok(body && body.truncated === true, "the delivery reports the truncation");
});

// ── (c) ranks below the top stay bounded, however many rows ────────────────

test("(c) ranks 2 and 3 keep ≤ MAX_EXCERPT_CHARS of body plus a read pointer", () => {
  const ranked = [BIG, SECOND, THIRD];
  const text = formatWhisper(ranked, BIG.name);
  assert.ok(text.includes(BIG_BODY), "the top rank still arrives whole");
  for (const skill of [SECOND, THIRD]) {
    const row = pointerRowOf(text, skill.name);
    assert.ok(row, `${skill.name} carries a pointer row`);
    assert.ok(row.includes(`read \`${skill.filePath}\` for the full skill`), "the row keeps its pointer");
    const lead = leadOf(row);
    assert.ok(
      lead.length <= MAX_EXCERPT_CHARS + 2,
      `${skill.name} lead is ${lead.length} chars, bound is ${MAX_EXCERPT_CHARS + 2}`,
    );
    assert.ok(
      !text.includes(skill.name === SECOND.name ? "END-OF-SECOND" : "END-OF-THIRD"),
      `${skill.name}'s body does not leak past the excerpt`,
    );
  }
});

test("(c2) with no body named, every row is a pointer (the once-per-session shape)", () => {
  const text = formatWhisper([BIG, SECOND]);
  assert.ok(!text.includes(BIG_BODY), "no row is expanded");
  const row = pointerRowOf(text, BIG.name);
  assert.ok(row && leadOf(row).length <= MAX_EXCERPT_CHARS + 2, "the top row is bounded too");
});

test("(a2) the handler's own delivery carries the 8,000-character body whole", async () => {
  // The formatter cases above pin the render; this one pins the wiring, so a
  // delivery that silently falls back to the excerpt tier cannot pass both.
  setCachedSkills([BIG]);
  const pi = fakePi();
  registerAutoInject(pi);
  const ctx = ctxFor("full-body-wired");
  openTurn();
  await pi.handlers.before_agent_start({ prompt: "match the big-match rules for panes" }, ctx);
  assert.equal(suggestionsIn(pi).length, 1, "the skill matched");
  const message = suggestionsIn(pi)[0];
  assert.ok(textOf(message).includes(BIG_BODY), "the delivered message carries the whole body");
  assert.ok(
    textOf(message).includes("no read call is needed for it"),
    "and says the read call is unnecessary",
  );
  assert.equal(message.details.fullBody, BIG.name, "the delivery is counted on the message");
});

// ── (d) once per session per skill ──────────────────────────────────────────

test("(d) the same skill is not delivered in full twice in one session", async () => {
  setCachedSkills([PANE]);
  const pi = fakePi();
  registerAutoInject(pi);
  const ctx = ctxFor("full-body-once");

  openTurn();
  await pi.handlers.before_agent_start({ prompt: SKILL_PROMPT }, ctx);
  assert.equal(suggestionsIn(pi).length, 1, "first match delivered");
  const first = suggestionsIn(pi)[0];
  assert.ok(textOf(first).includes("Create panes, split them right or down"), "the body arrived");
  assert.ok(
    textOf(first).includes("no read call is needed for it"),
    "the body tier reached the message, not a pointer row",
  );
  assert.equal(first.details.fullBody, "pane-topology", "the delivery is flagged on the message");

  // Ten filler turns put the floor cooldown behind it without matching anything.
  for (let t = 0; t < 10; t++) {
    openTurn();
    await pi.handlers.before_agent_start({ prompt: "just talk about the weather briefly" }, ctx);
  }
  openTurn();
  await pi.handlers.before_agent_start({ prompt: SKILL_PROMPT }, ctx);
  assert.equal(suggestionsIn(pi).length, 2, "the skill matched again once its cooldown expired");

  const second = suggestionsIn(pi)[1];
  const secondText = textOf(second);
  assert.ok(
    !secondText.includes("no read call is needed for it"),
    "the second match delivers no body: the body is already in this session",
  );
  assert.ok(
    !secondText.includes(`## pane-topology (full text`),
    "no body section on the second message",
  );
  const row = pointerRowOf(secondText, "pane-topology");
  assert.ok(row, "the second match is a pointer row");
  assert.ok(row.includes(`read \`${PANE.filePath}\` for the full skill`), "with the read pointer");
  assert.equal(second.details.fullBody, undefined, "no body flag on the second message");
});

// ── (e) the counter distinguishes a body delivery from a suggestion ─────────

test("(e) fullBody counts the delivered body once, apart from suggested", async () => {
  setCachedSkills([PANE]);
  const pi = fakePi();
  registerAutoInject(pi);
  const ctx = ctxFor("full-body-counted");
  // The durable store is process-global: earlier turns in this run have already
  // moved it, so the assertions are deltas over what was on disk.
  const before = { ...(getDurableSkillStats()["pane-topology"] ?? { suggested: 0, fullBody: 0, loaded: 0 }) };

  openTurn();
  await pi.handlers.before_agent_start({ prompt: SKILL_PROMPT }, ctx);
  let s = getSkillStats(ctx)["pane-topology"];
  assert.equal(s.suggested, 1, "the message counts as a suggestion");
  assert.equal(s.fullBody, 1, "and as a body delivery");
  assert.equal(s.loaded, 0, "a delivery is not a load");

  for (let t = 0; t < 10; t++) {
    openTurn();
    await pi.handlers.before_agent_start({ prompt: "just talk about the weather briefly" }, ctx);
  }
  openTurn();
  await pi.handlers.before_agent_start({ prompt: SKILL_PROMPT }, ctx);
  s = getSkillStats(ctx)["pane-topology"];
  assert.equal(s.suggested, 2, "both messages count as suggestions");
  assert.equal(s.fullBody, 1, "only the one that carried the body counts as a body delivery");
  const durable = getDurableSkillStats()["pane-topology"];
  assert.equal(durable.suggested - before.suggested, 2, "durable suggested moved by both messages");
  assert.equal(durable.fullBody - before.fullBody, 1, "durable fullBody moved by the body only");
  assert.equal(durable.loaded, 0, "the load counter stays apart from the body tier");
});

test("(e2) a suppressed whisper moves neither counter", async () => {
  const settingsDir = join(FAKE_HOME, ".pi", "agent");
  mkdirSync(settingsDir, { recursive: true });
  const settingsPath = join(settingsDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ braid: { suppressNudges: true } }), "utf-8");
  try {
    setCachedSkills([PANE]);
    const pi = fakePi();
    registerAutoInject(pi);
    const ctx = ctxFor("full-body-suppressed");
    openTurn();
    await pi.handlers.before_agent_start({ prompt: SKILL_PROMPT }, ctx);
    assert.equal(suggestionsIn(pi).length, 0, "nudges off, nothing delivered");
    assert.equal(getSkillStats(ctx)["pane-topology"]?.suggested ?? 0, 0, "nothing suggested");
    assert.equal(
      getSkillStats(ctx)["pane-topology"]?.fullBody ?? 0,
      0,
      "nothing delivered, so nothing counted as a body",
    );
  } finally {
    rmSync(settingsPath, { force: true });
  }
});

// ── (f) the added payload, measured ────────────────────────────────────────

test("(f) the added payload at the cap is measured, not estimated", () => {
  const pointerText = formatWhisper([LONG]);
  const wholeText = formatWhisper([BIG], BIG.name);
  const cappedText = formatWhisper([LONG], LONG.name);
  // The pointer row already carries MAX_EXCERPT_CHARS of the body, so the added
  // bytes are the body minus that excerpt plus the body section's own framing.
  const wholeAdded = wholeText.length - formatWhisper([BIG]).length;
  const cappedAdded = cappedText.length - pointerText.length;
  const framing = wholeText.length - BIG_BODY.length;
  console.log(
    `  payload: pointer row ${pointerText.length} chars (${estTokens(pointerText.length)} estTokens)`,
  );
  console.log(
    `  payload: whole body ${wholeText.length} chars (${estTokens(wholeText.length)} estTokens), +${wholeAdded} over the pointer row`,
  );
  console.log(
    `  payload: at the cap ${cappedText.length} chars (${estTokens(cappedText.length)} estTokens), +${cappedAdded} over the pointer row`,
  );
  console.log(
    `  payload: cap ${FULL_BODY_MAX_CHARS} chars = ${estTokens(FULL_BODY_MAX_CHARS)} estTokens of body`,
  );
  assert.equal(estTokens(FULL_BODY_MAX_CHARS), 3_000, "the cap is 3,000 estTokens at the pack divisor");
  assert.ok(
    framing > 0 && framing <= 400,
    // Three fixed lines (opening, body title, catalog trailer) plus the blank
    // lines between them measure 345 characters here; the bound guards a
    // header that grows, not a derivation.
    `the whole-body message is the body plus ${framing} chars of framing`,
  );
  assert.ok(
    cappedAdded <= FULL_BODY_MAX_CHARS + MAX_EXCERPT_CHARS,
    "the added payload at the cap stays inside the cap plus its framing",
  );
});

// ── the decision itself, pure ──────────────────────────────────────────────

test("pickFullBodySkill: the top rank, once; a delivered skill earns the pointer", () => {
  assert.equal(pickFullBodySkill([BIG, SECOND], new Set()), BIG.name, "top rank earns the body");
  assert.equal(
    pickFullBodySkill([BIG, SECOND], new Set([BIG.name])),
    undefined,
    "a re-match earns a pointer",
  );
  assert.equal(pickFullBodySkill([], new Set()), undefined, "nothing ranked, nothing expanded");
});
