/**
 * maxPowerModel is a deprecated alias of utilityModel: read once, cleaned on
 * the next role write, and the command surface drives the canonical key.
 *
 * WHY THIS TEST EXISTS:
 *   The max-power role merged into the utility role: one key, one tier. The
 *   old key still loads for one release (alias window), so an upgrade cannot
 *   silently drop a configured model, but every write must land on the
 *   canonical key and must remove the legacy key from settings.json - a
 *   map-only cleanup would leave the alias on disk and the next load would
 *   resurrect the old pin (the same resurrection bug the clear path had).
 *
 * WHAT IS PINNED HERE:
 *   1. Read: settings with only maxPowerModel load under utilityModel and
 *      resolveUtilityModel resolves through it (RED before the merge: the
 *      canonical resolver returned undefined), plus one process-global
 *      deprecation notice in the log buffer.
 *   2. Canonical wins when both keys are present.
 *   3. A role write deletes the legacy key from settings.json in the same
 *      transaction (utility write and vision write).
 *   4. /max-power-model set/show/clear operate on the canonical key and
 *      notify the deprecation (RED before the merge: it wrote maxPowerModel).
 *
 * PI_CODING_AGENT_DIR points at a temp dir before the dist modules load, so
 * neither pi's nor braid's settings path can touch the real agent directory.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const SETTINGS_DIR = mkdtempSync(join(tmpdir(), "role-merge-alias-"));
mkdirSync(SETTINGS_DIR, { recursive: true });
process.env.PI_CODING_AGENT_DIR = SETTINGS_DIR;
const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");

const { default: polyfillExtension } = await import(
  join(ROOT, "dist", "extensions", "core", "polyfill", "index.js")
);
const { resolveUtilityModel } = await import(join(ROOT, "dist", "lib", "ai", "model-resolver.js"));
const {
  getCustomModelKey,
  getCustomModelKeys,
  UTILITY_MODEL_KEY,
  VISION_MODEL_KEY,
  MAX_POWER_MODEL_KEY,
} = await import(join(ROOT, "dist", "lib", "state", "global-state.js"));
const { getLogBuffer, clearLogBuffer } = await import(join(ROOT, "dist", "lib", "core", "logger.js"));

const CATALOG = [
  { id: "a-model", provider: "route-a", api: "anthropic-messages", input: ["text"] },
  { id: "b-model", provider: "route-b", api: "anthropic-messages", input: ["text"] },
];
const SESSION = { id: "session-model-x", provider: "opencode-go", api: "anthropic-messages" };

function writeSettings(value) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function readSettings() {
  return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
}

/** Load the extension the way pi does, capturing the commands it registers. */
function loadExtension() {
  const commands = new Map();
  const pi = {
    on() {},
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
  };
  polyfillExtension(pi);
  return commands;
}

function makeCtx() {
  const notifications = [];
  return {
    notifications,
    hasUI: false,
    model: SESSION,
    modelRegistry: {
      find: (provider, id) => CATALOG.find((m) => m.provider === provider && m.id === id),
      getAll: () => CATALOG,
      getAvailable: () => CATALOG,
    },
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };
}

/** Every polyfill log line that mentions the legacy key. */
function legacyNotices() {
  return getLogBuffer().filter(
    (entry) => entry.source === "polyfill" && entry.message.includes("maxPowerModel"),
  );
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(`  [x] ${name}: ${e.message}`);
    failed++;
  } finally {
    getCustomModelKeys().clear();
  }
}

console.log("=== maxPowerModel deprecation alias ===\n");

await test("read: legacy-only settings resolve through the canonical key", async () => {
  clearLogBuffer();
  writeSettings({ [MAX_POWER_MODEL_KEY]: "route-a/a-model" });
  loadExtension();

  assert.equal(
    getCustomModelKey(UTILITY_MODEL_KEY),
    "route-a/a-model",
    "the legacy value must load under utilityModel",
  );
  assert.equal(
    resolveUtilityModel(makeCtx()),
    CATALOG[0],
    "the canonical resolver must resolve the aliased model",
  );
  const notices = legacyNotices();
  assert.equal(notices.length > 0, true, "the alias read must log a deprecation notice");
  assert.equal(
    notices.some((n) => /deprecat/i.test(n.message)),
    true,
    "the notice must name the deprecation",
  );
});

