/**
 * Session Recall - search functions
 *
 * Grep-based keyword search across past pi session files.
 * Supports rg, grep, and Node.js fallback backends.
 */

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";

const log = createLogger("session-recall-search");

// Types

export type SearchBackend = "rg" | "grep" | "node";

export interface FileMatchCount {
  path: string;
  /**
   * Occurrences: matches of the query (single term), or of the file's densest
   * single term (multi-term). A term hit twelve times on one long archive line
   * scores twelve here, not one as a line count did — so a dense archive can
   * outrank a session that merely mentions the term on many sparse lines. On
   * the grep backend this degrades to a line count (grep has no per-file match
   * counter); the rg backend and the node fallback count occurrences.
   */
  count: number;
  /** Occurrences of the whole query as one phrase. Multi-term queries only. */
  phrase?: number;
  /** Distinct query terms this file matches. Multi-term queries only. */
  terms?: number;
  /** Rarity-weighted coverage: Σ 1/(1+df) over the matched terms. */
  score?: number;
  /**
   * Matching lines whose entry carries a user role. Feeds the ranking's role
   * signal: a hit in a user turn outranks the same hit in a tool result.
   * Present only on backends that can test the role (rg, node).
   */
  userHits?: number;
}

/** Distinct terms a multi-term query is split into, in order. */
function terms(query: string): string[] {
  const seen = new Set<string>();
  for (const term of query.toLowerCase().split(/\s+/)) {
    if (term) seen.add(term);
  }
  return [...seen].slice(0, MAX_QUERY_TERMS);
}

// Paths

/**
 * The subset of the extension context the session root needs. Kept structural
 * so callers can pass the tool-handler ctx without importing pi's types here.
 */
export interface SessionsDirContext {
  sessionManager?: { getSessionDir?: () => string | undefined };
}

/**
 * Resolve the directory session search walks, from pi's own handle.
 *
 * `ctx.sessionManager.getSessionDir()` reflects the session directory actually
 * in use (settings, PI_CODING_AGENT_SESSION_DIR, --session-dir). Under pi's
 * default layout it is one encoded-cwd directory under the agent's sessions
 * root, and search keeps the whole root so the cross-project scan does not
 * silently narrow; a configured sessionDir is itself the root, with sessions
 * stored flat inside it. Without a session manager, fall back to the agent
 * directory pi resolves (honoring PI_CODING_AGENT_DIR).
 */
export function getSessionsDir(source?: SessionsDirContext): string {
  const defaultRoot = join(getAgentDir(), "sessions");
  let sessionDir: string | undefined;
  try {
    sessionDir = source?.sessionManager?.getSessionDir?.();
  } catch {
    // A stale ctx getter throws; fall through to the default root.
  }
  if (!sessionDir) return defaultRoot;
  const parent = dirname(sessionDir);
  const isDefaultProjectDir = parent === defaultRoot && /^--.*--$/.test(basename(sessionDir));
  return isDefaultProjectDir ? parent : sessionDir;
}

export function projectFromPath(sessionPath: string): string {
  const match = sessionPath.match(/sessions[/\\](--.*?--)[/\\]/);
  if (!match || !match[1]) return "~";
  const dirPath = sessionPath.slice(0, (match.index ?? 0) + match[0].length - 1);
  const cached = _projectByDir.get(dirPath);
  if (cached !== undefined) return cached;
  const cwd = cwdForSessionDir(sessionPath, dirPath);
  const label = cwd ? labelFromCwd(cwd) : decodeEncodedDir(match[1]);
  _projectByDir.set(dirPath, label);
  return label;
}

/**
 * The encoded directory name is lossy: `-` is both the path separator and a
 * legal character inside a name, so `--Users-<user>-projects-agents-pi-braid--`
 * is ambiguous between `projects/agents/pi/braid` and `projects/agents/pi-braid`.
 * Decoding it is the last resort; it is only reached when no session file in
 * the directory carries a header (see `cwdForSessionDir`).
 */
