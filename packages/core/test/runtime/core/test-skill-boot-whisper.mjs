/**
 * Test: skills-tool/auto-inject.ts — settings-driven session profile hints.
 *
 * Contract:
 *   (a) a configured profile with a hint fires exactly one skills-boot steer
 *       on the first non-empty prompt (verbatim hint text, tracked delivery
 *       path: deliverAs "steer", triggerTurn false, source skills-auto-inject);
 *   (b) later turns in the same session → no second hint;
 *   (c) the hint follows the config, not the profile name: an arbitrary name
 *       carries its own text;
 *   (d) a configured profile WITHOUT a hint never fires (classified for
 *       telemetry, silent in the prompt);
 *   (e) a cwd matching no profile never fires — even the directory that used
 *       to be hardcoded — and records the neutral profile;
 *   (f) empty first prompt defers; fires once on the next non-empty prompt;
 *   (g) the session start record carries the resolved profile name.
 *
 * Sensitivity: every turn in this fixture runs with a fresh flood-cap and
 * reprime state, so a duplicate delivery would NOT be masked by suppression —
 * it would land in the capture and fail the count. The capture measures the
 * once-per-session guard itself, not the whisper caps.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports, so the
 * real agent tree is never touched. The config home is addressed by path
 * construction (not by the dist getter) so a pre-change build still loads
 * this file and fails case-by-case instead of crashing at import.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "skill-profile-hint-"));
process.env.HOME = FAKE_HOME;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { registerAutoInject } = await import(
  join(ROOT, "dist", "extensions", "core", "skills-tool", "auto-inject.js")
);
const { readSessionRecords } = await import(
  join(ROOT, "dist", "extensions", "core", "skills-tool", "session-records.js")
);
const { clearAllBuckets } = await import(
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

// ── harness ─────────────────────────────────────────────────────────────────

/** Minimal ExtensionAPI double: captures handlers and every delivered message. */
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

// The braid config home and the adoption store, addressed directly so the
// fixture runs against any build whose paths land in the same place.
const BRAID_DIR = join(FAKE_HOME, ".pi", "agent", "braid");
const CONFIG_PATH = join(BRAID_DIR, "config.json");
const SESSIONS_FILE = join(BRAID_DIR, "skills-sessions.jsonl");

const ALPHA_CWD = join(FAKE_HOME, "ws", "alpha");
const BETA_CWD = join(FAKE_HOME, "ws", "beta");
const WORKER_CWD = join(FAKE_HOME, "projects", "some-repo");
/** The directory the retired hardcoded classification special-cased. */
const RETIRED_ROOT_CWD = join(BRAID_DIR, "orchestrator");
const HINT_ALPHA = "Alpha protocol: read the coordination skill before dispatching any worker.";
const HINT_BETA = "Beta protocol: a hint is configured data, not a built-in name.";

function writeConfig() {
  mkdirSync(BRAID_DIR, { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      sessionProfiles: [
        { name: "alpha", cwd: ALPHA_CWD, hint: HINT_ALPHA },
        { name: "beta", cwd: BETA_CWD, hint: HINT_BETA },
        { name: "worker", cwd: join(FAKE_HOME, "projects") },
      ],
    }),
    "utf-8",
  );
}

function clearConfig() {
  rmSync(CONFIG_PATH, { force: true });
}

const ctxFor = (cwd, sessionId) => ({
  sessionManager: { getSessionId: () => sessionId },
  cwd,
});

/**
 * Simulate a real turn boundary plus fresh cross-call (reprime) state, so a
 * would-be duplicate whisper cannot be suppressed by either mechanism.
 */
function newTurn() {
  beginTurn();
  clearAllBuckets();
}

/** Delivered messages whose text carries the given hint. */
const hintWhispers = (pi, text) =>
  pi.sent.filter((m) => m.params.content.some((c) => (c.text ?? "").includes(text)));

/** Durable adoption records written for one session. */
const sessionRecordsFor = (sessionId) =>
  readSessionRecords(SESSIONS_FILE).filter((r) => r.sessionId === sessionId);

console.log("skill-profile-hint test\n");

// ── (a) configured hint: exactly one steer, then silence for the session ────

await test("(a) configured hint → exactly one steer on the first non-empty prompt", async () => {
  writeConfig();
  const pi = fakePi();
  registerAutoInject(pi);
  const ctx = ctxFor(ALPHA_CWD, "hint-a");
  newTurn();
  await pi.handlers.before_agent_start({ prompt: "coordinate the release" }, ctx);

  const hints = hintWhispers(pi, HINT_ALPHA);
  assert.equal(hints.length, 1, "exactly one hint whisper");
  const { params, options } = hints[0];
  const body = params.content.map((c) => c.text ?? "").join("\n");
  assert.ok(body.includes(HINT_ALPHA), "verbatim hint text");
  assert.ok(body.includes("[braid-whisper - skills-auto-inject"), "tracked whisper envelope");
  assert.ok(body.includes("[braid-whisper-end]"), "end marker present");
  assert.equal(params.customType, "skills-boot");
  assert.equal(params.details._braidInjected, true);
  assert.equal(params.details._braidSource, "skills-auto-inject");
  assert.equal(options.deliverAs, "steer");
  assert.equal(options.triggerTurn, false);
  assert.equal(pi.sent.length, 1, "empty skill cache → the hint is the only delivery");

  newTurn();
  await pi.handlers.before_agent_start({ prompt: "second turn" }, ctx);
  newTurn();
  await pi.handlers.before_agent_start({ prompt: "third turn" }, ctx);
  assert.equal(pi.sent.length, 1, "still exactly one delivery after later turns");
  assert.equal(hintWhispers(pi, HINT_ALPHA).length, 1, "no second hint");
});

