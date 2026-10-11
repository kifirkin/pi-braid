/**
 * Mocked tests for the v2raytun network-monitor core (v2raytun.ts).
 *
 * Run with: node --experimental-strip-types packages/contrib/network-monitor/test.ts
 * (from the pi-braid root). No real tunnel is touched: exec and sleep are
 * fully mocked. This is the build-time gate; the live reconnect test is the
 * orchestrator's job with the owner present.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireLock, DEFAULT_LOCK_TTL_MS } from "./lock.ts";
import { createLogFileSink } from "./log-file.ts";
import {
  createTunnelWatcher,
  parseNcList,
  probeText,
  probeTunnel,
  reconnectTunnel,
  startTunnelWatcher,
  type Deps,
  type ExecResult,
  type ProbeResult,
  type ReconnectOutcome,
  type WatcherDeps,
} from "./v2raytun.ts";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: string): void {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? `: ${detail}` : ""}`);
  } else {
    console.log(`  ok ${name}`);
  }
}

/** Flush microtasks deterministically. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function waitFor(pred: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries && !pred(); i += 1) await flush();
}

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nm-test-locks-"));
const lockPath = (name: string): string => path.join(TMP_DIR, `${name}.lock`);

const firstLine = (text: string): string => text.split("\n")[0] ?? "";

function countCalls(calls: string[], entry: string): number {
  return calls.filter((c) => c === entry).length;
}

function ok(code: number, stdout = ""): ExecResult {
  return { stdout, stderr: "", code };
}

/** Two app-owned NE profiles with OS-assigned names; the live one second. */
const TWO_PROFILE_LIST = [
  '* (Connected)      00000000-0000-4000-8000-000000000002 VPN (com.databridges.privacy.v2RayTun) "v2RayTun 2" [VPN:com.databridges.privacy.v2RayTun]',
  '* (Disconnected)   00000000-0000-4000-8000-000000000001 VPN (com.databridges.privacy.v2RayTun) "v2RayTun" [VPN:com.databridges.privacy.v2RayTun]',
].join("\n");

/** scutil --nc list output when only the anchor profile exists. */
const ANCHOR_LIST_LINE =
  '* (Disconnected)   00000000-0000-4000-8000-000000000001 VPN (com.databridges.privacy.v2RayTun) "v2RayTun" [VPN:com.databridges.privacy.v2RayTun]';

interface FakeExecOptions {
  /** scutil first-line status to return (anchor and unlisted profiles). */
  ncStatus: string;
  /** curl http code to return. */
  curlCode: string;
  /** pgrep exit code for the app (-x v2RayTun). */
  appExit: number;
  /** pgrep exit code for the extension (-f ...snextension). */
  extExit: number;
  /** After this many probe calls, scutil flips to Connected (for reconnect). */
  connectAfterProbes?: number;
  /** `open v2raytun://connect` flips scutil to Connected. */
  connectFlipsProfile?: boolean;
  /** `open v2raytun://connect` flips curl to 302. */
  connectFlipsRoute?: boolean;
  /** scutil --nc list output; defaults to the anchor profile alone. */
  ncList?: string;
  /** Per-profile statuses, e.g. a stale anchor beside a live sibling. */
  ncProfiles?: Record<string, string>;
}

