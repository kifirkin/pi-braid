/**
 * Braid Settings - unified reader for pi settings.json braid config.
 *
 * The settings.json file mixes pi-native settings with braid config under a
 * top-level `braid` key. This module reads that config safely and provides
 * a single source of truth for all braid-related feature flags.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

interface BraidConfig {
  suppressNudges?: boolean;
  /**
   * Enforcement-layer overrides. Schema-validated at read time by the
   * NudgeManager (which owns the NudgeType schema); invalid entries
   * are logged and dropped. Empty object = no overrides (use defaults).
   *
   * Example:
   *   "braid": {
   *     "enforcement": {
   *       "nudgeConfigs": {
   *         "validation": { "baseCooldownMs": 30000 },
   *         "malformed": { "deduplicate": false }
   *       }
   *     }
   *   }
   */
  enforcement?: {
    /**
     * Per-NudgeType config overrides. Keys are NudgeType values
     * (validation, recordFailure, malformed, memory, scratchpad,
     * context, sessionSignals). Values are partial NudgeConfig -
     * only the fields to override.
     */
    nudgeConfigs?: Record<string, unknown>;
  };
}

interface Settings {
  braid?: BraidConfig;
}

/** Read and parse settings.json. Not cached - always reads fresh to respect runtime changes. */
function readSettings(): Settings {
  let result: Settings = {};
  try {
    if (existsSync(SETTINGS_PATH)) {
      result = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Settings;
    }
  } catch {
    // Non-fatal: fall through to empty settings
  }
  return result;
}

/**
 * Whether cognitive nudges (enforcement whispers, heartbeat suggestions,
 * feedback reminders) should be suppressed entirely.
 *
 * Controlled by braid.suppressNudges in settings.json.
 * Default: false - nudges are ENABLED by default.
 *
 * A user who wants to skip Y/n prompts would set that in pi's native settings -
 * this flag only affects braid's own cognitive nudges.
 */
export function areCognitiveNudgesDisabled(): boolean {
  const settings = readSettings();
  if (settings.braid?.suppressNudges !== undefined) {
    return settings.braid.suppressNudges === true;
  }
  // Default: nudges are enabled (safe default - braid's value prop is ON)
  return false;
}

/**
 * Read the raw braid.enforcement.nudgeConfigs block from settings.json.
 *
 * Returns an UNVALIDATED shape. Callers must pass the result through
 * NudgeManager.validateNudgeConfig() (or parseNudgeConfigOverrides())
 * before constructing a NudgeManager - the validation lives next to
 * the NudgeType schema to keep the type knowledge in one place.
 *
 * Returns {} when:
 *   - settings.json doesn't exist
 *   - the braid key isn't present
 *   - the enforcement key isn't present
 *   - nudgeConfigs is missing or not an object
 */
export function getRawNudgeConfigOverrides(): Record<string, unknown> {
  const settings = readSettings();
  const raw = settings.braid?.enforcement?.nudgeConfigs;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}