await test("read: the notice fires once per process", async () => {
  clearLogBuffer();
  writeSettings({ [MAX_POWER_MODEL_KEY]: "route-a/a-model" });
  loadExtension();

  assert.equal(
    legacyNotices().length,
    0,
    "a second alias read in the same process must not repeat the notice",
  );
});

await test("read: canonical utilityModel wins when both keys are present", async () => {
  writeSettings({
    [UTILITY_MODEL_KEY]: "route-a/a-model",
    [MAX_POWER_MODEL_KEY]: "route-b/b-model",
  });
  loadExtension();

  assert.equal(getCustomModelKey(UTILITY_MODEL_KEY), "route-a/a-model");
  assert.equal(resolveUtilityModel(makeCtx()), CATALOG[0], "the canonical model must win");
});

await test("write: a utility write deletes the legacy key from disk", async () => {
  writeSettings({ [MAX_POWER_MODEL_KEY]: "route-a/a-model" });
  const commands = loadExtension();
  const ctx = makeCtx();

  await commands.get("utility-model").handler("route-b/b-model", ctx);

  const settings = readSettings();
  assert.equal(settings[UTILITY_MODEL_KEY], "route-b/b-model");
  assert.equal(
    MAX_POWER_MODEL_KEY in settings,
    false,
    "the legacy key left on disk would resurrect the old pin",
  );
});

await test("write: a vision write also deletes the legacy key from disk", async () => {
  writeSettings({ [MAX_POWER_MODEL_KEY]: "route-a/a-model" });
  const commands = loadExtension();
  const ctx = makeCtx();

  await commands.get("vision-model").handler("route-b/b-model", ctx);

  const settings = readSettings();
  assert.equal(settings[VISION_MODEL_KEY], "route-b/b-model");
  assert.equal(
    UTILITY_MODEL_KEY in settings,
    true,
    "the aliased role must persist under the canonical key",
  );
  assert.equal(MAX_POWER_MODEL_KEY in settings, false, "any role write cleans the legacy key");
});

await test("command: /max-power-model set writes the canonical key and notifies", async () => {
  writeSettings({});
  const commands = loadExtension();
  const ctx = makeCtx();

  await commands.get("max-power-model").handler("route-a/a-model", ctx);

  const settings = readSettings();
  assert.equal(
    settings[UTILITY_MODEL_KEY],
    "route-a/a-model",
    "the alias must write the canonical key",
  );
  assert.equal(MAX_POWER_MODEL_KEY in settings, false, "the alias must not write its own key");
  assert.equal(
    ctx.notifications.some((n) => /deprecat/i.test(n.message)),
    true,
    "the alias must notify the deprecation",
  );
});

await test("command: /max-power-model show reads the canonical key and notifies", async () => {
  writeSettings({ [UTILITY_MODEL_KEY]: "route-a/a-model" });
  const commands = loadExtension();
  const ctx = makeCtx();

  await commands.get("max-power-model").handler("", ctx);

  assert.equal(
    ctx.notifications.some((n) => n.message.includes("route-a/a-model")),
    true,
    "the alias must show the canonical setting",
  );
  assert.equal(
    ctx.notifications.some((n) => /deprecat/i.test(n.message)),
    true,
    "the alias must notify the deprecation",
  );
});

await test("command: /max-power-model clear clears the canonical key and notifies", async () => {
  writeSettings({
    [UTILITY_MODEL_KEY]: ["route-a/a-model"],
    [MAX_POWER_MODEL_KEY]: "route-b/b-model",
  });
  const commands = loadExtension();
  const ctx = makeCtx();

  await commands.get("max-power-model").handler("clear", ctx);

  const settings = readSettings();
  assert.equal(
    UTILITY_MODEL_KEY in settings,
    false,
    "clear must not leave the canonical key on disk",
  );
  assert.equal(MAX_POWER_MODEL_KEY in settings, false);
  assert.equal(
    ctx.notifications.some((n) => /deprecat/i.test(n.message)),
    true,
    "the alias must notify the deprecation",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== role merge alias tests passed ===");
