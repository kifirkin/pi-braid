/**
 * Network Monitor Extension - rootless v2RayTun status + reconnect tools +
 * autonomous watcher.
 *
 * Two tools the agent invokes on demand:
 *   - v2raytun_status     - probe the tunnel (NE profile, reachability, app,
 *                           extension) and report whether it is up.
 *   - v2raytun_reconnect  - toggle via the app's own deep links
 *                           (v2raytun://disconnect -> connect) with
 *                           verify-after, guarded by a session cooldown and
 *                           the autoReconnect setting.
 *
 * Plus an autonomous watcher (autoWatch, default on): probes the tunnel on
 * an interval with the same read-only probe ladder and, when it observes an
 * UP->DOWN transition with autoReconnect enabled, runs the same deep-link
 * reconnect flow - retried up to maxAttemptsPerOutage times spaced by
 * reconnectCooldownMs, each attempt verified with a fresh probe. Persistent
 * failure logs a warning and stands down (no hammering); recovery resets the
 * counters. The interval timer is unref'd and cleared on session_shutdown.
 *
 * Config lives in the user settings file under braid.contrib.networkMonitor
 * (Pi core philosophy: settings, not process.env):
 *
 *   braid.contrib.networkMonitor: false                      -> disabled
 *   braid.contrib.networkMonitor: true                       -> defaults
 *   braid.contrib.networkMonitor: {
 *     profileName: "v2RayTun",          // NE profile name for scutil
 *     reachabilityUrl: "https://api.telegram.org",
 *     curlTimeoutSecs: 6,
 *     disconnectDelayMs: 2000,          // pause between disconnect and connect
 *     connectTimeoutMs: 30000,          // max wait for the tunnel to come up
 *     pollIntervalMs: 2000,
 *     cooldownMs: 60000,                // min gap between reconnects per session
 *     autoReconnect: true,              // false -> reconnect tool refuses (unless force)
 *     autoWatch: true,                  // background watcher: probe on an interval, auto-heal
 *     probeIntervalMs: 90000,           // watcher probe cadence
 *     maxAttemptsPerOutage: 3,          // watcher reconnect attempts per outage
 *     reconnectCooldownMs: 60000,       // pause between watcher reconnect attempts
 *     logFile: ""                       // optional append-only file for log lines
 *   }
 *
 * Reconnect cycles (tool and watcher alike) serialize on one cross-process
 * lockfile under ~/.pi/agent/ so two pi processes never double-toggle.
 *
 * Guardrails: probes and deep-link toggles only. No killall, no
 * system-extension toggle, no config file edits. Surfshark and other NE
 * profiles are never touched.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger, setLoggerContext } from "../logger.js";
import { reconnectLockFile } from "../state-paths.js";
import { createLogFileSink } from "./log-file.js";
import { getExtensionState } from "pi-braid/lib";
import {
  defaultExec,
  defaultSleep,
  probeText,
  probeTunnel,
  reconnectTunnel,
  startTunnelWatcher,
  type ProbeOptions,
  type ReconnectOptions,
  type WatcherHandle,
} from "./v2raytun.js";

const log = createLogger("network-monitor");

interface NetworkMonitorSettings {
  enabled: boolean;
  profileName: string;
  reachabilityUrl: string;
  curlTimeoutSecs: number;
  disconnectDelayMs: number;
  connectTimeoutMs: number;
  pollIntervalMs: number;
  cooldownMs: number;
  autoReconnect: boolean;
  autoWatch: boolean;
  probeIntervalMs: number;
  maxAttemptsPerOutage: number;
  reconnectCooldownMs: number;
  logFile: string;
}

const DEFAULTS: Omit<NetworkMonitorSettings, "enabled"> = {
  profileName: "v2RayTun",
  reachabilityUrl: "https://api.telegram.org",
  curlTimeoutSecs: 6,
  disconnectDelayMs: 2000,
  connectTimeoutMs: 30000,
  pollIntervalMs: 2000,
  cooldownMs: 60000,
  autoReconnect: true,
  autoWatch: true,
  probeIntervalMs: 90_000,
  maxAttemptsPerOutage: 3,
  reconnectCooldownMs: 60_000,
  logFile: "",
};

/**
 * Cross-process lockfile serializing reconnect cycles from every pi process
 * on this machine (one file, one owner; see lock.ts). Resolved per call under
 * the braid root (`state-paths.ts`), so BRAID_HOME relocates it.
 */

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function readSettings(): NetworkMonitorSettings {
  const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  let parsed: { braid?: { contrib?: { networkMonitor?: unknown } } } = {};
  try {
    if (fs.existsSync(settingsPath)) {
      parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    }
  } catch {
    // unreadable settings - fall back to defaults
  }
  const nm = parsed.braid?.contrib?.networkMonitor;
  if (nm === false) return { ...DEFAULTS, enabled: false };
  if (nm === undefined || nm === true) return { ...DEFAULTS, enabled: true };
  if (typeof nm === "object" && nm !== null) {
    const o = nm as Record<string, unknown>;
    return {
      enabled: true,
      profileName: str(o.profileName, DEFAULTS.profileName),
      reachabilityUrl: str(o.reachabilityUrl, DEFAULTS.reachabilityUrl),
      curlTimeoutSecs: num(o.curlTimeoutSecs, DEFAULTS.curlTimeoutSecs),
      disconnectDelayMs: num(o.disconnectDelayMs, DEFAULTS.disconnectDelayMs),
      connectTimeoutMs: num(o.connectTimeoutMs, DEFAULTS.connectTimeoutMs),
      pollIntervalMs: num(o.pollIntervalMs, DEFAULTS.pollIntervalMs),
      cooldownMs: num(o.cooldownMs, DEFAULTS.cooldownMs),
      autoReconnect: bool(o.autoReconnect, DEFAULTS.autoReconnect),
      autoWatch: bool(o.autoWatch, DEFAULTS.autoWatch),
      probeIntervalMs: num(o.probeIntervalMs, DEFAULTS.probeIntervalMs),
      maxAttemptsPerOutage: num(
        o.maxAttemptsPerOutage,
        DEFAULTS.maxAttemptsPerOutage,
      ),
      reconnectCooldownMs: num(
        o.reconnectCooldownMs,
        DEFAULTS.reconnectCooldownMs,
      ),
      logFile: str(o.logFile, DEFAULTS.logFile),
    };
  }
  return { ...DEFAULTS, enabled: true };
}