function makeDeps(o: FakeExecOptions): {
  deps: Deps;
  calls: string[];
  sleeps: number[];
  setNcStatus: (s: string) => void;
  setCurlCode: (c: string) => void;
} {
  const calls: string[] = [];
  const sleeps: number[] = [];
  let probeCount = 0;
  let ncStatus = o.ncStatus;
  let curlCode = o.curlCode;
  const ncList = o.ncList ?? ANCHOR_LIST_LINE;

  const exec = async (cmd: string, args: string[]): Promise<ExecResult> => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "scutil") {
      if (args[1] === "list") return ok(0, ncList);
      probeCount += 1;
      if (
        o.connectAfterProbes !== undefined &&
        probeCount >= o.connectAfterProbes
      ) {
        return ok(0, "Connected\nExtended Status <dictionary> {\n");
      }
      const name = args[2] ?? "";
      const status = o.ncProfiles?.[name] ?? ncStatus;
      return ok(0, `${status}\nExtended Status <dictionary> {\n`);
    }
    if (cmd === "curl") return ok(0, curlCode);
    if (cmd === "pgrep") {
      const isApp = args.includes("-x");
      return ok(isApp ? o.appExit : o.extExit);
    }
    if (cmd === "open") {
      if (args[0] === "v2raytun://connect") {
        if (o.connectFlipsProfile) ncStatus = "Connected";
        if (o.connectFlipsRoute) curlCode = "302";
      }
      return ok(0);
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
  };
  return {
    deps: { exec, sleep },
    calls,
    sleeps,
    setNcStatus: (s: string) => {
      ncStatus = s;
    },
    setCurlCode: (c: string) => {
      curlCode = c;
    },
  };
}

const baseOpts = {
  profileName: "v2RayTun",
  reachabilityUrl: "https://api.telegram.org",
  curlTimeoutSecs: 6,
};

console.log("probe: connected + reachable + both alive");
{
  const { deps } = makeDeps({
    ncStatus: "Connected",
    curlCode: "302",
    appExit: 0,
    extExit: 0,
  });
  const r = await probeTunnel(baseOpts, deps);
  check("status Connected", r.profileStatus === "Connected", r.profileStatus);
  check("reachable", r.reachable, r.reachabilityCode);
  check("app alive", r.appAlive);
  check("extension alive", r.extensionAlive);
  check("not down", !r.down);
  check("not routeOnlyDrop", !r.routeOnlyDrop);
}

console.log("probe: disconnected -> down");
{
  const { deps } = makeDeps({
    ncStatus: "Disconnected",
    curlCode: "000",
    appExit: 0,
    extExit: 0,
  });
  const r = await probeTunnel(baseOpts, deps);
  check("status Disconnected", r.profileStatus === "Disconnected");
  check("down", r.down);
  check("not reachable", !r.reachable);
}

console.log("probe: connected but unreachable -> route-only drop");
{
  const { deps } = makeDeps({
    ncStatus: "Connected",
    curlCode: "000",
    appExit: 0,
    extExit: 0,
  });
  const r = await probeTunnel(baseOpts, deps);
  check("down (route is ground truth)", r.down);
  check("routeOnlyDrop", r.routeOnlyDrop, String(r.routeOnlyDrop));
}

console.log("probe: app and extension dead");
{
  const { deps } = makeDeps({
    ncStatus: "Connected",
    curlCode: "302",
    appExit: 1,
    extExit: 1,
  });
  const r = await probeTunnel(baseOpts, deps);
  check("app dead", !r.appAlive);
  check("extension dead", !r.extensionAlive);
}

console.log("probe: unknown status line");
{
  const { deps } = makeDeps({
    ncStatus: "weird output",
    curlCode: "302",
    appExit: 0,
    extExit: 0,
  });
  const r = await probeTunnel(baseOpts, deps);
  check("status unknown", r.profileStatus === "unknown", r.profileStatus);
  check("not down while the route answers", !r.down);
}

console.log("probe: connected sibling profile wins over the stale anchor");
{
  const { deps } = makeDeps({
    ncStatus: "Disconnected",
    curlCode: "302",
    appExit: 0,
    extExit: 0,
    ncList: TWO_PROFILE_LIST,
    ncProfiles: { "v2RayTun 2": "Connected" },
  });
  const r = await probeTunnel(baseOpts, deps);
  check(
    "reports the connected sibling",
    r.profileName === "v2RayTun 2",
    r.profileName,
  );
  check("status Connected", r.profileStatus === "Connected");
  check(
    "both profiles enumerated",
    r.profiles.length === 2,
    String(r.profiles.length),
  );
  check("not down", !r.down);
  const text = probeText(r);
  check(
    "verdict UP, never DOWN",
    text.startsWith("v2RayTun: UP") && !text.includes("DOWN"),
    firstLine(text),
  );
}