// ── (b) arbitrary profile names carry their own text ────────────────────────

await test("(b) arbitrary profile name → its own hint text, nothing from other profiles", async () => {
  writeConfig();
  const pi = fakePi();
  registerAutoInject(pi);
  newTurn();
  await pi.handlers.before_agent_start(
    { prompt: "run the beta pipeline" },
    ctxFor(BETA_CWD, "hint-b"),
  );

  assert.equal(hintWhispers(pi, HINT_BETA).length, 1, "beta hint fires");
  assert.equal(hintWhispers(pi, HINT_ALPHA).length, 0, "alpha text does not leak to beta");
  assert.equal(pi.sent.length, 1, "one delivery only");
});

// ── (c) configured profile without a hint: classified, silent ───────────────

await test("(c) hintless profile → no whisper on any turn, still classified", async () => {
  writeConfig();
  const pi = fakePi();
  registerAutoInject(pi);
  const ctx = ctxFor(WORKER_CWD, "hint-c");
  newTurn();
  await pi.handlers.before_agent_start({ prompt: "implement the change" }, ctx);
  newTurn();
  await pi.handlers.before_agent_start({ prompt: "continue" }, ctx);
  assert.equal(pi.sent.length, 0, "a hintless profile never steers");

  const [record] = sessionRecordsFor("hint-c");
  assert.ok(record, "start record exists");
  assert.equal(record.role, "worker", "classified for telemetry despite no hint");
});

// ── (e) no profiles configured: nobody hints, the retired root included ─────

await test("(e) unconfigured → no hint even in the retired hardcoded root; neutral record", async () => {
  clearConfig();
  const pi = fakePi();
  registerAutoInject(pi);
  const ctx = ctxFor(RETIRED_ROOT_CWD, "hint-e");
  newTurn();
  await pi.handlers.before_agent_start({ prompt: "coordinate without config" }, ctx);
  newTurn();
  await pi.handlers.before_agent_start({ prompt: "keep going" }, ctx);
  assert.equal(pi.sent.length, 0, "no profiles configured → nobody hints");

  const [record] = sessionRecordsFor("hint-e");
  assert.ok(record, "start record exists");
  assert.equal(record.role, "other", "no match → neutral default profile");
});

// ── (f) empty first prompt defers the fire ──────────────────────────────────

await test("(f) empty first prompt defers; fires once on the next non-empty prompt", async () => {
  writeConfig();
  const pi = fakePi();
  registerAutoInject(pi);
  const ctx = ctxFor(ALPHA_CWD, "hint-f");
  newTurn();
  await pi.handlers.before_agent_start({ prompt: "" }, ctx);
  newTurn();
  await pi.handlers.before_agent_start({ prompt: "   \n\t " }, ctx);
  assert.equal(pi.sent.length, 0, "empty prompts are not a hint moment");

  newTurn();
  await pi.handlers.before_agent_start({ prompt: "now coordinate" }, ctx);
  assert.equal(
    hintWhispers(pi, HINT_ALPHA).length,
    1,
    "deferred fire lands on the first non-empty prompt",
  );

  newTurn();
  await pi.handlers.before_agent_start({ prompt: "later turn" }, ctx);
  assert.equal(pi.sent.length, 1, "still once per session");
});

// ── (g) telemetry names the profile ─────────────────────────────────────────

await test("(g) the session start record carries the resolved profile name", async () => {
  writeConfig();
  const pi = fakePi();
  registerAutoInject(pi);
  newTurn();
  await pi.handlers.before_agent_start({ prompt: "one turn" }, ctxFor(ALPHA_CWD, "hint-g"));
  const records = sessionRecordsFor("hint-g");
  assert.equal(records.length, 1, "one start record");
  assert.equal(records[0].role, "alpha", "profile name recorded");
  assert.equal(records[0].hadSkillLoad, false, "no load yet");
});

// ── sensitivity: the delivery pipeline is alive at this point in the run ────

await test("(h) sensitivity: a fresh session still delivers when its turn arrives", async () => {
  writeConfig();
  const pi = fakePi();
  registerAutoInject(pi);
  newTurn();
  await pi.handlers.before_agent_start({ prompt: "new session" }, ctxFor(ALPHA_CWD, "hint-h"));
  assert.equal(hintWhispers(pi, HINT_ALPHA).length, 1, "pipeline delivers for a new session");
});

// ── cleanup ─────────────────────────────────────────────────────────────────

try {
  rmSync(FAKE_HOME, { recursive: true, force: true });
} catch {
  /* best-effort */
}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
