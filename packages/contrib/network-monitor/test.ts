/**
 * Mocked tests for the client-agnostic tunnel core (tunnel.ts), the per-client
 * adapter table (clients.ts), and the live settings source (settings.ts).
 *
 * Run with: node --experimental-strip-types packages/contrib/network-monitor/test.ts
 * (from the pi-braid root). No real tunnel is touched: exec and sleep are
 * fully mocked. This is the build-time gate; the live reconnect test is the
 * orchestrator's job with the owner present.
 *
 * The mechanism tests use a synthetic client (the FACTS below) so the shared
 * layer's tests carry no vendor name; the adapter tests assert the shipped
 * facts and the fail-closed gate. The v2raytun fixture values match the
 * adapter's own, so a drift between them is visible.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireLock, DEFAULT_LOCK_TTL_MS } from "./lock.ts";
import { createLogFileSink } from "./log-file.ts";
import {
  TUNNEL_CLIENTS,
  isClientId,
  missingFacts,
  operableClient,
  probeClient,
  probeRefusal,
  toggleRefusal,
  wellFormedToggle,
  type ToggleMechanism,
  type TunnelClientAdapter,
} from "./clients.ts";
import {
  createLiveSettings,
  parseSettings,
  DEFAULTS,
  type SettingsDocument,
} from "./settings.ts";
import {
  createTunnelWatcher,
  describeToggle,
  parseNcList,
  probeText,
  probeTunnel,
  reconnectTunnel,
  startTunnelWatcher,
  togglePlan,
  type Deps,
  type ExecResult,
  type ProbeResult,
  type ReconnectOutcome,
  type WatchFrame,
  type WatcherDeps,
  type WatcherSettings,
} from "./tunnel.ts";

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

/** Synthetic client facts used by the mechanism tests (no vendor name). */
const FACTS = {
  displayName: "TestTunnel",
  bundleId: "test.bundle.id",
  profileName: "TestTunnel",
  appProcess: "testtunnel",
  extensionProcess: "test.bundle.id.ext",
};

/** Synthetic clients used by the adapter-shape tests. */
const LINK_TOGGLE: Extract<ToggleMechanism, { kind: "link" }> = {
  kind: "link",
  connect: "testtunnel://connect",
  disconnect: "testtunnel://disconnect",
};
const NE_PROFILE_TOGGLE: Extract<ToggleMechanism, { kind: "ne-profile" }> = {
  kind: "ne-profile",
  profile: "TestTunnel",
};

/** A plain adapter for shape tests; overrides select the capability gaps. */
function adapterOf(
  overrides: Partial<TunnelClientAdapter>,
): TunnelClientAdapter {
  return {
    id: "happ",
    displayName: "Fixture",
    bundleId: FACTS.bundleId,
    profileName: FACTS.profileName,
    appProcess: FACTS.appProcess,
    extensionProcess: FACTS.extensionProcess,
    toggle: LINK_TOGGLE,
    validation: "fixture",
    installHint: null,
    ...overrides,
  };
}

/** Two app-owned NE profiles with OS-assigned names; the live one second. */
const TWO_PROFILE_LIST = [
  `* (Connected)      00000000-0000-4000-8000-000000000002 VPN (${FACTS.bundleId}) "TestTunnel 2" [VPN:${FACTS.bundleId}]`,
  `* (Disconnected)   00000000-0000-4000-8000-000000000001 VPN (${FACTS.bundleId}) "TestTunnel" [VPN:${FACTS.bundleId}]`,
].join("\n");

/** scutil --nc list output when only the anchor profile exists. */
const ANCHOR_LIST_LINE = `* (Disconnected)   00000000-0000-4000-8000-000000000001 VPN (${FACTS.bundleId}) "TestTunnel" [VPN:${FACTS.bundleId}]`;

