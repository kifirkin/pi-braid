/**
 * The maxPowerModel alias window has closed: the legacy key is not read.
 *
 * WHY THIS TEST EXISTS:
 *   The max-power role merged into the utility role. The old key loaded as the
 *   canonical one for one release, with a per-process deprecation notice, and
 *   any role write removed it from settings.json. That window is over: the
 *   command that could maintain the key, and the read that honored it, are
 *   gone. The failure this guards is a silent resurrection - a settings.json
 *   still carrying only the legacy key must leave the utility role unset (the
 *   session model then serves classifications), never half-restore a role
 *   whose command no longer exists.
 *
 * WHAT IS PINNED HERE:
 *   1. Read: settings with only maxPowerModel leave the utility role unset, so
 *      the documented session-model fallback applies.
 *   2. Read: the canonical key still loads, and the legacy key beside it
 *      contributes nothing.
 *   3. Resolve: a retired vision pin in the shared map is not consulted - the
 *      merged role's image-capable entry wins even when the pin names a
 *      text-only model, which is what a priority-1 key would have returned.
 *
 * PI_CODING_AGENT_DIR points at a temp dir before the dist modules load, so
 * neither pi's nor braid's settings path can touch the real agent directory.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const { resolveUtilityModel, resolveVisionModel } = await import(
  join(ROOT, "dist", "lib", "ai", "model-resolver.js")
);
const { getCustomModelKey, getCustomModelKeys, UTILITY_MODEL_KEY } = await import(
  join(ROOT, "dist", "lib", "state", "global-state.js")
);

const CATALOG = [
  { id: "a-model", provider: "route-a", api: "anthropic-messages", input: ["text"] },
  { id: "b-model", provider: "route-b", api: "anthropic-messages", input: ["text"] },
  { id: "look-model", provider: "route-c", api: "anthropic-messages", input: ["text", "image"] },
];
const SESSION = { id: "session-model-x", provider: "opencode-go", api: "anthropic-messages" };

function writeSettings(value) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(value, null, 2) + "\n", "utf-8");
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
  return {
    hasUI: false,
    model: SESSION,
    modelRegistry: {
      find: (provider, id) => CATALOG.find((m) => m.provider === provider && m.id === id),
      getAll: () => CATALOG,
      getAvailable: () => CATALOG,
    },
    ui: { notify() {} },
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

console.log("=== maxPowerModel alias retirement ===\n");

await test("read: a legacy-only key leaves the utility role unset", async () => {
  writeSettings({ maxPowerModel: "route-a/a-model" });
  loadExtension();

  assert.equal(
    getCustomModelKey(UTILITY_MODEL_KEY),
    undefined,
    "the retired key must not populate the canonical role",
  );
  assert.equal(
    resolveUtilityModel(makeCtx()),
    undefined,
    "an unset role resolves to nothing, so the session model serves the call",
  );
});

await test("read: the canonical key loads and ignores the legacy key beside it", async () => {
  writeSettings({ [UTILITY_MODEL_KEY]: "route-a/a-model", maxPowerModel: "route-b/b-model" });
  loadExtension();

  assert.equal(getCustomModelKey(UTILITY_MODEL_KEY), "route-a/a-model");
  assert.equal(resolveUtilityModel(makeCtx()), CATALOG[0], "only the canonical value resolves");
});

await test("resolve: a retired vision pin in the map is not consulted", async () => {
  // Priority-1 semantics would return the pinned model; it is text-only, so a
  // consulted pin resolves to nothing and the merged role would not be asked.
  getCustomModelKeys().set("visionModel", "route-a/a-model");
  getCustomModelKeys().set(UTILITY_MODEL_KEY, "route-c/look-model");

  assert.equal(
    resolveVisionModel(makeCtx()),
    CATALOG[2],
    "the merged role's image-capable entry must decide, not a retired pin",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== role merge alias retirement tests passed ===");
