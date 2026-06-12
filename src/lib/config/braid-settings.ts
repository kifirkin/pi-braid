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
