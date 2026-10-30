/**
 * Session corpus index - the user's own turns, extracted once and stored as a
 * derived population.
 *
 * The transcript corpus is measured in gigabytes while every user message in it
 * is measured in megabytes: the human's words are a fraction of one percent of
 * the archive, and the rest is the agent's own reasoning and tool output. A
 * grep over the archive therefore drowns that fraction in noise, and no tool
 * reads it as a population. This module is the population: one row per user
 * turn, carrying the session file, the session id, the project label, the entry
 * timestamp, the line number in the session file, and the text as typed.
 *
 * Derived, never authoritative: every shard is rebuildable from the session
 * files alone. One shard per project under `corpusIndexDir()`, so a query can
 * read one project or all of them without walking a transcript tree.
 *
 * Two properties the readers depend on:
 *
 *  - **Fail closed.** A shard is accepted whole or not at all. A manifest that
 *    does not parse, a format this build does not know, a row count that
 *    disagrees with the manifest, or a row that does not parse makes the shard
 *    UNREADABLE - the caller must say it cannot answer rather than answer from
 *    half a store. `loadCorpusIndex` reports which shard and which defect.
 *  - **Excluded by construction.** Only `message` entries with role `user`
 *    contribute text. Assistant turns, tool calls, tool results and
 *    extension-injected `custom_message` entries never enter a row, so no key,
 *    no tool argument and no environment value can be retrieved from the index.
 *    Tool results arrive as user-role messages with no text block, so the text
 *    filter drops them without a role list.
 *
 * What is NOT indexed: the compaction archives under `<session dir>/archives/`.
 * An envelope there is a second copy of messages the session body already
 * carries (writeOriginalsArchive stores the pre-compaction originals), so
 * indexing both would count the same words twice.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, rename, stat, writeFile, mkdir } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { corpusIndexDir } from "../../../lib/config/braid-paths.js";
import { projectFromPath, walkJsonlFiles } from "./search.js";

/** Shard layout version. A shard written by another format is unreadable, not
 *  migrated: the build regenerates it from the sessions. */
export const CORPUS_INDEX_FORMAT = 1;

/** Directory-name segment that holds compaction envelopes, never session bodies. */
const ARCHIVE_SEGMENT = /(^|[/\\])archives[/\\]/;

/** One user turn. */
export interface CorpusTurn {
  /** Absolute path of the session file the turn was read from. */
  session: string;
  /** pi's session id, taken from the file name; the short cite handle. */
  session_id: string;
  /** Project label the session ran in (`projectFromPath`). */
  project: string;
  /** Entry timestamp, ISO-8601 (the file's date at midnight when absent). */
  ts: string;
  /** 1-based line number inside the session file. */
  line: number;
  /** The user's words, verbatim. */
  text: string;
}

/** One source session file as the shard's manifest records it. */
export interface CorpusShardFile {
  path: string;
  /** Source mtime in ms; with `size`, the incremental key. */
  mtimeMs: number;
  size: number;
  turns: number;
}

/** The shard's first line. Everything the reader needs to accept or refuse it. */
export interface CorpusShardManifest {
  kind: "manifest";
  format: number;
  project: string;
  built_at: string;
  /** Source session files the shard covers. */
  sessions: number;
  /** Rows written; row count must equal this. */
  turns: number;
  /** Summed UTF-8 bytes of the row texts. */
  bytes: number;
  files: CorpusShardFile[];
}

export interface LoadedShard {
  path: string;
  manifest: CorpusShardManifest;
  turns: CorpusTurn[];
}

export type CorpusLoad =
  | { ok: true; dir: string; shards: LoadedShard[] }
  | { ok: false; dir: string; reason: string; shards: string[] };

export interface BuildOptions {
  sessionsDir: string;
  indexDir?: string;
  now?: () => Date;
  /** Ignore existing shards and re-parse every session file. */
  rebuild?: boolean;
  /** Structural sink for `scripts/build-corpus-index.mjs --verbose`. */
  progress?: (line: string) => void;
}

