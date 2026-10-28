/**
 * Per-tool enable/disable settings, unified with pi's `settings.json`.
 *
 * Single source of truth is `braid.contrib.<extensionName>.enabled: string[]`
 * in settings.json. The file path resolves through pi's agent-directory helper,
 * so `PI_CODING_AGENT_DIR` relocates braid's setting reads and writes together
 * with pi's. A module-level `join(homedir(), ...)` constant silently ignored
 * the override: braid read and wrote the default file while pi read the
 * relocated one, and configured values appeared to be ignored.
 *
 * This module is the one writer for settings.json. Every write goes through
 * `updateSettings`, which keeps read-modify-write in a single synchronous
 * transaction and installs the result with temp-file-plus-rename. Two writers
 * rewriting the whole file from their own async read-modify-write can
 * interleave: the later write replaces the file with its own read snapshot
 * and drops the other's key (a `/utility-model` key lost to a concurrent
 * toggle).
 *
 * A refused write is reported as a return value, not a thrown exception. The
 * only synchronous callers run inside a TUI input callback, and an exception
 * escaping that callback reaches pi's `uncaughtException` handler, which exits
 * the process; a value lets each call site decide how to surface the failure.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Absolute path to pi's settings.json in the active agent directory. */
export function getSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

/** Raw settings.json shape. Individual values are owned by their writers. */
export type SettingsFile = Record<string, unknown>;

export interface ContribSettings {
  braid?: {
    contrib?: Record<string, unknown>;
  };
}

/** Outcome of a settings.json read, distinguishing a missing file from an unreadable one. */
export type SettingsReadOutcome =
  | { state: "ok"; settings: SettingsFile }
  | { state: "missing"; settings: SettingsFile }
  | { state: "invalid"; settings: SettingsFile; path: string; error: Error };

/**
 * Read settings.json and report why a read failed.
 *
 * `state: "missing"` is a genuinely absent file: a fresh install has no
 * settings, and callers treat it as "no saved config". `state: "invalid"` is a
 * file that exists but cannot be read or parsed; `readSettingsFile` degrades it
 * to `{}` for backward compatibility, but a caller with a user-facing surface
 * reads this outcome so the degradation is not mistaken for "no config saved".
 */
export function readSettingsFileOutcome(): SettingsReadOutcome {
  const path = getSettingsPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return { state: "missing", settings: {} };
    }
    return { state: "invalid", settings: {}, path, error: toError(err) };
  }
  try {
    return { state: "ok", settings: JSON.parse(raw) as SettingsFile };
  } catch (err) {
    return { state: "invalid", settings: {}, path, error: toError(err) };
  }
}

/** Read settings.json, tolerating a missing or unparseable file. */
export function readSettingsFile(): SettingsFile {
  return readSettingsFileOutcome().settings;
}

export function readSettings(): ContribSettings {
  return readSettingsFile() as ContribSettings;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Temp-file counter: two writes in one millisecond must not share a temp path. */
let _tmpSeq = 0;

/**
 * Outcome of a settings.json write. A refusal or I/O failure is a VALUE, not a
 * thrown exception: the synchronous callers run inside a TUI input callback,
 * and an exception escaping that callback reaches pi's `uncaughtException`
 * handler, which exits the process. Returning the failure lets each call site
 * report it without killing the session.
 */
export type SettingsWriteOutcome =
  | { ok: true }
  | { ok: false; reason: "existing-file-invalid" | "io"; path: string; error: Error };

/**
 * The one settings.json write path: read, mutate, atomically replace.
 *
 * The whole read-modify-write is synchronous, so no other write can interleave
 * between the read and the rename - two callers in the same tick both land.
 * The rename is atomic, so a reader never sees a half-written file. When the
 * existing file is present but unparseable the write is REFUSED: the file is
 * left byte-for-byte untouched and `{ ok: false, reason: "existing-file-invalid" }`
 * is returned, rather than clobbering settings keys this mutation does not own.
 */
export function updateSettings(mutate: (settings: SettingsFile) => void): SettingsWriteOutcome {
  const path = getSettingsPath();
  const existing = readSettingsFileOutcome();
  if (existing.state === "invalid") {
    return { ok: false, reason: "existing-file-invalid", path, error: existing.error };
  }

  const settings = existing.settings;
  mutate(settings);

  const json = JSON.stringify(settings, null, 2) + "\n";
  const tmp = `${path}.${process.pid}.${_tmpSeq++}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, json, "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup; the rename never happened */
    }
    return { ok: false, reason: "io", path, error: toError(err) };
  }
  return { ok: true };
}

/**
 * Read the per-tool enable list for an extension.
 */
export function readEnabledTools(extensionName: string): string[] | undefined {
  const settings = readSettings();
  const ext = settings.braid?.contrib?.[extensionName];
  if (ext === undefined || ext === true || ext === false) return undefined;
  if (typeof ext === "object" && ext !== null) {
    const enabled = (ext as { enabled?: unknown }).enabled;
    if (Array.isArray(enabled)) {
      return enabled.filter((e): e is string => typeof e === "string");
    }
  }
  return undefined;
}

/**
 * Write the per-tool enable list for an extension.
 */
export function writeEnabledTools(
  extensionName: string,
  enabledTools: string[] | undefined,
): SettingsWriteOutcome {
  return updateSettings((settings) => {
    const s = settings as ContribSettings;
    if (!s.braid) s.braid = {};
    if (!s.braid.contrib) s.braid.contrib = {};

    if (enabledTools === undefined) {
      const existing = s.braid.contrib[extensionName];
      if (typeof existing === "object" && existing !== null) {
        delete (existing as Record<string, unknown>).enabled;
        if (Object.keys(existing as Record<string, unknown>).length === 0) {
          delete s.braid.contrib[extensionName];
        }
      }
    } else {
      const existing = s.braid.contrib[extensionName];
      if (typeof existing === "object" && existing !== null) {
        (existing as Record<string, unknown>).enabled = enabledTools;
      } else {
        s.braid.contrib[extensionName] = { enabled: enabledTools };
      }
    }
  });
}

// ── Global (cross-extension) tool list ───────────────────────────────

const GLOBAL_KEY = "_global";

export function readGlobalEnabledTools(): string[] | undefined {
  return readEnabledTools(GLOBAL_KEY);
}

export function writeGlobalEnabledTools(enabledTools: string[] | undefined): SettingsWriteOutcome {
  return writeEnabledTools(GLOBAL_KEY, enabledTools);
}
