/**
 * Tunnel core logic - client-agnostic rootless probe + mechanism-driven reconnect.
 *
 * Pure and dependency-injected: exec and sleep are passed in so tests can
 * mock them without touching a real tunnel. No pi imports here; the
 * extension entry point (index.ts) owns settings and tool registration, and
 * the per-client facts (bundle id, process patterns, profile name, toggle
 * mechanism) arrive as data from the adapter table (clients.ts). This module
 * carries no vendor name.
 *
 * Probe ladder (cheapest first), all facts supplied via ProbeOptions:
 *   1. NE roster: `scutil --nc list` -> every profile owned by the client's
 *      bundle id; the connected one is used, so a stale anchor profile cannot
 *      pin the verdict to DOWN. Route reachability is the ground truth.
 *   2. NE status (anchor profile): `scutil --nc status "<name>"` -> first line
 *   3. Reachability: `curl -sS --max-time N -o /dev/null -w '%{http_code}' <url>`
 *   4. App alive:    `pgrep -x <app process>`
 *   5. Extension:    `pgrep -f <extension process pattern>`; a client that
 *      ships no separate extension process skips this leg (extensionAlive
 *      is null, reported as not applicable rather than dead).
 *
 * Reconnect (rung 1):
 *   probe first (an up tunnel is never bounced) -> run the client's toggle
 *   mechanism (deep links via `open`, or the NE profile via `scutil --nc
 *   stop|start`) -> pause -> connect side -> poll up to connectTimeout ->
 *   verify the route answers. The toggle cycle runs under a cross-process
 *   lockfile so concurrent pi processes serialize instead of double-toggling.
 *   No killall, no system-extension toggle, no config file edits (the vendor
 *   regenerates configs on connect).
 *
 * Autonomous watcher (autoWatch): the same probe on a cadence, but pointed at
 * a confirmation sequence rather than at the first bad probe. The outage
 * threshold is `outageThreshold` consecutive failed probes; probes are spaced
 * by the cadence the planner reports. Below the threshold the watcher logs
 * and does nothing; at the threshold it runs the reconnect loop, bounded by
 * maxAttemptsPerOutage and spaced by reconnectCooldownMs, and then stands
 * down until the route is reachable again. A distress signal (a provider or
 * watchdog observation) only opens the confirmation sequence: it probes
 * immediately, and a signal by itself toggles nothing.
 */

import { execFile } from "node:child_process";
import { acquireLock } from "./lock.ts";
import type { ToggleMechanism } from "./clients.ts";

// Dependency surface (injectable for tests)

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;
export type SleepFn = (ms: number) => Promise<void>;

export interface Deps {
  exec: ExecFn;
  sleep: SleepFn;
}

/** Real exec via execFile. Rejects on spawn errors, resolves on any exit code. */
export function defaultExec(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number }).code ?? 1) : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Toggle mechanism -> commands

export interface ToggleCommand {
  cmd: string;
  args: string[];
}

/** The disconnect/connect command pair a toggle mechanism runs, as argv. */
export interface TogglePlan {
  disconnect: ToggleCommand;
  connect: ToggleCommand;
}

/**
 * Turn a client's toggle mechanism into the two OS commands the reconnect
 * flow runs. Mechanism selection lives here, so a vendor that toggles through
 * its NE profile and a vendor that toggles through deep links need no
 * separate code path.
 */
export function togglePlan(mechanism: ToggleMechanism): TogglePlan {
  if (mechanism.kind === "link") {
    return {
      disconnect: { cmd: "open", args: [mechanism.disconnect] },
      connect: { cmd: "open", args: [mechanism.connect] },
    };
  }
  return {
    disconnect: { cmd: "scutil", args: ["--nc", "stop", mechanism.profile] },
    connect: { cmd: "scutil", args: ["--nc", "start", mechanism.profile] },
  };
}

/** One-line description of a toggle mechanism, for logs and dry runs. */
export function describeToggle(mechanism: ToggleMechanism): string {
  const plan = togglePlan(mechanism);
  const one = (c: ToggleCommand): string =>
    c.args.length === 1
      ? `${c.cmd} "${c.args[0]}"`
      : `${c.cmd} ${c.args.join(" ")}`;
  return `${one(plan.disconnect)} then ${one(plan.connect)}`;
}

