/**
 * Network-monitor settings: the defaults, the document parser, and the live
 * source the extension reads on every probe and every tick.
 *
 * Deliberately node-only (no pi imports): the settings document reader is
 * injected, so parse/merge/last-good are unit-testable without a settings
 * file or a running pi. The extension entry point (index.ts) wires the real
 * reader - pi's settings.json through core's `readSettingsFileOutcome`, so
 * `PI_CODING_AGENT_DIR` relocates the read like every other braid setting.
 *
 * Live semantics (a read-once-at-init read made `networkMonitor: false` a
 * no-op until the process restarted):
 *   - every `current()` call re-reads the document, so an edit lands on the
 *     next read (a tick, a tool call) with no process restart, in both
 *     directions;
 *   - a failing read (unreadable or unparseable file) keeps the last good
 *     settings and reports the error, so a half-written settings.json can
 *     never silently re-enable a monitor the owner disabled;
 *   - a missing file is not an error: it means defaults.
 *
 * Defaults (the documented surface under braid.contrib.networkMonitor):
 *   client: "v2raytun", profileName: "" (the adapter's own),
 *   reachabilityUrl: "https://api.telegram.org", curlTimeoutSecs: 6,
 *   disconnectDelayMs: 2000, connectTimeoutMs: 30000, pollIntervalMs: 2000,
 *   cooldownMs: 60000, autoReconnect: true, autoWatch: true,
 *   probeIntervalMs: 90000, maxAttemptsPerOutage: 3,
 *   reconnectCooldownMs: 60000, outageThreshold: 3, logFile: "" (off).
 *
 * `outageThreshold` is the hysteresis: that many consecutive failed probes,
 * spaced by `probeIntervalMs`, are required before the watcher toggles
 * anything. A single failed probe (or a provider-abort signal, which only
 * opens the confirmation window) never toggles.
 */

/** The settings shape the extension consumes; `enabled` is `networkMonitor !== false`. */
export interface NetworkMonitorSettings {
  enabled: boolean;
  client: string;
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
  outageThreshold: number;
  logFile: string;
}

export const DEFAULTS: Omit<NetworkMonitorSettings, "enabled"> = {
  client: "v2raytun",
  profileName: "",
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
  outageThreshold: 3,
  logFile: "",
};

/** The part of pi's settings.json this extension reads. */
export interface SettingsDocument {
  braid?: { contrib?: { networkMonitor?: unknown } };
}

/**
 * The raw `braid.contrib.networkMonitor` value. This is the module's
 * settings read site (the schema generator's existence check points here).
 */
export function networkMonitorSetting(parsed: SettingsDocument): unknown {
  const nm = parsed.braid?.contrib?.networkMonitor;
  return nm;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

/** Pure document -> settings. `false` disables; `true`/absent/unknown means defaults. */
export function parseSettings(
  parsed: SettingsDocument,
): NetworkMonitorSettings {
  const nm = networkMonitorSetting(parsed);
  if (nm === false) return { ...DEFAULTS, enabled: false };
  if (nm === undefined || nm === true) return { ...DEFAULTS, enabled: true };
  if (typeof nm === "object" && nm !== null) {
    const o = nm as Record<string, unknown>;
    return {
      enabled: true,
      client: str(o.client, DEFAULTS.client),
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
      outageThreshold: num(o.outageThreshold, DEFAULTS.outageThreshold),
      logFile: str(o.logFile, DEFAULTS.logFile),
    };
  }
  return { ...DEFAULTS, enabled: true };
}

/**
 * Read the settings document, or null when there is none to read. Throws when
 * a present document cannot be read or parsed: the live source needs to tell
 * "no settings saved" (defaults) from "the file is broken" (keep last good).
 */
export type SettingsDocumentReader = () => SettingsDocument | null;

export interface LiveSettings {
  /** The current settings: a fresh read when it succeeds, last good when it does not. */
  current(): NetworkMonitorSettings;
  /** Message from the most recent failed read; null after a clean read. */
  error(): string | null;
}

/**
 * Build the live source over an injected document reader. The first call that
 * lands on a failing read falls back to defaults (there is no last good yet)
 * and reports the error; later failing reads keep the previous good settings.
 */
export function createLiveSettings(read: SettingsDocumentReader): LiveSettings {
  let lastGood: NetworkMonitorSettings = { ...DEFAULTS, enabled: true };
  let lastError: string | null = null;
  return {
    current(): NetworkMonitorSettings {
      let parsed: SettingsDocument | null;
      try {
        parsed = read();
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        return lastGood;
      }
      lastError = null;
      lastGood = parseSettings(parsed ?? {});
      return lastGood;
    },
    error(): string | null {
      return lastError;
    },
  };
}