function decodeEncodedDir(encodedDir: string): string {
  let encoded = encodedDir.slice(2, -2);
  const homeEncoded = homedir()
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-");
  if (encoded.startsWith(homeEncoded + "-")) {
    encoded = encoded.slice(homeEncoded.length + 1);
  } else if (encoded === homeEncoded) {
    return "~";
  }
  return encoded.replace(/-/g, "/") || "~";
}

/**
 * Authoritative project for a session path: the `cwd` its header records.
 *
 * Live session files open with a `{type:"session",cwd}` header, which pi-core
 * itself reads back to recover the cwd (the directory name cannot be decoded).
 * A compaction archive has no header, so the same directory's live siblings
 * stand in for it: every file under one `--<encoded>--/` directory ran in one
 * cwd by construction.
 */
function cwdForSessionDir(sessionPath: string, dirPath: string): string | undefined {
  const own = headerCwd(sessionPath);
  if (own) return own;
  try {
    for (const name of readdirSync(dirPath)) {
      if (!name.endsWith(".jsonl")) continue;
      const cwd = headerCwd(join(dirPath, name));
      if (cwd) return cwd;
    }
  } catch {
    /* unreadable directory - fall back to the name */
  }
  return undefined;
}

/** Header lines are a few hundred bytes; this only guards a pathological file. */
const HEADER_SCAN_BYTES = 4096;

/** The cwd a session header records, read without loading the session body. */
function headerCwd(filePath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(HEADER_SCAN_BYTES);
    const read = readSync(fd, buf, 0, HEADER_SCAN_BYTES, 0);
    if (read <= 0) return undefined;
    const line = buf.subarray(0, read).toString("utf-8").split("\n", 1)[0];
    const parsed = JSON.parse(line ?? "") as { type?: unknown; cwd?: unknown };
    if (parsed.type !== "session" || typeof parsed.cwd !== "string" || !parsed.cwd) {
      return undefined;
    }
    return parsed.cwd;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Render a cwd the way the encoded directory name renders it: `~` for home,
 * home-relative below it, and without its leading separator elsewhere. This is
 * the inverse of `projectFromPath` and the only way to compare a candidate's
 * project label against the current cwd. */
export function labelFromCwd(cwd: string): string {
  const norm = cwd.replace(/[/\\]+$/, "").replace(/\\/g, "/");
  const home = homedir()
    .replace(/[/\\]+$/, "")
    .replace(/\\/g, "/");
  if (norm === home) return "~";
  if (norm.startsWith(home + "/")) return norm.slice(home.length + 1);
  return norm.replace(/^[/\\]/, "");
}

/**
 * Whether a session path belongs to the `project` filter the caller passed.
 * The filter matches the raw path (so the encoded directory name still works)
 * and the resolved project label (so the label the tools print is usable as a
 * filter - before this, `--Users-<user>-projects-agents-pi-braid--` printed as
 * `projects/agents/pi/braid` and filtering by that label found nothing).
 */
export function pathMatchesProject(sessionPath: string, projectFilter: string): boolean {
  return (
    sessionPath.includes(projectFilter) || projectFromPath(sessionPath).includes(projectFilter)
  );
}

export function dateFromPath(sessionPath: string): string {
  const match = sessionPath.match(/(\d{4}-\d{2}-\d{2})T/);
  if (match?.[1]) return match[1];
  // Compaction archives are named <sessionId>-<leafId>-<epoch>.jsonl — no date
  // stamp — so a path-only parser reports "unknown" and drops them from the
  // search, stats and batch views. Fall back to the file's mtime (the archive
  // is written once, at compaction, then immutable). Only undated paths are
  // stat'd, so live sessions cost nothing extra.
  try {
    return statSync(sessionPath).mtime.toISOString().slice(0, 10);
  } catch {
    return "unknown";
  }
}

// State (module-level, process-global by design)
// Cached search backend detection result. Survives across calls within the
// same process. Not per-session because there's no ctx available during
// tool execution (the tool execute callback doesn't receive ctx with
// sessionKey).

let _cachedBackend: SearchBackend | undefined;

// Project label per session directory. A directory's cwd is fixed for the life
// of the directory, so caching the derived label is keyed by immutable
// filesystem state, not per-session state that would leak between sessions.
// Worth caching: `stats` and `batch` label every matched file, and one
// directory holds every session of one project.
const _projectByDir = new Map<string, string>();

export function getSearchBackend(): SearchBackend {
  if (_cachedBackend !== undefined) return _cachedBackend;
  for (const cmd of ["rg", "grep"] as const) {
    try {
      execFileSync(cmd, ["--version"], { stdio: "ignore", timeout: 5000 });
      _cachedBackend = cmd;
      return cmd;
    } catch {
      /* try next */
    }
  }
  _cachedBackend = "node";
  return "node";
}

// File discovery

export async function walkJsonlFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".jsonl")) results.push(full);
    }
  }
  await walk(dir);
  return results;
}