interface FakeExecOptions {
  /** scutil first-line status to return (anchor and unlisted profiles). */
  ncStatus: string;
  /** curl http code to return. */
  curlCode: string;
  /** pgrep exit code for the app (-x pattern). */
  appExit: number;
  /** pgrep exit code for the extension (-f pattern). */
  extExit: number;
  /** After this many probe calls, scutil flips to Connected (for reconnect). */
  connectAfterProbes?: number;
  /** `open <fixture connect link>` flips scutil to Connected. */
  connectFlipsProfile?: boolean;
  /** `open <fixture connect link>` flips curl to 302. */
  connectFlipsRoute?: boolean;
  /** `scutil --nc start <profile>` flips scutil to Connected. */
  startFlipsProfile?: boolean;
  /** `scutil --nc start <profile>` flips curl to 302. */
  startFlipsRoute?: boolean;
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
      if (args[1] === "start") {
        if (o.startFlipsProfile) ncStatus = "Connected";
        if (o.startFlipsRoute) curlCode = "302";
        return ok(0);
      }
      if (args[1] === "stop") return ok(0);
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
      if (args[0] === LINK_TOGGLE.connect) {
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
  ...FACTS,
  reachabilityUrl: "https://api.telegram.org",
  curlTimeoutSecs: 6,
};

console.log("probe: connected + reachable + both alive");
{
  const { deps, calls } = makeDeps({
    ncStatus: "Connected",
    curlCode: "302",
    appExit: 0,
    extExit: 0,
  });
  const r = await probeTunnel(baseOpts, deps);
  check("status Connected", r.profileStatus === "Connected", r.profileStatus);
  check("reachable", r.reachable, r.reachabilityCode);
  check("app alive", r.appAlive);
  check("extension alive", r.extensionAlive === true);
  check("not down", !r.down);
  check("not routeOnlyDrop", !r.routeOnlyDrop);
  check(
    "app pattern comes from the options",
    calls.some((c) => c === `pgrep -x ${FACTS.appProcess}`),
    calls.join(","),
  );
  check(
    "extension pattern comes from the options",
    calls.some((c) => c === `pgrep -f ${FACTS.extensionProcess}`),
    calls.join(","),
  );
  check(
    "verdict line carries the display name",
    firstLine(probeText(r)).startsWith(`${FACTS.displayName}: UP`),
    firstLine(probeText(r)),
  );
}

console.log(
  "probe: a client with no separate extension process skips that leg",
);
{
  const { deps, calls } = makeDeps({
    ncStatus: "Connected",
    curlCode: "302",
    appExit: 0,
    extExit: 0,
  });
  const r = await probeTunnel({ ...baseOpts, extensionProcess: null }, deps);
  check(
    "no pgrep -f ran",
    calls.every((c) => !c.startsWith("pgrep -f")),
    calls.join(","),
  );
  check("extension liveness is not applicable", r.extensionAlive === null);
  check(
    "detail says not applicable",
    r.detail.includes("extension: n/a"),
    r.detail,
  );
  check("still up when the route answers", !r.down);
}

console.log(
  "probe: an appex path pattern with no live process is dead, not skipped",
);
{
  // Happ's extension leg: the appex bundle path is the pattern the probe
  // hands to `pgrep -f`, and a host where that process is gone must report
  // the leg dead rather than fall back to the not-applicable path.
  const pattern = TUNNEL_CLIENTS.happ.extensionProcess ?? "";
  const { deps, calls } = makeDeps({
    ncStatus: "Connected",
    curlCode: "302",
    appExit: 0,
    extExit: 1,
  });
  const r = await probeTunnel({ ...baseOpts, extensionProcess: pattern }, deps);
  check(
    "the appex pattern is the one probed",
    pattern.length > 0 && calls.some((c) => c === `pgrep -f ${pattern}`),
    calls.join(","),
  );
  check("extension liveness is false, not n/a", r.extensionAlive === false);
  check(
    "detail does not claim not applicable",
    !r.detail.includes("extension: n/a"),
    r.detail,
  );
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
  check("extension dead", r.extensionAlive === false);
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
    ncProfiles: { "TestTunnel 2": "Connected" },
  });
  const r = await probeTunnel(baseOpts, deps);
  check(
    "reports the connected sibling",
    r.profileName === "TestTunnel 2",
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
    text.startsWith("TestTunnel: UP") && !text.includes("DOWN"),
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
  const parsed = parseNcList(TWO_PROFILE_LIST, FACTS.bundleId);
  check("two app profiles parsed", parsed.length === 2, String(parsed.length));
  check(
    "names come from the list",
    parsed.map((p) => p.name).join(",") === "TestTunnel 2,TestTunnel",
    parsed.map((p) => p.name).join(","),
  );
  check(
    "statuses parsed",
    parsed[0].status === "Connected" && parsed[1].status === "Disconnected",
  );
}

