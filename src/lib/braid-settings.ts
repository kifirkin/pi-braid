/**
 * Braid Settings — unified reader for pi settings.json braid config.
 *
 * The settings.json file mixes pi-native settings with braid config under a
 * top-level `braid` key. This module reads that config safely and provides
 * a single source of truth for all braid-related feature flags.
 *
 * Settings hierarchy:
 *   braid.suppressNudges   — if true, all cognitive whispers (enforcement,
 *                            heartbeat, feedback) are suppressed.
 *                            Default: false (nudges ENABLED by default).
 *                            This is SEPARATE from disableConfirmations which
 *                            only affects blocking Y/n confirmation dialogs.
 *
 *   disableConfirmations   — pi-native: skip blocking confirmation dialogs.
 *                            Does NOT affect cognitive whispers (see above).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

interface BraidConfig {
  suppressNudges?: boolean;
}

interface Settings {
  disableConfirmations?: boolean;
  braid?: BraidConfig;
}

/** Read and parse settings.json. Not cached — always reads fresh to respect runtime changes. */
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
 * Whether blocking confirmation dialogs (Y/n) should be auto-confirmed.
 * This is the pi-native disableConfirmations flag.
 */
export function isConfirmDialogDisabled(): boolean {
  return readSettings().disableConfirmations === true;
}

/**
 * Whether cognitive nudges (enforcement whispers, heartbeat suggestions,
 * feedback reminders) should be suppressed entirely.
 *
 * Controlled by braid.suppressNudges in settings.json.
 * Default: false — nudges are ENABLED by default.
 *
 * This is semantically SEPARATE from isConfirmDialogDisabled().
 * A user may want to skip Y/n prompts but still see cognitive reminders.
 */
export function areCognitiveNudgesDisabled(): boolean {
  const settings = readSettings();
  if (settings.braid?.suppressNudges !== undefined) {
    return settings.braid.suppressNudges === true;
  }
  // Default: nudges are enabled (safe default — braid's value prop is ON)
  return false;
}