// Search implementations

export const MAX_SEARCH_RESULTS = 10;
export const MAX_SNIPPETS_PER_SESSION = 3;

/**
 * Term cap for a multi-term query. Each term costs one pass over the corpus
 * (plus one for the phrase), so an unbounded word count multiplies a ~4 s scan
 * by the number of words. Six words cover the queries the tool is used for;
 * the full query still counts as the phrase, so nothing is widened silently.
 */
export const MAX_QUERY_TERMS = 6;

export function tokenizeQuery(query: string): string[] {
  return terms(query);
}

/**
 * Cost bounds.
 *
 * The measured corpus is ~3,250 session files / 2.3 GB, and every search used
 * to scan all of it once for occurrences and again to tag the role signal.
 * Role only breaks ties, so it is refined on the files that can reach the
 * render window instead of the corpus. The candidate cap is five times the
 * render window: the role boost can only reorder the refined set, so anything
 * outside it can fall but never rise, and five slots per rendered result leaves
 * that reordering room without a corpus pass.
 */
export const ROLE_REFINE_LIMIT = 5 * MAX_SEARCH_RESULTS;

/**
 * A single pathological session file must not dominate a scan or be read whole
 * into memory by the fallback. Set at ~p99.9 of the measured corpus (32.0 MB),
 * so it excludes only the handful of multi-tens-of-MB outliers and leaves the
 * working set untouched.
 */
export const SEARCH_MAX_FILESIZE = "32M";
const SEARCH_MAX_BYTES = 32 * 1024 * 1024;

/** Phrase candidate files per backend invocation, to stay under ARG_MAX. */
const PHRASE_PASS_CHUNK = 500;

export interface SearchOptions {
  /** Backend timeout in ms (default 10000). */
  timeout?: number;
  /**
   * Cheap ordering (occurrences, recency, project - no role) used to pick the
   * files the role signal refines. Defaults to `rankFileMatches`; the tool
   * passes its four-signal ranker so the candidates match the render order.
   */
  rankCandidates?: (matches: FileMatchCount[]) => FileMatchCount[];
  /** Max files the role pass refines. Defaults to `ROLE_REFINE_LIMIT`. */
  roleLimit?: number;
}

/** Matches plus the cost provenance the caller surfaces in `details`. */
export interface SearchInfo {
  matches: FileMatchCount[];
  /** Backend that produced the matches - `node` is the slow fallback. */
  backend: SearchBackend;
  /** Wall-clock for the search, excluding snippet reads. */
  elapsedMs: number;
  /** Files the role signal was computed for (0 when the backend cannot tag). */
  roleRefined: number;
}

/**
 * A query is matched as terms, not as one literal phrase. `rg -F <query>`
 * requires the words to be adjacent and in order, so a natural multi-word
 * query returns nothing while a single term of it returns the sessions.
 * Requiring every term is no better: multi-word terms scatter across lines and
 * files, so an all-terms filter recalls nothing either. Every term is therefore
 * a match candidate and relevance is decided by ranking: lines carrying the
 * whole phrase, then rarity-weighted term coverage, then hit count.
 */
export async function searchFiles(
  query: string,
  sessionsDir: string,
  opts: SearchOptions = {},
): Promise<FileMatchCount[]> {
  return (await searchFilesWithInfo(query, sessionsDir, opts)).matches;
}