// Probe

export type ProfileStatus =
  | "Connected"
  | "Disconnected"
  | "Connecting"
  | "Disconnecting"
  | "unknown";

export interface ProbeOptions {
  /** Verdict-line label (the client's display name). */
  displayName: string;
  /** NE bundle id whose profiles the roster step filters on. */
  bundleId: string;
  /** Anchor NE profile name for `scutil --nc status`. */
  profileName: string;
  /** `pgrep -x` pattern for the client app process. */
  appProcess: string;
  /** `pgrep -f` pattern for a separate extension process; null skips the leg. */
  extensionProcess: string | null;
  reachabilityUrl: string;
  curlTimeoutSecs: number;
}

export interface ProfileInfo {
  name: string;
  status: ProfileStatus;
  raw: string;
}

export interface ProbeResult {
  /** Display label the verdict line leads with. */
  displayName: string;
  /** Status of the reported profile: Connected when any client profile is. */
  profileStatus: ProfileStatus;
  /** Which NE profile the reported status came from. */
  profileName: string;
  profileRaw: string;
  /** Every client-owned NE profile seen, anchor profile first. */
  profiles: ProfileInfo[];
  reachabilityCode: string;
  reachable: boolean;
  appAlive: boolean;
  /** Extension liveness; null when the client ships no separate process. */
  extensionAlive: boolean | null;
  /** Tunnel unusable: the probe URL is unreachable (route is ground truth). */
  down: boolean;
  /** Profile Connected but the probe URL is unreachable: stale-route drop. */
  routeOnlyDrop: boolean;
  detail: string;
}

const KNOWN_STATUSES: ProfileStatus[] = [
  "Connected",
  "Disconnected",
  "Connecting",
  "Disconnecting",
];

function parseProfileStatus(firstLine: string): ProfileStatus {
  const trimmed = firstLine.trim();
  for (const s of KNOWN_STATUSES) {
    if (trimmed === s) return s;
  }
  return "unknown";
}

/**
 * Parse `scutil --nc list` for profiles belonging to `bundleId`. Line shape:
 *   * (Connected)  <uuid> VPN (<bundle-id>) "<name>" ...
 * Names come from the OS; no profile name is assumed here.
 */
export function parseNcList(stdout: string, bundleId: string): ProfileInfo[] {
  const out: ProfileInfo[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(
      /^\*?\s*\(([^)]+)\)\s+\S+\s+\S+\s+\(([^)]+)\)\s+"([^"]+)"/,
    );
    if (!m || m[2] !== bundleId) continue;
    const status = parseProfileStatus(m[1]);
    out.push({ name: m[3], status, raw: m[1] });
  }
  return out;
}