console.log(
  "probe: profile Disconnected + route up -> UP with both facts separate",
);
{
  const { deps } = makeDeps({
    ncStatus: "Disconnected",
    curlCode: "302",
    appExit: 0,
    extExit: 0,
  });
  const r = await probeTunnel(baseOpts, deps);
  check("reachable", r.reachable);
  check("not down", !r.down);
  check("not routeOnlyDrop", !r.routeOnlyDrop);
  const text = probeText(r);
  check(
    "never DOWN when the URL answers",
    !text.includes("DOWN"),
    firstLine(text),
  );
  check(
    "profile fact still reported",
    text.includes("NE profile Disconnected"),
    firstLine(text),
  );
}

console.log("probe: profile Connected + route dead -> route-only drop is DOWN");
{
  const { deps } = makeDeps({
    ncStatus: "Connected",
    curlCode: "000",
    appExit: 0,
    extExit: 0,
  });
  const r = await probeTunnel(baseOpts, deps);
  check("down", r.down);
  check("routeOnlyDrop", r.routeOnlyDrop);
  const text = probeText(r);
  check(
    "verdict names the route-only drop",
    text.includes("DOWN") && text.includes("route-only drop"),
    firstLine(text),
  );
}

console.log(
  "probe: scutil --nc list parsing uses OS names, not an assumed one",
);
{
  const parsed = parseNcList(
    TWO_PROFILE_LIST,
    "com.databridges.privacy.v2RayTun",
  );
  check("two app profiles parsed", parsed.length === 2, String(parsed.length));
  check(
    "names come from the list",
    parsed.map((p) => p.name).join(",") === "v2RayTun 2,v2RayTun",
    parsed.map((p) => p.name).join(","),
  );
  check(
    "statuses parsed",
    parsed[0].status === "Connected" && parsed[1].status === "Disconnected",
  );
}

console.log("reconnect: sequence and success");
{
  const { deps, calls, sleeps } = makeDeps({
    ncStatus: "Disconnected",
    curlCode: "000",
    appExit: 0,
    extExit: 0,
    connectAfterProbes: 2, // first probe still Disconnected, second Connected
    connectFlipsRoute: true, // the deep-link cycle brings the route back
  });
  const r = await reconnectTunnel(
    {
      ...baseOpts,
      disconnectDelayMs: 2000,
      connectTimeoutMs: 30000,
      pollIntervalMs: 100,
      lockFile: lockPath("sequence"),
    },
    deps,
  );
  check("reconnect ok", r.ok, r.reason);
  check(
    "disconnect link opened",
    calls.some((c) => c === "open v2raytun://disconnect"),
  );
  check(
    "connect link opened",
    calls.some((c) => c === "open v2raytun://connect"),
  );
  check(
    "disconnect before connect",
    calls.indexOf("open v2raytun://disconnect") <
      calls.indexOf("open v2raytun://connect"),
  );
  check(
    "sleep between disconnect and connect",
    sleeps.length >= 1 && sleeps[0] === 2000,
    `sleeps=${sleeps.join(",")}`,
  );
  check("final probe Connected", r.final?.profileStatus === "Connected");
}

console.log("reconnect: timeout when tunnel never comes up");
{
  const { deps } = makeDeps({
    ncStatus: "Disconnected",
    curlCode: "000",
    appExit: 0,
    extExit: 0,
  });
  const r = await reconnectTunnel(
    {
      ...baseOpts,
      disconnectDelayMs: 10,
      connectTimeoutMs: 250,
      pollIntervalMs: 50,
      lockFile: lockPath("timeout"),
    },
    deps,
  );
  check("reconnect not ok", !r.ok, r.reason);
  check("final probe still down", r.final?.down === true);
  check("made multiple attempts", r.attempts >= 2, `attempts=${r.attempts}`);
}

