/**
 * Cross-process reconnect lock - O_EXCL lockfile with a TTL.
 *
 * The reconnect flow toggles the tunnel through the app's own deep links;
 * two pi processes doing that at once bounce a working tunnel (observed as
 * an extra stop/start pair with no owner). One lockfile serializes them:
 * creation uses the exclusive form of open(), which is atomic across
 * processes, so exactly one caller wins and the rest are refused.
 *
 * A lock whose timestamp is older than the TTL belonged to a process that
 * died mid-cycle; it is stolen once (unlink, then a fresh exclusive create,
 * so two stealers still cannot both win). Release only removes the file
 * when it still carries this process's stamp.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_LOCK_TTL_MS = 120_000;

export interface LockInfo {
  pid: number;
  ts: number;
}

export type LockAcquireResult =
  | { acquired: true; release: () => void }
  | { acquired: false; reason: string };

export interface LockOptions {
  /** Age after which an existing lock counts as abandoned (default 120s). */
  ttlMs?: number;
  /** Clock override for tests. */
  now?: () => number;
  /** PID stamped into the lockfile (default: this process). */
  pid?: number;
}

function tryCreate(filePath: string, info: LockInfo): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "wx");
  } catch {
    return false;
  }
  try {
    fs.writeSync(fd, JSON.stringify(info));
  } catch {
    // A content-less lock still excludes; only stealing needs the stamp.
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Nothing left to close.
    }
  }
  return true;
}

function readLock(filePath: string): LockInfo | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf-8"),
    ) as Partial<LockInfo>;
    if (typeof parsed.pid === "number" && typeof parsed.ts === "number") {
      return { pid: parsed.pid, ts: parsed.ts };
    }
  } catch {
    // Missing or unreadable; the caller decides via the age fallback.
  }
  return null;
}

/** Age in ms: content stamp when parseable, file mtime otherwise; null if gone. */
function lockAge(filePath: string, now: number): number | null {
  const info = readLock(filePath);
  if (info !== null) return now - info.ts;
  try {
    return now - fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Acquire the reconnect lock at `filePath`. Returns a release function on
 * success; on refusal the reason names the holder (or the unreadable state).
 */
export function acquireLock(
  filePath: string,
  opts: LockOptions = {},
): LockAcquireResult {
  const ttlMs = opts.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid;
  const info: LockInfo = { pid, ts: now() };

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    // The create below reports the real failure.
  }

  if (tryCreate(filePath, info)) {
    return { acquired: true, release: () => release(filePath, info) };
  }

  const age = lockAge(filePath, now());
  if (age === null) {
    // The file vanished between the failed create and the read; retry once.
    if (tryCreate(filePath, info)) {
      return { acquired: true, release: () => release(filePath, info) };
    }
    return { acquired: false, reason: "the lockfile is changing" };
  }
  if (age < ttlMs) {
    const holder = readLock(filePath);
    return {
      acquired: false,
      reason: holder
        ? `by pid ${holder.pid} since ${new Date(holder.ts).toISOString()}`
        : "by an unreadable lockfile",
    };
  }

  // Stale: steal once. The exclusive create below still picks one winner.
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Retried below; a lost race is refused, not fatal.
  }
  if (tryCreate(filePath, info)) {
    return { acquired: true, release: () => release(filePath, info) };
  }
  return { acquired: false, reason: "stolen concurrently by another process" };
}

function release(filePath: string, info: LockInfo): void {
  const current = readLock(filePath);
  if (current === null || current.pid !== info.pid || current.ts !== info.ts) {
    // Not ours anymore (stolen after the TTL): leave the new owner alone.
    return;
  }
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Already gone.
  }
}
