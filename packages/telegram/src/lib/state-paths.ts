/**
 * Canonical state locations for the Telegram extension.
 *
 * Contract: braid-owned state lives under the braid home
 * (~/.pi/agent/braid, overridable per call via BRAID_HOME), never under the
 * session's working directory — a cwd-relative state file pollutes every
 * project a session runs in (and forks one offset state per cwd).
 * Explicit BRAID_TG_STATE_FILE / BRAID_TG_LIVE_UPDATE_STATE_FILE overrides
 * still win at the call sites.
 */

import * as os from "node:os";
import * as path from "node:path";

/** Braid home root; BRAID_HOME wins. Read on every call so tests can pin
 *  the whole tree into a tmpdir (mirrors pi-braid core's braidDir()). */
export function braidDir(): string {
  const override = process.env.BRAID_HOME;
  return override && override.trim()
    ? path.resolve(override)
    : path.join(os.homedir(), ".pi", "agent", "braid");
}

/** Default inbound offset/lock state file. */
export function defaultStateFilePath(): string {
  return path.join(braidDir(), "telegram-state.json");
}

/** Default live-update tracker state file (beside the offset state). */
export function defaultLiveUpdateFilePath(): string {
  return path.join(braidDir(), "telegram-live-update.json");
}
