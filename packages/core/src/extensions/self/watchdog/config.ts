/**
 * Watchdog Config — `broker.watchdog` in settings.json.
 *
 * Native-style optional override, NO new env vars (design doc: default-ON,
 * code-constant defaults). When the settings key is absent (or invalid) the
 * watchdog runs with DEFAULT_WATCHDOG_CONFIG from engine.ts.
 *
 *   settings.json:
 *     "broker": {
 *       "watchdog": {
 *         "mode": "on" | "off",
 *         "baseMs": 900000,     // BASE cadence (healthy), default 15min
 *         "hotMs": 180000,      // HOT cadence (≥1 open issue), default 3min
 *         "stallMult": 5,       // turn-stall threshold = stallMult × baseMs
 *         "streamSilenceMs": 600000, // wire-silence threshold while streaming
 *         "quotaErrors": 3,     // consecutive LLM 429/403/rotation gate
 *         "tunnelFailures": 5   // consecutive getUpdates-failure gate
 *       }
 *     }
 *
 * Invalid fields fall back to their default; the whole block ignored when not
 * an object. `broker` is the design-doc-named namespace (no existing pi-core
 * `broker` key) — kept as-is per the architecture.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WATCHDOG_CONFIG, type WatchdogConfig, type WatchdogMode } from "./engine.js";

/** Default settings file (matches braid-settings.ts / loader.ts path). */
// Honor the shared config-dir override: PI_CODING_AGENT_DIR when set,
// else ~/.pi/agent.
const WATCHDOG_CONFIG_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
export const WATCHDOG_SETTINGS_PATH = join(WATCHDOG_CONFIG_DIR, "settings.json");

/** Positive finite number or undefined. */
function positiveFinite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Positive integer or undefined (counters must be whole). */
function positiveInteger(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

export function loadWatchdogConfig(path: string = WATCHDOG_SETTINGS_PATH): WatchdogConfig {
  let raw: unknown;
  try {
    if (existsSync(path)) raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // non-fatal — fall through to defaults
  }
  const block = (raw as { broker?: { watchdog?: unknown } } | null)?.broker?.watchdog;
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return { ...DEFAULT_WATCHDOG_CONFIG };
  }
  const b = block as Record<string, unknown>;
  const cfg: WatchdogConfig = { ...DEFAULT_WATCHDOG_CONFIG };
  if (b.mode === "on" || b.mode === "off") cfg.mode = b.mode as WatchdogMode;
  const baseMs = positiveFinite(b.baseMs);
  const hotMs = positiveFinite(b.hotMs);
  const stallMult = positiveFinite(b.stallMult);
  const streamSilenceMs = positiveFinite(b.streamSilenceMs);
  const quotaErrors = positiveInteger(b.quotaErrors);
  const tunnelFailures = positiveInteger(b.tunnelFailures);
  if (baseMs !== undefined) cfg.baseMs = baseMs;
  if (hotMs !== undefined) cfg.hotMs = hotMs;
  if (stallMult !== undefined) cfg.stallMult = stallMult;
  if (streamSilenceMs !== undefined) cfg.streamSilenceMs = streamSilenceMs;
  if (quotaErrors !== undefined) cfg.quotaErrors = quotaErrors;
  if (tunnelFailures !== undefined) cfg.tunnelFailures = tunnelFailures;
  return cfg;
}