export async function probeTunnel(
  opts: ProbeOptions,
  deps: Deps,
): Promise<ProbeResult> {
  const extLeg =
    opts.extensionProcess === null
      ? Promise.resolve<ExecResult | null>(null)
      : deps.exec("pgrep", ["-f", opts.extensionProcess]);
  const [nc, curl, app, ext] = await Promise.all([
    deps.exec("scutil", ["--nc", "status", opts.profileName]),
    deps.exec("curl", [
      "-sS",
      "--max-time",
      String(opts.curlTimeoutSecs),
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      opts.reachabilityUrl,
    ]),
    deps.exec("pgrep", ["-x", opts.appProcess]),
    extLeg,
  ]);

  const anchorRaw = nc.stdout.split("\n")[0] ?? "";
  const anchor: ProfileInfo = {
    name: opts.profileName,
    status: parseProfileStatus(anchorRaw),
    raw: anchorRaw,
  };

  // Enumerate the client's own profiles so a stale anchor (some clients keep
  // a disconnected profile beside the live one) cannot hide a connected
  // tunnel.
  const profiles: ProfileInfo[] = [anchor];
  const listed = await deps.exec("scutil", ["--nc", "list"]);
  if (listed.code === 0) {
    for (const p of parseNcList(listed.stdout, opts.bundleId)) {
      if (p.name === anchor.name) continue;
      const st = await deps.exec("scutil", ["--nc", "status", p.name]);
      const raw = st.stdout.split("\n")[0] ?? "";
      profiles.push({ name: p.name, status: parseProfileStatus(raw), raw });
    }
  }

  const selected = profiles.find((p) => p.status === "Connected") ?? anchor;
  const reachabilityCode = (curl.stdout.trim() || "000").slice(0, 3);
  const reachable = reachabilityCode === "200" || reachabilityCode === "302";
  const appAlive = app.code === 0;
  const extensionAlive = ext === null ? null : ext.code === 0;
  const down = !reachable;
  const routeOnlyDrop = selected.status === "Connected" && down;

  const profileText =
    profiles.length > 1
      ? `NE profiles: ${profiles.map((p) => `${p.name}=${p.status}`).join(", ")}`
      : `NE status: ${selected.status}`;
  const extensionText =
    extensionAlive === null
      ? "extension: n/a (client ships no separate process)"
      : `extension: ${extensionAlive ? "alive" : "dead"}`;
  const detail = [
    profileText,
    `reachability ${opts.reachabilityUrl}: HTTP ${reachabilityCode}${reachable ? "" : " (down)"}`,
    `app: ${appAlive ? "alive" : "dead"}`,
    extensionText,
  ].join(" | ");

  return {
    displayName: opts.displayName,
    profileStatus: selected.status,
    profileName: selected.name,
    profileRaw: selected.raw,
    profiles,
    reachabilityCode,
    reachable,
    appAlive,
    extensionAlive,
    down,
    routeOnlyDrop,
    detail,
  };
}

/**
 * Verdict line plus the probe detail. Profile state and route reachability
 * are reported as separate facts; the verdict never says DOWN while the probe
 * URL answers.
 */
export function probeText(r: ProbeResult): string {
  if (r.down) {
    const lead = r.routeOnlyDrop ? "route-only drop: " : "";
    return [
      `${r.displayName}: DOWN (${lead}route unreachable; NE profile ${r.profileStatus})`,
      r.detail,
    ].join("\n");
  }
  return [
    `${r.displayName}: UP (route reachable; NE profile ${r.profileStatus})`,
    r.detail,
  ].join("\n");
}

// Reconnect (rung 1: the client's own mechanism, no kill)

export interface ReconnectOptions extends ProbeOptions {
  /** Data-carried toggle mechanism: deep links or an NE-profile command. */
  toggle: ToggleMechanism;
  disconnectDelayMs: number;
  connectTimeoutMs: number;
  pollIntervalMs: number;
  /** Cross-process lockfile serializing concurrent reconnect cycles. */
  lockFile: string;
  /** Age after which a lock left by a dead process may be stolen. */
  lockTtlMs?: number;
}

export interface ReconnectOutcome {
  ok: boolean;
  attempts: number;
  final: ProbeResult | null;
  reason: string;
  /** Another process held the reconnect lock; nothing was toggled. */
  lockHeld?: boolean;
  /** The pre-toggle probe found the route up; the toggle cycle was skipped. */
  skipped?: boolean;
}

/**
 * Reconnect via the client's own toggle mechanism, then poll until the probe
 * URL answers (or the connect timeout elapses).
 *
 * - Probe before toggling: an up tunnel is never bounced.
 * - The toggle cycle runs under a cross-process lockfile, so concurrent pi
 *   processes serialize instead of double-toggling; a refused call reports
 *   `lock held` and toggles nothing.
 * - Success requires a reachable route. A profile that reports Connected
 *   while the route is still dead is a route-only drop, not a heal.
 */