console.log("reconnect: probe-before-toggle skips an up tunnel");
{
  const { deps, calls } = makeDeps({
    ncStatus: "Connected",
    curlCode: "302",
    appExit: 0,
    extExit: 0,
  });
  const r = await reconnectTunnel(
    {
      ...baseOpts,
      disconnectDelayMs: 5,
      connectTimeoutMs: 100,
      pollIntervalMs: 5,
      lockFile: lockPath("skip"),
    },
    deps,
  );
  check("ok", r.ok, r.reason);
  check("skipped", r.skipped === true, r.reason);
  check(
    "no deep link opened",
    calls.every((c) => !c.startsWith("open ")),
    calls.join(","),
  );
  check("final probe up", r.final !== null && !r.final.down);
}

console.log("reconnect: route still dead after the toggle is not success");
{
  const { deps, calls } = makeDeps({
    ncStatus: "Disconnected",
    curlCode: "000",
    appExit: 0,
    extExit: 0,
    connectFlipsProfile: true, // the app reports Connected, the route stays dead
  });
  const r = await reconnectTunnel(
    {
      ...baseOpts,
      disconnectDelayMs: 1,
      connectTimeoutMs: 60,
      pollIntervalMs: 5,
      lockFile: lockPath("routedeadd"),
    },
    deps,
  );
  check("not ok", !r.ok, r.reason);
  check(
    "route is the reason",
    /route still unreachable/.test(r.reason),
    r.reason,
  );
  check(
    "final is a route-only drop",
    r.final?.routeOnlyDrop === true,
    String(r.final?.profileStatus),
  );
  check(
    "toggle was attempted (pre-probe found it down)",
    calls.some((c) => c === "open v2raytun://disconnect"),
  );
}

console.log(
  "lock: concurrent reconnect cycles serialize; the second is refused",
);
{
  const env = makeDeps({
    ncStatus: "Disconnected",
    curlCode: "000",
    appExit: 0,
    extExit: 0,
    connectFlipsProfile: true,
    connectFlipsRoute: true,
  });
  let releaseFirstDisconnect: (() => void) | null = null;
  const firstDisconnectGate = new Promise<void>((resolve) => {
    releaseFirstDisconnect = resolve;
  });
  let disconnectCalls = 0;
  const deps: Deps = {
    exec: async (cmd, args) => {
      if (
        cmd === "open" &&
        args[0] === "v2raytun://disconnect" &&
        disconnectCalls++ === 0
      ) {
        await firstDisconnectGate;
      }
      return env.deps.exec(cmd, args);
    },
    sleep: env.deps.sleep,
  };
  const opts = {
    ...baseOpts,
    disconnectDelayMs: 1,
    connectTimeoutMs: 200,
    pollIntervalMs: 5,
    lockFile: lockPath("shared"),
  };
  const first = reconnectTunnel(opts, deps);
  await waitFor(() => fs.existsSync(opts.lockFile));
  const second = await reconnectTunnel(opts, deps);
  check(
    "second refused",
    !second.ok && second.lockHeld === true,
    second.reason,
  );
  check(
    "refusal names the lock",
    second.reason.includes("lock held"),
    second.reason,
  );
  check(
    "second toggled nothing",
    countCalls(env.calls, "open v2raytun://disconnect") === 0,
    env.calls.join(","),
  );
  const release = releaseFirstDisconnect as unknown as () => void;
  release();
  const firstResult = await first;
  check(
    "first cycle completes after release",
    firstResult.ok,
    firstResult.reason,
  );
  check("lockfile removed on release", !fs.existsSync(opts.lockFile));
}

console.log("lock: TTL - fresh refuses, release frees, stale is stolen");
{
  const p = lockPath("ttl");
  const a = acquireLock(p);
  check("first acquire wins", a.acquired);
  const b = acquireLock(p);
  check(
    "fresh lock refuses",
    !b.acquired && /by pid /.test(b.reason),
    b.acquired ? "" : b.reason,
  );
  if (a.acquired) a.release();
  check("release removes the file", !fs.existsSync(p));
  const c = acquireLock(p);
  check("acquirable after release", c.acquired);
  if (c.acquired) c.release();

  fs.writeFileSync(p, JSON.stringify({ pid: 999999, ts: 1000 }));
  const stale = acquireLock(p, { now: () => 1000 + DEFAULT_LOCK_TTL_MS + 1 });
  check("stale lock stolen", stale.acquired);
  check(
    "stolen lock carries our pid",
    (JSON.parse(fs.readFileSync(p, "utf-8")) as { pid: number }).pid ===
      process.pid,
  );
  if (stale.acquired) stale.release();
}