function probeOptions(s: NetworkMonitorSettings): ProbeOptions {
  return {
    profileName: s.profileName,
    reachabilityUrl: s.reachabilityUrl,
    curlTimeoutSecs: s.curlTimeoutSecs,
  };
}

function reconnectOptions(s: NetworkMonitorSettings): ReconnectOptions | null {
  const lockFile = reconnectLockFile();
  if (lockFile === null) {
    if (!warnedNoLockPath) {
      warnedNoLockPath = true;
      log.warn(
        "[network-monitor] reconnect lock path is underivable (BRAID_HOME unset and no absolute home); reconnect cycles refuse rather than toggle without the cross-process lock",
      );
    }
    return null;
  }
  return {
    ...probeOptions(s),
    disconnectDelayMs: s.disconnectDelayMs,
    connectTimeoutMs: s.connectTimeoutMs,
    pollIntervalMs: s.pollIntervalMs,
    lockFile,
  };
}

/** Warned once per process: an outage loop must not repeat this line. */
let warnedNoLockPath = false;

// Reconnect cooldown (session-scoped)

interface MonitorState {
  lastReconnectAt: number;
}

function createState(): MonitorState {
  return { lastReconnectAt: 0 };
}

export default function networkMonitorExtension(pi: ExtensionAPI): void {
  const settings = readSettings();
  if (!settings.enabled) {
    log.info(
      "[network-monitor] disabled via settings (braid.contrib.networkMonitor: false).",
    );
    return;
  }

  const fileSink = createLogFileSink(settings.logFile);
  let sessionCtx: ExtensionContext | null = null;
  let handle: WatcherHandle | null = null;

  const info = (msg: string): void => {
    log.info(msg);
    fileSink?.append("info", msg);
  };
  const warn = (msg: string): void => {
    log.warn(msg);
    fileSink?.append("warn", msg);
  };
  const debug = (msg: string): void => {
    log.debug(msg);
    fileSink?.append("debug", msg);
  };

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

  info(
    `[network-monitor] loaded - profile "${settings.profileName}", ` +
      `autoReconnect=${settings.autoReconnect}, cooldown=${settings.cooldownMs}ms, ` +
      `autoWatch=${settings.autoWatch}` +
      (settings.autoWatch
        ? ` (probe every ${settings.probeIntervalMs}ms, max ${settings.maxAttemptsPerOutage} attempts/outage)`
        : "") +
      (settings.logFile ? `, logFile=${settings.logFile}` : ""),
  );

  pi.registerTool({
    name: "v2raytun_status",
    exposure: "deferred",
    label: "v2RayTun status",
    promptSnippet: "Check whether the v2RayTun tunnel is connected",
    description:
      "Probe the v2RayTun tunnel rootlessly and report whether it is up. " +
      "Checks the NE profile via scutil (primary), reachability of the probe " +
      "URL via curl, and liveness of the app and its system extension via " +
      "pgrep. Read-only - never toggles anything. Use before and after a " +
      "reconnect to confirm the tunnel came back.",
    parameters: Type.Object({}),
    execute: async (): Promise<any> => {
      const result = await probeTunnel(probeOptions(settings), {
        exec: defaultExec,
        sleep: defaultSleep,
      });
      info(`[network-monitor] status: ${result.detail}`);
      return {
        content: [{ type: "text" as const, text: probeText(result) }],
        details: {
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
    },
  });

  pi.registerTool({
    name: "v2raytun_reconnect",
    exposure: "deferred",
    label: "v2RayTun reconnect",
    promptSnippet: "Reconnect the v2RayTun tunnel via its deep links",
    description:
      "Reconnect the v2RayTun tunnel via the app's own deep links, then verify it " +
      "comes back. Deep links: v2raytun://disconnect, then v2raytun://connect. " +
      "No killall, no system-extension toggle, no config edits. " +
      "Guarded by a session cooldown and the autoReconnect setting; pass " +
      "force: true to bypass both. dry_run: true reports what would happen " +
      "without toggling anything.",
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
    ): Promise<any> => {
      const dryRun = params?.dry_run === true;
      const force = params?.force === true;

      if (!settings.autoReconnect && !force) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Reconnect refused: autoReconnect is disabled in settings " +
                "(braid.contrib.networkMonitor.autoReconnect: false). " +
                "Pass force: true to override, or check status with v2raytun_status.",
            },
          ],
          details: { refused: true, reason: "autoReconnect disabled" },
        };
      }

      const state = getExtensionState(ctx, "network-monitor", createState);
      const sinceLast = Date.now() - state.lastReconnectAt;
      if (
        !force &&
        state.lastReconnectAt > 0 &&
        sinceLast < settings.cooldownMs
      ) {
        const remainingMs = settings.cooldownMs - sinceLast;
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
                `open "v2raytun://disconnect", ` +
                `wait ${settings.disconnectDelayMs}ms, ` +
                `open "v2raytun://connect", then verify within ${settings.connectTimeoutMs}ms. ` +
                "Nothing was toggled.",
            },
          ],
          details: { dry_run: true, toggled: false },
        };
      }

      info("[network-monitor] reconnect: disconnect -> connect (deep links)");
      const reconnectOpts = reconnectOptions(settings);
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
      const outcome = await reconnectTunnel(reconnectOpts, {
        exec: defaultExec,
        sleep: defaultSleep,
      });
      // Only a real toggle starts the session cooldown; a skip or a refused
      // lock toggled nothing.
      if (!outcome.skipped && !outcome.lockHeld) {
        state.lastReconnectAt = Date.now();
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
    },
  });

  // Autonomous watcher (autoWatch)

  if (settings.autoWatch) {
    handle = startTunnelWatcher(
      {
        autoWatch: true,
        probeIntervalMs: settings.probeIntervalMs,
        autoReconnect: settings.autoReconnect,
        maxAttemptsPerOutage: settings.maxAttemptsPerOutage,
        reconnectCooldownMs: settings.reconnectCooldownMs,
      },
      {
        probe: async () => {
          const r = await probeTunnel(probeOptions(settings), {
            exec: defaultExec,
            sleep: defaultSleep,
          });
          debug(`[network-monitor] watcher probe: ${r.detail}`);
          return r;
        },
        reconnect: () => {
          info(
            "[network-monitor] watcher: reconnect flow starting (deep links)",
          );
          const reconnectOpts = reconnectOptions(settings);
          if (reconnectOpts === null) {
            return Promise.resolve({
              ok: false,
              attempts: 0,
              final: null,
              reason:
                "reconnect lock path is underivable (BRAID_HOME unset and no absolute home)",
            });
          }
          return reconnectTunnel(reconnectOpts, {
            exec: defaultExec,
            sleep: defaultSleep,
          });
        },
        sleep: defaultSleep,
        log: (msg: string) => info(`[network-monitor] ${msg}`),
        warn: (msg: string) => warn(`[network-monitor] ${msg}`),
        notify: (msg: string) => {
          sessionCtx?.ui.notify(`[network-monitor] ${msg}`, "warning");
        },
      },
      {
        setInterval: (cb: () => void, ms: number) => setInterval(cb, ms),
        clearInterval: (t: unknown) => clearInterval(t as NodeJS.Timeout),
      },
    );
  }
}
