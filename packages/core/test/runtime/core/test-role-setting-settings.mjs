/**
 * A role setting survives the settings.json round trip as a string or a list.
 *
 * WHY THIS TEST EXISTS:
 *   The role settings (utilityModel / visionModel / maxPowerModel) are written
 *   to pi's settings.json by the model polyfill and read back at startup. The
 *   read path accepted `typeof value === "string"` only, so an ordered list
 *   written by hand (the way a role is pinned to several providers) was dropped
 *   on load and the role silently fell back to the session model.
 *
 * WHAT IS PINNED HERE:
 *   1. Read: a list in settings.json lands in the in-memory map as that list; a
 *      scalar stays a scalar; a value with no usable pattern is treated as unset
 *      rather than stored as something that resolves to nothing.
 *   2. Write: /utility-model with a comma-separated argument stores the list
 *      form, and with one argument stores the scalar form.
 *   3. Validation: a pattern that no catalog model matches is refused and the
 *      stored setting is left alone.
 *   4. Clear: /utility-model clear removes the key from settings.json, not only
 *      from memory (a key deleted from the map alone was still on disk and the
 *      next start resurrected it).
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

const SETTINGS_DIR = mkdtempSync(join(tmpdir(), "role-setting-settings-"));
mkdirSync(SETTINGS_DIR, { recursive: true });
process.env.PI_CODING_AGENT_DIR = SETTINGS_DIR;
const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");

const { default: polyfillExtension } = await import(
  join(ROOT, "dist", "extensions", "core", "polyfill", "index.js")
);
const {
  getCustomModelKey,
  getCustomModelKeys,
  UTILITY_MODEL_KEY,
  VISION_MODEL_KEY,
  MAX_POWER_MODEL_KEY,
} = await import(join(ROOT, "dist", "lib", "state", "global-state.js"));

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

console.log("=== Role settings round trip through settings.json ===\n");

await test("read: a list on disk lands in the map as that list", async () => {
  writeSettings({ [UTILITY_MODEL_KEY]: ["route-a/a-model", "route-b/b-model"] });
  loadExtension();

  assert.deepEqual(getCustomModelKey(UTILITY_MODEL_KEY), ["route-a/a-model", "route-b/b-model"]);
});

await test("read: a scalar on disk stays a scalar", async () => {
  writeSettings({ [UTILITY_MODEL_KEY]: "route-a/a-model" });
  loadExtension();

  assert.equal(getCustomModelKey(UTILITY_MODEL_KEY), "route-a/a-model");
});

await test("read: a value with no usable pattern is left unset", async () => {
  writeSettings({ [UTILITY_MODEL_KEY]: ["", null, 42] });
  loadExtension();

  assert.equal(
    getCustomModelKey(UTILITY_MODEL_KEY),
    undefined,
    "an unusable value must not become a pattern that resolves to nothing",
  );
});

await test("write: a comma-separated argument stores the list form", async () => {
  writeSettings({});
  const commands = loadExtension();
  const ctx = makeCtx();

  await commands.get("utility-model").handler("route-a/a-model,route-b/b-model", ctx);

  assert.deepEqual(readSettings()[UTILITY_MODEL_KEY], ["route-a/a-model", "route-b/b-model"]);
  assert.deepEqual(getCustomModelKey(UTILITY_MODEL_KEY), ["route-a/a-model", "route-b/b-model"]);
});

await test("write: one argument stores the scalar form", async () => {
  writeSettings({});
  const commands = loadExtension();
  const ctx = makeCtx();

  await commands.get("utility-model").handler("route-a/a-model", ctx);

  assert.equal(readSettings()[UTILITY_MODEL_KEY], "route-a/a-model");
});

await test("write: an unmatched pattern is refused and the setting is left alone", async () => {
  writeSettings({ [UTILITY_MODEL_KEY]: "route-a/a-model" });
  const commands = loadExtension();
  const ctx = makeCtx();

  await commands.get("utility-model").handler("route-a/a-model,route-z/nope", ctx);

  assert.equal(readSettings()[UTILITY_MODEL_KEY], "route-a/a-model", "nothing may be written");
  assert.equal(
    ctx.notifications.some((n) => n.level === "error" && n.message.includes("route-z/nope")),
    true,
    "the refused pattern must be named",
  );
});

await test("write: an argument with no pattern is refused", async () => {
  writeSettings({ [UTILITY_MODEL_KEY]: "route-a/a-model" });
  const commands = loadExtension();
  const ctx = makeCtx();

  await commands.get("utility-model").handler(",", ctx);

  assert.equal(readSettings()[UTILITY_MODEL_KEY], "route-a/a-model", "nothing may be written");
  assert.equal(ctx.notifications.some((n) => n.level === "error"), true, "the refusal must be named");
});

await test("clear: the key leaves settings.json, not only memory", async () => {
  writeSettings({ [UTILITY_MODEL_KEY]: ["route-a/a-model", "route-b/b-model"] });
  const commands = loadExtension();
  const ctx = makeCtx();

  await commands.get("utility-model").handler("clear", ctx);

  assert.equal(getCustomModelKey(UTILITY_MODEL_KEY), undefined);
  assert.equal(
    UTILITY_MODEL_KEY in readSettings(),
    false,
    "a cleared key left on disk is resurrected by the next start",
  );
});

await test("clear: a scalar key is removed too, and other role keys survive", async () => {
  writeSettings({ [UTILITY_MODEL_KEY]: "route-a/a-model", [VISION_MODEL_KEY]: "route-b/b-model" });
  const commands = loadExtension();
  const ctx = makeCtx();

  await commands.get("utility-model").handler("clear", ctx);

  const settings = readSettings();
  assert.equal(UTILITY_MODEL_KEY in settings, false);
  assert.equal(settings[VISION_MODEL_KEY], "route-b/b-model", "an unrelated role key must survive");
});

await test("read: a legacy maxPowerModel loads as the canonical utility key", async () => {
  writeSettings({ [MAX_POWER_MODEL_KEY]: "route-a/a-model" });
  loadExtension();

  assert.equal(
    getCustomModelKey(UTILITY_MODEL_KEY),
    "route-a/a-model",
    "the deprecated key must load under the canonical key",
  );
});

await test("read: canonical utilityModel wins over the legacy key", async () => {
  writeSettings({
    [UTILITY_MODEL_KEY]: "route-a/a-model",
    [MAX_POWER_MODEL_KEY]: "route-b/b-model",
  });
  loadExtension();

  assert.equal(getCustomModelKey(UTILITY_MODEL_KEY), "route-a/a-model");
});

await test("write: a role write removes the legacy key from disk", async () => {
  writeSettings({ [MAX_POWER_MODEL_KEY]: "route-a/a-model" });
  const commands = loadExtension();
  const ctx = makeCtx();

  await commands.get("utility-model").handler("route-b/b-model", ctx);

  const settings = readSettings();
  assert.equal(settings[UTILITY_MODEL_KEY], "route-b/b-model");
  assert.equal(
    MAX_POWER_MODEL_KEY in settings,
    false,
    "a legacy key left on disk is resurrected by the next start",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== role-setting settings round trip passed ===");