console.log("adapters: capability-scoped, mechanism carried as data");
{
  const v = TUNNEL_CLIENTS.v2raytun;
  check("v2raytun probe refusal is null", probeRefusal(v) === null);
  check("v2raytun toggle refusal is null", toggleRefusal(v) === null);
  check("v2raytun narrows to an operable client", operableClient(v) !== null);
  check(
    "v2raytun bundle id is the host app's",
    v.bundleId === "com.databridges.privacy.v2RayTun",
    String(v.bundleId),
  );
  check(
    "v2raytun toggle is the app's deep links",
    v.toggle?.kind === "link" &&
      v.toggle.connect === "v2raytun://connect" &&
      v.toggle.disconnect === "v2raytun://disconnect",
  );
  check(
    "v2raytun process patterns match the live processes",
    v.appProcess === "v2RayTun" &&
      v.extensionProcess === "com.databridges.privacy.v2RayTun.snextension",
  );

  const h = TUNNEL_CLIENTS.happ;
  check("happ can be probed", probeRefusal(h) === null);
  check(
    "happ extension leg probes the appex bundle path",
    h.extensionProcess === "Happ.app/Contents/PlugIns/Tunnel.appex",
    String(h.extensionProcess),
  );
  check(
    "happ probe facts are the host-validated ones",
    h.bundleId === "su.ffg.happ" &&
      h.profileName === "Happ" &&
      h.appProcess === "Happ",
    `${h.bundleId}/${h.profileName}/${h.appProcess}`,
  );
  check(
    "happ toggle is its NE profile, not a deep link",
    h.toggle?.kind === "ne-profile" && h.toggle.profile === "Happ",
    JSON.stringify(h.toggle),
  );
  check("happ narrows to an operable client", operableClient(h) !== null);

  const i = TUNNEL_CLIENTS.incy;
  const iProbe = probeRefusal(i);
  const iToggle = toggleRefusal(i);
  check("incy cannot be probed on this host", iProbe !== null);
  check(
    "incy probe refusal names the machine facts",
    (iProbe ?? "").includes("bundleId") &&
      (iProbe ?? "").includes("appProcess"),
    iProbe ?? "",
  );
  check("incy cannot be toggled either", iToggle !== null);
  check(
    "incy toggle refusal names the missing probe facts",
    (iToggle ?? "").includes("bundleId"),
    iToggle ?? "",
  );
  check(
    "incy links are the documented ones",
    i.toggle?.kind === "link" &&
      i.toggle.connect === "incy://connect" &&
      i.toggle.disconnect === "incy://disconnect",
  );
  check(
    "incy refusal carries the install command",
    (iProbe ?? "").includes("brew install --cask incy"),
    iProbe ?? "",
  );
  check(
    "incy does not narrow to an operable client",
    operableClient(i) === null,
  );

  // Capability scoping: a probe-only client probes but never toggles.
  const probeOnly = adapterOf({
    id: "incy",
    toggle: null,
    validation: "fixture: no toggle mechanism",
  });
  check("probe-only client can be probed", probeClient(probeOnly) !== null);
  check(
    "probe-only client has no probe refusal",
    probeRefusal(probeOnly) === null,
  );
  check(
    "probe-only client cannot be toggled",
    toggleRefusal(probeOnly) !== null,
  );
  check(
    "probe-only client is not operable",
    operableClient(probeOnly) === null,
  );
  check(
    "probe capability ignores the extension process",
    missingFacts(adapterOf({ extensionProcess: null }), "probe").length === 0,
  );
  check(
    "toggle capability demands a mechanism",
    missingFacts(adapterOf({ toggle: null }), "toggle").join(",") ===
      "toggle mechanism",
    missingFacts(adapterOf({ toggle: null }), "toggle").join(","),
  );
  const emptyLink = adapterOf({
    toggle: { kind: "link", connect: "", disconnect: "x" },
  });
  check(
    "an empty link is not a mechanism",
    !wellFormedToggle(emptyLink.toggle),
  );
  check("an empty link refuses toggling", toggleRefusal(emptyLink) !== null);
  check(
    "a null mechanism refuses toggling",
    toggleRefusal(adapterOf({ toggle: null })) !== null,
  );
  check("a complete mechanism is well formed", wellFormedToggle(LINK_TOGGLE));

  check(
    "client id validation",
    isClientId("v2raytun") &&
      isClientId("happ") &&
      isClientId("incy") &&
      !isClientId("nope"),
  );
}

