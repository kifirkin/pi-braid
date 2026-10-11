/**
 * Cross-process store lock for the memory disk layers.
 *
 * The memory stores are written by several live pi processes (workers,
 * subagents, heartbeat). A read-merge-write cycle is only as safe as the
 * window between reading the file and renaming the new one: without mutual
 * exclusion, two concurrent merge-writers can still lose each other's update
 * (both read the same baseline, both rename, the last rename wins). The lock
 * closes that window.
 *
 * Mechanism: an exclusive-create lock file (`open(path, "wx")`). It works
 * across processes AND across interleaved async calls within one process.
 * Contenders poll; a lock older than LOCK_STALE_MS is stolen (its holder may
 * have crashed between create and release). Timeout raises so a wedged lock
 * never hangs a memory write forever; callers degrade to their existing
 * error paths.
 */

import { open, stat, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileHandle } from "node:fs/promises";

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function lockIsStale(lockPath: string): Promise<boolean> {
  try {
    const st = await stat(lockPath);
    return Date.now() - st.mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Run `fn` while holding the exclusive lock at `lockPath`.
 * Throws on timeout; the caller decides how to degrade.
 */
export async function withStoreLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle: FileHandle;
  for (;;) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
      if (await lockIsStale(lockPath)) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`memory store lock timeout: ${lockPath}`, { cause: err });
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}
