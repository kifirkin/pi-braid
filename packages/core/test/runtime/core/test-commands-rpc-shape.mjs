/**
 * Every command wave one touched answers RPC mode with text, not silence.
 *
 * WHY THIS TEST EXISTS:
 *   Three of these commands opened a terminal component (or were assumed to
 *   need one) whose only mount point is the TUI. In RPC mode `ctx.ui.custom`
 *   is accepted and never rendered, so the handler returned normally and the
 *   caller saw nothing: no error, no output, no way to tell the command ran.
 *   The guard is `ctx.mode !== "tui"`, and the failure it prevents is a silent
 *   handler - which is exactly what this test reads: each RPC invocation must
 *   produce at least one notify, and never call custom.
 *
 * WHAT IS PINNED HERE:
 *   1. utility-model: RPC with no argument notifies the current setting and
 *      never opens the selector; the TUI path calls custom once. The same
 *      model argument writes the same settings.json value from either mode.
 *   2. utility-model completion names only models the registry reports as
 *      available: a model present in getAll() but absent from getAvailable()
 *      is never offered.
 *   3. logs: `clear` and `level` notify in both modes and leave the same
 *      buffer/level state; completion names its verbs and the level values.
 *   4. telegram: `status` and `disable` notify in both modes with the same
 *      text; completion names its verbs. (Its grammar is untouched, so the
 *      two modes share one code path.)
 *   5. tools: RPC prints one row per tool and never opens the dialog, while
 *      the TUI opens it once; both name the same tool set.
 *
 * The agent directory, braid root and Telegram state are pinned to temp dirs
 * before any dist module loads, and the Telegram token is a fixture: the
 * factory under test is the registered surface, not a live channel.
 */

import { register } from "node:module";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const HOME = mkdtempSync(join(tmpdir(), "commands-rpc-shape-home-"));
const AGENT_DIR = join(HOME, ".pi", "agent");
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");
process.env.HOME = HOME;
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.BRAID_HOME = mkdtempSync(join(tmpdir(), "commands-rpc-shape-braid-"));
process.env.BRAID_TG_BOT_TOKEN = "123456:fixture-token";
process.env.BRAID_TG_CHAT_ID = "42";
process.env.BRAID_TG_POLL_DISABLED = "1";
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
delete process.env.TELEGRAM_POLL_DISABLED;
// The fixture drives the registered surface, not a role gate: a worker-runtime
// environment would otherwise return before registering anything.
delete process.env.BRAID_SESSION_ROLE;
process.chdir(mkdtempSync(join(tmpdir(), "commands-rpc-shape-cwd-")));

register(
  new URL("../../helpers/contrib-ts-loader.mjs", import.meta.url).href,
  import.meta.url,
);

const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme("dark");

const { default: polyfillExtension } = await import(
  join(ROOT, "dist", "extensions", "core", "polyfill", "index.js")
);
const { default: healthExtension } = await import(
  join(ROOT, "dist", "extensions", "self", "health-maintenance", "index.js")
);
const { createLogger, getLogBuffer, setConsoleLogLevel } = await import(
  join(ROOT, "dist", "lib", "core", "logger.js")
);
const { default: toolConfigExtension } = await import(
  pathToFileURL(join(ROOT, "..", "contrib", "tool-config", "index.ts")).href
);
const { default: telegramExtension } = await import(
  pathToFileURL(join(ROOT, "..", "telegram", "src", "index.ts")).href
);

const MODELS = [
  { provider: "route-a", id: "a-model", api: "anthropic-messages" },
  { provider: "route-b", id: "b-model", api: "anthropic-messages" },
];
const HIDDEN = { provider: "route-h", id: "hidden-model", api: "anthropic-messages" };
const TOOLS = [{ name: "read" }, { name: "write" }, { name: "tool_search" }];

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

/** A pi surface just wide enough to load an extension and call its commands. */
function makePi() {
  const commands = new Map();
  const handlers = new Map();
  const pi = {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerTool() {},
    getAllTools: () => TOOLS,
    getActiveTools: () => ["read"],
    setActiveTools() {},
    appendEntry() {},
    sendUserMessage() {},
  };
  return { pi, commands };
}

/**
 * A ctx that records notifications. `runFactory` controls whether a component
 * factory is materialized: the selector is not driven here (its own tests
 * drive it), while the tools list is rendered so both outputs can be compared.
 */
function makeCtx(mode, { runFactory = false, models = MODELS } = {}) {
  const notices = [];
  let customCalls = 0;
  let component = null;
  const ctx = {
    mode,
    hasUI: true,
    model: undefined,
    modelRegistry: {
      getAvailable: () => models,
      getAll: () => [...models, HIDDEN],
      find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    },
    ui: {
      notify(message, type) {
        notices.push({ message, type });
      },
      custom(factory) {
        customCalls++;
        if (runFactory) {
          component = factory(
            { requestRender() {} },
            { fg: (_color, text) => text, bold: (text) => text },
            null,
            () => {},
          );
        }
        return Promise.resolve(undefined);
      },
    },
  };
  return { ctx, notices, get customCalls() { return customCalls; }, getComponent: () => component };
}

console.log("=== command RPC shape ===\n");

await test("utility-model: TUI opens the selector once, RPC notifies and never opens it", async () => {
  const { pi, commands } = makePi();
  polyfillExtension(pi);
  const command = commands.get("utility-model");
  assert.ok(command, "/utility-model must be registered");

  const tui = makeCtx("tui");
  await command.handler("", tui.ctx);
  assert.equal(tui.customCalls, 1, "the TUI form opens the selector");
  assert.equal(tui.notices.length, 0, "the selector is the output");

  const rpc = makeCtx("rpc");
  await command.handler("", rpc.ctx);
  assert.equal(rpc.customCalls, 0, "RPC must not open a component that never renders");
  assert.equal(rpc.notices.length, 1, "RPC must print the current setting");
  assert.match(rpc.notices[0].message, /Utility model/, "the text names the setting");
});