export interface BuildReport {
  index_dir: string;
  projects: number;
  shards: number;
  sessions: number;
  turns: number;
  bytes: number;
  /** Session files parsed this run. */
  parsed_files: number;
  /** Session files whose rows were carried over from an unchanged shard. */
  reused_files: number;
  /** Session files the shard dropped because they are gone from disk. */
  removed_files: number;
  /** Unreadable session files, by path. */
  skipped: string[];
  elapsed_ms: number;
}

/** Thrown by the shard reader; the message names the shard and the defect. */
export class CorpusShardError extends Error {
  constructor(
    readonly shardPath: string,
    readonly defect: string,
  ) {
    super(`${shardPath}: ${defect}`);
    this.name = "CorpusShardError";
  }
}

/** pi's session file name is `<iso-ts>_<session-id>.jsonl`; a shard cites the id. */
const SESSION_ID_IN_NAME = /_([0-9a-z][0-9a-z-]{7,})\.jsonl$/i;

/**
 * File-name stem for one project's shard.
 *
 * The project label is decoded from an encoded directory name, which is lossy
 * (`-` is both a separator and a legal character inside a name), so two
 * different projects can decode to one label and two labels can sanitize to one
 * stem. The digest of the label keeps one shard per project; the readable
 * prefix keeps the directory browsable. Every reader goes through here, so a
 * writer and a reader cannot name different files.
 */
export function shardSlug(project: string): string {
  const safe =
    project
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 80) || "project";
  const digest = createHash("sha256").update(project).digest("hex").slice(0, 8);
  return `${safe}-${digest}`;
}

/** Absolute path of one project's shard. */
export function shardPath(indexDir: string, project: string): string {
  return join(indexDir, `${shardSlug(project)}.jsonl`);
}

/** The session id a session file name carries, or the file's stem when it carries none. */
export function sessionIdFromPath(sessionPath: string): string {
  const name = basename(sessionPath);
  const match = SESSION_ID_IN_NAME.exec(name);
  return match?.[1] ?? name.replace(/\.jsonl$/, "");
}

/** The `YYYY-MM-DD` date a session file name starts with, or null. */
function dateFromName(sessionPath: string): string | null {
  const match = basename(sessionPath).match(/^(\d{4}-\d{2}-\d{2})T/);
  return match?.[1] ?? null;
}

/** Text of a message's content: a string, or the text blocks joined. */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type?: unknown; text?: unknown } => !!block && typeof block === "object",
    )
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join(" ");
}

export interface ExtractOptions {
  session: string;
  project: string;
  /** Fallback timestamp for entries that carry none. */
  fileDate: string | null;
}

/**
 * Every user turn in one session body, in file order.
 *
 * A turn is a `message` entry whose role is `user` and whose content carries
 * text. The role alone is not enough: a tool result is delivered as a
 * user-role message with `tool_result` blocks and no text, and a thought or a
 * blank paste carries no words worth indexing. Blank text is dropped here so
 * the corpus holds only what the human actually typed.
 */
export function extractUserTurns(content: string, opts: ExtractOptions): CorpusTurn[] {
  const sessionId = sessionIdFromPath(opts.session);
  const fallbackTs = opts.fileDate ? `${opts.fileDate}T00:00:00.000Z` : "";
  const turns: CorpusTurn[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.includes('"user"')) continue;
    let entry: {
      type?: unknown;
      timestamp?: unknown;
      message?: { role?: unknown; content?: unknown };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "message") continue;
    if (entry.message?.role !== "user") continue;
    const text = textOfContent(entry.message.content);
    if (!text.trim()) continue;
    turns.push({
      session: opts.session,
      session_id: sessionId,
      project: opts.project,
      ts: typeof entry.timestamp === "string" ? entry.timestamp : fallbackTs,
      line: i + 1,
      text,
    });
  }
  return turns;
}