export async function reconnectTunnel(
  opts: ReconnectOptions,
  deps: Deps,
): Promise<ReconnectOutcome> {
  const before = await probeTunnel(opts, deps);
  if (!before.down) {
    return {
      ok: true,
      attempts: 0,
      final: before,
      skipped: true,
      reason: "route already reachable - toggle skipped",
    };
  }

  const lock = acquireLock(opts.lockFile, { ttlMs: opts.lockTtlMs });
  if (!lock.acquired) {
    return {
      ok: false,
      attempts: 0,
      final: before,
      lockHeld: true,
      reason: `lock held: ${lock.reason}`,
    };
  }

  const toggle = togglePlan(opts.toggle);
  try {
    await deps.exec(toggle.disconnect.cmd, toggle.disconnect.args);
    await deps.sleep(opts.disconnectDelayMs);
    await deps.exec(toggle.connect.cmd, toggle.connect.args);

    const deadline = Date.now() + opts.connectTimeoutMs;
    let attempts = 0;
    let final: ProbeResult = before;

    while (Date.now() < deadline) {
      attempts += 1;
      final = await probeTunnel(opts, deps);
      if (!final.down) {
        return {
          ok: true,
          attempts,
          final,
          reason: `route reachable after ${attempts} probe(s)`,
        };
      }
      await deps.sleep(opts.pollIntervalMs);
    }

    return {
      ok: false,
      attempts,
      final,
      reason: final.routeOnlyDrop
        ? `route still unreachable after ${attempts} probe(s) (NE profile Connected)`
        : `not connected within ${opts.connectTimeoutMs}ms (${attempts} probe(s))`,
    };
  } finally {
    lock.release();
  }
}

// Autonomous watcher (autoWatch)

/** The watcher's own knobs, re-read from the live settings on every plan. */
export interface WatcherSettings {
  /** false -> an outage is confirmed and reported but never reconnected. */
  autoReconnect: boolean;
  /** Reconnect attempts per outage before standing down. */
  maxAttemptsPerOutage: number;
  /** Pause between reconnect attempts within one outage. */
  reconnectCooldownMs: number;
  /** Consecutive failed probes required before any toggle. */
  outageThreshold: number;
}

/**
 * A coherent snapshot: the knobs plus probe/reconnect bound to the same
 * settings values and the same client, so one tick cannot probe one client
 * and toggle another.
 */
export interface WatchFrame {
  settings: WatcherSettings;
  probeIntervalMs: number;
  probe: () => Promise<ProbeResult>;
  /** Absent when the selected client has no toggle mechanism on this host. */
  reconnect?: () => Promise<ReconnectOutcome>;
  /** Why this frame cannot toggle; set when `reconnect` is absent. */
  toggleRefusal?: string;
}

/** What the watcher should do right now: run on a frame, or stand down. */
export type WatchPlan =
  | WatchFrame
  | { standDown: string; probeIntervalMs: number };

export type WatchPlanner = () => WatchPlan;

export interface WatcherDeps {
  sleep: SleepFn;
  log?: (msg: string) => void;
  debug?: (msg: string) => void;
  warn?: (msg: string) => void;
  /** Owner-visible TUI notice for failure modes (stand-down). */
  notify?: (msg: string) => void;
}

export interface WatcherState {
  /** Verdict of the last completed probe; null until the first probe lands. */
  lastDown: boolean | null;
  /** Consecutive failed probes since the last reachable probe. */
  failures: number;
  /** True while a failure streak is open below the outage threshold. */
  confirming: boolean;
  /** Reconnect attempts burned on the current outage. */
  attempts: number;
  /** No further action until the route is reachable again. */
  stoodDown: boolean;
  /** True while a reconnect attempt loop is running. */
  inFlight: boolean;
}

export interface TunnelWatcher {
  /** One probe cycle: confirmation sequence + guarded auto-reconnect. */
  tick(frame?: WatchFrame): Promise<void>;
  /** Open the confirmation sequence on an external (provider/watchdog) signal. */
  signalDistress(reason: string): Promise<void>;
  state: WatcherState;
}

const noop = (): void => {};

/**
 * Confirmation-sequence watcher over the shared probe/reconnect logic.
 *
 * - A failed probe only counts toward `outageThreshold`; below it the watcher
 *   logs and does nothing, so a lag is not an outage. A reachable probe resets
 *   the streak and the attempt counter.
 * - At the threshold the outage runs at most maxAttemptsPerOutage reconnect
 *   attempts spaced by reconnectCooldownMs, each verified with a fresh probe.
 *   After the cap it warns, notifies the TUI, and stands down until the route
 *   is reachable again. A reconnect refused by the cross-process lock (lock
 *   held) is logged and does not toggle anything.
 * - `signalDistress` (a provider abort or a watchdog observation) only opens
 *   the confirmation sequence: it probes immediately and a signal alone never
 *   toggles.
 * - inFlight guard: ticks and signals that land while a reconnect loop is
 *   running are skipped, so reconnects never overlap.
 */
