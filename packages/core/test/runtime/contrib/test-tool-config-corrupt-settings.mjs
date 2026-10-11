/**
 * /tools on a corrupt settings.json: no crash, one clear message, refusal kept.
 *
 * WHY THIS TEST EXISTS:
 *   The one-writer change made the settings writer refuse to clobber an
 *   unparseable settings.json by throwing. The /tools command
 *   (packages/contrib/tool-config) calls that writer from inside the
 *   SettingsList onChange callback, which the
 *   TUI input dispatch invokes synchronously with no catch. The throw escaped
 *   to pi's uncaughtException handler and exited the process with code 1: one
 *   toggle on a corrupt or zero-byte settings.json killed the session. The read
 *   side was silent in the other direction, showing "all tools enabled" as if
 *   nothing were saved.
 *
 * WHAT THIS GATES:
 *   - A toggle on a corrupt file returns normally, keeps the in-memory toggle,
 *     reports exactly one actionable message, and leaves the file untouched.
 *   - A session start on a corrupt file reports the unreadable settings once.
 *   - A genuinely missing file stays silent and writes normally.
 *
 * HOW IT DRIVES THE REAL HANDLER:
 *   packages/contrib is TypeScript with no build step, and its `pi-braid/lib`
 *   import would otherwise resolve to the main checkout. ./helpers/contrib-ts-loader.mjs
 *   redirects that import to this worktree's core dist and teaches the loader
 *   the `.js` -> `.ts` specifier fallback; the extension is then loaded and
 *   driven through a fake pi + ctx.
 *
 * Run: node test/runtime/contrib/test-tool-config-corrupt-settings.mjs
 */

import { register } from "node:module";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRIB_TOOL_CONFIG = join(HERE, "..", "..", "..", "..", "contrib", "tool-config", "index.ts");

register(new URL("../../helpers/contrib-ts-loader.mjs", import.meta.url).href, import.meta.url);

const SETTINGS_DIR = mkdtempSync(join(tmpdir(), "tool-config-corrupt-"));
process.env.PI_CODING_AGENT_DIR = SETTINGS_DIR;
const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");
const CORRUPT = "{ this is not json";

const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme("dark");
const { default: toolConfigExtension } = await import(pathToFileURL(CONTRIB_TOOL_CONFIG).href);

console.log("=== /tools on a corrupt settings.json ===\n");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function makeHarness() {
  const notifications = [];
  const setActiveToolsCalls = [];
  let sessionStart = null;
  const commands = new Map();
  const tools = [{ name: "read" }, { name: "write" }];

  const pi = {
    getAllTools: () => tools,
    getActiveTools: () => tools.map((t) => t.name),
    setActiveTools: (names) => setActiveToolsCalls.push(names),
    on: (event, fn) => {
      if (event === "session_start") sessionStart = fn;
    },
    registerCommand: (name, opts) => commands.set(name, opts),
  };

  toolConfigExtension(pi);
  return { notifications, setActiveToolsCalls, commands, runSessionStart: () => sessionStart };
}

/** ctx whose ui.custom captures the /tools component so a toggle can be driven. */
function dialogCtx(notifications) {
  let component = null;
  let finish = null;
  const ctx = {
    ui: {
      notify: (msg, type) => notifications.push({ msg, type }),
      custom: (factory) => {
        const promise = new Promise((resolve) => (finish = resolve));
        component = factory({ requestRender() {} }, { fg: (_c, t) => t, bold: (t) => t }, null, finish);
        return promise;
      },
    },
  };
  return { ctx, getComponent: () => component, finish: () => finish && finish() };
}

function seedCorrupt() {
  writeFileSync(SETTINGS_PATH, CORRUPT);
}

await test("a toggle on a corrupt settings.json survives and reports once", async () => {
  seedCorrupt();
  const h = makeHarness();
  const dialog = dialogCtx(h.notifications);
  const run = h.commands.get("tools").handler("", dialog.ctx);
  await tick();
  assert.ok(dialog.getComponent(), "the /tools dialog was created");
  assert.doesNotThrow(() => dialog.getComponent().handleInput(" "));
  dialog.finish();
  await run;

  assert.equal(h.notifications.length, 1, "exactly one message for the failed toggle");
  assert.equal(h.notifications[0].type, "error");
  assert.match(h.notifications[0].msg, /not saved/);
  assert.match(h.notifications[0].msg, /left unchanged/);
  assert.match(h.notifications[0].msg, /unreadable or not valid JSON/);
  assert.ok(h.setActiveToolsCalls.length >= 1, "the in-memory toggle was applied for the session");
  assert.equal(readFileSync(SETTINGS_PATH, "utf-8"), CORRUPT, "the corrupt file was left untouched");
});

await test("a session start on a corrupt settings.json reports it once", async () => {
  seedCorrupt();
  const h = makeHarness();
  const ctx = { ui: { notify: (msg, type) => h.notifications.push({ msg, type }) } };
  await h.runSessionStart()({}, ctx);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].type, "error");
  assert.match(h.notifications[0].msg, /unreadable or not valid JSON/);
  assert.match(h.notifications[0].msg, /keeps its default tool set/);
});

await test("a missing settings.json stays silent and a toggle writes the file", async () => {
  rmSync(SETTINGS_PATH, { force: true });
  const h = makeHarness();
  const dialog = dialogCtx(h.notifications);
  const run = h.commands.get("tools").handler("", dialog.ctx);
  await tick();
  dialog.getComponent().handleInput(" ");
  dialog.finish();
  await run;

  assert.equal(h.notifications.length, 0, "a missing file is not a failure");
  const saved = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  assert.deepEqual(saved.braid.contrib._global.enabled, ["read"]);
});

rmSync(SETTINGS_DIR, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== /tools corrupt-settings tests passed ===");
