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
 */

import * as os from "node:os";
import * as path from "node:path";

/** Braid home root; BRAID_HOME wins. Read per call, like core's braidDir(). */
export function braidDir(): string {
  const override = process.env.BRAID_HOME;
  return override && override.trim()
    ? path.resolve(override)
    : path.join(os.homedir(), ".pi", "agent", "braid");
}

/** Observatory session recordings (`<session>.jsonl`, one file per session). */
export function observatorySessionsDir(): string {
  return path.join(braidDir(), "observatory", "sessions");
}

/** Browser screenshots (disposable captures referenced by tool results). */
export function browserScreenshotsDir(): string {
  return path.join(braidDir(), "browser", "screenshots");
}

/** Chrome profile scratch for the scraping browser (disposable; no session
 *  data is synced into it and braid never reads it back). */
export function browserProfileDir(): string {
  return path.join(braidDir(), "browser", "profile-scratch");
}

/** Cross-process reconnect lock for the network monitor. */
export function reconnectLockFile(): string {
  return path.join(braidDir(), "network-monitor", "reconnect.lock");
}
