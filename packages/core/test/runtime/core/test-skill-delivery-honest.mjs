/**
 * Test: skills auto-injection — a suggestion is a DELIVERED session message,
 * and conversion is a DETECTED READ.
 *
 * Contract:
 *   (a) DELIVERY: on a live-turn shape the suggestion reaches the session
 *       stream — the same class of durable trace the hygiene and enforcement
 *       whispers leave — not merely the `sendMessage` stub. The fixture opens
 *       the turn ONCE and lets prompt-builder's once-per-session hygiene
 *       whisper (a low-priority whisper, delivered in the same
 *       before_agent_start, before the skills handler) run first, which is
 *       the live ordering; a suggestion that only survives a sanitized turn
 *       is not delivered in a real one.
 *   (b) HONESTY: `suggested` counts arrivals. For every skill, the session
 *       counter must equal the number of suggestion entries in the stream; a
 *       suggestion that a suppression path dropped must not be counted, so
 *       the adoption numbers measure the suggestion channel instead of the
 *       intent to use it.
 *   (c) CONVERSION: a detected `read` of the suggested SKILL.md is what
 *       converts the suggestion (raises `actual`). No read leaves `actual`
 *       at 0 with the suggestion standing, so the miss stays visible as the
 *       gap between `suggested` and `actual`.
 *   (d) ASK: the whisper asks for the read; the retired LOADED/SKIP reply
 *       ritual is gone.
 *   (e) SUPPRESSED MEANS NOT COUNTED: with cognitive nudges disabled the
 *       whisper is dropped and `suggested` stays at 0 — the other arm of (b),
 *       so neither delivery nor suppression can move the counter alone.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports, so the
 * real agent tree is never touched.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "skill-delivery-"));
process.env.HOME = FAKE_HOME;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { registerAutoInject, getSkillStats, formatWhisper } = await import(
  join(ROOT, "dist", "extensions", "core", "skills-tool", "auto-inject.js")
);
const { setCachedSkills } = await import(
  join(ROOT, "dist", "extensions", "core", "skills-tool", "index.js")
);
const { sendTrackedMessage, clearAllBuckets } = await import(
  join(ROOT, "dist", "lib", "utils", "injection-tracker.js")
);
const { beginTurn } = await import(join(ROOT, "dist", "lib", "enforcement", "turn-dedup.js"));

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

// ── fixture ─────────────────────────────────────────────────────────────────

const SKILLS_DIR = join(FAKE_HOME, "skills");
const PANE_SKILL_DIR = join(SKILLS_DIR, "herdr-topology");
mkdirSync(PANE_SKILL_DIR, { recursive: true });
const PANE_SKILL_PATH = join(PANE_SKILL_DIR, "SKILL.md");
writeFileSync(
  PANE_SKILL_PATH,
  "---\nname: herdr-topology\ndescription: Herdr pane topology\n---\n\n" +
    "Create panes, split them right or down, and wait for an agent to settle.\n",
  "utf-8",
);

setCachedSkills([
  {
    name: "herdr-topology",
    description: "Herdr pane topology",
    filePath: PANE_SKILL_PATH,
    baseDir: SKILLS_DIR,
  },
]);

/**
 * A pi double whose `sendMessage` keeps pi-core's append semantics: a
 * `{deliverAs: "steer", triggerTurn: false}` message is appended to the
 * session when the run is idle (`_appendCustomMessage`) and parked, then
 * appended at the turn's end, when a run is active (`_pendingCustomMessages`).
 * Either way it lands in the stream, so here reaching `sendMessage` and
 * reaching the stream are the same step. A suppression upstream of
 * `sendMessage` lands nowhere.
 */
