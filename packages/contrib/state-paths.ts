/**
 * Canonical state locations for the contrib extensions.
 *
 * Contract: braid-owned state lives under the braid home
 * (~/.pi/agent/braid, overridable per call via BRAID_HOME), never under the
 * session's working directory and never directly in pi's agent directory.
 * Every accessor resolves on each call, so a pinned BRAID_HOME relocates the
 * whole tree (the test suites rely on that).
 *
 * Mirrors packages/telegram/src/lib/state-paths.ts: this package is
 * standalone (it does not import pi-braid core), so the braid-root expression
 * is reproduced here and has to stay in step with core's `braidDir()`.
 *
 * Relocated data is disposable except the telegram media/pause state, which
 * lives in that package's own mirror with a read fallback. Screenshots,
 * observatory recordings and the browser scratch profile were never
 * read back by braid, so they simply start in the new root.
 *
 * Refusal contract: `braidDir()` returns null when no absolute root can be
 * derived - BRAID_HOME is unset and `os.homedir()` does not resolve an
 * absolute path (a relative or blank HOME would otherwise put the whole tree
 * beside the cwd), or BRAID_HOME is set to a path that is not absolute (a
 * relative override resolves against whatever cwd the process has, which is
 * the same hazard). Every derived accessor returns null with it; callers
 * refuse instead of writing somewhere unowned and report the refusal through
 * their own logger.
 */

import * as os from "node:os";
import * as path from "node:path";

/**
 * Braid home root; BRAID_HOME wins. Read per call, like core's braidDir().
 * Null when no absolute root can be derived: see the refusal contract above.
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

/** Observatory session recordings (`<session>.jsonl`, one file per session). */
export function observatorySessionsDir(): string | null {
  const root = braidDir();
  return root === null ? null : path.join(root, "observatory", "sessions");
}

/** Browser screenshots (disposable captures referenced by tool results). */
export function browserScreenshotsDir(): string | null {
  const root = braidDir();
  return root === null ? null : path.join(root, "browser", "screenshots");
}

/** Chrome profile scratch for the scraping browser (disposable; no session
 *  data is synced into it and braid never reads it back). */
export function browserProfileDir(): string | null {
  const root = braidDir();
  return root === null ? null : path.join(root, "browser", "profile-scratch");
}

/** Cross-process reconnect lock for the network monitor. */
export function reconnectLockFile(): string | null {
  const root = braidDir();
  return root === null
    ? null
    : path.join(root, "network-monitor", "reconnect.lock");
}
