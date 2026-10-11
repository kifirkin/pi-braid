/**
 * Skills flagged `disable-model-invocation: true` stay out of the model-facing
 * skill surfaces while explicit reads keep counting.
 *
 * Contract:
 *   (a) the list_skills catalog omits flagged skills and its totals exclude
 *       them;
 *   (b) the auto-inject whisper never suggests a flagged skill, while an
 *       unflagged matching skill is still suggested;
 *   (c) an explicit read of a flagged skill's SKILL.md is still recognized
 *       (the read-detector keeps the unfiltered cache).
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports, so the
 * real agent tree is never touched.
 *
 * Run: node test/runtime/core/test-skills-disable-model-invocation.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "skills-flag-pin-"));
process.env.HOME = FAKE_HOME;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const skillsToolModule = await import(
  join(ROOT, "dist", "extensions", "core", "skills-tool", "index.js")
);
const { setCachedSkills } = skillsToolModule;
const skillsToolExtension = skillsToolModule.default;
const { updateSkillCache, skillNameFromRead } = await import(
  join(ROOT, "dist", "extensions", "core", "skills-tool", "auto-inject.js")
);
const { beginTurn } = await import(join(ROOT, "dist", "lib", "enforcement", "turn-dedup.js"));
const { clearAllBuckets } = await import(join(ROOT, "dist", "lib", "utils", "injection-tracker.js"));

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  [ok] ${name}`);
    })
    .catch((e) => {
      failed++;
      console.log(`  [fail] ${name}: ${e.message}`);
    });
}

const skill = (name, description, disableModelInvocation) => ({
  name,
  description,
  filePath: join(FAKE_HOME, "skills", name, "SKILL.md"),
  baseDir: join(FAKE_HOME, "skills"),
  sourceInfo: { source: "user" },
  ...(disableModelInvocation === undefined ? {} : { disableModelInvocation }),
});

const visible = skill("alpha-topic", "Handle alpha topic work.");
const hidden = skill("hidden-topic", "Handle hidden topic work.", true);

/** ExtensionAPI double: captures registered tools and delivered messages. */
function fakePi() {
  const handlers = {};
  const tools = new Map();
  const sent = [];
  return {
    handlers,
    tools,
    sent,
    on(event, handler) {
      handlers[event] = handler;
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
    sendMessage(params, options) {
      sent.push({ params, options });
    },
  };
}

console.log("skills disable-model-invocation test\n");

await test("list_skills omits flagged skills and excludes them from totals", async () => {
  setCachedSkills([visible, hidden]);
  const pi = fakePi();
  skillsToolExtension(pi);
  const tool = pi.tools.get("list_skills");
  assert.ok(tool, "list_skills must be registered");

  const result = await tool.execute(
    "call-1",
    { action: "list", page: 1, pageSize: 50 },
    undefined,
    undefined,
    {},
  );
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.total, 1, "total must count only model-visible skills");
  assert.deepEqual(
    payload.skills.map((s) => s.name),
    ["alpha-topic"],
  );
  assert.equal(result.details.total, 1);
});

await test("auto-inject never suggests a flagged skill", async () => {
  const pi = fakePi();
  skillsToolExtension(pi);
  updateSkillCache([visible, hidden]);
  beginTurn();
  clearAllBuckets();

  const ctx = {
    cwd: join(FAKE_HOME, "ws"),
    sessionManager: {
      getSessionId: () => "flag-pin-session",
      getSessionFile: () => join(FAKE_HOME, "sessions", "flag-pin-session.jsonl"),
    },
  };
  await pi.handlers["before_agent_start"](
    { prompt: "hidden-topic alpha-topic work", systemPromptOptions: { skills: [] } },
    ctx,
  );

  const text = pi.sent
    .map((m) => m.params.content.map((c) => c.text ?? "").join(" "))
    .join("\n");
  assert.ok(!text.includes("hidden-topic"), `flagged skill must not be suggested, got:\n${text}`);
  assert.ok(text.includes("alpha-topic"), `unflagged matching skill must be suggested, got:\n${text}`);
});

await test("an explicit read of a flagged skill is still recognized", () => {
  updateSkillCache([visible, hidden]);
  const body = "# hidden-topic\n\nBody text.";
  assert.equal(
    skillNameFromRead(hidden.filePath, body),
    "hidden-topic",
    "the read-detector must resolve flagged skills from the unfiltered cache",
  );
});

rmSync(FAKE_HOME, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
