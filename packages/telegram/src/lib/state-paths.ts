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
 *
 * Refusal contract: `braidDir()` returns null when no absolute root can be
 * derived - BRAID_HOME is unset and `os.homedir()` does not resolve an
 * absolute path (a relative or blank HOME would otherwise put the whole tree
 * beside the cwd), or BRAID_HOME is set to a path that is not absolute (a
 * relative override resolves against whatever cwd the process has, which is
 * the same hazard). Every derived accessor returns null with it; callers
 * refuse instead of writing somewhere unowned, and `warnUnderivableRoot`
 * reports the refusal once per process through the extension's TUI-safe log
 * sink (never console.*).
 */

import * as os from "node:os";
import * as path from "node:path";
import { existsSync } from "node:fs";

/**
 * Braid home root; BRAID_HOME wins. Read on every call so tests can pin the
 * whole tree into a tmpdir (mirrors pi-braid core's braidDir()). Null when no
 * absolute root can be derived: see the refusal contract above.
 */
export function braidDir(): string | null {
  const override = process.env.BRAID_HOME;
  if (override && override.trim()) {
    if (!path.isAbsolute(override)) return null;
    return path.resolve(override);
  }
  let home: string;
  try {
    home = os.homedir();
  } catch {
    return null;
  }
  if (!home || !path.isAbsolute(home)) return null;
  return path.join(home, ".pi", "agent", "braid");
}

/** Warn sink for a refused default path. The extension factory binds it to
 *  the TUI-safe log; unset it is silent, exactly like log() itself. */
let refusalSink: ((message: string) => void) | undefined;

/** Bind (or clear) the sink a path refusal is reported through. */
export function setPathRefusalSink(
  sink: ((message: string) => void) | undefined,
): void {
  refusalSink = sink;
}

let warnedRefusal = false;

/**
 * Report one refused default path, once per process: a request loop must not
 * repeat the line, and the caller still refuses. Silent with no sink bound
 * (headless/print runs), so the TUI input line never sees it.
 */
export function warnUnderivableRoot(what: string): void {
  if (warnedRefusal) return;
  warnedRefusal = true;
  refusalSink?.(
    `${what}: BRAID_HOME is unset and no absolute home resolves, so braid's ` +
      `state directory cannot be derived without writing beside the cwd. ` +
      `Set BRAID_HOME (or HOME) to an absolute directory.`,
  );
}

/** Telegram state dir under the braid root: media, pause state, future
 *  sinks. The offset/live-update files predate it and stay at the root. */
export function telegramStateDir(): string | null {
  const root = braidDir();
  return root === null ? null : path.join(root, "telegram");
}

/** Default inbound offset/lock state file. */
export function defaultStateFilePath(): string | null {
  const root = braidDir();
  return root === null ? null : path.join(root, "telegram-state.json");
}

/** Default live-update tracker state file (beside the offset state). */
export function defaultLiveUpdateFilePath(): string | null {
  const root = braidDir();
  return root === null ? null : path.join(root, "telegram-live-update.json");
}

/** Media dir for downloaded photo/voice/document bytes. */
export function defaultMediaDir(): string | null {
  const dir = telegramStateDir();
  return dir === null ? null : path.join(dir, "media");
}

/**
 * Pre-move media dir directly under pi's agent directory. Read-only fallback
 * for files recorded before the relocation; never a write target. Null when
 * no absolute home resolves (a relative fallback would read the cwd).
 *
 * This accessor and `resolveMediaReadPath` ship with no production caller:
 * they are the documented read seam for pre-move media, kept for the
 * compatibility contract and exercised by the package's tests.
 */
export function legacyMediaDir(): string | null {
  let home: string;
  try {
    home = os.homedir();
  } catch {
    return null;
  }
  if (!home || !path.isAbsolute(home)) return null;
  return path.join(home, ".pi", "agent", "telegram-media");
}

/**
 * Read-side resolution for one stored media file: the braid-root copy when it
 * exists, else the pre-move copy of the same name when that exists, else the
 * current-root path (so a caller reports the miss against the write target).
 * Writes always go to `defaultMediaDir()`. Null when neither root resolves.
 */
export function resolveMediaReadPath(fileName: string): string | null {
  const current = path.isAbsolute(fileName)
    ? fileName
    : (() => {
        const dir = defaultMediaDir();
        return dir === null ? null : path.join(dir, fileName);
      })();
  if (current !== null && existsSync(current)) return current;
  const legacyDir = legacyMediaDir();
  const legacy =
    legacyDir === null ? null : path.join(legacyDir, path.basename(fileName));
  if (legacy !== null && existsSync(legacy)) return legacy;
  return current;
}

/** Pause-state file under the braid root (the write target). */
export function defaultPauseStateFile(): string | null {
  const dir = telegramStateDir();
  return dir === null ? null : path.join(dir, "pause-state.json");
}

/** Pre-move pause-state file directly under pi's agent directory. Read-only
 *  fallback; never a write target. Null when no absolute home resolves. */
export function legacyPauseStateFile(): string | null {
  let home: string;
  try {
    home = os.homedir();
  } catch {
    return null;
  }
  if (!home || !path.isAbsolute(home)) return null;
  return path.join(home, ".pi", "agent", "telegram-pause-state.json");
}