export function createTunnelWatcher(
  plan: WatchPlanner,
  deps: WatcherDeps,
): TunnelWatcher {
  const state: WatcherState = {
    lastDown: null,
    failures: 0,
    confirming: false,
    attempts: 0,
    stoodDown: false,
    inFlight: false,
  };
  const info = deps.log ?? noop;
  const warn = deps.warn ?? noop;
  const debug = deps.debug ?? noop;

  async function runOutage(frame: WatchFrame, failures: number): Promise<void> {
    state.inFlight = true;
    try {
      let max = frame.settings.maxAttemptsPerOutage;
      for (let attempt = 1; attempt <= max; attempt += 1) {
        const current = plan();
        if ("standDown" in current) {
          state.stoodDown = true;
          info(`watcher: standing down mid-outage (${current.standDown})`);
          return;
        }
        if (!current.settings.autoReconnect) {
          state.stoodDown = true;
          info(
            "watcher: standing down mid-outage (autoReconnect disabled in settings)",
          );
          return;
        }
        if (current.reconnect === undefined) {
          state.stoodDown = true;
          info(
            `watcher: cannot toggle - ${current.toggleRefusal ?? "the selected client has no toggle mechanism"}; ` +
              "standing down until the route is reachable again",
          );
          return;
        }
        max = current.settings.maxAttemptsPerOutage;
        state.attempts = attempt;
        info(
          `watcher: outage confirmed after ${failures} consecutive failed probes - ` +
            `reconnect attempt ${attempt}/${max}`,
        );
        const outcome = await current.reconnect();
        if (outcome.lockHeld) {
          info("watcher: reconnect skipped - lock held by another process");
        }
        // Verify-after with a fresh probe; do not trust the reconnect flow's
        // own last poll as the verdict.
        const verify = await current.probe();
        if (!verify.down) {
          info(
            `watcher: tunnel recovered after reconnect (attempt ${attempt}/${max})`,
          );
          state.lastDown = false;
          state.attempts = 0;
          state.failures = 0;
          state.stoodDown = false;
          return;
        }
        if (attempt < max) {
          await deps.sleep(current.settings.reconnectCooldownMs);
        }
      }
      state.stoodDown = true;
      const standDown =
        `watcher: outage persists after ${max} reconnect attempts - ` +
        "standing down until the tunnel is reachable again; continuing to watch";
      warn(standDown);
      deps.notify?.(standDown);
    } finally {
      state.inFlight = false;
    }
  }

  /** Probe once and fold the verdict into the confirmation state machine. */
  async function observe(
    frame: WatchFrame,
    source: "tick" | "signal",
  ): Promise<void> {
    const result = await frame.probe();
    const prevDown = state.lastDown;
    state.lastDown = result.down;

    if (!result.down) {
      if (state.failures > 0 || prevDown === true || state.stoodDown) {
        info(
          `watcher: route reachable again - failure streak reset ` +
            `(was ${state.failures} consecutive failed probe(s))`,
        );
      }
      state.failures = 0;
      state.confirming = false;
      state.attempts = 0;
      state.stoodDown = false;
      return;
    }

    if (state.stoodDown) {
      debug(
        "watcher: still down - standing down until the route is reachable again",
      );
      return;
    }

    const threshold = frame.settings.outageThreshold;
    state.failures += 1;
    if (state.failures < threshold) {
      state.confirming = true;
      info(
        `watcher: failed probe ${state.failures}/${threshold}` +
          (source === "signal"
            ? " (confirmation sequence opened by a distress signal)"
            : "") +
          ` - no toggle yet`,
      );
      return;
    }

    state.confirming = false;
    if (!frame.settings.autoReconnect) {
      state.stoodDown = true;
      info(
        `watcher: outage confirmed after ${state.failures} consecutive failed probes - ` +
          "autoReconnect disabled, no reconnect attempted",
      );
      return;
    }
    if (frame.reconnect === undefined) {
      state.stoodDown = true;
      const cannot = `watcher: outage confirmed after ${state.failures} consecutive failed probes - cannot toggle (${frame.toggleRefusal ?? "the selected client has no toggle mechanism"}); standing down until the route is reachable again`;
      warn(cannot);
      deps.notify?.(cannot);
      return;
    }
    await runOutage(frame, state.failures);
  }

  async function tick(frame?: WatchFrame): Promise<void> {
    if (state.inFlight) {
      info("watcher: probe tick skipped - reconnect already in flight");
      return;
    }
    const current = frame ?? plan();
    if ("standDown" in current) {
      debug(`watcher: probe tick skipped - ${current.standDown}`);
      return;
    }
    await observe(current, "tick");
  }

  async function signalDistress(reason: string): Promise<void> {
    if (state.inFlight) {
      info(
        `watcher: distress signal (${reason}) ignored - a reconnect attempt is already in flight`,
      );
      return;
    }
    const current = plan();
    if ("standDown" in current) {
      debug(
        `watcher: distress signal (${reason}) ignored - ${current.standDown}`,
      );
      return;
    }
    if (state.stoodDown) {
      info(
        `watcher: distress signal (${reason}) ignored - standing down until the tunnel is reachable again`,
      );
      return;
    }
    info(
      `watcher: distress signal (${reason}) - probing now; a signal alone never toggles`,
    );
    await observe(current, "signal");
  }

  return { tick, signalDistress, state };
}

