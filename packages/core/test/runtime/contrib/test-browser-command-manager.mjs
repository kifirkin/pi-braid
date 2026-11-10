/**
 * `/browser` is one manager over four intents, and its no-argument form is the
 * place the tab list's opt-in is stated.
 *
 * WHY THIS TEST EXISTS:
 *   The browser extension shipped four commands for one object
 *   (start, connect, disconnect, tabs), and the last one was invisible unless
 *   `braid.contrib.browserAdvanced` was on, with nothing saying so. The fold
 *   leaves one command: no argument shows the endpoint, the connection state,
 *   the active tab and the actions; a verb is the scripted form. The failure
 *   this test reads is a manager that silently omits the advanced tab list, or
 *   a no-argument form that opens a component on a path that runs headless.
 *
 * WHAT IS PINNED HERE:
 *   1. The registered command set is `browser` alone; the four retired names
 *      are absent.
 *   2. With `browserAdvanced` off, the TUI manager opens once and renders the
 *      endpoint, the state, the four actions, and the sentence naming the
 *      setting and the file to put it in.
 *   3. Headless no-argument prints the same facts as text, names the verbs,
 *      and calls neither `ui.custom` nor `ui.select`.
 *   4. The `tabs` verb with advanced off states the same fact instead of
 *      disappearing; an unknown verb warns without opening a component.
 *   5. With `browserAdvanced: true`, the manager drops the off sentence and
 *      carries every open tab as a row; the `tabs` verb lists that tab without
 *      spawning anything.
 *
 * HOME and the agent directory point at a temp dir before the contrib module
 * loads, so its settings readers see this test's document. The tab registry is
 * seeded through the module's own exported writer: a manager test must not
 * start Chrome to have a tab to show.
 */

import { register } from "node:module";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const HOME = mkdtempSync(join(tmpdir(), "browser-manager-home-"));
const SETTINGS_PATH = join(HOME, ".pi", "agent", "settings.json");
mkdirSync(join(HOME, ".pi", "agent"), { recursive: true });
process.env.HOME = HOME;
process.env.PI_CODING_AGENT_DIR = join(HOME, ".pi", "agent");
process.env.BRAID_HOME = mkdtempSync(join(tmpdir(), "browser-manager-braid-"));
delete process.env.BRAID_SESSION_ROLE;
process.chdir(mkdtempSync(join(tmpdir(), "browser-manager-cwd-")));

register(new URL("../../helpers/contrib-ts-loader.mjs", import.meta.url).href, import.meta.url);

const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme("dark");

const browserModule = await import(pathToFileURL(join(ROOT, "..", "contrib", "browser", "index.ts")).href);
const { default: browserExtension, addTab } = browserModule;

const RETIRED = ["browser-connect", "browser-disconnect", "browser-start", "browser-tabs"];
const TABS_OFF = /braid\.contrib\.browserAdvanced/;

/** Write the settings document the contrib extension reads at factory time. */
function writeSettings(document) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(document));
}

/** Load the extension the way pi does, capturing the commands it registers. */
function loadExtension() {
  const commands = new Map();
  const pi = {
    on() {},
    registerTool() {},
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
  };
  browserExtension(pi);
  return commands;
}

