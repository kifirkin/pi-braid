/**
 * worker-egress.test.mjs: the session-role census, which outbound surface the
 * extension registers for each role.
 *
 * This extension is the agent's route to the owner, and a worker session runs
 * under the same owner bot token and chat id as the seat. So every surface the
 * factory registers is a route out of a worker into the owner's chat, and the
 * marker the orchestrator exports into a worker's pane shell
 * (BRAID_SESSION_ROLE=worker) has to leave a worker with none of them:
 *
 *   - tools:    telegram_send, telegram_inbox, telegram_poller
 *   - seams:    the watchdog tg-signal sender and the provider-outage notify
 *               sender: process-global slots other subsystems call directly
 *   - handlers: turn-complete auto-notify and the live-update tracker, which
 *               send through the same client on turn_end with no tool call
 *               (the TUI log sink is the one handler a worker keeps: it writes
 *               to the local notify channel and reaches nobody)
 *
 * The seat arm is the control: the same enumeration, with the marker unset and
 * every other variable identical, must find all three tools, both seams and
 * lifecycle handlers. A census that finds nothing in either arm would satisfy
 * the worker assertions while measuring nothing.
 *
 * The env carries a token in BOTH arms, so absence in the worker arm is the
 * role gate and not the if-has-token guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import telegramExtension, {
  ENV_CHAT_ID,
  ENV_LIVE_UPDATE_STATE_FILE,
  ENV_POLLER_LOCK_FILE,
  ENV_SESSION_ROLE,
  ENV_STATE_FILE,
  ENV_TOKEN,
  PROVIDER_OUTAGE_NOTIFY_KEY,
  TELEGRAM_POLLER_LIVENESS_KEY,
  WATCHDOG_TG_SIGNAL_KEY,
} from "../dist/index.js";
import { BOT_TOKEN, jsonResponse, makeFakeFetch } from "./fixtures.mjs";

/** Every surface the extension can reach the owner through, by class. */
const OUTBOUND_TOOLS = ["telegram_inbox", "telegram_poller", "telegram_send"];
const OUTBOUND_SEAMS = [WATCHDOG_TG_SIGNAL_KEY, PROVIDER_OUTAGE_NOTIFY_KEY];
const ALL_SEAMS = [...OUTBOUND_SEAMS, TELEGRAM_POLLER_LIVENESS_KEY];

/** Set process.env for the duration of fn, restoring every prior value after. */
function withEnv(pairs, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(pairs)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  let result;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === "function") {
    return result.finally(restore);
  }
  restore();
  return result;
}

/** Minimal pi-like surface the factory touches (same shape as index.test.mjs). */
function makeFakePi() {
  const handlers = new Map();
  const pi = {
    tools: [],
    commands: [],
    handlers,
    registerTool: (tool) => pi.tools.push(tool),
    registerCommand: (name, options) => pi.commands.push({ name, ...options }),
    sendUserMessage: () => {},
    on: (event, fn) =>
      handlers.set(event, [...(handlers.get(event) ?? []), fn]),
  };
  return pi;
}

