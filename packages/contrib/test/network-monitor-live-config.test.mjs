/**
 * network-monitor-live-config.test.mjs - the extension entry point's wiring,
 * driven offline: live settings, capability-scoped refusals, and the
 * confirmation sequence that stands between a distress signal and a toggle.
 *
 * The failure mode this covers is the one where a settings edit was a no-op
 * until the process restarted: the entry point read its settings once at init,
 * so `braid.contrib.networkMonitor: false` (and every tunable with it) had no
 * effect on a running session. Here the same entry point is loaded with a
 * fake pi, a fake settings document, fake exec/sleep and fake timers, and the
 * settings document is edited between timer fires.
 *
 * Run with:
 *   node --experimental-strip-types --import ./test/lib/register-ts-resolve.mjs \
 *     test/network-monitor-live-config.test.mjs
 * (from packages/contrib). No real tunnel is touched: every command answers
 * from a local state object, and `scutil --nc start|stop` only flips that
 * state. The shipped adapter facts (bundle ids, profiles, process names) are
 * the test's fixtures on purpose: a drift in the adapter table shows up here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { formatLogBuffer, clearLogBuffer } from "../logger.js";

const V2RAYTUN_BUNDLE = "com.databridges.privacy.v2RayTun";
const HAPP_BUNDLE = "su.ffg.happ";

/** Both clients' NE profiles, as `scutil --nc list` prints them. */
const NC_LIST = [
  `* (Disconnected)   00000000-0000-4000-8000-000000000001 VPN (${V2RAYTUN_BUNDLE}) "v2RayTun" [VPN:${V2RAYTUN_BUNDLE}]`,
  `* (Connected)      00000000-0000-4000-8000-000000000002 VPN (${HAPP_BUNDLE}) "Happ" [VPN:${HAPP_BUNDLE}]`,
].join("\n");

const res = (code, stdout = "") => ({ stdout, stderr: "", code });

/** A fresh extension instance with every external seam faked. */
async function harness(initialDoc) {
  const { default: networkMonitorExtension } =
    await import("../network-monitor/index.ts");
  clearLogBuffer();

  const state = {
    reachable: true,
    neStatus: "Connected",
    appAlive: true,
    extAlive: true,
  };
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "scutil") {
      if (args[1] === "list") return res(0, NC_LIST);
      if (args[1] === "start") {
        state.reachable = true;
        state.neStatus = "Connected";
        return res(0);
      }
      if (args[1] === "stop") {
        state.reachable = false;
        state.neStatus = "Disconnected";
        return res(0);
      }
      return res(0, `${state.neStatus}\nExtended Status <dictionary> {\n`);
    }
    if (cmd === "curl") return res(0, state.reachable ? "302" : "000");
    if (cmd === "pgrep") {
      const alive = args.includes("-x") ? state.appAlive : state.extAlive;
      return res(alive ? 0 : 1);
    }
    if (cmd === "open") return res(0);
    throw new Error(`unexpected command: ${cmd}`);
  };

  const scheduled = [];
  const timers = {
    setTimeout: (cb, ms) => {
      const entry = { cb, ms, cleared: false };
      scheduled.push(entry);
      return entry;
    },
    clearTimeout: (entry) => {
      entry.cleared = true;
    },
  };

  let doc = initialDoc;
  let readError = null;
  const tools = new Map();
  const handlers = new Map();
  const notices = [];
  const ctx = {
    ui: { notify: (message) => notices.push(message) },
    sessionManager: { getSessionFile: () => "network-monitor-test-session" },
  };
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (event, handler) => {
      handlers.set(event, handler);
      return () => {};
    },
  };
  const deps = {
    exec,
    sleep: async () => {},
    timers,
    readSettingsDocument: () => {
      if (readError) throw readError;
      return doc;
    },
  };

  networkMonitorExtension(pi, deps);
  const settle = async () => {
    for (let i = 0; i < 25; i += 1) await delay(0);
  };
  const fireTimer = async () => {
    const entry = scheduled.find((s) => !s.cleared);
    assert.ok(entry, "no timer is pending");
    entry.cleared = true;
    entry.cb();
    await settle();
  };
  await settle();

  return {
    state,
    calls,
    tools,
    handlers,
    notices,
    ctx,
    scheduled,
    settle,
    fireTimer,
    setDoc: (next) => {
      doc = next;
    },
    setReadError: (err) => {
      readError = err;
    },
    count: (prefix) => calls.filter((c) => c.startsWith(prefix)).length,
  };
}