/**
 * A command context that records notifications and materializes at most one
 * component. The component is rendered for assertions; the dialog itself is
 * resolved immediately, so a handler never waits on a keypress no test types.
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
      select() {
        throw new Error("the browser manager must not use ui.select");
      },
      setStatus() {},
      theme,
      custom(factory) {
        customCalls++;
        component = factory({ requestRender() {} }, theme, null, () => {});
        return Promise.resolve(undefined);
      },
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

const rendered = (run) => run.getComponent().render(100).join("\n");

test("the registered command set is browser alone", () => {
  const names = [...loadExtension().keys()].sort();
  assert.deepEqual(names, ["browser"], "one command owns every browser intent");
});

test("the four retired names are absent", () => {
  const commands = loadExtension();
  for (const name of RETIRED) {
    assert.equal(commands.has(name), false, `${name} must not survive the fold`);
  }
});

test("TUI with no argument opens the manager once and names the setting that gates tabs", () => {
  writeSettings({});
  const tui = makeCtx("tui");
  const run = loadExtension()
    .get("browser")
    .handler("", tui.ctx);
  return run.then(() => {
    assert.equal(tui.customCalls, 1, "the no-argument TUI form opens one manager");
    assert.equal(tui.notices.length, 0, "the manager is the output");

    const text = rendered(tui);
    assert.match(text, /endpoint\s+http:\/\/127\.0\.0\.1:9222/);
    assert.match(text, /state\s+/, "the manager states the connection");
    assert.match(text, /active\s+/, "the manager states the active tab");
    for (const action of ["connect", "start", "start --profile", "disconnect"]) {
      assert.ok(text.includes(action), `the manager offers ${action}`);
    }
    assert.match(text, TABS_OFF, "advanced off must be stated, not silently missing");
    assert.match(text, /~\/\.pi\/agent\/settings\.json/, "the setting's file is named");
  });
});

test("headless with no argument prints the facts and never opens anything", () => {
  writeSettings({});
  const rpc = makeCtx("rpc");
  return loadExtension()
    .get("browser")
    .handler("", rpc.ctx)
    .then(() => {
      assert.equal(rpc.customCalls, 0, "a headless caller has no component to render");
      assert.equal(rpc.notices.length, 1, "the facts print exactly once");
      const text = rpc.notices[0].message;
      assert.match(text, /endpoint\s+http:\/\/127\.0\.0\.1:9222/);
      assert.match(text, /Usage: \/browser \[connect\|start \[--profile\]\|disconnect\|tabs\]/);
      assert.match(text, TABS_OFF);
    });
});

test("the tabs verb with advanced off states the same fact", () => {
  writeSettings({});
  const rpc = makeCtx("rpc");
  return loadExtension()
    .get("browser")
    .handler("tabs", rpc.ctx)
    .then(() => {
      assert.equal(rpc.customCalls, 0);
      assert.equal(rpc.notices.length, 1);
      assert.match(rpc.notices[0].message, TABS_OFF);
    });
});

test("an unknown verb warns without opening a component", () => {
  const rpc = makeCtx("rpc");
  return loadExtension()
    .get("browser")
    .handler("pause", rpc.ctx)
    .then(() => {
      assert.equal(rpc.notices.length, 1);
      assert.equal(rpc.notices[0].type, "warning");
      assert.match(rpc.notices[0].message, /Unknown browser action "pause"/);
      assert.equal(rpc.customCalls, 0);
    });
});

test("advanced on drops the off sentence and carries each open tab as a row", () => {
  writeSettings({ braid: { contrib: { browserAdvanced: true } } });
  addTab({
    id: "tab-1",
    url: "https://example.test/",
    title: "Example",
    client: { isConnected: true },
    active: true,
    createdAt: Date.now(),
  });

  const tui = makeCtx("tui");
  return loadExtension()
    .get("browser")
    .handler("", tui.ctx)
    .then(() => {
      const text = rendered(tui);
      assert.doesNotMatch(text, TABS_OFF, "the gate is stated only while it is off");
      assert.match(text, /tab:Example/, "an open tab is a row the manager can pick");
      assert.match(text, /tab-1/, "the row identifies the tab it switches to");
    });
});

test("advanced on: the tabs verb lists the open tab without spawning Chrome", () => {
  writeSettings({ braid: { contrib: { browserAdvanced: true } } });
  const rpc = makeCtx("rpc");
  return loadExtension()
    .get("browser")
    .handler("tabs", rpc.ctx)
    .then(() => {
      assert.equal(rpc.notices.length, 1);
      assert.match(rpc.notices[0].message, /\[1\] Example \(tab-1\)/);
      assert.equal(rpc.customCalls, 0);
    });
});