console.log("mechanism: link and NE-profile toggles plan different commands");
{
  const link = togglePlan(LINK_TOGGLE);
  check(
    "link toggle opens the disconnect link first",
    link.disconnect.cmd === "open" &&
      link.disconnect.args[0] === LINK_TOGGLE.disconnect,
  );
  check(
    "link toggle opens the connect link second",
    link.connect.cmd === "open" && link.connect.args[0] === LINK_TOGGLE.connect,
  );
  const ne = togglePlan(NE_PROFILE_TOGGLE);
  check(
    "NE-profile toggle stops the profile",
    ne.disconnect.cmd === "scutil" &&
      ne.disconnect.args.join(" ") === "--nc stop TestTunnel",
    ne.disconnect.args.join(" "),
  );
  check(
    "NE-profile toggle starts the profile",
    ne.connect.cmd === "scutil" &&
      ne.connect.args.join(" ") === "--nc start TestTunnel",
    ne.connect.args.join(" "),
  );
  check(
    "describeToggle reads like the commands it runs",
    describeToggle(NE_PROFILE_TOGGLE) ===
      "scutil --nc stop TestTunnel then scutil --nc start TestTunnel",
    describeToggle(NE_PROFILE_TOGGLE),
  );
  check(
    "describeToggle quotes a single-arg command",
    describeToggle(LINK_TOGGLE) ===
      'open "testtunnel://disconnect" then open "testtunnel://connect"',
    describeToggle(LINK_TOGGLE),
  );
}

console.log("reconnect: sequence and success (deep-link mechanism)");
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
      toggle: LINK_TOGGLE,
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
    calls.some((c) => c === `open ${LINK_TOGGLE.disconnect}`),
  );
  check(
    "connect link opened",
    calls.some((c) => c === `open ${LINK_TOGGLE.connect}`),
  );
  check(
    "disconnect before connect",
    calls.indexOf(`open ${LINK_TOGGLE.disconnect}`) <
      calls.indexOf(`open ${LINK_TOGGLE.connect}`),
  );
  check(
    "sleep between disconnect and connect",
    sleeps.length >= 1 && sleeps[0] === 2000,
    `sleeps=${sleeps.join(",")}`,
  );
  check("final probe Connected", r.final?.profileStatus === "Connected");
}