console.log(
  "log sink: append-only, and a broken path disables instead of throwing",
);
{
  const p = path.join(TMP_DIR, "sink", "monitor.log");
  const sink = createLogFileSink(p);
  check("sink created", sink !== null);
  sink?.append("info", "first line");
  sink?.append("warn", "second line");
  const text = fs.readFileSync(p, "utf-8");
  check(
    "both lines appended",
    text.includes("first line") && text.includes("second line"),
    text.trim(),
  );
  check("levels recorded", /\bINFO\b/.test(text) && /\bWARN\b/.test(text));
  check("timestamps recorded", /^\d{4}-\d{2}-\d{2}T/.test(text.trim()));
  check("no path -> no sink", createLogFileSink("") === null);
  const broken = createLogFileSink(path.join(p, "beneath-a-file.log"));
  let threw = false;
  try {
    broken?.append("info", "nope");
  } catch {
    threw = true;
  }
  check("broken sink swallows write errors", !threw && broken !== null);
}

// Watcher (autoWatch) tests

function mkProbe(down: boolean, routeOnlyDrop = false): ProbeResult {
  const status = routeOnlyDrop
    ? "Connected"
    : down
      ? "Disconnected"
      : "Connected";
  return {
    profileStatus: status,
    profileName: "v2RayTun",
    profileRaw: status,
    profiles: [{ name: "v2RayTun", status, raw: status }],
    reachabilityCode: down ? "000" : "200",
    reachable: !down,
    appAlive: true,
    extensionAlive: true,
    down,
    routeOnlyDrop,
    detail: down ? "down" : "up",
  };
}

console.log(
  "watcher: UP→DOWN triggers exactly one reconnect flow with verify-after probe",
);
{
  const env = makeDeps({
    ncStatus: "Connected",
    curlCode: "302",
    appExit: 0,
    extExit: 0,
    connectFlipsProfile: true,
    connectFlipsRoute: true,
  });
  let probeCalls = 0;
  const info: string[] = [];
  const w = createTunnelWatcher(
    {
      autoReconnect: true,
      maxAttemptsPerOutage: 3,
      reconnectCooldownMs: 60_000,
    },
    {
      probe: async () => {
        probeCalls += 1;
        return probeTunnel(baseOpts, env.deps);
      },
      reconnect: () =>
        reconnectTunnel(
          {
            ...baseOpts,
            disconnectDelayMs: 5,
            connectTimeoutMs: 100,
            pollIntervalMs: 5,
            lockFile: lockPath("watch-heal"),
          },
          env.deps,
        ),
      sleep: env.deps.sleep,
      log: (m) => info.push(m),
    },
  );
  await w.tick(); // baseline UP
  check("baseline probe ran", probeCalls === 1, String(probeCalls));
  check(
    "no reconnect while up",
    countCalls(env.calls, "open v2raytun://disconnect") === 0,
  );
  env.setNcStatus("Disconnected");
  env.setCurlCode("000"); // the drop takes the route down with it
  await w.tick(); // UP->DOWN -> outage; the deep-link cycle brings both facts back
  check(
    "one disconnect link",
    countCalls(env.calls, "open v2raytun://disconnect") === 1,
  );
  check(
    "one connect link",
    countCalls(env.calls, "open v2raytun://connect") === 1,
  );
  check("verify-after probe ran", probeCalls === 3, String(probeCalls));
  check(
    "state back to up",
    w.state.lastDown === false && w.state.attempts === 0,
  );
  check(
    "recovery logged",
    info.some((m) => m.includes("recovered after reconnect")),
  );
  await w.tick(); // still up → nothing
  check(
    "no reconnect while still up",
    countCalls(env.calls, "open v2raytun://disconnect") === 1,
  );
}