function parseManifest(line: string, shard: string): CorpusShardManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new CorpusShardError(shard, "first line is not JSON (truncated or foreign file)");
  }
  const manifest = parsed as Partial<CorpusShardManifest> | null;
  if (!manifest || typeof manifest !== "object") {
    throw new CorpusShardError(shard, "first line is not an object");
  }
  if (manifest.kind !== "manifest") {
    throw new CorpusShardError(shard, "first line is not a manifest");
  }
  if (manifest.format !== CORPUS_INDEX_FORMAT) {
    throw new CorpusShardError(
      shard,
      `format ${String(manifest.format)} is not the supported format ${CORPUS_INDEX_FORMAT}`,
    );
  }
  if (typeof manifest.project !== "string" || !manifest.project) {
    throw new CorpusShardError(shard, "manifest carries no project");
  }
  if (typeof manifest.built_at !== "string" || Number.isNaN(Date.parse(manifest.built_at))) {
    throw new CorpusShardError(shard, "manifest carries no readable built_at");
  }
  if (typeof manifest.turns !== "number" || !Number.isFinite(manifest.turns)) {
    throw new CorpusShardError(shard, "manifest carries no turn count");
  }
  if (!Array.isArray(manifest.files)) {
    throw new CorpusShardError(shard, "manifest carries no file list");
  }
  return manifest as CorpusShardManifest;
}

function parseRow(line: string, shard: string, manifest: CorpusShardManifest): CorpusTurn {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new CorpusShardError(shard, "a row is not JSON (partial write?)");
  }
  const row = parsed as Partial<CorpusTurn> | null;
  if (!row || typeof row !== "object") {
    throw new CorpusShardError(shard, "a row is not an object");
  }
  if (typeof row.session !== "string" || !isAbsolute(row.session)) {
    throw new CorpusShardError(shard, "a row names no absolute session path");
  }
  if (typeof row.project !== "string" || row.project !== manifest.project) {
    throw new CorpusShardError(shard, "a row names a project the manifest does not");
  }
  if (typeof row.session_id !== "string" || !row.session_id) {
    throw new CorpusShardError(shard, "a row carries no session id");
  }
  if (typeof row.ts !== "string" || Number.isNaN(Date.parse(row.ts))) {
    throw new CorpusShardError(shard, "a row carries no readable timestamp");
  }
  if (typeof row.line !== "number" || !Number.isInteger(row.line) || row.line < 1) {
    throw new CorpusShardError(shard, "a row carries no line number");
  }
  if (typeof row.text !== "string" || !row.text.trim()) {
    throw new CorpusShardError(shard, "a row carries no text");
  }
  return row as CorpusTurn;
}

/** Read and validate one shard. Whole or nothing - see CorpusShardError. */
export async function readShard(shard: string): Promise<LoadedShard> {
  let raw: string;
  try {
    raw = await readFile(shard, "utf-8");
  } catch (err) {
    throw new CorpusShardError(shard, `unreadable: ${(err as Error).message}`);
  }
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    throw new CorpusShardError(shard, "empty file (no manifest)");
  }
  const manifest = parseManifest(lines[0] as string, shard);
  const turns: CorpusTurn[] = [];
  for (let i = 1; i < lines.length; i++) {
    turns.push(parseRow(lines[i] as string, shard, manifest));
  }
  if (turns.length !== manifest.turns) {
    throw new CorpusShardError(
      shard,
      `${turns.length} rows but the manifest records ${manifest.turns} (partial write?)`,
    );
  }
  return { path: shard, manifest, turns };
}

/**
 * Load every shard under the corpus index directory, or refuse.
 *
 * Refusal is the point: a caller that cannot read its evidence must say so.
 * `reason` names the first unreadable shard and its defect; `shards` lists
 * every shard path the directory held, so a refusal can show its population.
 * A `project` filter narrows which shards are read, and a filter that matches
 * nothing is still a refusal - an empty population cannot answer either.
 */