/**
 * The search, with the cost provenance the tool surfaces in its `details`.
 *
 * A single-term query issues one full-corpus backend invocation; an N-term
 * query N (one per term). The phrase and role signals are refined on bounded
 * candidate sets rather than the corpus - see `countPhrase` and
 * `attachUserHits`.
 */
export async function searchFilesWithInfo(
  query: string,
  sessionsDir: string,
  opts: SearchOptions = {},
): Promise<SearchInfo> {
  const timeout = opts.timeout ?? 10000;
  const started = Date.now();
  const backend = getSearchBackend();
  const queryTerms = terms(query);
  const needles = queryTerms.length > 1 ? queryTerms : [query];

  if (backend === "rg" || backend === "grep") {
    if (queryTerms.length <= 1) {
      const matches = countFixed(backend, [query], sessionsDir, timeout);
      if (matches) {
        const refined = attachUserHits(
          backend,
          needles,
          annotateSingleTerm(matches),
          timeout,
          opts,
        );
        return {
          matches: refined.matches,
          backend,
          elapsedMs: Date.now() - started,
          roleRefined: refined.refined,
        };
      }
    } else {
      const merged = countTerms(backend, query, queryTerms, sessionsDir, timeout);
      if (merged) {
        const refined = attachUserHits(backend, needles, merged, timeout, opts);
        return {
          matches: refined.matches,
          backend,
          elapsedMs: Date.now() - started,
          roleRefined: refined.refined,
        };
      }
    }
  }

  // The node fallback reads each file once, so the role count comes free with
  // the occurrence count; no separate pass and nothing to bound.
  const matches = await nodeSearchFiles(query, sessionsDir);
  return { matches, backend: "node", elapsedMs: Date.now() - started, roleRefined: matches.length };
}

/** The role marker that classifies a line as a user turn. */
const USER_ROLE_MARKER = '"role":"user"';

/**
 * Occurrence count for the file's role signal: lines that carry the marker and
 * at least one of the query's needles. A line is the granularity a grep-style
 * counter can offer (a match count cannot be split by role in one pass), so
 * this is a line count, not an occurrence count — see `rankSearchResults` for
 * how it is normalised. rg-only: grep has no lookahead, so the node fallback
 * (which has the parsed line) is the only other producer. Returns null when the
 * pass itself failed, so callers keep the ranking rather than lose it.
 */