function fakePi() {
  const handlers = {};
  const stream = [];
  const calls = [];
  return {
    handlers,
    stream,
    calls,
    on: (event, handler) => {
      handlers[event] = handler;
    },
    sendMessage: (params, options) => {
      calls.push({ params, options });
      if (options?.triggerTurn) {
        stream.push(params); // a wake always enters the session
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

/** Open a turn with fresh cross-call (reprime) state, as session.prompt() does. */
function openTurn() {
  beginTurn();
  clearAllBuckets();
}

/**
 * The once-per-session hygiene whisper: prompt-builder's before_agent_start
 * runs first and spends the turn's advisory (low-priority) whisper slot.
 * Source name is the production one, so the real priority mapping applies.
 */
function deliverHygieneWhisper(pi) {
  sendTrackedMessage(
    pi,
    {
      customType: "hygiene",
      display: true,
      content: [{ type: "text", text: "Hygiene: 0K tokens in context; baseline set (0K)." }],
    },
    { deliverAs: "steer", triggerTurn: false },
    { type: "context", source: "prompt-builder/hygiene" },
  );
}

const suggestionsIn = (pi) => pi.stream.filter((m) => m.customType === "skills-suggestion");

const SKILL_PROMPT = "create a herdr pane and split it right, then wait for it to settle";

console.log("skill-delivery-honest test\n");

// ── (a) a live-turn shape still carries the suggestion ──────────────────────

await test("(a) suggestion reaches the session stream on a live-turn shape", async () => {
  const pi = fakePi();
  registerAutoInject(pi);
  const ctx = ctxFor("delivery-a");

  openTurn();
  deliverHygieneWhisper(pi);
  await pi.handlers.before_agent_start({ prompt: SKILL_PROMPT }, ctx);

  const delivered = suggestionsIn(pi);
  assert.equal(
    delivered.length,
    1,
    "the suggestion is present in the session stream; a whisper dropped before " +
      "sendMessage (the low-priority slot already spent by the hygiene whisper) " +
      "reaches no stream at all",
  );
  const body = delivered[0].content.map((c) => c.text ?? "").join("\n");
  assert.ok(body.includes("[SKILL SUGGESTION]"), "suggestion body");
  assert.ok(body.includes(PANE_SKILL_PATH), "carries the SKILL.md path");
  assert.equal(delivered[0].details._braidSource, "skills-auto-inject");
  assert.deepEqual(delivered[0].details.skills, ["herdr-topology"]);
});

// ── (b) `suggested` is a measurement of arrival ─────────────────────────────

await test("(b) suggested counts only suggestions present in the stream", async () => {
  const pi = fakePi();
  registerAutoInject(pi);
  const ctx = ctxFor("delivery-b");

  openTurn();
  deliverHygieneWhisper(pi);
  await pi.handlers.before_agent_start({ prompt: SKILL_PROMPT }, ctx);

  const delivered = suggestionsIn(pi).filter((m) =>
    (m.details.skills ?? []).includes("herdr-topology"),
  ).length;
  const counted = getSkillStats(ctx)["herdr-topology"]?.suggested ?? 0;
  assert.equal(
    counted,
    delivered,
    `suggested (${counted}) must equal the suggestions in the stream (${delivered}); ` +
      "a counter that moves for an undelivered suggestion makes every adoption number untrustworthy",
  );
});

// ── (c) conversion is a detected read ───────────────────────────────────────

await test("(c) a detected read converts the suggestion; no read leaves the miss visible", async () => {
  const pi = fakePi();
  registerAutoInject(pi);
  const ctx = ctxFor("delivery-c");

  // Turn 1: suggest, no read.
  openTurn();
  await pi.handlers.before_agent_start({ prompt: SKILL_PROMPT }, ctx);
  assert.equal(suggestionsIn(pi).length, 1, "suggestion delivered");
  let s = getSkillStats(ctx)["herdr-topology"];
  assert.equal(s.suggested, 1, "suggested recorded");
  assert.equal(s.actual, 0, "no read yet");
  assert.equal(s.suggested - s.actual, 1, "the unconverted suggestion stays visible");

  // The agent opens the suggested path: the read is the conversion.
  pi.handlers.tool_result(
    {
      toolName: "read",
      input: { path: PANE_SKILL_PATH },
      content: [{ type: "text", text: "---\nname: herdr-topology\n---\nbody" }],
    },
    ctx,
  );
  s = getSkillStats(ctx)["herdr-topology"];
  assert.equal(s.actual, 1, "detected read of the suggested SKILL.md converts");
  assert.equal(s.loaded, 1, "loaded mirrors the detected read");
  assert.equal(s.suggested - s.actual, 0, "the gap closes on conversion");

  // An unrelated read does not convert a standing suggestion.
  clearAllBuckets();
  beginTurn();
  await pi.handlers.before_agent_start({ prompt: SKILL_PROMPT }, ctx);
  pi.handlers.tool_result(
    {
      toolName: "read",
      input: { path: join(FAKE_HOME, "notes.md") },
      content: [{ type: "text", text: "unrelated notes" }],
    },
    ctx,
  );
  s = getSkillStats(ctx)["herdr-topology"];
  assert.equal(s.actual, 1, "a non-skill read never converts");
});

// ── (d) the read pointer, with the reply ritual retired ─────────────────

await test("(d) the whisper points at the read and solicits no reply", () => {
  const whisper = formatWhisper([
    { name: "herdr-topology", description: "Herdr pane topology", filePath: PANE_SKILL_PATH },
  ]);
  assert.ok(whisper.includes(PANE_SKILL_PATH), "points at the SKILL.md path");
  assert.ok(
    !/open it and apply/i.test(whisper) && !/say in one line/i.test(whisper),
    "the 2%-compliance reply ask is retired",
  );
  assert.ok(
    !/LOADED/.test(whisper) && !/\bSKIP\b/.test(whisper),
    "the LOADED/SKIP reply ritual stays retired",
  );
});

// ── (e) suppressed means not counted ────────────────────────────────────────

await test("(e) a suppressed suggestion is not counted either", async () => {
  const settingsDir = join(FAKE_HOME, ".pi", "agent");
  mkdirSync(settingsDir, { recursive: true });
  const settingsPath = join(settingsDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ braid: { suppressNudges: true } }), "utf-8");
  try {
    const pi = fakePi();
    registerAutoInject(pi);
    const ctx = ctxFor("delivery-e");
    openTurn();
    await pi.handlers.before_agent_start({ prompt: SKILL_PROMPT }, ctx);
    assert.equal(suggestionsIn(pi).length, 0, "nudges off → nothing delivered");
    assert.equal(
      getSkillStats(ctx)["herdr-topology"]?.suggested ?? 0,
      0,
      "nothing delivered → nothing counted, so the counter stays a measurement",
    );
  } finally {
    rmSync(settingsPath, { force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
