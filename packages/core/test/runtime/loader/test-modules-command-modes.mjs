/**
 * `/modules` reaches the same writer from the TUI list and from RPC text.
 *
 * WHY THIS TEST EXISTS:
 *   A command whose no-argument form opens a component has two lives: a TUI
 *   session renders it, and RPC mode gets nothing because a custom component
 *   is never mounted. The fold made one handler for both: the TUI opens a
 *   SettingsList, RPC prints the same rows as text, and both toggle through
 *   the loader's single writer. This test drives both surfaces and compares
 *   what they wrote, so a mode guard that regresses to "open custom
 *   everywhere" or "notify nowhere" fails by name rather than in a session.
 *
 * WHAT IS PINNED HERE:
 *   1. TUI with no argument calls ctx.ui.custom exactly once and never notify.
 *   2. A toggle in that list reaches the loader writer: the effective state
 *      flips and the override lands in braid's store.
 *   3. RPC with no argument notifies the rows, never calls custom, and prints
 *      one line per extension, including where its state came from.
 *   4. An RPC verb writes through the same store file: both overrides are in
 *      one braid.modules document, so the two surfaces share the writer and
 *      its merge (the second write cannot drop the first).
 *
 * HOME, BRAID_HOME and cwd are pinned before the loader module loads: the
 * loader resolves its settings sources from HOME at import and its store from
 * the cwd, and a test must not touch the real agent tree.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const HOME = mkdtempSync(join(tmpdir(), "modules-modes-home-"));
const PROJECT = mkdtempSync(join(tmpdir(), "modules-modes-project-"));
process.env.HOME = HOME;
process.env.PI_CODING_AGENT_DIR = join(HOME, ".pi", "agent");
process.env.BRAID_HOME = mkdtempSync(join(tmpdir(), "modules-modes-braid-"));
delete process.env.BRAID_MODULES;
process.chdir(PROJECT);

const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme("dark");

const { default: modulesApiExtension } = await import(join(ROOT, "dist", "loader", "api.js"));
const loader = await import(join(ROOT, "dist", "loader", "loader.js"));
const { getEntry } = await import(join(ROOT, "dist", "extensions", "manifest.js"));
const braidPaths = await import(join(ROOT, "dist", "lib", "config", "braid-paths.js"));

const STORE_PATH = braidPaths.getModuleOverridesFilePath(PROJECT);

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
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A context that records notifications and opens at most one component. */
function makeCtx(mode) {
  const notices = [];
  const customCalls = [];
  let component = null;
  let finish = null;
  const ctx = {
    mode,
    hasUI: true,
    ui: {
      notify(message, type) {
        notices.push({ message, type });
      },
      custom(factory) {
        customCalls.push(factory);
        // A real dialog stays open until the user closes it; RPC has no user,
        // so resolve immediately. The count is what the assertions read: a
        // handler that opens a component in RPC still fails by name instead of
        // hanging the whole file on a promise nothing can settle.
        if (mode !== "tui") return Promise.resolve(undefined);
        return new Promise((resolve) => {
          finish = resolve;
          component = factory(
            { requestRender() {} },
            { fg: (_color, text) => text, bold: (text) => text },
            null,
            resolve,
          );
        });
      },
    },
  };
  return {
    ctx,
    notices,
    customCalls,
    getComponent: () => component,
    finish: () => finish && finish(),
  };
}

async function loadCommand() {
  const commands = new Map();
  await modulesApiExtension({
    on() {},
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
  });
  return commands.get("modules");
}

/** The first manifest entry a toggle can actually change. */
function firstMutable(states, exclude = []) {
  return Object.keys(states).find(
    (id) => !getEntry(id)?.alwaysOn && !exclude.includes(id),
  );
}

function readStore() {
  return JSON.parse(readFileSync(STORE_PATH, "utf-8"));
}

console.log("=== modules command modes ===\n");

const states = loader.getModuleStates();
const target = firstMutable(states);
const second = firstMutable(states, [target]);
const targetIndex = Object.keys(states).indexOf(target);

assert.ok(target, "the manifest must have a mutable extension to drive");
assert.ok(targetIndex < 18, "the driven row must be inside the first visible page");

await test("TUI with no argument opens the SettingsList once and does not notify", async () => {
  const modules = await loadCommand();
  const tui = makeCtx("tui");
  const run = modules.handler("", tui.ctx);
  await tick();

  assert.equal(tui.customCalls.length, 1, "the no-argument TUI form must open one component");
  assert.equal(tui.notices.length, 0, "the list is the output; it must not also notify a summary");
  assert.ok(tui.getComponent(), "the component factory must return a component");

  tui.finish();
  await run;
});

await test("a toggle in the TUI list writes through the loader's store", async () => {
  const modules = await loadCommand();
  const before = loader.getModuleStates()[target].enabled;
  const tui = makeCtx("tui");
  const run = modules.handler("", tui.ctx);
  await tick();

  const component = tui.getComponent();
  assert.equal(typeof component.handleMouse, "function", "the list must forward mouse input");
  // The list renders a two-line search field before its rows.
  component.handleMouse({ type: "click", button: "left", y: targetIndex + 2 });
  await tick();

  assert.equal(
    loader.getModuleStates()[target].enabled,
    !before,
    `"${target}" must flip in the effective state`,
  );
  assert.equal(
    readStore().braid.modules[target],
    !before,
    `"${target}" must be persisted to braid.modules`,
  );
  assert.equal(tui.notices.length, 0, "a successful toggle needs no error notice");

  tui.finish();
  await run;
});

await test("RPC with no argument notifies the rows and never calls custom", async () => {
  const modules = await loadCommand();
  const rpc = makeCtx("rpc");
  await modules.handler("", rpc.ctx);

  assert.equal(rpc.customCalls.length, 0, "RPC must not mount a component it cannot render");
  assert.equal(rpc.notices.length, 1, "RPC must print the rows exactly once");
  const text = rpc.notices[0].message;
  assert.match(text, /^Extensions \(\d+, config: /, "the text output names the row count and source");

  const rowCount = text.split("\n").filter((line) => /^ {2}(on|off)\b/.test(line)).length;
  assert.equal(rowCount, Object.keys(states).length, "one row per extension");
  assert.match(text, /\(manifest(; restart to apply)?\)/, "a row names where its state came from");
});

await test("an RPC verb writes through the same store the TUI used", async () => {
  const modules = await loadCommand();
  const rpc = makeCtx("rpc");
  await modules.handler(`off ${second}`, rpc.ctx);

  assert.equal(rpc.notices.length, 1, "the verb reports its result");
  assert.match(rpc.notices[0].message, new RegExp(`"${second}" disabled`));
  assert.equal(loader.getModuleStates()[second].enabled, false);

  const modulesBlock = readStore().braid.modules;
  assert.equal(modulesBlock[target], !states[target].enabled, "the TUI override survives");
  assert.equal(modulesBlock[second], false, "the RPC override lands in the same document");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== modules command modes tests passed ===");
