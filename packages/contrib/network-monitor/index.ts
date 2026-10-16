/**
 * Network Monitor Extension - rootless tunnel status + reconnect tools for
 * macOS clients (v2RayTun, Happ, Incy) + an autonomous watcher.
 *
 * The client-agnostic mechanism lives in tunnel.ts; the per-client facts
 * (probe facts and the toggle mechanism: deep links or an NE-profile command)
 * live in the adapter table (clients.ts); the settings live in settings.ts.
 * An adapter that cannot do one of the two jobs is refused for that job only
 * (`probeRefusal` / `toggleRefusal`) instead of guessing: a client with no
 * separate extension process is still probed, and a client whose toggle
 * mechanism is unknown is still probed but never toggled.
 *
 * Four tools are registered: the general pair and the two v2RayTun-pinned
 * aliases kept for compatibility.
 *   - tunnel_status      - probe the selected client (NE profile roster,
 *                          probe-URL reachability, app, extension) and report
 *                          up/down.
 *   - tunnel_reconnect   - toggle via the client's mechanism with
 *                          verify-after, guarded by a session cooldown and
 *                          the autoReconnect setting.
 *   - v2raytun_status    - alias of tunnel_status pinned to client v2raytun.
 *   - v2raytun_reconnect - alias of tunnel_reconnect pinned to client v2raytun.
 *
 * Plus an autonomous watcher (autoWatch, default on): probes the selected
 * client on a cadence and only toggles after `outageThreshold` consecutive
 * failed probes (default 3), at most maxAttemptsPerOutage attempts per outage
 * spaced by reconnectCooldownMs, each attempt verified with a fresh probe.
 * Below the threshold a lag is not an outage: the watcher logs the failed
 * probe and does nothing. A provider abort (an aborted agent run) is fed in
 * as a distress signal, and a signal at most opens the confirmation sequence
 * - it never toggles. Persistent failure logs a warning and stands down (no
 * hammering); a reachable probe resets the counters. The timer is unref'd and
 * cleared on session_shutdown.
 *
 * Settings are live: every probe, toggle and watcher tick re-reads them, so
 * `braid.contrib.networkMonitor` edits take effect without a process restart,
 * in both directions (a monitor disabled here refuses and stands down on the
 * next tick; re-enabling it resumes the watcher). A read that fails keeps the
 * last good configuration instead of silently falling back to defaults.
 *
 * Config lives in pi's settings file under braid.contrib.networkMonitor
 * (Pi core philosophy: settings, not process.env):
 *
 *   braid.contrib.networkMonitor: false                      -> disabled
 *   braid.contrib.networkMonitor: true                       -> defaults
 *   braid.contrib.networkMonitor: {
 *     client: "v2raytun",               // v2raytun | happ | incy
 *     profileName: "",                  // NE profile override (empty = adapter's own)
 *     reachabilityUrl: "https://api.telegram.org",
 *     curlTimeoutSecs: 6,
 *     disconnectDelayMs: 2000,          // pause between disconnect and connect
 *     connectTimeoutMs: 30000,          // max wait for the tunnel to come up
 *     pollIntervalMs: 2000,
 *     cooldownMs: 60000,                // min gap between reconnects per session
 *     autoReconnect: true,              // false -> reconnect tool refuses (unless force)
 *     autoWatch: true,                  // background watcher: probe on a cadence, auto-heal
 *     probeIntervalMs: 90000,           // watcher probe cadence (spacing of the confirmation probes)
 *     outageThreshold: 3,               // consecutive failed probes before any toggle
 *     maxAttemptsPerOutage: 3,          // watcher reconnect attempts per outage
 *     reconnectCooldownMs: 60000,       // pause between watcher reconnect attempts
 *     logFile: ""                       // optional append-only file for log lines
 *   }
 *
 * Reconnect cycles (tool and watcher alike) serialize on one cross-process
 * lockfile under ~/.pi/agent/ so two pi processes never double-toggle.
 *
 * Guardrails: probes, deep links, and the client's own NE-profile command
 * only. No killall, no system-extension toggle, no config file edits. Other
 * VPN profiles are never touched.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger, setLoggerContext } from "../logger.js";
import { reconnectLockFile } from "../state-paths.js";
import { readSettingsFileOutcome } from "pi-braid/lib";
import {
  CLIENT_IDS,
  TUNNEL_CLIENTS,
  isClientId,
  missingFacts,
  operableClient,
  probeClient,
  probeRefusal,
  toggleRefusal,
  type Capability,
  type OperableClient,
  type ProbeClient,
  type TunnelClientAdapter,
} from "./clients.js";
import { createLogFileSink } from "./log-file.js";
import { getExtensionState } from "pi-braid/lib";
import {
  createLiveSettings,
  type NetworkMonitorSettings,
  type SettingsDocument,
  type SettingsDocumentReader,
} from "./settings.js";
import {
  defaultExec,
  defaultSleep,
  describeToggle,
  probeText,
  probeTunnel,
  reconnectTunnel,
  startTunnelWatcher,
  type ExecFn,
  type ProbeOptions,
  type ReconnectOptions,
  type ReconnectOutcome,
  type SleepFn,
  type TimerDeps,
  type WatcherHandle,
  type WatchFrame,
  type WatchPlan,
} from "./tunnel.js";

const log = createLogger("network-monitor");

/** Injectable seams, so the wiring is exercised offline without a host tunnel. */
export interface NetworkMonitorDeps {
  exec?: ExecFn;
  sleep?: SleepFn;
  timers?: TimerDeps;
  /** Settings document reader; defaults to pi's settings.json through core. */
  readSettingsDocument?: SettingsDocumentReader;
}

