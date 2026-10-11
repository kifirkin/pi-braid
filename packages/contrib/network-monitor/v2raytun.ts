/**
 * v2RayTun core logic - rootless probe + deep-link reconnect.
 *
 * Pure and dependency-injected: exec and sleep are passed in so tests can
 * mock them without touching a real tunnel. No pi imports here; the
 * extension entry point (index.ts) owns settings and tool registration.
 *
 * Probe ladder (cheapest first):
 *   1. NE roster: `scutil --nc list` -> every app-owned network-extension
 *      profile; the connected one is used, so a stale anchor profile cannot
 *      pin the verdict to DOWN. Route reachability is the ground truth.
 *   2. NE status (anchor profile from settings): `scutil --nc status "<name>"`
 *      -> first line
 *   3. Reachability: `curl -sS --max-time N -o /dev/null -w '%{http_code}' <url>`
 *   4. App alive:    `pgrep -x v2RayTun`
 *   5. Extension:    `pgrep -f databridges.privacy.v2RayTun.snextension`
 *
 * Reconnect (rung 1):
 *   probe first (an up tunnel is never bounced) -> `open
 *   "v2raytun://disconnect"` -> sleep ~2s -> `open "v2raytun://connect"` ->
 *   poll up to connectTimeout -> verify the route answers. The toggle cycle
 *   runs under a cross-process lockfile so concurrent pi processes serialize
 *   instead of double-toggling. No killall, no system-extension toggle, no
 *   config file edits (the vendor regenerates configs on connect).
 */

import { execFile } from "node:child_process";
import { acquireLock } from "./lock.ts";

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

// Probe

export type ProfileStatus =
  | "Connected"
  | "Disconnected"
  | "Connecting"
  | "Disconnecting"
  | "unknown";

export interface ProbeOptions {
  profileName: string;
  reachabilityUrl: string;
  curlTimeoutSecs: number;
}

export interface ProfileInfo {
  name: string;
  status: ProfileStatus;
  raw: string;
}

export interface ProbeResult {
  /** Status of the reported profile: Connected when any app profile is. */
  profileStatus: ProfileStatus;
  /** Which NE profile the reported status came from. */
  profileName: string;
  profileRaw: string;
  /** Every app-owned NE profile seen, anchor profile first. */
  profiles: ProfileInfo[];
  reachabilityCode: string;
  reachable: boolean;
  appAlive: boolean;
  extensionAlive: boolean;
  /** Tunnel unusable: the probe URL is unreachable (route is ground truth). */
  down: boolean;
  /** Profile Connected but the probe URL is unreachable: stale-route drop. */
  routeOnlyDrop: boolean;
  detail: string;
}

const APP_BUNDLE_ID = "com.databridges.privacy.v2RayTun";

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
 *   * (Connected)  <uuid> VPN (com.databridges.privacy.v2RayTun) "v2RayTun 2" ...
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
    deps.exec("pgrep", ["-x", "v2RayTun"]),
    deps.exec("pgrep", ["-f", "databridges.privacy.v2RayTun.snextension"]),
  ]);

  const anchorRaw = nc.stdout.split("\n")[0] ?? "";
  const anchor: ProfileInfo = {
    name: opts.profileName,
    status: parseProfileStatus(anchorRaw),
    raw: anchorRaw,
  };

  // Enumerate the app's own profiles so a stale anchor (the app keeps a
  // disconnected profile beside the live one) cannot hide a connected tunnel.
  const profiles: ProfileInfo[] = [anchor];
  const listed = await deps.exec("scutil", ["--nc", "list"]);
  if (listed.code === 0) {
    for (const p of parseNcList(listed.stdout, APP_BUNDLE_ID)) {
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
  const extensionAlive = ext.code === 0;
  const down = !reachable;
  const routeOnlyDrop = selected.status === "Connected" && down;

  const profileText =
    profiles.length > 1
      ? `NE profiles: ${profiles.map((p) => `${p.name}=${p.status}`).join(", ")}`
      : `NE status: ${selected.status}`;
  const detail = [
    profileText,
    `reachability ${opts.reachabilityUrl}: HTTP ${reachabilityCode}${reachable ? "" : " (down)"}`,
    `app: ${appAlive ? "alive" : "dead"}`,
    `extension: ${extensionAlive ? "alive" : "dead"}`,
  ].join(" | ");

  return {
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
      `v2RayTun: DOWN (${lead}route unreachable; NE profile ${r.profileStatus})`,
      r.detail,
    ].join("\n");
  }
  return [
    `v2RayTun: UP (route reachable; NE profile ${r.profileStatus})`,
    r.detail,
  ].join("\n");
}

// Reconnect (rung 1: deep links, no kill)

export interface ReconnectOptions extends ProbeOptions {
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
 * Reconnect via the app's own deep links, then poll until the probe URL
 * answers (or the connect timeout elapses).
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

