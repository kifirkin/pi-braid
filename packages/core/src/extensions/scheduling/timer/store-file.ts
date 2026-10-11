/**
 * The per-project timer store's write path.
 *
 * The store lives at getTimerFilePath(cwd) — one pending-timers.jsonl per
 * project CWD under braidDir()/projects/<sanitized-cwd>/. Every writer of
 * that file goes through here, because the file and its directory are one
 * artefact: a store with nothing to persist is not a store.
 *
 * Writing an empty store instead (mkdir + a file holding "\n" or "") leaves
 * a file for ever, and the directory with it — one per cwd, including every
 * cwd that only ever existed for the length of a test run. Deleting is
 * behaviour-preserving for every reader:
 *
 *   - loadPendingTimers (index.ts) returns [] for a missing file and for an
 *     empty one;
 *   - recoverPersistedTimers (recovery.ts) returns on !existsSync and on an
 *     empty read;
 *   - sweepProjectStoresRetention (recovery.ts) skips a directory with no
 *     store and a store with no lines alike.
 *
 * The path stays a generic mechanism: it keys on a cwd and knows nothing
 * about which cwds are "real". Whether it may also remove the directory is
 * decided by what the directory holds — a project directory that carries
 * other per-cwd state (locks.json, workers.json) survives, because a
 * non-recursive rmdir only succeeds on an empty one.
 */

import { rmSync, rmdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { braidDir } from "../../../lib/config/braid-paths.js";

/**
 * Persist `lines` (already serialized records) as the store at `file`, or
 * remove the store when there is nothing to persist.
 */
export function writeTimerStore(file: string, lines: string[]): void {
  if (lines.length === 0) {
    removeTimerStore(file);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n") + "\n", "utf-8");
}

/**
 * Remove the store file, and its directory when that leaves the directory
 * empty. Only a per-project store directory is ever removed: the legacy flat
 * store beside braidDir() must not take the braid home down with it.
 */
export function removeTimerStore(file: string): void {
  rmSync(file, { force: true });
  if (dirname(file) === braidDir()) return;
  try {
    rmdirSync(dirname(file));
  } catch {
    // Directory still holds other per-cwd state (locks, workers), or is
    // already gone: either way the store is removed, which is the job.
  }
}