function tmpDir(prefix) {
  const dir = join(
    tmpdir(),
    `tg-egress-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function tmpPath(prefix) {
  return join(tmpDir(prefix), "state.json");
}

/**
 * The env both arms run under: a token, pinned state/lock/live-update paths, and
 * nothing else role-bearing. `role` is the only difference between the arms.
 */
function baseEnv(role) {
  return {
    [ENV_TOKEN]: BOT_TOKEN,
    TELEGRAM_BOT_TOKEN: undefined,
    [ENV_STATE_FILE]: tmpPath("state"),
    TELEGRAM_STATE_FILE: undefined,
    [ENV_POLLER_LOCK_FILE]: tmpPath("lock"),
    TELEGRAM_POLLER_LOCK_FILE: undefined,
    [ENV_CHAT_ID]: "999888777",
    TELEGRAM_CHAT_ID: undefined,
    [ENV_LIVE_UPDATE_STATE_FILE]: tmpPath("live"),
    [ENV_SESSION_ROLE]: role,
  };
}

/** A fetch that answers every request with an empty getUpdates result. */
function emptyUpdatesFetch() {
  return makeFakeFetch(async () => jsonResponse({ ok: true, result: [] }));
}

/**
 * A child process that runs the factory against a boundary-only pi and prints
 * what it registered. The marker reaches this child the way it reaches a
 * worker: through the environment it is spawned with, not through a call.
 */
const CHILD_PROBE = `
const tools = [];
const handlers = [];
const pi = {
  registerTool: (tool) => tools.push(tool.name),
  registerCommand: () => {},
  sendUserMessage: () => {},
  on: (event) => handlers.push(event),
};
const mod = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
await mod.default(pi, {
  fetch: async () => new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }),
});
console.log(JSON.stringify({
  role: process.env.BRAID_SESSION_ROLE ?? null,
  tools: tools.sort(),
  watchdogSeam: typeof globalThis[mod.WATCHDOG_TG_SIGNAL_KEY],
  outageSeam: typeof globalThis[mod.PROVIDER_OUTAGE_NOTIFY_KEY],
  handlers: handlers.sort(),
}));
process.exit(0);
`;

/** Spawn the probe with the given marker value (undefined = unset). */
function runProbe(marker) {
  const env = {
    ...process.env,
    [ENV_TOKEN]: BOT_TOKEN,
    [ENV_STATE_FILE]: tmpPath("child-state"),
    [ENV_POLLER_LOCK_FILE]: tmpPath("child-lock"),
    [ENV_CHAT_ID]: "999888777",
    [ENV_LIVE_UPDATE_STATE_FILE]: tmpPath("child-live"),
    HOME: tmpDir("child-home"),
  };
  for (const alias of [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_STATE_FILE",
    "TELEGRAM_CHAT_ID",
    "TELEGRAM_POLLER_LOCK_FILE",
    "BRAID_TG_POLL_ENABLED",
    "BRAID_TG_POLL_DISABLED",
  ]) {
    delete env[alias];
  }
  if (marker === undefined) delete env[ENV_SESSION_ROLE];
  else env[ENV_SESSION_ROLE] = marker;
  const out = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", CHILD_PROBE],
    { encoding: "utf8", env },
  );
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.trim().split("\n").at(-1));
}

/** Clear the process-global slots so each arm reads only what it published. */
function clearSeams() {
  for (const key of ALL_SEAMS) delete globalThis[key];
}

test("the marker name is the literal the spawn instruction writes", () => {
  // The orchestrator's spawn-worker instruction names this variable in the pane
  // command; pinning the literal on this side is what makes a rename on either
  // end a red test instead of a silently inert gate.
  assert.equal(ENV_SESSION_ROLE, "BRAID_SESSION_ROLE");
});

test("seat (marker unset): three tools, both send seams, lifecycle handlers", async () => {
  clearSeams();
  const pi = makeFakePi();
  try {
    await withEnv(baseEnv(undefined), async () => {
      await telegramExtension(pi, { fetch: emptyUpdatesFetch() });
    });
    assert.deepEqual(
      pi.tools.map((tool) => tool.name).sort(),
      OUTBOUND_TOOLS,
      "the seat must register every outbound tool: the control arm of the census",
    );
    assert.equal(pi.commands.length, 1);
    for (const key of OUTBOUND_SEAMS) {
      assert.equal(
        typeof globalThis[key],
        "function",
        `the seat must publish the ${key} send seam`,
      );
    }
    assert.ok(
      pi.handlers.size > 0,
      "the seat registers lifecycle handlers (auto-notify / live-update send on turn_end)",
    );
  } finally {
    clearSeams();
  }
});

test("worker: no tool, no command, no send seam, no turn_end sender", async () => {
  clearSeams();
  const pi = makeFakePi();
  const fetchFn = emptyUpdatesFetch();
  try {
    await withEnv(baseEnv("worker"), async () => {
      await telegramExtension(pi, { fetch: fetchFn });
    });
    assert.deepEqual(pi.tools, [], "a worker session has no tool of its own");
    assert.deepEqual(
      pi.commands,
      [],
      "a worker session has no channel command",
    );
    for (const key of OUTBOUND_SEAMS) {
      assert.equal(
        globalThis[key],
        undefined,
        `${key} must not be published in a worker session: it sends without a tool call`,
      );
    }
    // The only handlers left are the TUI log sink bound before the role gate:
    // they write to the local notify channel and have no outbound path. The
    // turn_end senders (auto-notify, live-update) must be absent.
    assert.deepEqual(
      [...pi.handlers.keys()].sort(),
      ["session_shutdown", "session_start"],
      "the pre-gate log sink is the only handler a worker may have",
    );
    assert.equal(
      fetchFn.calls.length,
      0,
      "a worker session issues no bot API call",
    );
    // The read-only liveness probe stays published: a worker owns no poller, and
    // "stopped" is what the awareness row should read.
    assert.equal(
      typeof globalThis[TELEGRAM_POLLER_LIVENESS_KEY],
      "function",
      "the poller liveness probe is a read, not an outbound surface",
    );
    assert.equal(globalThis[TELEGRAM_POLLER_LIVENESS_KEY](), false);
  } finally {
    clearSeams();
  }
});

test("a spawned child: the marker in its environment is what the factory reads", async () => {
  const marked = runProbe("worker");
  assert.equal(
    marked.role,
    "worker",
    "the child sees the marker it was spawned with",
  );
  assert.deepEqual(marked.tools, []);
  assert.equal(marked.watchdogSeam, "undefined");
  assert.equal(marked.outageSeam, "undefined");
  assert.deepEqual(marked.handlers, ["session_shutdown", "session_start"]);

  // Control: the same child with the variable unset registers the seat surface.
  // Without this arm the assertions above would pass on a probe that never ran
  // the factory at all.
  const plain = runProbe(undefined);
  assert.equal(plain.role, null);
  assert.deepEqual(plain.tools, OUTBOUND_TOOLS);
  assert.equal(plain.watchdogSeam, "function");
  assert.equal(plain.outageSeam, "function");
  assert.ok(plain.handlers.includes("turn_end"));
});
