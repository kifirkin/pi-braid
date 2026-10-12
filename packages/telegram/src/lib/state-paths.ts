/**
 * Canonical state locations for the Telegram extension.
 *
 * Contract: braid-owned state lives under the braid home
 * (~/.pi/agent/braid, overridable per call via BRAID_HOME), never under the
 * session's working directory — a cwd-relative state file pollutes every
 * project a session runs in (and forks one offset state per cwd).
 * Explicit BRAID_TG_STATE_FILE / BRAID_TG_LIVE_UPDATE_STATE_FILE overrides
 * still win at the call sites.
 *
 * Downloaded media and the inline-keyboard pause state moved from pi's agent
 * directory into `<braidDir>/telegram/`. Both are read-compatible with their
 * pre-move location: a read falls back to the old copy when the new one is
 * absent (`resolveMediaReadPath`, `legacyPauseStateFile`), a write never
 * touches it.
 */

import * as os from "node:os";
import * as path from "node:path";
import { existsSync } from "node:fs";

/** Braid home root; BRAID_HOME wins. Read on every call so tests can pin
 *  the whole tree into a tmpdir (mirrors pi-braid core's braidDir()). */
export function braidDir(): string {
  const override = process.env.BRAID_HOME;
  return override && override.trim()
    ? path.resolve(override)
    : path.join(os.homedir(), ".pi", "agent", "braid");
}

/** Telegram state dir under the braid root: media, pause state, future
 *  sinks. The offset/live-update files predate it and stay at the root. */
export function telegramStateDir(): string {
  return path.join(braidDir(), "telegram");
}

/** Default inbound offset/lock state file. */
export function defaultStateFilePath(): string {
  return path.join(braidDir(), "telegram-state.json");
}

/** Default live-update tracker state file (beside the offset state). */
export function defaultLiveUpdateFilePath(): string {
  return path.join(braidDir(), "telegram-live-update.json");
}

/** Media dir for downloaded photo/voice/document bytes. */
export function defaultMediaDir(): string {
  return path.join(telegramStateDir(), "media");
}

/** Pre-move media dir directly under pi's agent directory. Read-only
 *  fallback for files recorded before the relocation; never a write target. */
export function legacyMediaDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "telegram-media");
}

/**
 * Read-side resolution for one stored media file: the braid-root copy when it
 * exists, else the pre-move copy of the same name when that exists, else the
 * current-root path (so a caller reports the miss against the write target).
 * Writes always go to `defaultMediaDir()`.
 */
export function resolveMediaReadPath(fileName: string): string {
  const current = path.isAbsolute(fileName)
    ? fileName
    : path.join(defaultMediaDir(), fileName);
  if (existsSync(current)) return current;
  const legacy = path.join(legacyMediaDir(), path.basename(fileName));
  return existsSync(legacy) ? legacy : current;
}

/** Pause-state file under the braid root (the write target). */
export function defaultPauseStateFile(): string {
  return path.join(telegramStateDir(), "pause-state.json");
}

/** Pre-move pause-state file directly under pi's agent directory. Read-only
 *  fallback; never a write target. */
export function legacyPauseStateFile(): string {
  return path.join(os.homedir(), ".pi", "agent", "telegram-pause-state.json");
}