export async function loadCorpusIndex(
  opts: {
    indexDir?: string;
    project?: string | null;
  } = {},
): Promise<CorpusLoad> {
  const dir = opts.indexDir ?? corpusIndexDir();
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return { ok: false, dir, reason: `no index directory at ${dir}`, shards: [] };
  }
  if (names.length === 0) {
    return { ok: false, dir, reason: `no shards in ${dir}`, shards: [] };
  }
  const paths = names.map((name) => join(dir, name));
  const shards: LoadedShard[] = [];
  for (const path of paths) {
    let shard: LoadedShard;
    try {
      shard = await readShard(path);
    } catch (err) {
      // The reader's contract is a refusal, never a throw: a caller that has to
      // catch to learn "cannot answer" is a caller that will answer anyway.
      const detail = err instanceof CorpusShardError ? err.defect : (err as Error).message;
      return { ok: false, dir, reason: `${path}: ${detail}`, shards: paths };
    }
    const wanted = opts.project ?? null;
    if (wanted && shard.manifest.project !== wanted) continue;
    shards.push(shard);
  }
  if (shards.length === 0) {
    return {
      ok: false,
      dir,
      reason: `no shard matches project "${opts.project}" (shards: ${names.length})`,
      shards: paths,
    };
  }
  return { ok: true, dir, shards };
}

/**
 * How far the index has drifted from the session files.
 *
 * A shard is derived data, so an answer built from it is only as new as the
 * last build. The check is one walk plus one stat per session file: cheap next
 * to the answer, and it lets the result carry its own freshness instead of
 * presenting a stale population as current.
 */
export interface CorpusFreshness {
  /** Session files the index covers. */
  indexed: number;
  /** Indexed files whose mtime or size moved since the build. */
  changed: number;
  /** Session files present on disk that no shard covers. */
  added: number;
  /** Indexed files that are gone from disk. */
  removed: number;
  /** Newest source mtime seen among changed and added files, ISO-8601. */
  newest_change: string | null;
}

export async function corpusIndexFreshness(
  shards: LoadedShard[],
  sessionsDir: string,
): Promise<CorpusFreshness> {
  const indexed = new Map<string, CorpusShardFile>();
  for (const shard of shards) {
    for (const file of shard.manifest.files) indexed.set(file.path, file);
  }
  const onDisk = (await walkJsonlFiles(sessionsDir)).filter((p) => !ARCHIVE_SEGMENT.test(p));
  let changed = 0;
  let added = 0;
  let newest = 0;
  const seen = new Set<string>();
  for (const path of onDisk) {
    seen.add(path);
    const known = indexed.get(path);
    if (!known) {
      added++;
      try {
        newest = Math.max(newest, (await stat(path)).mtimeMs);
      } catch {
        /* vanished between walk and stat */
      }
      continue;
    }
    let info: { mtimeMs: number; size: number };
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (info.mtimeMs !== known.mtimeMs || info.size !== known.size) {
      changed++;
      newest = Math.max(newest, info.mtimeMs);
    }
  }
  let removed = 0;
  for (const path of indexed.keys()) if (!seen.has(path)) removed++;
  return {
    indexed: indexed.size,
    changed,
    added,
    removed,
    newest_change: newest > 0 ? new Date(newest).toISOString() : null,
  };
}

interface SourceFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/** Group the session bodies by project label. */
async function groupByProject(sessionsDir: string): Promise<Map<string, SourceFile[]>> {
  const grouped = new Map<string, SourceFile[]>();
  for (const path of await walkJsonlFiles(sessionsDir)) {
    if (ARCHIVE_SEGMENT.test(path)) continue;
    let info: { mtimeMs: number; size: number };
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    const project = projectFromPath(path);
    const list = grouped.get(project);
    const entry = { path, mtimeMs: info.mtimeMs, size: info.size };
    if (list) list.push(entry);
    else grouped.set(project, [entry]);
  }
  return grouped;
}

function manifestLine(manifest: CorpusShardManifest): string {
  return JSON.stringify(manifest);
}

/** Row text bytes, the figure the shard's manifest records. */
function textBytes(turns: CorpusTurn[]): number {
  let bytes = 0;
  for (const turn of turns) bytes += Buffer.byteLength(turn.text, "utf8");
  return bytes;
}

