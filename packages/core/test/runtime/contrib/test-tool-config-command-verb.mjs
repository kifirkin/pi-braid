/**
 * `/tools` owns tool state, and `status` is its verb rather than a second
 * command.
 *
 * WHY THIS TEST EXISTS:
 *   `tool-status` was a separate registration whose one line the `/tools`
 *   dialog already showed in place, so the palette offered two names for one
 *   object. The fold leaves one command: no argument is the interactive list
 *   (the text rows in RPC mode), `status` prints the same one-line report the
 *   old name printed. The failure this test reads is a `status` verb that
 *   opens the list on a path meant to be scripted, or a no-argument form that
 *   changed while gaining the verb.
 *
 * WHAT IS PINNED HERE:
 *   1. The registered set is `tools` alone; `tool-status` is absent.
 *   2. No argument in the TUI still opens the dialog once and notifies
 *      nothing; headless it still prints one row per tool.
 *   3. `status` prints exactly the old one-line report in both modes and never
 *      opens a component.
 *   4. An unknown verb warns and does not open the list on a typo.
 *
 * HOME and the agent directory point at a temp dir before the contrib module
 * loads, so its settings readers see this test's (empty) document.
 */

import { register } from "node:module";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const HOME = mkdtempSync(join(tmpdir(), "tools-command-verb-home-"));
process.env.HOME = HOME;
process.env.PI_CODING_AGENT_DIR = join(HOME, ".pi", "agent");
process.env.BRAID_HOME = mkdtempSync(join(tmpdir(), "tools-command-verb-braid-"));
delete process.env.BRAID_SESSION_ROLE;
process.chdir(mkdtempSync(join(tmpdir(), "tools-command-verb-cwd-")));

register(new URL("../../helpers/contrib-ts-loader.mjs", import.meta.url).href, import.meta.url);

const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme("dark");

const { default: toolConfigExtension } = await import(
  pathToFileURL(join(ROOT, "..", "contrib", "tool-config", "index.ts")).href
);

const TOOLS = [{ name: "read" }, { name: "write" }, { name: "tool_search" }];

/** Load the extension the way pi does, capturing the commands it registers. */
function loadExtension() {
  const commands = new Map();
  const pi = {
    on() {},
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerTool() {},
    getAllTools: () => TOOLS,
    getActiveTools: () => ["read"],
    setActiveTools() {},
  };
  toolConfigExtension(pi);
  return commands;
}

/**
 * A command context that records notifications and materializes at most one
 * component. The dialog is resolved immediately; a test never types a key.
 */
function makeCtx(mode) {
  const notices = [];
  let customCalls = 0;
  let component = null;
  const theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
  };
  const ctx = {
    mode,
    hasUI: true,
    ui: {
      notify(message, type) {
        notices.push({ message, type });
      },
      custom(factory) {
        customCalls++;
        component = factory({ requestRender() {} }, theme, null, () => {});
        return Promise.resolve(undefined);
      },
      setStatus() {},
      theme,
    },
  };
  return {
    ctx,
    notices,
    get customCalls() {
      return customCalls;
    },
    getComponent: () => component,
  };
}

test("the registered command set is tools alone", () => {
  const names = [...loadExtension().keys()].sort();
  assert.deepEqual(names, ["tools"], "one command owns tool state");
});

test("tool-status is absent", () => {
  assert.equal(loadExtension().has("tool-status"), false);
});

test("TUI with no argument still opens the dialog once and notifies nothing", async () => {
  const tui = makeCtx("tui");
  await loadExtension().get("tools").handler("", tui.ctx);

  assert.equal(tui.customCalls, 1, "the no-argument TUI form opens one dialog");
  assert.equal(tui.notices.length, 0, "the dialog is the output");
  const text = tui.getComponent().render(80).join("\n");
  for (const tool of TOOLS) assert.ok(text.includes(tool.name), `the list renders ${tool.name}`);
});

test("headless with no argument still prints one row per tool", async () => {
  const rpc = makeCtx("rpc");
  await loadExtension().get("tools").handler("", rpc.ctx);

  assert.equal(rpc.customCalls, 0, "a headless caller has no dialog to render");
  assert.equal(rpc.notices.length, 1);
  const text = rpc.notices[0].message;
  assert.match(text, /^Tools \(\d+ enabled, \d+ disabled\):/);
  for (const tool of TOOLS) assert.ok(text.includes(tool.name), `the text names ${tool.name}`);
});

test("status prints exactly the old one-line report in both modes", async () => {
  for (const mode of ["tui", "rpc"]) {
    const run = makeCtx(mode);
    await loadExtension().get("tools").handler("status", run.ctx);

    assert.equal(run.customCalls, 0, `status must not open the list in ${mode} mode`);
    assert.equal(run.notices.length, 1, `status reports once in ${mode} mode`);
    assert.equal(run.notices[0].message, "0 enabled, 3 disabled (version 0)");
  }
});

test("an unknown verb warns without opening the list", async () => {
  const rpc = makeCtx("rpc");
  await loadExtension().get("tools").handler("enabled", rpc.ctx);

  assert.equal(rpc.notices.length, 1);
  assert.equal(rpc.notices[0].type, "warning");
  assert.match(rpc.notices[0].message, /Usage: \/tools \[status\]/);
  assert.equal(rpc.customCalls, 0);
});