/**
 * The real settings reader: pi's settings.json, through core's outcome-typed
 * read so `PI_CODING_AGENT_DIR` relocates it like every other braid setting.
 * Missing means "no saved config" (defaults); unreadable or unparseable
 * throws, and the live source keeps the last good configuration.
 */
function defaultReadSettingsDocument(): SettingsDocument | null {
  const outcome = readSettingsFileOutcome();
  if (outcome.state === "missing") return null;
  if (outcome.state === "invalid") {
    throw new Error(`${outcome.path}: ${outcome.error.message}`);
  }
  return outcome.settings as SettingsDocument;
}

const DISABLED_TEXT =
  "Network monitor is disabled in settings " +
  "(braid.contrib.networkMonitor: false). Nothing was probed and nothing was " +
  "toggled. Set it back to true (or an object of tunables) and the monitor " +
  "resumes without a restart.";

/** Real timer surface for the watcher's self-rescheduling chain. */
const realTimers: TimerDeps = {
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
  clearTimeout: (t: unknown) => clearTimeout(t as NodeJS.Timeout),
};

export default function networkMonitorExtension(
  pi: ExtensionAPI,
  deps: NetworkMonitorDeps = {},
): void {
  const exec = deps.exec ?? defaultExec;
  const sleep = deps.sleep ?? defaultSleep;
  const timers = deps.timers ?? realTimers;
  const execDeps = { exec, sleep };
  const live = createLiveSettings(
    deps.readSettingsDocument ?? defaultReadSettingsDocument,
  );

  // Warned once per extension load: an outage loop must not repeat this line.
  let warnedNoLockPath = false;
  let sessionCtx: ExtensionContext | null = null;
  let handle: WatcherHandle | null = null;
  let lastSettingsError: string | null = null;

  /** The log-file sink, rebuilt when the live `logFile` setting changes. */
  let sinkPath: string | null = null;
  let sink: ReturnType<typeof createLogFileSink> = null;
  const emit = (level: "info" | "warn" | "debug", msg: string): void => {
    const s = live.current();
    if (s.logFile !== sinkPath) {
      sinkPath = s.logFile;
      sink = createLogFileSink(s.logFile);
    }
    sink?.append(level, msg);
  };
  const info = (msg: string): void => {
    log.info(msg);
    emit("info", msg);
  };
  const warn = (msg: string): void => {
    log.warn(msg);
    emit("warn", msg);
  };
  const debug = (msg: string): void => {
    log.debug(msg);
    emit("debug", msg);
  };

  /**
   * The live settings, with read failures reported once per distinct error.
   * `live.current()` already returns the last good configuration, so a broken
   * settings file cannot silently re-enable or re-tune the monitor.
   */
  const settingsNow = (): NetworkMonitorSettings => {
    const s = live.current();
    const error = live.error();
    if (error !== lastSettingsError) {
      lastSettingsError = error;
      if (error !== null) {
        warn(
          "[network-monitor] settings read failed - keeping the last good configuration: " +
            error,
        );
      } else {
        info("[network-monitor] settings read recovered");
      }
    }
    return s;
  };

  /** The client an unqualified call acts on: the `client` parameter wins. */
  function pickAdapter(
    requested: string | undefined,
    s: NetworkMonitorSettings,
  ): TunnelClientAdapter | string {
    const id = requested ?? s.client;
    if (!isClientId(id)) {
      return (
        `Unknown client "${id}". Valid clients: ${CLIENT_IDS.join(", ")}. ` +
        "Pass client: one of the valid ids, or set braid.contrib.networkMonitor.client."
      );
    }
    return TUNNEL_CLIENTS[id];
  }

  type ToolResult = {
    content: { type: "text"; text: string }[];
    details: Record<string, unknown>;
  };

  /** Refusal payload shared by both tool families. */
  function refusalResult(
    text: string,
    adapter?: TunnelClientAdapter,
    capability?: Capability,
  ): ToolResult {
    return {
      content: [{ type: "text" as const, text }],
      details: {
        refused: true,
        ...(adapter
          ? {
              client: adapter.id,
              missing_facts: missingFacts(adapter, capability ?? "probe"),
              validation: adapter.validation,
            }
          : {}),
      },
    };
  }

  type Resolution<C> =
    | { client: C }
    | {
        refusal: string;
        adapter?: TunnelClientAdapter;
        capability: Capability;
      };

  /** Resolve a request to a probe-capable client, or return the refusal text. */
  function resolveProbe(
    requested: string | undefined,
    s: NetworkMonitorSettings,
  ): Resolution<ProbeClient> {
    if (!s.enabled) return { refusal: DISABLED_TEXT, capability: "probe" };
    const picked = pickAdapter(requested, s);
    if (typeof picked === "string") {
      return { refusal: picked, capability: "probe" };
    }
    const client = probeClient(picked);
    if (client === null) {
      return {
        refusal:
          probeRefusal(picked) ??
          `Client "${picked.id}" cannot be probed on this host.`,
        adapter: picked,
        capability: "probe",
      };
    }
    return { client };
  }

  /**
   * Resolve a request to a client that can be probed and toggled. Every
   * refusal - disabled, unknown id, missing facts - is answered before any
   * probe runs: verification is not attempted on an unvalidated arm.
   */
  function resolveToggle(
    requested: string | undefined,
    s: NetworkMonitorSettings,
  ): Resolution<OperableClient> {
    if (!s.enabled) return { refusal: DISABLED_TEXT, capability: "toggle" };
    const picked = pickAdapter(requested, s);
    if (typeof picked === "string") {
      return { refusal: picked, capability: "toggle" };
    }
    const client = operableClient(picked);
    if (client === null) {
      return {
        refusal:
          toggleRefusal(picked) ??
          `Client "${picked.id}" cannot be toggled on this host.`,
        adapter: picked,
        capability: "toggle",
      };
    }
    return { client };
  }

  /** Probe options for one client; the settings profile name wins. */
  function probeOptions(
    s: NetworkMonitorSettings,
    c: ProbeClient,
  ): ProbeOptions {
    return {
      displayName: c.displayName,
      bundleId: c.bundleId,
      profileName: s.profileName || c.profileName,
      appProcess: c.appProcess,
      extensionProcess: c.extensionProcess,
      reachabilityUrl: s.reachabilityUrl,
      curlTimeoutSecs: s.curlTimeoutSecs,
    };
  }

  /**
   * Cross-process lockfile serializing reconnect cycles from every pi process
   * on this machine (one file, one owner; see lock.ts). Resolved per call
   * under the braid root (`state-paths.ts`), so BRAID_HOME relocates it.
   */
  function reconnectOptions(
    s: NetworkMonitorSettings,
    c: OperableClient,
  ): ReconnectOptions | null {
    const lockFile = reconnectLockFile();
    if (lockFile === null) {
      if (!warnedNoLockPath) {
        warnedNoLockPath = true;
        warn(
          "[network-monitor] reconnect lock path is underivable (BRAID_HOME unset and no absolute home); reconnect cycles refuse rather than toggle without the cross-process lock",
        );
      }
      return null;
    }
    return {
      ...probeOptions(s, c),
      toggle: c.toggle,
      disconnectDelayMs: s.disconnectDelayMs,
      connectTimeoutMs: s.connectTimeoutMs,
      pollIntervalMs: s.pollIntervalMs,
      lockFile,
    };
  }

  // Reconnect cooldown (session-scoped, per client)

  interface MonitorState {
    lastReconnectAt: Record<string, number>;
  }

  function createState(): MonitorState {
    return { lastReconnectAt: {} };
  }

  /** The status flow for one client id (shared by the tool and its alias). */
  async function statusForClient(requested: string): Promise<ToolResult> {
    const s = settingsNow();
    const resolved = resolveProbe(requested, s);
    if ("refusal" in resolved) {
      info(`[network-monitor] status refused: ${resolved.refusal}`);
      return refusalResult(
        resolved.refusal,
        resolved.adapter,
        resolved.capability,
      );
    }
    const client = resolved.client;
    const result = await probeTunnel(probeOptions(s, client), execDeps);
    info(`[network-monitor] status (${client.id}): ${result.detail}`);
    return {
      content: [{ type: "text" as const, text: probeText(result) }],
      details: {
        client: client.id,
        profile_status: result.profileStatus,
        profile_name: result.profileName,
        profiles: result.profiles.map((p) => ({
          name: p.name,
          status: p.status,
        })),
        profile_raw: result.profileRaw,
        reachability_code: result.reachabilityCode,
        reachable: result.reachable,
        app_alive: result.appAlive,
        extension_alive: result.extensionAlive,
        down: result.down,
        route_only_drop: result.routeOnlyDrop,
      },
    };
  }

  /** The reconnect flow for one client id (shared by the tool and its alias). */
  async function reconnectForClient(
    requested: string,
    params: any,
    ctx: ExtensionContext,
  ): Promise<ToolResult> {
    const dryRun = params?.dry_run === true;
    const force = params?.force === true;

    const s = settingsNow();
    const resolved = resolveToggle(requested, s);
    if ("refusal" in resolved) {
      info(`[network-monitor] reconnect refused: ${resolved.refusal}`);
      return refusalResult(
        resolved.refusal,
        resolved.adapter,
        resolved.capability,
      );
    }
    const client = resolved.client;

    if (!s.autoReconnect && !force) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "Reconnect refused: autoReconnect is disabled in settings " +
              "(braid.contrib.networkMonitor.autoReconnect: false). " +
              "Pass force: true to override, or check status with tunnel_status.",
          },
        ],
        details: { refused: true, reason: "autoReconnect disabled" },
      };
    }

    const state = getExtensionState(ctx, "network-monitor", createState);
    const lastReconnectAt = state.lastReconnectAt[client.id] ?? 0;
    const sinceLast = Date.now() - lastReconnectAt;
    if (!force && lastReconnectAt > 0 && sinceLast < s.cooldownMs) {
      const remainingMs = s.cooldownMs - sinceLast;
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Reconnect refused: cooldown active (${Math.ceil(remainingMs / 1000)}s remaining). ` +
              "Pass force: true to override.",
          },
        ],
        details: {
          refused: true,
          reason: "cooldown",
          client: client.id,
          remaining_ms: remainingMs,
        },
      };
    }

    if (dryRun) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Dry run: probe first (an up tunnel is never bounced). Otherwise: ` +
              `${describeToggle(client.toggle)}, then verify within ` +
              `${s.connectTimeoutMs}ms (pause ${s.disconnectDelayMs}ms between ` +
              "the two). Nothing was toggled.",
          },
        ],
        details: { dry_run: true, toggled: false, client: client.id },
      };
    }

    info(
      `[network-monitor] reconnect (${client.id}): ${describeToggle(client.toggle)}`,
    );
    const reconnectOpts = reconnectOptions(s, client);
    if (reconnectOpts === null) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "Reconnect refused: no absolute braid root for the reconnect lock " +
              "(BRAID_HOME is unset and no absolute home resolves). Nothing was toggled.",
          },
        ],
        details: { ok: false, reason: "lock-path-underivable" },
      };
    }
    const outcome = await reconnectTunnel(reconnectOpts, execDeps);
    // Only a real toggle starts the session cooldown; a skip or a refused
    // lock toggled nothing.
    if (!outcome.skipped && !outcome.lockHeld) {
      state.lastReconnectAt[client.id] = Date.now();
    }
    info(
      `[network-monitor] reconnect ${outcome.ok ? "ok" : "failed"}: ${outcome.reason}`,
    );

    const headline = outcome.lockHeld
      ? "Reconnect refused: another process holds the reconnect lock (lock held). Nothing was toggled."
      : outcome.skipped
        ? "Reconnect not needed: the route already answers; the toggle cycle was skipped."
        : outcome.ok
          ? "Reconnect OK."
          : "Reconnect did not confirm within the timeout.";

    return {
      content: [
        {
          type: "text" as const,
          text: [
            headline,
            `Reason: ${outcome.reason}`,
            outcome.final
              ? probeText(outcome.final)
              : "No final probe available.",
          ].join("\n"),
        },
      ],
      details: {
        client: client.id,
        ok: outcome.ok,
        attempts: outcome.attempts,
        reason: outcome.reason,
        lock_held: outcome.lockHeld === true,
        skipped: outcome.skipped === true,
        final: outcome.final
          ? {
              profile_status: outcome.final.profileStatus,
              profile_name: outcome.final.profileName,
              reachability_code: outcome.final.reachabilityCode,
              reachable: outcome.final.reachable,
              app_alive: outcome.final.appAlive,
              extension_alive: outcome.final.extensionAlive,
              down: outcome.final.down,
              route_only_drop: outcome.final.routeOnlyDrop,
            }
          : null,
      },
    };
  }

  // Bind the logger context (and keep it for direct TUI notices) so watcher
  // state changes reach the user instead of a sink that discards them.
  pi.on("session_start", (_event, ctx) => {
    sessionCtx = ctx;
    setLoggerContext(ctx);
  });
  pi.on("session_shutdown", () => {
    if (handle) {
      handle.stop();
      handle = null;
      info("[network-monitor] watcher stopped (session shutdown)");
    }
    sessionCtx = null;
    setLoggerContext(null);
  });

  /** The reconnect flow bound to one settings snapshot and client. */
  function reconnectBound(
    s: NetworkMonitorSettings,
    client: OperableClient,
  ): () => Promise<ReconnectOutcome> {
    return async () => {
      info(
        `[network-monitor] watcher: reconnect flow starting (${client.id}, ${describeToggle(client.toggle)})`,
      );
      const reconnectOpts = reconnectOptions(s, client);
      if (reconnectOpts === null) {
        return {
          ok: false,
          attempts: 0,
          final: null,
          reason:
            "reconnect lock path is underivable (BRAID_HOME unset and no absolute home)",
        };
      }
      return reconnectTunnel(reconnectOpts, execDeps);
    };
  }

  /**
   * Plan one watcher step from a single settings snapshot: the stand-down
   * reasons first, then the frame the probe and toggle are bound to.
   */
  const watchPlan = (): WatchPlan => {
    const s = settingsNow();
    const standDown = !s.enabled
      ? "disabled in settings (braid.contrib.networkMonitor: false)"
      : !s.autoWatch
        ? "autoWatch is off in settings"
        : null;
    if (standDown !== null) {
      return { standDown, probeIntervalMs: s.probeIntervalMs };
    }
    const picked = pickAdapter(undefined, s);
    if (typeof picked === "string") {
      return { standDown: picked, probeIntervalMs: s.probeIntervalMs };
    }
    const client = probeClient(picked);
    if (client === null) {
      return {
        standDown:
          probeRefusal(picked) ?? `Client "${picked.id}" cannot be probed.`,
        probeIntervalMs: s.probeIntervalMs,
      };
    }
    const frame: WatchFrame = {
      probeIntervalMs: s.probeIntervalMs,
      settings: {
        autoReconnect: s.autoReconnect,
        maxAttemptsPerOutage: s.maxAttemptsPerOutage,
        reconnectCooldownMs: s.reconnectCooldownMs,
        outageThreshold: s.outageThreshold,
      },
      probe: async () => {
        const r = await probeTunnel(probeOptions(s, client), execDeps);
        debug(`[network-monitor] watcher probe (${client.id}): ${r.detail}`);
        return r;
      },
    };
    // A probe-only client still watches: it can confirm an outage and report
    // it, but it has no toggle mechanism to drive, so the frame carries the
    // refusal instead of a reconnect flow.
    const operable = operableClient(picked);
    if (operable === null) {
      frame.toggleRefusal =
        toggleRefusal(picked) ??
        `Client "${picked.id}" has no toggle mechanism on this host.`;
    } else {
      frame.reconnect = reconnectBound(s, operable);
    }
    return frame;
  };

  const initial = settingsNow();
  info(
    `[network-monitor] loaded - client "${initial.client}", ` +
      `profile "${initial.profileName || "(adapter default)"}", ` +
      `autoReconnect=${initial.autoReconnect}, cooldown=${initial.cooldownMs}ms, ` +
      `autoWatch=${initial.autoWatch}` +
      (initial.autoWatch
        ? ` (probe every ${initial.probeIntervalMs}ms, toggle after ` +
          `${initial.outageThreshold} consecutive failed probes, max ` +
          `${initial.maxAttemptsPerOutage} attempts/outage)`
        : "") +
      (initial.logFile ? `, logFile=${initial.logFile}` : ""),
  );
  if (!initial.enabled) {
    warn(
      "[network-monitor] disabled via settings (braid.contrib.networkMonitor: false) - loaded but inert; tools refuse and the watcher stands down until the setting changes.",
    );
  }

  const clientParam = Type.Optional(
    Type.String({
      description:
        `Client id: ${CLIENT_IDS.join(" | ")} ` +
        "(default: braid.contrib.networkMonitor.client).",
    }),
  );

  pi.registerTool({
    name: "tunnel_status",
    exposure: "deferred",
    label: "Tunnel status",
    promptSnippet: "Check whether the macOS tunnel client is connected",
    description:
      "Probe one macOS tunnel client rootlessly and report whether it is up. " +
      "The client adapter (v2RayTun, Happ, Incy) comes from the client parameter " +
      "or braid.contrib.networkMonitor.client. Checks the client's network-extension " +
      "profile roster via scutil (primary), reachability of the probe URL via curl, " +
      "and liveness of the app and, when it ships one, its system extension via " +
      "pgrep. Read-only - never toggles anything. A client without validated probe " +
      "facts is refused with the reason (nothing is probed). Use before and after a " +
      "reconnect to confirm the tunnel came back.",
    parameters: Type.Object({ client: clientParam }),
    execute: async (_toolCallId: string, params: any): Promise<any> =>
      statusForClient(params?.client ?? settingsNow().client),
  });

  pi.registerTool({
    name: "tunnel_reconnect",
    exposure: "deferred",
    label: "Tunnel reconnect",
    promptSnippet: "Reconnect the macOS tunnel client via its own mechanism",
    description:
      "Reconnect a macOS tunnel client through its own toggle mechanism (the " +
      "app's deep links, or the client's network-extension profile via scutil) and " +
      "then verify it comes back. The client adapter (v2RayTun, Happ, Incy) is " +
      "selected by the client parameter or braid.contrib.networkMonitor.client. " +
      "No killall, no system-extension toggle, no config edits. Guarded by a session " +
      "cooldown and the autoReconnect setting; pass force: true to bypass both. " +
      "dry_run: true reports what would happen without toggling anything. A client " +
      "without a validated toggle mechanism is refused with the reason (nothing is " +
      "toggled). This is an explicit action: the autonomous watcher instead waits " +
      "for several consecutive failed probes before it toggles.",
    parameters: Type.Object({
      client: clientParam,
      dry_run: Type.Optional(
        Type.Boolean({
          description:
            "Report the plan without toggling the tunnel (default false)",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            "Bypass the cooldown and the autoReconnect setting (default false)",
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: ExtensionContext,
    ): Promise<any> =>
      reconnectForClient(params?.client ?? settingsNow().client, params, ctx),
  });

  // Compatibility aliases: the shipped v2raytun_* names, pinned to their
  // client regardless of the `client` setting.

  pi.registerTool({
    name: "v2raytun_status",
    exposure: "deferred",
    label: "v2RayTun status (alias of tunnel_status)",
    promptSnippet: "Check whether the v2RayTun tunnel is connected",
    description:
      "Alias of tunnel_status pinned to client v2raytun (kept for compatibility; " +
      "prefer tunnel_status). Probes the v2RayTun tunnel rootlessly and reports " +
      "whether it is up: NE profile via scutil, probe-URL reachability via curl, " +
      "app and system-extension liveness via pgrep. Read-only.",
    parameters: Type.Object({}),
    execute: async (): Promise<any> => statusForClient("v2raytun"),
  });

  pi.registerTool({
    name: "v2raytun_reconnect",
    exposure: "deferred",
    label: "v2RayTun reconnect (alias of tunnel_reconnect)",
    promptSnippet: "Reconnect the v2RayTun tunnel via its deep links",
    description:
      "Alias of tunnel_reconnect pinned to client v2raytun (kept for compatibility; " +
      "prefer tunnel_reconnect). Reconnects via the app's own deep links, then " +
      "verifies it comes back. No killall, no system-extension toggle, no config " +
      "edits. Guarded by a session cooldown and the autoReconnect setting; pass " +
      "force: true to bypass both. dry_run: true reports what would happen without " +
      "toggling anything.",
    parameters: Type.Object({
      dry_run: Type.Optional(
        Type.Boolean({
          description:
            "Report the plan without toggling the tunnel (default false)",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            "Bypass the cooldown and the autoReconnect setting (default false)",
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      ctx: ExtensionContext,
    ): Promise<any> => reconnectForClient("v2raytun", params, ctx),
  });

  // Autonomous watcher (autoWatch). Started unconditionally: the planner
  // stands it down while settings disable it, so re-enabling is live.
  handle = startTunnelWatcher(
    watchPlan,
    {
      sleep,
      log: (msg: string) => info(`[network-monitor] ${msg}`),
      debug: (msg: string) => debug(`[network-monitor] ${msg}`),
      warn: (msg: string) => warn(`[network-monitor] ${msg}`),
      notify: (msg: string) => {
        sessionCtx?.ui.notify(`[network-monitor] ${msg}`, "warning");
      },
    },
    timers,
  );

  // A provider abort is a hint, not an outage: it only opens the
  // confirmation sequence, and the probe cadence decides from there.
  pi.on("agent_settled", (event) => {
    if (event.aborted) {
      handle?.signalDistress("agent run aborted (provider abort)");
    }
  });
}
