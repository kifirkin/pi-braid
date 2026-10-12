/**
 * Machine-wide poller ownership lock.
 *
 * Telegram's getUpdates is a per-bot singleton: only one consumer may long-
 * poll at a time. A module-local flag cannot provide this guarantee — it is
 * per-process state, so two pi processes could each "own" the poller and
 * 409-fight over the stream. This lock file is the machine-wide half: every
 * start path acquires it first and refuses while a LIVE foreign pid holds
 * it; a stale lock (dead pid, corrupt, or unreadable file) is taken over
 * silently. A crashed holder therefore never locks the channel out, and a
 * same-pid re-acquire (session reload cycles) always succeeds.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { braidDir } from "./state-paths.js";

/** Default lock location: beside the other braid-owned telegram state
 *  (~/.pi/agent/braid, BRAID_HOME-overridable). Null when no absolute braid
 *  root resolves: the poller refuses to start rather than lock beside the cwd. */
export function defaultPollerLockPath(): string | null {
  const root = braidDir();
  return root === null ? null : join(root, "telegram-poller.lock");
}

/** Who holds the lock: the pid is the liveness key; startedAt/role/startedBy
 *  make a refusal message name the holder. */
export interface PollerLockInfo {
  pid: number;
  startedAt: number;
  role?: string;
  startedBy?: string;
}

export type AcquirePollerLockResult =
  | { ok: true; tookOver: boolean }
  | { ok: false; holder: PollerLockInfo };

/** Read the lock file; absent/corrupt/unreadable reads as "no holder". */
export function readPollerLock(path: string): PollerLockInfo | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PollerLockInfo;
    if (Number.isFinite(parsed?.pid)) return parsed;
  } catch {
    // fall through to undefined
  }
  return undefined;
}

/**
 * Live-pid probe. Signal-0 errors with EPERM when the pid exists but is not
 * ours to signal (still alive); ESRCH means the pid is gone.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// Best-effort release at process exit: the exit hook removes the lock this
// process last acquired. A hook that never runs (kill -9, crash) leaves the
// file behind — harmless, because the next acquirer sees a dead pid and
// takes the lock over.
let exitHookInstalled = false;
let heldLockPath: string | undefined;

function installExitRelease(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    if (!heldLockPath) return;
    try {
      unlinkSync(heldLockPath);
    } catch {
      // best effort — the live-pid check covers a surviving file
    }
  });
}

/**
 * Take the lock. A live FOREIGN holder refuses (the caller reports it); our
 * own pid, a dead pid, or an unreadable file is taken over silently.
 */
export function acquirePollerLock(
  path: string,
  info: PollerLockInfo,
  pidAlive: (pid: number) => boolean = isPidAlive,
): AcquirePollerLockResult {
  const existing = readPollerLock(path);
  if (existing && existing.pid !== info.pid && pidAlive(existing.pid)) {
    return { ok: false, holder: existing };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(info));
  heldLockPath = path;
  installExitRelease();
  return { ok: true, tookOver: existing !== undefined };
}

/**
 * Release the lock — only when this process holds it; a foreign lock is
 * never touched. Best-effort: reports whether the file was removed.
 */
export function releasePollerLock(path: string): boolean {
  const existing = readPollerLock(path);
  if (!existing || existing.pid !== process.pid) return false;
  try {
    unlinkSync(path);
  } catch {
    // already gone — treat as released
  }
  if (heldLockPath === path) heldLockPath = undefined;
  return true;
}

/** Human-readable holder description for refusal messages. */
export function describeLockHolder(holder: PollerLockInfo): string {
  const since = Number.isFinite(holder.startedAt)
    ? new Date(holder.startedAt).toISOString()
    : "unknown time";
  const role = holder.role ?? "unknown role";
  const by = holder.startedBy ? `, started by ${holder.startedBy}` : "";
  return `pid ${holder.pid} since ${since} (${role}${by})`;
}
