/**
 * Episodes disk layer: append-on-write durability + shutdown compaction.
 *
 * Whole-file-rewrite-at-shutdown alone loses episodes: with several live pi
 * processes the last shutdown erases every episode the other processes wrote
 * since their own load, and an episode written mid-session is lost when the
 * process ends without a clean shutdown.
 *
 * Two writers share this file:
 *   - `queueEpisodeAppend` (called by addEpisode): appends one JSONL line per
 *     episode within milliseconds of the call, fire-and-forget from the
 *     caller's synchronous context. Appends are serialized in-process; the
 *     store lock makes them exclusive across processes, so concurrent
 *     appenders never interleave inside each other's lines.
 *   - `compactEpisodesFile` (called at session_shutdown): re-reads the file,
 *     unions it with the local snapshot by episode id (dropping torn or
 *     duplicate lines and capping at the same 500-entry bound the in-memory
 *     prune uses), and rewrites atomically. Compaction is the fallback that
 *     still lands an episode whose append failed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EPISODES_FILE } from "../../../lib/config/braid-paths.js";
import { withStoreLock } from "../../../lib/memory/store-lock.js";
import { createLogger } from "../../../lib/core/logger.js";
import { asyncExists } from "../../../lib/utils/async-fs.js";
import type { Episode } from "./types.js";

const log = createLogger("three-memory-stores:episodes-disk");

/** Exclusive lock guarding reads/writes/appends on EPISODES_FILE. */
export const EPISODES_LOCK_FILE = `${EPISODES_FILE}.lock`;

/** Same cap as pruneEpisodes in episodes.ts: the store stays bounded. */
const EPISODE_STORE_CAP = 500;

// In-process append serialization: appends to one file keep their order.
let appendQueue: Promise<void> = Promise.resolve();

function enqueueAppend(line: string): Promise<void> {
  const run = appendQueue.then(() =>
    withStoreLock(EPISODES_LOCK_FILE, async () => {
      await fs.mkdir(path.dirname(EPISODES_FILE), { recursive: true });
      await fs.appendFile(EPISODES_FILE, line, "utf-8");
    }),
  );
  // A failed append must not poison the chain for later episodes.
  appendQueue = run.catch(() => {});
  return run;
}

/**
 * Append one episode line. Resolves when the line is on disk; rejects on
 * I/O failure (callers may await it when a tool result must imply disk
 * truth, and fire-and-forget callers let the shutdown compaction retry).
 */
export function queueEpisodeAppend(episode: Episode): Promise<void> {
  return enqueueAppend(`${JSON.stringify(episode)}\n`);
}

/**
 * Drain all pending appends: resolves once every queued line is on disk.
 */
export async function flushEpisodeAppends(): Promise<void> {
  await appendQueue;
}

/**
 * Parse every intact episode line on disk. Torn or corrupt lines (a crash
 * mid-append) are skipped — they are the only lines a crash can lose.
 */
async function readEpisodeLines(): Promise<Episode[]> {
  try {
    if (!(await asyncExists(EPISODES_FILE))) return [];
    const content = await fs.readFile(EPISODES_FILE, "utf-8");
    const episodes: Episode[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        episodes.push(JSON.parse(line));
      } catch {
        /* torn or malformed line — skip */
      }
    }
    return episodes;
  } catch (err) {
    log.warn(`episodes file read failed: ${err}`);
    return [];
  }
}

/**
 * Shutdown compaction: union the disk file with the local snapshot by
 * episode id (local wins — it is the fresher in-process state), drop
 * duplicate ids and torn lines, cap at the store bound, and rewrite the
 * file atomically. Returns the number of episodes persisted.
 */
export async function compactEpisodesFile(local: readonly Episode[]): Promise<number> {
  return withStoreLock(EPISODES_LOCK_FILE, async () => {
    const diskEpisodes = await readEpisodeLines();
    const byId = new Map<string, Episode>();
    for (const ep of diskEpisodes) byId.set(ep.id, ep);
    for (const ep of local) byId.set(ep.id, ep);

    const merged = [...byId.values()];
    const dropped = Math.max(0, merged.length - EPISODE_STORE_CAP);
    const kept = dropped > 0 ? merged.slice(-EPISODE_STORE_CAP) : merged;

    await fs.mkdir(path.dirname(EPISODES_FILE), { recursive: true });
    const tmpPath = `${EPISODES_FILE}.compacting`;
    await fs.writeFile(
      tmpPath,
      kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length > 0 ? "\n" : ""),
      "utf-8",
    );
    await fs.rename(tmpPath, EPISODES_FILE);
    return kept.length;
  });
}