/** Minimal timer surface so tests can fake scheduling. */
export interface TimerDeps {
  setTimeout: (cb: () => void, ms: number) => { unref?: () => void };
  clearTimeout: (timer: unknown) => void;
}

/**
 * Retry delay when planning itself throws (a programming error, not a
 * settings read - the live source already swallows those). The watcher must
 * survive an unexpected throw in a planner instead of dying silently with no
 * timer left.
 */
const PLAN_FAILURE_RETRY_MS = 60_000;

export interface WatcherHandle {
  stop(): void;
  /** Open the confirmation sequence on an external distress signal. */
  signalDistress(reason: string): void;
}

/**
 * Wire the watcher to a self-rescheduling timer. Every fire re-plans: a
 * stand-down (extension disabled, autoWatch off, client not probe-capable)
 * logs once and reschedules instead of stopping, so re-enabling the monitor
 * takes effect on the next fire without a process restart; a changed probe
 * cadence is picked up on the next schedule. The timer is unref'd when the
 * runtime supports it so it never keeps the process alive by itself; stop()
 * clears it (call from session_shutdown).
 */
export function startTunnelWatcher(
  plan: WatchPlanner,
  deps: WatcherDeps,
  timers: TimerDeps,
): WatcherHandle {
  const watcher = createTunnelWatcher(plan, deps);
  const info = deps.log ?? noop;
  const warn = deps.warn ?? noop;
  const failed = (err: unknown): void => {
    warn(
      `watcher: probe tick failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  };
  let stopped = false;
  let timer: unknown = null;
  let standDownLogged: string | null = null;

  const schedule = (ms: number): void => {
    if (stopped) return;
    const t = timers.setTimeout(fire, ms);
    timer = t;
    if (typeof t.unref === "function") t.unref();
  };

  const fire = (): void => {
    if (stopped) return;
    let current: WatchPlan;
    try {
      current = plan();
    } catch (err) {
      warn(
        `watcher: plan failed: ${err instanceof Error ? err.message : String(err)} - retrying`,
      );
      schedule(PLAN_FAILURE_RETRY_MS);
      return;
    }
    if ("standDown" in current) {
      if (current.standDown !== standDownLogged) {
        standDownLogged = current.standDown;
        info(`watcher: standing down (${current.standDown})`);
      }
      schedule(current.probeIntervalMs);
      return;
    }
    standDownLogged = null;
    schedule(current.probeIntervalMs);
    void watcher.tick(current).catch(failed);
  };

  // Initial probe: establishes the baseline, and a tunnel that was already
  // down when the extension loaded heals once the sequence confirms.
  fire();

  return {
    stop: () => {
      stopped = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
    signalDistress: (reason: string) => {
      if (stopped) return;
      void watcher.signalDistress(reason).catch(failed);
    },
  };
}