function countUserLinesFixed(
  needles: string[],
  targets: string[],
  timeout: number,
): Map<string, number> | null {
  if (targets.length === 0) return new Map();
  const alternation = needles.map((p) => `\\Q${quoteForPcre(p)}\\E`).join("|");
  const pattern = `^(?=.*"role":"user").*(?:${alternation})`;
  try {
    const output = execFileSync("rg", ["-P", "-i", "-c", "-e", pattern, ...targets], {
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new Map(parseCountOutput(output).map((h) => [h.path, h.count]));
  } catch (err: any) {
    if (err.status === 1) return new Map();
    return null;
  }
}

/** Escape a term for use inside a `\Q...\E` literal in a PCRE2 pattern. */
function quoteForPcre(term: string): string {
  return term.replace(/\\E/g, "\\E\\\\E\\Q");
}

/**
 * The role signal, refined on a bounded candidate set.
 *
 * Role only breaks ties, so it is computed for the files that can reach the
 * render window: the caller's cheap ordering, truncated to `roleLimit`. Every
 * file outside that set keeps `userHits` undefined, which the ranker reads as a
 * neutral signal - a file ranked below the cutoff can fall once the files above
 * it are refined, never rise. A failed pass leaves the ranking intact rather
 * than losing the matches.
 */
function attachUserHits(
  backend: SearchBackend,
  needles: string[],
  matches: FileMatchCount[],
  timeout: number,
  opts: SearchOptions,
): { matches: FileMatchCount[]; refined: number } {
  if (backend !== "rg") return { matches, refined: 0 };
  const limit = Math.max(0, opts.roleLimit ?? ROLE_REFINE_LIMIT);
  const order = (opts.rankCandidates ?? rankFileMatches)(matches);
  const paths = order.slice(0, limit).map((m) => m.path);
  if (paths.length === 0) return { matches, refined: 0 };
  const userHits = countUserLinesFixed(needles, paths, timeout);
  if (!userHits) return { matches, refined: 0 };
  return {
    matches: matches.map((m) => {
      const hits = userHits.get(m.path);
      return hits === undefined ? m : { ...m, userHits: hits };
    }),
    refined: paths.length,
  };
}

/** rg/grep with the tool's flags; null means "backend failed, try the next". */
function countFixed(
  backend: "rg" | "grep",
  patterns: string[],
  target: string | string[],
  timeout: number,
): FileMatchCount[] | null {
  const targets = Array.isArray(target) ? target : [target];
  const args =
    backend === "rg"
      ? [
          "-i",
          "--count-matches",
          "-F",
          "--max-filesize",
          SEARCH_MAX_FILESIZE,
          ...patterns.flatMap((p) => ["-e", p]),
          ...targets,
        ]
      : [
          "-r",
          "-i",
          "-c",
          "-F",
          "--include=*.jsonl",
          ...patterns.flatMap((p) => ["-e", p]),
          ...targets,
        ];
  try {
    const output = execFileSync(backend, args, {
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return parseCountOutput(output);
  } catch (err: any) {
    if (err.status === 1) return [];
    return null;
  }
}

/**
 * One backend pass per term, merged. A file's score is the sum of its matched
 * terms' rarity weights 1/(1+df), so a file matching a term that appears in 2
 * of the corpus's files outranks one matching a term in 24 of them. The phrase
 * is counted by `countPhrase` on the only files that can contain it, so an
 * N-term query costs N corpus passes, not N+1.
 */
function countTerms(
  backend: "rg" | "grep",
  query: string,
  queryTerms: string[],
  sessionsDir: string,
  timeout: number,
): FileMatchCount[] | null {
  const perTerm: Array<Map<string, number>> = [];
  for (const term of queryTerms) {
    const hits = countFixed(backend, [term], sessionsDir, timeout);
    if (!hits) return null;
    perTerm.push(new Map(hits.map((h) => [h.path, h.count])));
  }
  const phrase = countPhrase(backend, query, perTerm, timeout);
  if (!phrase) return null;
  return mergeTermCounts(perTerm, phrase);
}

/**
 * Phrase occurrences, counted only where the phrase can exist.
 *
 * A phrase hit implies every one of its terms matched, so only files in the
 * intersection of the per-term match sets can carry the query as one literal.
 * That intersection is the candidate list - usually tiny (slice 2 measured 0 of
 * 26 files matching both terms of a two-word query), so this is bounded work,
 * not another corpus pass. The counts are identical to a corpus-wide pass
 * because every file outside the intersection scores 0 either way. Returns null
 * so a failed pass still falls through to the node backend.
 */
function countPhrase(
  backend: "rg" | "grep",
  query: string,
  perTerm: Array<Map<string, number>>,
  timeout: number,
): Map<string, number> | null {
  const [first, ...rest] = perTerm;
  if (!first) return new Map();
  const candidates = [...first.keys()].filter((path) => rest.every((files) => files.has(path)));
  const phrase = new Map<string, number>();
  for (let i = 0; i < candidates.length; i += PHRASE_PASS_CHUNK) {
    const chunk = candidates.slice(i, i + PHRASE_PASS_CHUNK);
    const hits = countFixed(backend, [query], chunk, timeout);
    if (!hits) return null;
    for (const h of hits) phrase.set(h.path, h.count);
  }
  return phrase;
}

function mergeTermCounts(
  perTerm: Array<Map<string, number>>,
  phrase: Map<string, number>,
): FileMatchCount[] {
  const weights = perTerm.map((files) => 1 / (1 + files.size));
  const merged = new Map<string, FileMatchCount>();
  perTerm.forEach((files, i) => {
    for (const [path, count] of files) {
      const entry = merged.get(path) ?? { path, count, terms: 0, score: 0, phrase: 0 };
      entry.count = Math.max(entry.count, count);
      entry.terms = (entry.terms ?? 0) + 1;
      entry.score = (entry.score ?? 0) + weights[i]!;
      merged.set(path, entry);
    }
  });
  const fullCoverage = weights.reduce((sum, w) => sum + w, 0);
  for (const [path, count] of phrase) {
    // A phrase hit implies every term matched, so the entry normally exists.
    const entry = merged.get(path) ?? {
      path,
      count,
      terms: perTerm.length,
      score: fullCoverage,
      phrase: 0,
    };
    entry.phrase = count;
    merged.set(path, entry);
  }
  return [...merged.values()];
}

/** Single-term matches: the phrase is the term, so every hit is a phrase hit. */
function annotateSingleTerm(matches: FileMatchCount[]): FileMatchCount[] {
  const weight = 1 / (1 + matches.length);
  return matches.map((m) => ({ ...m, phrase: m.count, terms: 1, score: weight }));
}

/**
 * Slice-2 ordering, kept for the term-matching contract and its test: files
 * carrying the whole query as a phrase first, then rarity-weighted term
 * coverage, then occurrences, then path (descending). The production search
 * path routes through `rankSearchResults` (rank.ts), which keeps these two
 * query-shape tiers and places its four-signal blend underneath.
 */
export function rankFileMatches(matches: FileMatchCount[]): FileMatchCount[] {
  return [...matches].sort(
    (a, b) =>
      (b.phrase ?? 0) - (a.phrase ?? 0) ||
      (b.score ?? 0) - (a.score ?? 0) ||
      b.count - a.count ||
      b.path.localeCompare(a.path),
  );
}

function parseCountOutput(output: string): FileMatchCount[] {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const lastColon = line.lastIndexOf(":");
      return { path: line.slice(0, lastColon), count: parseInt(line.slice(lastColon + 1), 10) };
    });
}

async function nodeSearchFiles(query: string, sessionsDir: string): Promise<FileMatchCount[]> {
  const files = await walkJsonlFiles(sessionsDir);
  const queryTerms = terms(query);
  if (queryTerms.length <= 1) {
    return annotateSingleTerm(await nodeCountFiles(query, files));
  }

  // One read per file carries per-term occurrence counts, phrase occurrences
  // and the role signal, so the fallback does in a single pass what the rg path
  // splits across one backend invocation per term plus the bounded refinements.
  const perTerm = new Map<string, Map<string, number>>(queryTerms.map((t) => [t, new Map()]));
  const phrase = new Map<string, number>();
  const userHits = new Map<string, number>();
  const lowerQuery = query.toLowerCase();
  for (const filePath of files) {
    if (isOversized(filePath)) continue;
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    let userLines = 0;
    for (const line of content.split("\n")) {
      const lower = line.toLowerCase();
      let hit = false;
      for (const term of queryTerms) {
        const occurrences = countOccurrences(lower, term);
        if (occurrences > 0) {
          const counts = perTerm.get(term)!;
          counts.set(filePath, (counts.get(filePath) ?? 0) + occurrences);
          hit = true;
        }
      }
      if (lowerQuery) {
        const occurrences = countOccurrences(lower, lowerQuery);
        if (occurrences > 0) {
          phrase.set(filePath, (phrase.get(filePath) ?? 0) + occurrences);
          hit = true;
        }
      }
      if (hit && lower.includes(USER_ROLE_MARKER)) userLines++;
    }
    if (userLines > 0) userHits.set(filePath, userLines);
  }
  return mergeTermCounts([...perTerm.values()], phrase).map((m) =>
    userHits.has(m.path) ? { ...m, userHits: userHits.get(m.path) } : m,
  );
}

/** Non-overlapping occurrences of `needle`, matching `rg --count-matches`. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count++;
    from = idx + needle.length;
  }
}

/**
 * Whether a file exceeds the backend cap. The node fallback reads a whole file
 * into memory, so it applies the same bound as rg's `--max-filesize` rather
 * than letting one runaway session define the fallback's memory.
 */
function isOversized(filePath: string): boolean {
  try {
    return statSync(filePath).size > SEARCH_MAX_BYTES;
  } catch {
    return false;
  }
}

/** Occurrence-only scan, used for single-term queries on the node backend. */
async function nodeCountFiles(query: string, files: string[]): Promise<FileMatchCount[]> {
  const results: FileMatchCount[] = [];
  const needle = query.toLowerCase();
  for (const filePath of files) {
    if (isOversized(filePath)) continue;
    try {
      const content = await readFile(filePath, "utf-8");
      let occurrences = 0;
      let userLines = 0;
      for (const line of content.split("\n")) {
        const lower = line.toLowerCase();
        const hits = countOccurrences(lower, needle);
        if (hits > 0) {
          occurrences += hits;
          if (lower.includes(USER_ROLE_MARKER)) userLines++;
        }
      }
      if (occurrences > 0)
        results.push({ path: filePath, count: occurrences, userHits: userLines });
    } catch {
      /* skip bad files */
    }
  }
  return results;
}

/** Distinct query terms present in a message, for ranking message hits. */
export function countTermsInText(text: string, queryTerms: string[]): number {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const term of queryTerms) {
    if (lower.includes(term)) hits++;
  }
  return hits;
}

/**
 * Messages a query matched, all-term hits first (stable, so archive order is
 * kept inside a bucket). A single-term query keeps the plain filter behaviour:
 * the matched messages in their original order.
 */
export function messagesMatchingTerms<T extends { text: string }>(
  messages: T[],
  queryTerms: string[],
): T[] {
  return messages
    .map((msg) => ({ msg, hits: countTermsInText(msg.text, queryTerms) }))
    .filter((candidate) => candidate.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((candidate) => candidate.msg);
}

export async function searchLines(
  query: string,
  filePath: string,
  limit: number,
): Promise<string[]> {
  return (await searchLineHits(query, filePath, limit)).map((hit) => hit.text);
}

/** A matching line with the line number a citation needs. */
export interface LineHit {
  /** 1-based line number in the session file. */
  line: number;
  /** The raw JSONL line, as read. */
  text: string;
  /** Distinct query terms the line carries. */
  hits: number;
}

/**
 * Matching lines with their line numbers, ranked.
 *
 * Ranked the same way as file order: lines carrying more query terms first, and
 * the stable sort keeps the earliest occurrence first inside a tie. The line
 * number is what makes a rendered snippet citable - a passage an agent cannot
 * point back to is a claim, not evidence.
 */
export async function searchLineHits(
  query: string,
  filePath: string,
  limit: number,
): Promise<LineHit[]> {
  const results: LineHit[] = [];
  const queryTerms = terms(query);
  const needles = queryTerms.length > 1 ? queryTerms : [query.toLowerCase()];

  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      const hits = hitsFor(line, needles);
      if (hits > 0) results.push({ line: i + 1, text: line, hits });
    }
  } catch {
    // Unreadable session file - partial results are still useful for recall.
  }

  // A file can be in the result set on one term alone, so snippet order is
  // ranked the same way as file order: lines matching more terms first, and
  // the stable sort keeps the earliest occurrence first inside a tie.
  if (needles.length <= 1) return results.slice(0, limit);
  return results.sort((a, b) => b.hits - a.hits).slice(0, limit);
}

/**
 * Drop the calling session's own file from a match list.
 *
 * A session that matches its own transcript first is the shape that made the
 * archive unreadable: the agent's current words crowd out the human's earlier
 * ones. The comparison resolves symlinked spellings of the same file, so a
 * match reached through another path cannot slip past it.
 */
export function excludeSessionPath<T extends { path: string }>(
  matches: T[],
  sessionFile: string | null | undefined,
): T[] {
  if (!sessionFile) return matches;
  const target = resolveReal(sessionFile);
  return matches.filter((match) => resolveReal(match.path) !== target);
}

/** A path with its symlinks resolved where it exists, else its lexical form. */
function resolveReal(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function hitsFor(line: string, needles: string[]): number {
  const lower = line.toLowerCase();
  let hits = 0;
  for (const needle of needles) {
    if (needle && lower.includes(needle)) hits++;
  }
  return hits;
}