/**
 * Walk the session files once and write one shard per project.
 *
 * Incremental by (mtime, size): a session file whose stamp still matches its
 * manifest entry contributes its previous rows without being parsed, so a
 * daily refresh costs what changed rather than the corpus. A shard that cannot
 * be read is not repaired in place - it is rebuilt from its session files,
 * which is the only authority for derived data.
 */
export async function buildCorpusIndex(opts: BuildOptions): Promise<BuildReport> {
  const started = Date.now();
  const dir = opts.indexDir ?? corpusIndexDir();
  const now = opts.now ?? (() => new Date());
  await mkdir(dir, { recursive: true });
  const grouped = await groupByProject(opts.sessionsDir);

  const report: BuildReport = {
    index_dir: dir,
    projects: grouped.size,
    shards: 0,
    sessions: 0,
    turns: 0,
    bytes: 0,
    parsed_files: 0,
    reused_files: 0,
    removed_files: 0,
    skipped: [],
    elapsed_ms: 0,
  };

  for (const [project, files] of grouped) {
    const shard = shardPath(dir, project);
    let previous: LoadedShard | null = null;
    if (!opts.rebuild) {
      try {
        previous = await readShard(shard);
      } catch {
        // A corrupt or absent shard costs a rebuild, never a merge: derived
        // data has one authority, the session files.
        previous = null;
      }
    }
    const previousFiles = new Map<string, CorpusShardFile>();
    const previousRows = new Map<string, CorpusTurn[]>();
    if (previous && previous.manifest.project === project) {
      for (const file of previous.manifest.files) previousFiles.set(file.path, file);
      for (const turn of previous.turns) {
        const rows = previousRows.get(turn.session);
        if (rows) rows.push(turn);
        else previousRows.set(turn.session, [turn]);
      }
    }

    const turns: CorpusTurn[] = [];
    const manifestFiles: CorpusShardFile[] = [];
    for (const file of files) {
      const known = previousFiles.get(file.path);
      const carried = previousRows.get(file.path);
      if (known && carried && known.mtimeMs === file.mtimeMs && known.size === file.size) {
        for (const turn of carried) turns.push(turn);
        manifestFiles.push({ ...file, turns: carried.length });
        report.reused_files++;
        continue;
      }
      let content: string;
      try {
        content = await readFile(file.path, "utf-8");
      } catch (err) {
        report.skipped.push(`${file.path}: ${(err as Error).message}`);
        continue;
      }
      const extracted = extractUserTurns(content, {
        session: file.path,
        project,
        fileDate: dateFromName(file.path),
      });
      for (const turn of extracted) turns.push(turn);
      manifestFiles.push({ ...file, turns: extracted.length });
      report.parsed_files++;
    }

    // Files the manifest carried that the walk no longer sees. Counted, not
    // guessed at: a shard that silently kept them would cite a deleted file.
    for (const path of previousFiles.keys()) {
      if (!files.some((file) => file.path === path)) report.removed_files++;
    }

    turns.sort((a, b) => a.session.localeCompare(b.session) || a.line - b.line);
    const manifest: CorpusShardManifest = {
      kind: "manifest",
      format: CORPUS_INDEX_FORMAT,
      project,
      built_at: now().toISOString(),
      sessions: manifestFiles.length,
      turns: turns.length,
      bytes: textBytes(turns),
      files: manifestFiles,
    };
    const body = [manifestLine(manifest), ...turns.map((turn) => JSON.stringify(turn))].join("\n");
    const temp = `${shard}.tmp-${process.pid}`;
    await writeFile(temp, `${body}\n`, "utf-8");
    await rename(temp, shard);

    report.shards++;
    report.sessions += manifestFiles.length;
    report.turns += manifest.turns;
    report.bytes += manifest.bytes;
    opts.progress?.(
      `${project}: ${manifest.turns} turns from ${manifestFiles.length} sessions ` +
        `(${(manifest.bytes / 1_048_576).toFixed(2)} MB)`,
    );
  }

  report.elapsed_ms = Date.now() - started;
  return report;
}