console.log(
  "watcher: cooldown between attempts, attempt cap, warn after cap, no hammering",
);
{
  const env = makeDeps({
    ncStatus: "Disconnected",
    curlCode: "000",
    appExit: 0,
    extExit: 0,
  });
  const warn: string[] = [];
  const notices: string[] = [];
  const w = createTunnelWatcher(
    { autoReconnect: true, maxAttemptsPerOutage: 3, reconnectCooldownMs: 500 },
    {
      probe: () => probeTunnel(baseOpts, env.deps),
      reconnect: () =>
        reconnectTunnel(
          {
            ...baseOpts,
            disconnectDelayMs: 1,
            connectTimeoutMs: 0,
            pollIntervalMs: 5,
            lockFile: lockPath("watch-cap"),
          },
          env.deps,
        ),
      sleep: env.deps.sleep,
      log: () => {},
      warn: (m) => warn.push(m),
      notify: (m) => notices.push(m),
    },
  );
  await w.tick(); // baseline already down → outage, 3 attempts
  check(
    "exactly maxAttempts reconnect flows",
    countCalls(env.calls, "open v2raytun://disconnect") === 3,
  );
  check(
    "cooldown sleep between attempts",
    env.sleeps.filter((s) => s === 500).length === 2,
  );
  check(
    "warn logged after cap",
    warn.length === 1 && /persists after 3/.test(warn[0]),
    warn.join("|"),
  );
  check("attempts capped", w.state.attempts === 3 && w.state.lastDown === true);
  await w.tick(); // still down, no transition → no action
  check(
    "no hammering on later down probes",
    countCalls(env.calls, "open v2raytun://disconnect") === 3,
  );
  check("no second warn", warn.length === 1);
  check(
    "stand-down surfaced to the TUI",
    notices.length === 1 && /standing down/.test(notices[0]),
    notices.join("|"),
  );
}

console.log(
  "watcher: DOWN→UP resets attempt counter; second outage re-attempts",
);
{
  const env = makeDeps({
    ncStatus: "Disconnected",
    curlCode: "000",
    appExit: 0,
    extExit: 0,
  });
  const warn: string[] = [];
  let reconnectCalls = 0;
  const w = createTunnelWatcher(
    { autoReconnect: true, maxAttemptsPerOutage: 2, reconnectCooldownMs: 10 },
    {
      probe: () => probeTunnel(baseOpts, env.deps),
      reconnect: async () => {
        reconnectCalls += 1;
        return {
          ok: false,
          attempts: 0,
          final: null,
          reason: "injected failure",
        };
      },
      sleep: env.deps.sleep,
      log: () => {},
      warn: (m) => warn.push(m),
    },
  );
  await w.tick(); // baseline down → outage: 2 attempts
  check("first outage attempts", reconnectCalls === 2, String(reconnectCalls));
  env.setNcStatus("Connected");
  env.setCurlCode("302"); // recovery means the route answers again
  await w.tick(); // DOWN->UP -> recovery, reset
  check(
    "attempts reset on recovery",
    w.state.attempts === 0 && w.state.lastDown === false,
  );
  env.setNcStatus("Disconnected");
  env.setCurlCode("000");
  await w.tick(); // UP->DOWN -> fresh outage
  check(
    "second outage re-attempts",
    reconnectCalls === 4,
    String(reconnectCalls),
  );
  check(
    "second outage capped again",
    w.state.attempts === 2 && warn.length === 2,
  );
}

console.log(
  "watcher: route-only drop triggers the outage path; recovery resets it",
);
{
  const env = makeDeps({
    ncStatus: "Connected",
    curlCode: "000",
    appExit: 0,
    extExit: 0,
  });
  let reconnectCalls = 0;
  const w = createTunnelWatcher(
    { autoReconnect: true, maxAttemptsPerOutage: 1, reconnectCooldownMs: 10 },
    {
      probe: () => probeTunnel(baseOpts, env.deps),
      reconnect: async () => {
        reconnectCalls += 1;
        env.setCurlCode("302"); // the deep-link cycle restored the route
        return { ok: true, attempts: 1, final: null, reason: "test" };
      },
      sleep: env.deps.sleep,
      log: () => {},
    },
  );
  const baseline = await probeTunnel(baseOpts, env.deps);
  check(
    "probe is a route-only drop",
    baseline.routeOnlyDrop &&
      baseline.down &&
      baseline.profileStatus === "Connected",
  );
  await w.tick();
  check("route-only drop triggered the outage path", reconnectCalls === 1);
  check(
    "recovered when the route returned",
    w.state.lastDown === false && w.state.attempts === 0,
  );
}