  try {
    await deps.exec("open", ["v2raytun://disconnect"]);
    await deps.sleep(opts.disconnectDelayMs);
    await deps.exec("open", ["v2raytun://connect"]);

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

export interface WatcherSettings {
  /** false -> the watcher probes and logs but never reconnects. */
  autoReconnect: boolean;
  /** Reconnect attempts per outage before standing down. */
  maxAttemptsPerOutage: number;
  /** Pause between reconnect attempts within one outage. */
  reconnectCooldownMs: number;
}

export interface WatcherDeps {
  /** Same probe logic the status tool uses (probeTunnel, pre-bound). */
  probe: () => Promise<ProbeResult>;
  /** Same reconnect flow the reconnect tool uses (reconnectTunnel, pre-bound). */
  reconnect: () => Promise<ReconnectOutcome>;
  sleep: SleepFn;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  /** Owner-visible TUI notice for failure modes (stand-down). */
  notify?: (msg: string) => void;
}

export interface WatcherState {
  /** Verdict of the last completed probe; null until the first probe lands. */
  lastDown: boolean | null;
  /** Reconnect attempts burned on the current outage. */
  attempts: number;
  /** True while a reconnect attempt loop is running. */
  inFlight: boolean;
}

export interface TunnelWatcher {
  /** One probe cycle: transition detection + guarded auto-reconnect. */
  tick(): Promise<void>;
  state: WatcherState;
}

const noop = (): void => {};

/**
 * Transition-tracking watcher over the shared probe/reconnect logic.
 *
 * - Acts only on UP->DOWN transitions (a first probe that is already down
 *   counts as an outage too - the tunnel was down before watching started).
 *   "Down" means the probe URL is unreachable: a profile that reports
 *   Connected while the route is dead is a route-only drop and triggers the
 *   outage path too. Down probes that follow an already-known down state
 *   never re-trigger.
 * - Each outage runs at most maxAttemptsPerOutage reconnect attempts spaced
 *   by reconnectCooldownMs, each verified with a fresh probe. After the cap
 *   it warns, notifies the TUI, and stands down until the tunnel flaps UP
 *   again. A reconnect refused by the cross-process lock (lock held) is
 *   logged and does not toggle anything.
 * - DOWN->UP (self-healed or external) logs recovery and resets attempts.
 * - inFlight guard: probe ticks that land while a reconnect loop is running
 *   are skipped, so reconnects never overlap.
 */
export function createTunnelWatcher(
  settings: WatcherSettings,
  deps: WatcherDeps,
): TunnelWatcher {
  const state: WatcherState = { lastDown: null, attempts: 0, inFlight: false };
  const info = deps.log ?? noop;
  const warn = deps.warn ?? noop;

  async function runOutage(): Promise<void> {
    state.inFlight = true;
    try {
      for (
        let attempt = 1;
        attempt <= settings.maxAttemptsPerOutage;
        attempt += 1
      ) {
        state.attempts = attempt;
        info(
          `watcher: tunnel down - reconnect attempt ${attempt}/${settings.maxAttemptsPerOutage}`,
        );
        const outcome = await deps.reconnect();
        if (outcome.lockHeld) {
          info("watcher: reconnect skipped - lock held by another process");
        }
        // Verify-after with a fresh probe; do not trust the reconnect flow's
        // own last poll as the verdict.
        const verify = await deps.probe();
        if (!verify.down) {
          info(
            `watcher: tunnel recovered after reconnect (attempt ${attempt}/${settings.maxAttemptsPerOutage})`,
          );
          state.lastDown = false;
          state.attempts = 0;
          return;
        }
        if (attempt < settings.maxAttemptsPerOutage) {
          await deps.sleep(settings.reconnectCooldownMs);
        }
      }
      const standDown =
        `watcher: outage persists after ${settings.maxAttemptsPerOutage} reconnect attempts - ` +
        "standing down until the tunnel flaps UP again; continuing to watch";
      warn(standDown);
      deps.notify?.(standDown);
    } finally {
      state.inFlight = false;
    }
  }

  async function tick(): Promise<void> {
    if (state.inFlight) {
      info("watcher: probe tick skipped - reconnect already in flight");
      return;
    }
    const result = await deps.probe();
    const prev = state.lastDown;
    state.lastDown = result.down;
    if (result.down && prev !== true) {
      if (!settings.autoReconnect) {
        info(
          "watcher: tunnel down - autoReconnect disabled, no reconnect attempted",
        );
        return;
      }
      await runOutage();
      return;
    }
    if (!result.down && prev === true) {
      info(
        "watcher: tunnel recovered (self-healed or external) - attempt counter reset",
      );
      state.attempts = 0;
    }
  }

  return { tick, state };
}

export interface AutoWatchSettings extends WatcherSettings {
  autoWatch: boolean;
  probeIntervalMs: number;
}

/** Minimal timer surface so tests can fake scheduling. */
export interface TimerDeps {
  setInterval: (cb: () => void, ms: number) => { unref?: () => void };
  clearInterval: (timer: unknown) => void;
}

export interface WatcherHandle {
  stop(): void;
}

/**
 * Wire the watcher to a real interval timer. Returns null when autoWatch is
 * disabled (no timer is created, no probe runs). The timer is unref'd when
 * the runtime supports it so it never keeps the process alive by itself;
 * stop() clears it (call from session_shutdown).
 */
export function startTunnelWatcher(
  settings: AutoWatchSettings,
  deps: WatcherDeps,
  timers: TimerDeps,
): WatcherHandle | null {
  if (!settings.autoWatch) return null;
  const watcher = createTunnelWatcher(settings, deps);
  const runTick = (): void => {
    watcher.tick().catch((err: unknown) => {
      deps.warn?.(
        `watcher: probe tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };
  // Initial probe: establishes the baseline and heals a tunnel that was
  // already down when the extension loaded.
  runTick();
  const timer = timers.setInterval(runTick, settings.probeIntervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return {
    stop: () => {
      timers.clearInterval(timer);
    },
  };
}
