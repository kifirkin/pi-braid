/**
 * `/analytics` is one command over three scopes, and no argument asks which.
 *
 * WHY THIS TEST EXISTS:
 *   Three names (`analytics`, `analytics:all`, `analytics:ab`) were three
 *   windows onto one object, and the colon form was indistinguishable from
 *   pi's duplicate-collision suffix. The fold leaves one command whose
 *   argument selects the scope and whose no-argument form asks in the TUI. The
 *   failure this test reads is the one the fold is meant to prevent: a second
 *   name surviving, or a no-argument form that opens a component (or a
 *   selector) on a path that runs headless and prints nothing.
 *
 * WHAT IS PINNED HERE:
 *   1. The registered set is `analytics` alone; both retired names are absent.
 *   2. No argument in the TUI calls `ui.select` exactly once with the three
 *      scopes, never `ui.custom`, and prints the chosen scope through the
 *      formatter that scope already owned.
 *   3. No argument headless prints the session scope and names the two other
 *      verbs, and calls neither `ui.select` nor `ui.custom`.
 *   4. The `all` verb prints the same block the TUI selection prints: both
 *      modes go through one formatter, not two.
 *   5. `session`, `all` and `ab` each print, and an unknown scope warns without
 *      opening anything.
 *
 * HOME, the agent directory and BRAID_HOME point at temp dirs before the dist
 * module loads, so the historical-scope formatter reads an empty metrics store
 * instead of the developer's.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const HOME = mkdtempSync(join(tmpdir(), "analytics-command-scope-home-"));
process.env.HOME = HOME;
process.env.PI_CODING_AGENT_DIR = join(HOME, ".pi", "agent");
process.env.BRAID_HOME = mkdtempSync(join(tmpdir(), "analytics-command-scope-braid-"));
process.chdir(mkdtempSync(join(tmpdir(), "analytics-command-scope-cwd-")));

const { default: analyticsExtension } = await import(
  join(ROOT, "dist", "extensions", "heartbeat", "analytics", "index.js")
);

const RETIRED = ["analytics:ab", "analytics:all"];

/** Load the extension the way pi does, capturing the commands it registers. */
function loadExtension() {
  const commands = new Map();
  const pi = {
    on() {},
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
  };
  analyticsExtension(pi);
  return commands;
}

/**
 * A command context that records both output paths. `scope` is what the TUI
 * selector returns; a case that must not select leaves it untouched.
 */
function makeCtx(mode, { scope } = {}) {
  const notices = [];
  const selects = [];
  let customCalls = 0;
  const ctx = {
    mode,
    hasUI: true,
    ui: {
      notify(message, type) {
        notices.push({ message, type });
      },
      select(title, options) {
        selects.push({ title, options });
        return Promise.resolve(scope);
      },
      custom() {
        customCalls++;
        return Promise.resolve(undefined);
      },
    },
  };
  return {
    ctx,
    notices,
    selects,
    get customCalls() {
      return customCalls;
    },
  };
}

test("the registered command set is analytics alone", () => {
  const names = [...loadExtension().keys()].sort();
  assert.deepEqual(names, ["analytics"], "one command owns all three scopes");
});

test("both retired names are absent", () => {
  const commands = loadExtension();
  for (const name of RETIRED) {
    assert.equal(commands.has(name), false, `${name} must not survive the fold`);
  }
});

test("TUI with no argument asks the scope once and prints the chosen block", async () => {
  const command = loadExtension().get("analytics");
  const tui = makeCtx("tui", { scope: "All sessions" });
  await command.handler("", tui.ctx);

  assert.equal(tui.selects.length, 1, "the no-argument TUI form asks exactly once");
  assert.deepEqual(
    tui.selects[0].options,
    ["This session", "All sessions", "A/B variants"],
    "the selector names all three scopes",
  );
  assert.equal(tui.customCalls, 0, "the selector is the surface, not a custom component");
  assert.equal(tui.notices.length, 1, "the chosen scope prints exactly one block");
  assert.match(tui.notices[0].message, /^## Tool Analytics - Historical Summary/);
});

test("headless with no argument prints the session scope and the other verbs", async () => {
  const command = loadExtension().get("analytics");
  const rpc = makeCtx("rpc");
  await command.handler("", rpc.ctx);

  assert.equal(rpc.selects.length, 0, "a headless caller has no selector to answer");
  assert.equal(rpc.customCalls, 0, "a headless caller has no component to render");
  assert.equal(rpc.notices.length, 1, "the default scope prints exactly one block");
  assert.match(rpc.notices[0].message, /^## Tool Analytics - Current Session/);
  assert.match(rpc.notices[0].message, /\/analytics all/);
  assert.match(rpc.notices[0].message, /\/analytics ab/);
});

test("the all verb prints the block the TUI selection prints", async () => {
  const command = loadExtension().get("analytics");
  const tui = makeCtx("tui", { scope: "All sessions" });
  await command.handler("", tui.ctx);

  const rpc = makeCtx("rpc");
  await command.handler("all", rpc.ctx);

  assert.equal(rpc.notices.length, 1);
  assert.equal(
    rpc.notices[0].message,
    tui.notices[0].message,
    "both surfaces must reach one formatter",
  );
});

test("each scope prints its own report", async () => {
  const cases = [
    ["session", /^## Tool Analytics - Current Session/],
    ["all", /^## Tool Analytics - Historical Summary/],
    ["ab", /^## A\/B Results/],
  ];
  for (const [scope, pattern] of cases) {
    const rpc = makeCtx("rpc");
    await loadExtension().get("analytics").handler(scope, rpc.ctx);
    assert.equal(rpc.notices.length, 1, `${scope} prints one block`);
    assert.match(rpc.notices[0].message, pattern);
  }
});

test("an unknown scope warns without opening a component", async () => {
  const rpc = makeCtx("rpc");
  await loadExtension().get("analytics").handler("everything", rpc.ctx);

  assert.equal(rpc.notices.length, 1);
  assert.equal(rpc.notices[0].type, "warning");
  assert.match(rpc.notices[0].message, /Usage: \/analytics \[session\|all\|ab\]/);
  assert.equal(rpc.selects.length, 0);
  assert.equal(rpc.customCalls, 0);
});