await test("utility-model: the same argument writes the same setting in both modes", async () => {
  const write = async (mode) => {
    const { pi, commands } = makePi();
    polyfillExtension(pi);
    const run = makeCtx(mode);
    await commands.get("utility-model").handler("route-a/a-model", run.ctx);
    assert.equal(run.notices.length, 1, "a successful set reports the resolved model");
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")).utilityModel;
  };

  const tuiValue = await write("tui");
  const rpcValue = await write("rpc");
  assert.equal(tuiValue, "route-a/a-model");
  assert.deepEqual(rpcValue, tuiValue, "both modes must persist the same value");
});

await test("utility-model completion names only models available to the registry", async () => {
  const { pi, commands } = makePi();
  polyfillExtension(pi);
  const command = commands.get("utility-model");
  const run = makeCtx("rpc");
  await command.handler("", run.ctx);

  const items = (await command.getArgumentCompletions("route-")) ?? [];
  const values = items.map((item) => item.value);
  assert.ok(values.includes("route-a/a-model"), "an available model is offered");
  assert.ok(values.includes("route-b/b-model"), "an available model is offered");
  assert.equal(
    values.some((value) => value.includes(HIDDEN.id)),
    false,
    "a model the registry does not report as available must not be offered",
  );
});

await test("logs: RPC clear notifies and both modes clear the same buffer", async () => {
  const { pi, commands } = makePi();
  healthExtension(pi);
  const command = commands.get("logs");
  assert.ok(command, "/logs must be registered");
  const logger = createLogger("rpc-shape-sentinel");

  logger.info("sentinel-rpc-entry");
  const rpc = makeCtx("rpc");
  await command.handler("clear", rpc.ctx);
  assert.equal(rpc.notices.length, 1, "clear reports in RPC mode");
  assert.equal(
    getLogBuffer().some((entry) => entry.message.includes("sentinel-rpc-entry")),
    false,
    "RPC clear empties the buffer",
  );

  logger.info("sentinel-tui-entry");
  const tui = makeCtx("tui");
  await command.handler("clear", tui.ctx);
  assert.equal(
    getLogBuffer().some((entry) => entry.message.includes("sentinel-tui-entry")),
    false,
    "TUI clear empties the buffer through the same call",
  );
});

await test("logs: level reports the same message in both modes, completion names the values", async () => {
  const { pi, commands } = makePi();
  healthExtension(pi);
  const command = commands.get("logs");
  const rpc = makeCtx("rpc");
  const tui = makeCtx("tui");
  await command.handler("level debug", rpc.ctx);
  await command.handler("level debug", tui.ctx);
  setConsoleLogLevel("none");
  assert.equal(rpc.notices.length, 1);
  assert.deepEqual(rpc.notices[0], tui.notices[0], "both modes report the same state change");

  const levelItems = (await command.getArgumentCompletions("level ")) ?? [];
  assert.deepEqual(
    levelItems.map((item) => item.value),
    ["level none", "level error", "level warn", "level info", "level debug"],
  );
  const clearItems = (await command.getArgumentCompletions("cl")) ?? [];
  assert.deepEqual(clearItems.map((item) => item.value), ["clear"]);
});

await test("telegram: status and disable notify in both modes with the same text", async () => {
  const { pi, commands } = makePi();
  await telegramExtension(pi, {
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, result: [] }) }),
  });
  const command = commands.get("telegram");
  assert.ok(command, "/telegram must be registered");

  const tui = makeCtx("tui");
  const rpc = makeCtx("rpc");
  await command.handler("status", tui.ctx);
  await command.handler("status", rpc.ctx);
  assert.equal(rpc.notices.length, 1, "status must print in RPC mode");
  assert.match(rpc.notices[0].message, /Telegram channel:/);
  assert.deepEqual(rpc.notices[0], tui.notices[0], "both modes report the same channel state");

  await command.handler("disable", rpc.ctx);
  assert.match(rpc.notices.at(-1).message, /poller (was )?not running/i);

  const items = (await command.getArgumentCompletions("en")) ?? [];
  assert.deepEqual(items.map((item) => item.value), ["enable"]);
});

await test("tools: RPC prints one row per tool while the TUI opens the list once", async () => {
  const { pi, commands } = makePi();
  toolConfigExtension(pi);
  const command = commands.get("tools");
  assert.ok(command, "/tools must be registered");

  const tui = makeCtx("tui", { runFactory: true });
  await command.handler("", tui.ctx);
  assert.equal(tui.customCalls, 1, "the TUI form opens the dialog");
  assert.equal(tui.notices.length, 0, "the dialog is the output");
  const rendered = tui.getComponent().render(80).join("\n");

  const rpc = makeCtx("rpc");
  await command.handler("", rpc.ctx);
  assert.equal(rpc.customCalls, 0, "RPC must not open a dialog that never renders");
  assert.equal(rpc.notices.length, 1, "RPC must print the tool rows");
  const text = rpc.notices[0].message;
  assert.match(text, /^Tools \(\d+ enabled, \d+ disabled\):/);

  for (const tool of TOOLS) {
    assert.ok(text.includes(tool.name), `the text names ${tool.name}`);
    assert.ok(rendered.includes(tool.name), `the list renders ${tool.name}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== command RPC shape tests passed ===");
