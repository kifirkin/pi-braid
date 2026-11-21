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
import { episodesFilePath } from "../../../lib/config/braid-paths.js";
import { withStoreLock } from "../../../lib/memory/store-lock.js";
import { createLogger } from "../../../lib/core/logger.js";
import {
  describeJsonlSummary,
  readVersionedJsonl,
  type JsonlSummary,
} from "../../../lib/store/versioned.js";
import type { Episode } from "./types.js";

const log = createLogger("three-memory-stores:episodes-disk");

/** Exclusive lock guarding reads/writes/appends on the episodes file. Resolved
 *  through episodesFilePath() so the lock and the file it guards always name
 *  the same (possibly BRAID_HOME-pinned) store. */
export function episodesLockFilePath(): string {
  return `${episodesFilePath()}.lock`;
}

/** Same cap as pruneEpisodes in episodes.ts: the store stays bounded. */
const EPISODE_STORE_CAP = 500;

// In-process append serialization: appends to one file keep their order.
let appendQueue: Promise<void> = Promise.resolve();

function enqueueAppend(line: string): Promise<void> {
  const run = appendQueue.then(() =>
    withStoreLock(episodesLockFilePath(), async () => {
      const file = episodesFilePath();
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, line, "utf-8");
    }),
  );
  // A failed append must not poison the chain for later episodes; the first
  // refusal in a process warns (the store may be refusing because no absolute
  // braid root resolves), later ones stay quiet.
  appendQueue = run.catch(reportAppendFailure);
  return run;
}

/** Warned once per process about a refused episode append. */
let _warnedAppendFailure = false;

function reportAppendFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (_warnedAppendFailure) return;
  _warnedAppendFailure = true;
  log.warn(`episode append failed (${message}); the shutdown compaction retries from memory`);
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

/** The row version this build reads episodes at. A stored row that declares a
 *  different one is counted and reported rather than reinterpreted. */
export const EPISODE_ROW_VERSION = 1;

/** Fields every stored episode carries. A row missing one is a row this build
 *  cannot use, and it is counted with its line number. */
const EPISODE_REQUIRED_FIELDS = [
  "id",
  "task",
  "solution",
  "outcome",
  "similarity",
  "timestamp",
  "toolSequence",
  "tags",
  "project",
  "sessionId",
  "quality",
] as const;

/** Fields a stored episode may omit. The rows written before these fields
 *  existed never had them, and inventing a value for them would be a worse
 *  answer than the count: the honest state is that those rows predate the
 *  fields, and `partial` is how that state is visible. */
const EPISODE_OPTIONAL_FIELDS = ["strategicSOP", "functionalSOP", "atomicSOP"] as const;

/** One read of the episode store: the rows this build can use, and what the
 *  file held that it could not. */
export interface EpisodeStoreRead {
  readonly episodes: Episode[];
  /** Null when the file could not be read at all, so a caller can tell an
   *  empty store from an unreadable one. */
  readonly summary: JsonlSummary | null;
}

/**
 * Read every usable episode row from disk under the declared row version.
 *
 * The store is read for what it holds: a torn line from a crash, a row missing
 * a required field and a row at a version this build does not read are counted
 * with their line numbers, never silently dropped. A file that cannot be read
 * at all is a warning and an empty result, because the store's readers run on
 * the session-start path and a missing store is recoverable while a session
 * that refuses to start is not.
 */
export async function readEpisodeStore(): Promise<EpisodeStoreRead> {
  const path = episodesFilePath();
  try {
    const read = readVersionedJsonl(path, {
      supported: [EPISODE_ROW_VERSION],
      rowVersion: EPISODE_ROW_VERSION,
      required: EPISODE_REQUIRED_FIELDS,
      optional: EPISODE_OPTIONAL_FIELDS,
    });
    reportEpisodeRead(read.summary);
    return { episodes: read.rows as unknown as Episode[], summary: read.summary };
  } catch (err) {
    log.warn(`episodes store read failed: ${err instanceof Error ? err.message : String(err)}`);
    return { episodes: [], summary: null };
  }
}

/** A read is information, not alarm: partial rows are the expected shape of a
 *  store whose fields were added later. Rows this build cannot use at all are a
 *  warning, with the lines named, because those are the rows a session will not
 *  recall. */
function reportEpisodeRead(summary: JsonlSummary): void {
  if (!summary.present) return;
  const unusable = summary.unparseable + summary.incomplete + summary.unknownVersion;
  if (unusable === 0) {
    log.debug(`episodes store: ${describeJsonlSummary(summary)}`);
    return;
  }
  const lines = summary.problems.map((problem) => `line ${problem.line}: ${problem.detail}`);
  const omitted = summary.problemsOmitted > 0 ? `, ${summary.problemsOmitted} more not listed` : "";
  log.warn(`episodes store: ${describeJsonlSummary(summary)}; ${lines.join("; ")}${omitted}`);
}

/**
 * Shutdown compaction: union the disk file with the local snapshot by
 * episode id (local wins — it is the fresher in-process state), drop
 * duplicate ids and torn lines, cap at the store bound, and rewrite the
 * file atomically. Returns the number of episodes persisted.
 */
export async function compactEpisodesFile(local: readonly Episode[]): Promise<number> {
  return withStoreLock(episodesLockFilePath(), async () => {
    const { episodes: diskEpisodes } = await readEpisodeStore();
    const byId = new Map<string, Episode>();
    for (const ep of diskEpisodes) byId.set(ep.id, ep);
    for (const ep of local) byId.set(ep.id, ep);

    const merged = [...byId.values()];
    const dropped = Math.max(0, merged.length - EPISODE_STORE_CAP);
    const kept = dropped > 0 ? merged.slice(-EPISODE_STORE_CAP) : merged;

    const file = episodesFilePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmpPath = `${file}.compacting`;
    await fs.writeFile(
      tmpPath,
      kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length > 0 ? "\n" : ""),
      "utf-8",
    );
    await fs.rename(tmpPath, file);
    return kept.length;
  });
}