console.log("reconnect: the NE-profile mechanism drives scutil, not links");
{
  const { deps, calls } = makeDeps({
    ncStatus: "Disconnected",
    curlCode: "000",
    appExit: 0,
    extExit: 0,
    startFlipsProfile: true,
    startFlipsRoute: true,
  });
  const r = await reconnectTunnel(
    {
      ...baseOpts,
      toggle: NE_PROFILE_TOGGLE,
      disconnectDelayMs: 1,
      connectTimeoutMs: 200,
      pollIntervalMs: 5,
      lockFile: lockPath("mechanism"),
    },
    deps,
  );
  check("reconnect ok", r.ok, r.reason);
  check(
    "profile stopped before it is started",
    calls.indexOf("scutil --nc stop TestTunnel") >= 0 &&
      calls.indexOf("scutil --nc stop TestTunnel") <
        calls.indexOf("scutil --nc start TestTunnel"),
    calls.join(","),
  );
  check(
    "no deep link was opened",
    calls.every((c) => !c.startsWith("open ")),
    calls.join(","),
  );
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
      toggle: LINK_TOGGLE,
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
      toggle: LINK_TOGGLE,
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
    "no toggle command ran",
    calls.every(
      (c) => !c.startsWith("open ") && !c.startsWith("scutil --nc stop"),
    ),
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
      toggle: LINK_TOGGLE,
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
    calls.some((c) => c === `open ${LINK_TOGGLE.disconnect}`),
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
        args[0] === LINK_TOGGLE.disconnect &&
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
    toggle: LINK_TOGGLE,
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
    countCalls(env.calls, `open ${LINK_TOGGLE.disconnect}`) === 0,
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

console.log("settings: parse, defaults, and out-of-range fallbacks");
{
  const defaults = parseSettings({});
  check("absent -> defaults, enabled", defaults.enabled);
  check(
    "the hysteresis default is at least three probes",
    defaults.outageThreshold >= 3,
    String(defaults.outageThreshold),
  );
  check(
    "defaults match the exported DEFAULTS",
    defaults.client === DEFAULTS.client &&
      defaults.probeIntervalMs === DEFAULTS.probeIntervalMs,
  );
  const off = parseSettings({
    braid: { contrib: { networkMonitor: false } },
  });
  check("false disables", !off.enabled);
  check("false keeps the documented defaults", off.client === DEFAULTS.client);
  const on = parseSettings({ braid: { contrib: { networkMonitor: true } } });
  check("true enables with defaults", on.enabled);
  const tuned = parseSettings({
    braid: {
      contrib: {
        networkMonitor: {
          client: "happ",
          outageThreshold: 5,
          autoWatch: false,
          logFile: "/tmp/nm.log",
          curlTimeoutSecs: "nope",
          maxAttemptsPerOutage: -2,
        },
      },
    },
  });
  check("object tunes the client", tuned.client === "happ");
  check("object tunes the threshold", tuned.outageThreshold === 5);
  check("object tunes autoWatch", tuned.autoWatch === false);
  check("object tunes logFile", tuned.logFile === "/tmp/nm.log");
  check(
    "non-numeric and non-positive values fall back",
    tuned.curlTimeoutSecs === DEFAULTS.curlTimeoutSecs &&
      tuned.maxAttemptsPerOutage === DEFAULTS.maxAttemptsPerOutage,
  );
}

console.log(
  "settings: a live source re-reads, and a broken read keeps last good",
);
{
  let doc: SettingsDocument = {
    braid: { contrib: { networkMonitor: false } },
  };
  let readError: Error | null = null;
  const live = createLiveSettings(() => {
    if (readError) throw readError;
    return doc;
  });
  const first = live.current();
  check("disabled is read at once", !first.enabled);
  // The incident: the write that should have stopped the monitor did nothing.
  doc = {
    braid: {
      contrib: {
        networkMonitor: { client: "happ", outageThreshold: 4 },
      },
    },
  };
  const second = live.current();
  check(
    "a later read sees the edit",
    second.enabled && second.client === "happ",
  );
  check("a later read sees the new knob", second.outageThreshold === 4);
  readError = new Error("settings.json: Unexpected end of JSON input");
  const duringFailure = live.current();
  check(
    "a broken read keeps the last good settings",
    duringFailure.client === "happ" && duringFailure.outageThreshold === 4,
  );
  check(
    "the failure is reported",
    (live.error() ?? "").includes("Unexpected end of JSON input"),
    live.error() ?? "",
  );
  // A corrupt file must never re-enable a disabled monitor.
  doc = { braid: { contrib: { networkMonitor: false } } };
  readError = null;
  check("disabled again", !live.current().enabled);
  readError = new Error("settings.json: EACCES");
  check("still disabled through a broken read", !live.current().enabled);
  readError = null;
  live.current();
  check("error clears on a clean read", live.error() === null);
  check(
    "missing document means defaults",
    createLiveSettings(() => null).current().enabled,
  );
}

// Watcher (autoWatch) tests

function mkProbe(down: boolean, routeOnlyDrop = false): ProbeResult {
  const status = routeOnlyDrop
    ? "Connected"
    : down
      ? "Disconnected"
      : "Connected";
  return {
    displayName: FACTS.displayName,
    profileStatus: status,
    profileName: FACTS.profileName,
    profileRaw: status,
    profiles: [{ name: FACTS.profileName, status, raw: status }],
    reachabilityCode: down ? "000" : "200",
    reachable: !down,
    appAlive: true,
    extensionAlive: true,
    down,
    routeOnlyDrop,
    detail: down ? "down" : "up",
  };
}

const WATCH_DEFAULTS: WatcherSettings = {
  autoReconnect: true,
  maxAttemptsPerOutage: 3,
  reconnectCooldownMs: 60_000,
  outageThreshold: 3,
};

/** A frame whose probe is scripted; the last state repeats when exhausted. */
function frameOf(o: {
  probe: () => Promise<ProbeResult>;
  reconnect?: () => Promise<ReconnectOutcome>;
  toggleRefusal?: string;
  settings?: Partial<WatcherSettings>;
}): WatchFrame {
  const frame: WatchFrame = {
    probeIntervalMs: 90_000,
    settings: { ...WATCH_DEFAULTS, ...o.settings },
    probe: o.probe,
  };
  if (o.reconnect) frame.reconnect = o.reconnect;
  if (o.toggleRefusal) frame.toggleRefusal = o.toggleRefusal;
  return frame;
}

function scriptedProbe(states: boolean[]): () => Promise<ProbeResult> {
  let i = 0;
  return async () => {
    const down = states[Math.min(i, states.length - 1)] ?? false;
    i += 1;
    return mkProbe(down);
  };
}

function countingProbe(base: () => Promise<ProbeResult>): {
  probe: () => Promise<ProbeResult>;
  calls: () => number;
} {
  let n = 0;
  return {
    probe: async () => {
      n += 1;
      return base();
    },
    calls: () => n,
  };
}

const plannerOf = (frame: WatchFrame) => () => frame;

console.log("watcher: no toggle at K-1 consecutive failed probes; toggle at K");
{
  const probe = scriptedProbe([false, true, true, true, false]);
  let toggles = 0;
  const w = createTunnelWatcher(
    plannerOf(
      frameOf({
        probe,
        reconnect: async () => {
          toggles += 1;
          return { ok: true, attempts: 1, final: null, reason: "injected" };
        },
        settings: {
          outageThreshold: 3,
          maxAttemptsPerOutage: 1,
          reconnectCooldownMs: 1,
        },
      }),
    ),
    { sleep: async () => {}, log: () => {} },
  );
  await w.tick(); // baseline up
  await w.tick(); // failure 1/3
  check("one failed probe does not toggle", toggles === 0, String(toggles));
  check("the streak is open", w.state.failures === 1 && w.state.confirming);
  await w.tick(); // failure 2/3
  check("two failed probes do not toggle", toggles === 0, String(toggles));
  check(
    "still below the threshold",
    w.state.failures === 2 && w.state.confirming,
  );
  await w.tick(); // failure 3/3 -> toggle
  check("the K-th failed probe toggles", toggles === 1, String(toggles));
  check(
    "verified recovery resets the streak",
    w.state.failures === 0 && !w.state.confirming && !w.state.lastDown,
  );
}

console.log(
  "watcher: a lag (a reachable probe) resets the streak; the second outage starts over",
);
{
  const probe = scriptedProbe([true, true, false, true, true, true, false]);
  let toggles = 0;
  const w = createTunnelWatcher(
    plannerOf(
      frameOf({
        probe,
        reconnect: async () => {
          toggles += 1;
          return { ok: true, attempts: 1, final: null, reason: "injected" };
        },
        settings: { maxAttemptsPerOutage: 1, reconnectCooldownMs: 1 },
      }),
    ),
    { sleep: async () => {}, log: () => {} },
  );
  await w.tick(); // failure 1
  await w.tick(); // failure 2
  await w.tick(); // reachable again: the lag was not an outage
  check("the streak reset on the reachable probe", w.state.failures === 0);
  check("nothing toggled through the lag", toggles === 0, String(toggles));
  await w.tick(); // failure 1 of the next streak
  await w.tick(); // failure 2
  check(
    "the previous streak does not count toward the new one",
    toggles === 1 ? false : w.state.failures === 2,
    `toggles=${toggles} failures=${w.state.failures}`,
  );
  await w.tick(); // failure 3 -> toggle
  check("the new outage toggles at K", toggles === 1, String(toggles));
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
    plannerOf(
      frameOf({
        probe: () => probeTunnel(baseOpts, env.deps),
        reconnect: () =>
          reconnectTunnel(
            {
              ...baseOpts,
              toggle: LINK_TOGGLE,
              disconnectDelayMs: 1,
              connectTimeoutMs: 0,
              pollIntervalMs: 5,
              lockFile: lockPath("watch-cap"),
            },
            env.deps,
          ),
        settings: {
          outageThreshold: 1,
          maxAttemptsPerOutage: 3,
          reconnectCooldownMs: 500,
        },
      }),
    ),
    {
      sleep: env.deps.sleep,
      log: () => {},
      warn: (m) => warn.push(m),
      notify: (m) => notices.push(m),
    },
  );
  await w.tick(); // baseline down at threshold 1 -> outage, 3 attempts
  check(
    "exactly maxAttempts reconnect flows",
    countCalls(env.calls, `open ${LINK_TOGGLE.disconnect}`) === 3,
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
  check(
    "attempts capped and stood down",
    w.state.attempts === 3 && w.state.lastDown === true && w.state.stoodDown,
  );
  await w.tick(); // still down, no transition -> no action
  check(
    "no hammering on later down probes",
    countCalls(env.calls, `open ${LINK_TOGGLE.disconnect}`) === 3,
  );
  check("no second warn", warn.length === 1);
  check(
    "stand-down surfaced to the TUI",
    notices.length === 1 && /standing down/.test(notices[0]),
    notices.join("|"),
  );
}

console.log(
  "watcher: DOWN->UP resets attempt counter; second outage re-attempts",
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
    plannerOf(
      frameOf({
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
        settings: {
          outageThreshold: 1,
          maxAttemptsPerOutage: 2,
          reconnectCooldownMs: 10,
        },
      }),
    ),
    {
      sleep: env.deps.sleep,
      log: () => {},
      warn: (m) => warn.push(m),
    },
  );
  await w.tick(); // baseline down -> outage: 2 attempts
  check("first outage attempts", reconnectCalls === 2, String(reconnectCalls));
  env.setNcStatus("Connected");
  env.setCurlCode("302"); // recovery means the route answers again
  await w.tick(); // DOWN->UP -> recovery, reset
  check(
    "attempts reset on recovery",
    w.state.attempts === 0 && w.state.lastDown === false && !w.state.stoodDown,
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
    plannerOf(
      frameOf({
        probe: () => probeTunnel(baseOpts, env.deps),
        reconnect: async () => {
          reconnectCalls += 1;
          env.setCurlCode("302"); // the toggle cycle restored the route
          return { ok: true, attempts: 1, final: null, reason: "test" };
        },
        settings: {
          outageThreshold: 1,
          maxAttemptsPerOutage: 1,
          reconnectCooldownMs: 10,
        },
      }),
    ),
    { sleep: env.deps.sleep, log: () => {} },
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
    plannerOf(
      frameOf({
        probe: () => probeTunnel(baseOpts, env.deps),
        reconnect: () =>
          reconnectTunnel(
            {
              ...baseOpts,
              toggle: LINK_TOGGLE,
              disconnectDelayMs: 1,
              connectTimeoutMs: 20,
              pollIntervalMs: 5,
              lockFile: lockPath("watch-routedeadd"),
            },
            env.deps,
          ),
        settings: {
          outageThreshold: 1,
          maxAttemptsPerOutage: 1,
          reconnectCooldownMs: 10,
        },
      }),
    ),
    {
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
  "watcher: a probe-only client confirms the outage and stands down without toggling",
);
{
  const warn: string[] = [];
  const w = createTunnelWatcher(
    plannerOf(
      frameOf({
        probe: scriptedProbe([true, true, true]),
        toggleRefusal: 'Client "incy" is not operable: no bundleId',
        settings: { outageThreshold: 1 },
      }),
    ),
    { sleep: async () => {}, log: () => {}, warn: (m) => warn.push(m) },
  );
  await w.tick();
  check("stood down instead of toggling", w.state.stoodDown);
  check(
    "the refusal is in the warning",
    warn.length === 1 && warn[0].includes("no bundleId"),
    warn.join("|"),
  );
}

console.log(
  "watcher: a distress signal opens the confirmation sequence and never toggles alone",
);
{
  let probeCalls = 0;
  let reconcile = 0;
  const states = [false, true, true, true, false]; // up, then down, then heals
  const w = createTunnelWatcher(
    plannerOf(
      frameOf({
        probe: async () => {
          const down = states[Math.min(probeCalls, states.length - 1)] ?? false;
          probeCalls += 1;
          return mkProbe(down);
        },
        reconnect: async () => {
          reconcile += 1;
          return { ok: true, attempts: 1, final: null, reason: "injected" };
        },
        settings: { maxAttemptsPerOutage: 1, reconnectCooldownMs: 1 },
      }),
    ),
    { sleep: async () => {}, log: () => {} },
  );
  await w.tick(); // baseline up
  check("baseline probe ran", probeCalls === 1 && w.state.failures === 0);
  await w.signalDistress("agent run aborted (provider abort)");
  check("the signal probed immediately", probeCalls === 2, String(probeCalls));
  check(
    "the signal alone counted one failed probe",
    w.state.failures === 1 && w.state.confirming,
  );
  check("the signal alone toggled nothing", reconcile === 0, String(reconcile));
  await w.tick(); // failure 2
  check("still no toggle below K", reconcile === 0, String(reconcile));
  await w.tick(); // failure 3 -> toggle
  check("K failed probes toggle", reconcile === 1, String(reconcile));
  check(
    "a signal after the recovery resets the streak",
    w.state.failures === 0,
  );
}

console.log(
  "watcher: a distress signal while stood down is ignored, not a retrigger",
);
{
  const probe = countingProbe(scriptedProbe([true]));
  const w = createTunnelWatcher(
    plannerOf(
      frameOf({
        probe: probe.probe,
        reconnect: async () => ({
          ok: false,
          attempts: 0,
          final: null,
          reason: "injected",
        }),
        settings: {
          outageThreshold: 1,
          maxAttemptsPerOutage: 1,
          reconnectCooldownMs: 1,
        },
      }),
    ),
    { sleep: async () => {}, log: () => {}, warn: () => {} },
  );
  await w.tick(); // outage: one attempt, then stood down
  check("stood down", w.state.stoodDown);
  const before = probe.calls();
  await w.signalDistress("agent run aborted");
  check("the signal probed nothing", probe.calls() === before);
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
        args[0] === LINK_TOGGLE.disconnect &&
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
    toggle: LINK_TOGGLE,
    disconnectDelayMs: 1,
    connectTimeoutMs: 200,
    pollIntervalMs: 5,
    lockFile: lockPath("watch-serial"),
  };
  const outcomes: ReconnectOutcome[] = [];
  const logB: string[] = [];
  const frame = frameOf({
    probe: () => probeTunnel(baseOpts, deps),
    reconnect: () => reconnectTunnel(opts, deps),
    settings: {
      outageThreshold: 1,
      maxAttemptsPerOutage: 1,
      reconnectCooldownMs: 10,
    },
  });
  const watcherA = createTunnelWatcher(() => frame, {
    sleep: env.deps.sleep,
    log: () => {},
  });
  const watcherB = createTunnelWatcher(
    () =>
      frameOf({
        probe: () => probeTunnel(baseOpts, deps),
        reconnect: async () => {
          const outcome = await reconnectTunnel(opts, deps);
          outcomes.push(outcome);
          return outcome;
        },
        settings: {
          outageThreshold: 1,
          maxAttemptsPerOutage: 1,
          reconnectCooldownMs: 10,
        },
      }),
    {
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
    countCalls(env.calls, `open ${LINK_TOGGLE.disconnect}`) === 0,
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
  "watcher timer: a stand-down creates no probe, and live settings resume it",
);
{
  const created: number[] = [];
  const cleared: unknown[] = [];
  let fireCb: (() => void) | undefined;
  const timers = {
    created,
    cleared,
    setTimeout: (cb: () => void, ms: number) => {
      fireCb = cb;
      created.push(ms);
      return {};
    },
    clearTimeout: (t: unknown) => {
      cleared.push(t);
    },
  };
  let mode: "off" | "run" = "off";
  let probeCalls = 0;
  const deps: WatcherDeps = {
    sleep: async () => {},
    log: () => {},
  };
  const planner = () =>
    mode === "off"
      ? {
          standDown: "autoWatch is off in settings",
          probeIntervalMs: 1234,
        }
      : frameOf({
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
        });
  const handle = startTunnelWatcher(planner, deps, timers);
  await flush();
  check("no probe while standing down", probeCalls === 0, String(probeCalls));
  check(
    "timer scheduled at the stand-down cadence",
    created.length === 1 && created[0] === 1234,
  );
  mode = "run";
  (fireCb as unknown as () => void)();
  await flush();
  check("the next fire probes once the setting flips", probeCalls === 1);
  check(
    "timer scheduled at the frame cadence",
    created.length === 2 && created[1] === 90_000,
  );
  handle.signalDistress("test signal");
  await flush();
  check("the handle exposes the distress seam", probeCalls === 2);
  handle.stop();
  check("stop clears the timer", cleared.length === 1);
  const afterStop = created.length;
  (fireCb as unknown as () => void)();
  await flush();
  check(
    "a fired timer after stop does nothing",
    created.length === afterStop && probeCalls === 2,
  );
}

console.log("watcher: in-flight guard skips probe ticks during reconnect");
{
  let probeCalls = 0;
  let reconnectCalls = 0;
  let probeDown = true;
  let releaseReconnect: (() => void) | null = null;
  const info: string[] = [];
  const w = createTunnelWatcher(
    plannerOf(
      frameOf({
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
        settings: { outageThreshold: 1 },
      }),
    ),
    {
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

console.log(
  "watcher timer: a planner that throws is logged and retried, never dropped",
);
{
  const created: number[] = [];
  let fireCb: (() => void) | undefined;
  const timers = {
    setTimeout: (cb: () => void, ms: number) => {
      fireCb = cb;
      created.push(ms);
      return {};
    },
    clearTimeout: () => {},
  };
  const warn: string[] = [];
  let planned = 0;
  let probeCalls = 0;
  const handle = startTunnelWatcher(
    () => {
      planned += 1;
      if (planned === 1) throw new Error("planner exploded");
      return frameOf({
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
      });
    },
    { sleep: async () => {}, log: () => {}, warn: (m) => warn.push(m) },
    timers,
  );
  await flush();
  check(
    "the throw is warned about, not swallowed",
    warn.length === 1 && warn[0].includes("planner exploded"),
    warn.join("|"),
  );
  check(
    "the chain reschedules itself",
    created.length === 1 && created[0] === 60_000,
    created.join(","),
  );
  (fireCb as unknown as () => void)();
  await flush();
  check("the next fire probes", probeCalls === 1, String(probeCalls));
  handle.stop();
}

console.log(`\n${checks} checks, ${failures} failures`);
if (failures > 0) process.exit(1);
