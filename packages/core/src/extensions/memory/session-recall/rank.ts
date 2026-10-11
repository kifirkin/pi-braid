/**
 * Session-recall ranking.
 *
 * Ranking by matching *lines* per file would misorder results: a term hit
 * twelve times on one long compaction-archive line counts once against a file
 * that mentions it on twelve sparse lines, and line count ignores everything
 * else the search already knows about a hit: when the session was, which
 * project it belongs to, and whether the hit is in a user turn or a tool
 * result.
 *
 * `rankSearchResults` blends four signals:
 *
 *   1. occurrences - matches, not lines (`count` on `FileMatchCount`).
 *   2. recency     - `dateFromPath`, the same source the search path resolves.
 *   3. project     - `projectFromPath` compared with the caller's cwd label.
 *   4. role        - a match on a user-role line over the file's occurrences.
 *
 * The blend is multiplicative, mirroring the memory store's recall score
 * (`lib/memory/index.ts`): occurrences scaled by a freshness factor
 * (half-life decay, floored so an old session is never zeroed), a same-project
 * boost, and a user-turn boost. Its multiplicative shape means an old session
 * with many occurrences still outranks a recent session with one, while a tie
 * on occurrences is broken by recency, then project, then role — deterministic,
 * with the path as the final tie-break.
 *
 * Slice 2's two ordering tiers are preserved ahead of the blend: files carrying
 * the whole query as a phrase sort first, then files with more
 * rarity-weighted term coverage. Those are query-shape signals, not corpus
 * signals, so the four-signal blend decides inside a tier.
 */

import { dateFromPath, projectFromPath, type FileMatchCount } from "./search.js";

const DAY_MS = 86_400_000;

/** Weights of the blend. Named here so a future change is a diff, not a hunt. */
export const RANK_WEIGHTS = {
  /** Recency half-life: a session this old keeps half its recency credit. */
  recencyHalfLifeDays: 30,
  /** Freshness floor: recency modulates a score, it never erases a hit. */
  recencyFloor: 0.4,
  /** Multiplier when the candidate is in the caller's project. */
  sameProjectBoost: 1.3,
  /** Added to the score when every occurrence is on a user-role line. */
  userTurnBoost: 0.5,
} as const;

export interface RankOptions {
  /** Project label the agent is currently in (from its cwd). Enables the project boost. */
  currentProject?: string;
  /** Clock for recency. Injectable so ranking is deterministic in tests. */
  now?: number;
}

export interface RankSignals {
  occurrences: number;
  /** Age in days, or Infinity when the date is unknown. */
  ageDays: number;
  /** Recency multiplier in [recencyFloor, 1], or 1 when the date is unknown. */
  freshness: number;
  sameProject: boolean;
  /** User-role matching lines over occurrences, clamped to [0, 1]. */
  userShare: number;
}

export interface RankedMatch extends FileMatchCount {
  /** The four-signal blend. Higher is better; only comparable within a tier. */
  rankScore: number;
  rankSignals: RankSignals;
}

/**
 * Rank candidates for rendering. Phrase-bearing files first, then
 * rarity-weighted coverage, then the blend, then path (descending, matching the
 * pre-existing single-term tie-break). Fully deterministic for a given corpus,
 * clock and cwd.
 */
export function rankSearchResults(
  matches: FileMatchCount[],
  opts: RankOptions = {},
): RankedMatch[] {
  const now = opts.now ?? Date.now();
  const scored = matches.map((m) => score(m, now, opts.currentProject));
  return scored.sort(
    (a, b) =>
      phraseHit(b) - phraseHit(a) ||
      (b.score ?? 0) - (a.score ?? 0) ||
      b.rankScore - a.rankScore ||
      b.path.localeCompare(a.path),
  );
}

function phraseHit(m: FileMatchCount): number {
  return (m.phrase ?? 0) > 0 ? 1 : 0;
}

function score(m: FileMatchCount, now: number, currentProject?: string): RankedMatch {
  const occurrences = Math.max(0, m.count);
  const date = dateFromPath(m.path);
  const dateMs = date && date !== "unknown" ? Date.parse(`${date}T00:00:00.000Z`) : NaN;
  const known = Number.isFinite(dateMs);
  const ageDays = known ? Math.max(0, (now - dateMs) / DAY_MS) : Infinity;
  // An unknown date carries no recency evidence, so it is neutral rather than
  // penalised; a known date decays from 1 toward the floor.
  const freshness = known
    ? RANK_WEIGHTS.recencyFloor +
      (1 - RANK_WEIGHTS.recencyFloor) * Math.pow(0.5, ageDays / RANK_WEIGHTS.recencyHalfLifeDays)
    : 1;
  const sameProject = !!currentProject && projectFromPath(m.path) === currentProject;
  const userShare = Math.min(1, (m.userHits ?? 0) / Math.max(1, occurrences));
  const rankScore =
    occurrences *
    freshness *
    (sameProject ? RANK_WEIGHTS.sameProjectBoost : 1) *
    (1 + RANK_WEIGHTS.userTurnBoost * userShare);
  return {
    ...m,
    rankScore,
    rankSignals: { occurrences, ageDays, freshness, sameProject, userShare },
  };
}