test("a monitor disabled at load still registers its tools, refuses them, and probes nothing", async () => {
  const env = await harness({ braid: { contrib: { networkMonitor: false } } });
  assert.equal(env.tools.size, 4, [...env.tools.keys()].join(","));
  const status = await env.tools.get("tunnel_status").execute("t", {});
  assert.match(status.content[0].text, /disabled in settings/);
  assert.equal(status.details.refused, true);
  assert.equal(env.count("curl"), 0, "no probe ran");
  assert.equal(env.count("scutil --nc stop"), 0);
  assert.match(formatLogBuffer(), /disabled via settings/);
});

test("a settings edit takes effect on the next tick, without a restart", async () => {
  const env = await harness({ braid: { contrib: { networkMonitor: false } } });
  env.setDoc({ braid: { contrib: { networkMonitor: { client: "happ" } } } });
  await env.fireTimer(); // the fire that stood down before
  assert.ok(
    env.calls.includes("pgrep -x Happ"),
    "the next tick probes the newly selected client",
  );
  assert.equal(
    env.count("pgrep -f"),
    0,
    "Happ has no separate extension process to check",
  );
  const status = await env.tools.get("tunnel_status").execute("t", {});
  assert.equal(status.details.client, "happ");
  assert.equal(status.details.extension_alive, null);
  assert.match(status.content[0].text, /^Happ: UP/);
});

test("a provider-abort signal never toggles by itself; K consecutive failed probes do", async () => {
  const env = await harness({
    braid: {
      contrib: { networkMonitor: { client: "happ", outageThreshold: 3 } },
    },
  });
  const toggles = () =>
    env.calls.filter(
      (c) => c === "scutil --nc stop Happ" || c === "scutil --nc start Happ",
    );
  assert.equal(toggles().length, 0);

  const before = env.count("curl");
  env.handlers.get("agent_settled")({ aborted: true });
  await env.settle();
  assert.equal(env.count("curl"), before + 1, "the signal probes");
  assert.equal(toggles().length, 0, "the signal alone toggles nothing");

  env.state.reachable = false;
  await env.fireTimer();
  assert.equal(toggles().length, 0, "one failed probe is a lag, not an outage");
  await env.fireTimer();
  assert.equal(toggles().length, 0, "two failed probes is still below K");
  await env.fireTimer();
  assert.deepEqual(
    toggles(),
    ["scutil --nc stop Happ", "scutil --nc start Happ"],
    "the K-th failed probe toggles through the client's own mechanism",
  );
});

test("disabling mid-run stops the monitor on the next tick; re-enabling resumes", async () => {
  const env = await harness({
    braid: { contrib: { networkMonitor: { client: "happ" } } },
  });
  env.state.reachable = false;
  await env.fireTimer(); // failure 1 of the confirmation sequence
  const before = env.count("curl");
  env.setDoc({ braid: { contrib: { networkMonitor: false } } });
  await env.fireTimer();
  assert.equal(env.count("curl"), before, "a disabled monitor probes nothing");
  env.setDoc({ braid: { contrib: { networkMonitor: { client: "happ" } } } });
  await env.fireTimer();
  assert.equal(env.count("curl"), before + 1, "re-enabling resumes watching");
});

test("a client that cannot be probed is refused and stands the watcher down", async () => {
  const env = await harness({
    braid: { contrib: { networkMonitor: { client: "incy" } } },
  });
  const status = await env.tools.get("tunnel_status").execute("t", {});
  assert.match(status.content[0].text, /cannot be probed/);
  assert.match(status.content[0].text, /bundleId/);
  assert.equal(env.count("curl"), 0, "nothing was probed");
  assert.match(formatLogBuffer(), /standing down/);
});

test("dry_run names the client's toggle mechanism and touches nothing", async () => {
  const env = await harness({
    braid: { contrib: { networkMonitor: { client: "happ" } } },
  });
  const out = await env.tools
    .get("tunnel_reconnect")
    .execute("t", { dry_run: true }, undefined, undefined, env.ctx);
  assert.match(out.content[0].text, /scutil --nc stop Happ/);
  assert.match(out.content[0].text, /scutil --nc start Happ/);
  assert.equal(out.details.toggled, false);
  assert.equal(env.count("scutil --nc stop"), 0);
});

test("a broken settings read keeps the last good configuration", async () => {
  const env = await harness({
    braid: { contrib: { networkMonitor: { client: "happ" } } },
  });
  env.setReadError(new Error("settings.json: Unexpected end of JSON input"));
  const status = await env.tools.get("tunnel_status").execute("t", {});
  assert.equal(
    status.details.client,
    "happ",
    "last good settings served the call",
  );
  assert.match(formatLogBuffer(), /keeping the last good configuration/);
});