console.log(
  "watcher: a route-dead reconnect is not success; stand-down reaches the TUI",
);
{
  const env = makeDeps({
    ncStatus: "Disconnected",
    curlCode: "000",
    appExit: 0,
    extExit: 0,
    connectFlipsProfile: true, // the profile heals, the route stays dead
  });
  const warn: string[] = [];
  const notices: string[] = [];
  const w = createTunnelWatcher(
    { autoReconnect: true, maxAttemptsPerOutage: 1, reconnectCooldownMs: 10 },
    {
      probe: () => probeTunnel(baseOpts, env.deps),
      reconnect: () =>
        reconnectTunnel(
          {
            ...baseOpts,
            disconnectDelayMs: 1,
            connectTimeoutMs: 20,
            pollIntervalMs: 5,
            lockFile: lockPath("watch-routedeadd"),
          },
          env.deps,
        ),
      sleep: env.deps.sleep,
      log: () => {},
      warn: (m) => warn.push(m),
      notify: (m) => notices.push(m),
    },
  );
  await w.tick();
  check("still down after a route-dead reconnect", w.state.lastDown === true);
  check(
    "warn after cap",
    warn.length === 1 && /persists after 1/.test(warn[0]),
    warn.join("|"),
  );
  check(
    "stand-down surfaced to the TUI",
    notices.length === 1 && /standing down/.test(notices[0]),
    notices.join("|"),
  );
}

console.log(
  "watcher: concurrent outage cycles serialize on the lock; the second logs lock held",
);
{
  const env = makeDeps({
    ncStatus: "Disconnected",
    curlCode: "000",
    appExit: 0,
    extExit: 0,
    connectFlipsProfile: true,
    connectFlipsRoute: true,
  });
  let releaseFirstDisconnect: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseFirstDisconnect = resolve;
  });
  let disconnectCalls = 0;
  const deps: Deps = {
    exec: async (cmd, args) => {
      if (
        cmd === "open" &&
        args[0] === "v2raytun://disconnect" &&
        disconnectCalls++ === 0
      ) {
        await gate;
      }
      return env.deps.exec(cmd, args);
    },
    sleep: env.deps.sleep,
  };
  const opts = {
    ...baseOpts,
    disconnectDelayMs: 1,
    connectTimeoutMs: 200,
    pollIntervalMs: 5,
    lockFile: lockPath("watch-serial"),
  };
  const outcomes: ReconnectOutcome[] = [];
  const logB: string[] = [];
  const watcherA = createTunnelWatcher(
    { autoReconnect: true, maxAttemptsPerOutage: 1, reconnectCooldownMs: 10 },
    {
      probe: () => probeTunnel(baseOpts, deps),
      reconnect: () => reconnectTunnel(opts, deps),
      sleep: env.deps.sleep,
      log: () => {},
    },
  );
  const watcherB = createTunnelWatcher(
    { autoReconnect: true, maxAttemptsPerOutage: 1, reconnectCooldownMs: 10 },
    {
      probe: () => probeTunnel(baseOpts, deps),
      reconnect: async () => {
        const outcome = await reconnectTunnel(opts, deps);
        outcomes.push(outcome);
        return outcome;
      },
      sleep: env.deps.sleep,
      log: (m) => logB.push(m),
    },
  );
  const tickA = watcherA.tick(); // holds the lock, parked on the gated disconnect
  await waitFor(() => fs.existsSync(opts.lockFile));
  await watcherB.tick(); // refused: one attempt, capped, stands down
  check(
    "second cycle refused on the lock",
    outcomes.length === 1 && outcomes[0].lockHeld === true,
    JSON.stringify(outcomes),
  );
  check(
    "second cycle logged lock held",
    logB.some((m) => m.includes("lock held")),
    logB.join("|"),
  );
  check(
    "second cycle toggled nothing",
    countCalls(env.calls, "open v2raytun://disconnect") === 0,
    env.calls.join(","),
  );
  const release = releaseFirstDisconnect as unknown as () => void;
  release();
  await tickA;
  check("first cycle recovered", watcherA.state.lastDown === false);
  check(
    "lockfile released after the first cycle",
    !fs.existsSync(opts.lockFile),
  );
}

console.log(
  "watcher: autoWatch false → no timer, no probe; true → timer + stop clears",
);
{
  const created: number[] = [];
  const cleared: unknown[] = [];
  let createdCb: (() => void) | undefined = undefined;
  const timers = {
    created,
    cleared,
    setInterval: (cb: () => void, ms: number) => {
      createdCb = cb;
      created.push(ms);
      return {};
    },
    clearInterval: (t: unknown) => {
      cleared.push(t);
    },
  };
  let probeCalls = 0;
  const deps: WatcherDeps = {
    probe: async () => {
      probeCalls += 1;
      return mkProbe(false);
    },
    reconnect: async () => ({
      ok: true,
      attempts: 0,
      final: null,
      reason: "test",
    }),
    sleep: async () => {},
  };
  const off = startTunnelWatcher(
    {
      autoWatch: false,
      probeIntervalMs: 1000,
      autoReconnect: true,
      maxAttemptsPerOutage: 3,
      reconnectCooldownMs: 1000,
    },
    deps,
    timers,
  );
  check("no handle when autoWatch false", off === null);
  check(
    "no timer created",
    timers.created.length === 0 && createdCb === undefined,
  );
  await flush();
  check("no probe ran", probeCalls === 0, String(probeCalls));

  const on = startTunnelWatcher(
    {
      autoWatch: true,
      probeIntervalMs: 1234,
      autoReconnect: true,
      maxAttemptsPerOutage: 3,
      reconnectCooldownMs: 1000,
    },
    deps,
    timers,
  );
  check(
    "timer created with probeIntervalMs",
    timers.created.length === 1 && timers.created[0] === 1234,
  );
  await flush();
  check("initial probe ran", probeCalls === 1, String(probeCalls));
  on?.stop();
  check("stop clears timer", timers.cleared.length === 1);
}

console.log("watcher: in-flight guard skips probe ticks during reconnect");
{
  let probeCalls = 0;
  let reconnectCalls = 0;
  let probeDown = true;
  let releaseReconnect: (() => void) | null = null;
  const info: string[] = [];
  const w = createTunnelWatcher(
    { autoReconnect: true, maxAttemptsPerOutage: 3, reconnectCooldownMs: 1000 },
    {
      probe: async () => {
        probeCalls += 1;
        return mkProbe(probeDown);
      },
      reconnect: async () => {
        reconnectCalls += 1;
        await new Promise<void>((resolve) => {
          releaseReconnect = resolve;
        });
        return { ok: true, attempts: 1, final: null, reason: "released" };
      },
      sleep: async () => {},
      log: (m) => info.push(m),
    },
  );
  const first = w.tick(); // down → outage starts, reconnect hangs
  await flush();
  check("reconnect in flight", w.state.inFlight && reconnectCalls === 1);
  await w.tick(); // probe tick while in flight → skipped
  check("skipped tick did not probe", probeCalls === 1, String(probeCalls));
  check("skipped tick did not reconnect", reconnectCalls === 1);
  check(
    "skip logged",
    info.some((m) => m.includes("skipped")),
  );
  probeDown = false;
  const release = releaseReconnect as (() => void) | null; // assigned inside executor; widen past CFA
  release?.();
  await first;
  check("verify-after ran after release", probeCalls === 2, String(probeCalls));
  check(
    "recovered and released inFlight",
    w.state.lastDown === false && !w.state.inFlight,
  );
}

console.log(`\n${checks} checks, ${failures} failures`);
if (failures > 0) process.exit(1);
