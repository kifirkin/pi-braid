/**
 * Session corpus ask - lexical retrieval over the user-turn index.
 *
 * BM25 over one document per user turn. At this corpus size the lexical model
 * is the cheap, testable choice: no embedding pass to keep current, no vector
 * store to back up, no key to spend on a query, and a score a reader can
 * re-derive by eye from the terms it names. What would earn a vector store is
 * a measured failure: recall@3 below the bar on questions whose answering
 * passage is in the index (the report's falsifier is that measurement).
 *
 * Every hit carries its citation - project, session path, line, timestamp -
 * because the answer is the owner's own words and a reader must be able to
 * check them against the session file. The refusal is a first-class result: a
 * query whose terms appear nowhere in the population says so and names what it
 * searched, rather than returning the least bad rows.
 */

import type { CorpusFreshness, CorpusTurn, LoadedShard } from "./corpus-index.js";

/** BM25 term-frequency saturation. */
export const BM25_K1 = 1.2;
/** BM25 length normalisation. */
export const BM25_B = 0.75;
/** Hits a query returns when the caller names no limit. */
export const MAX_ASK_HITS = 5;
/** Characters of a turn the answer prints before it trims. */
const PASSAGE_CHARS = 360;

/**
 * Words that carry no retrieval signal in a question about work. A fixed
 * language table, not a project vocabulary: it holds English function words
 * only, so a query term that names something always survives it.
 */
const STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "before",
  "being",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "done",
  "for",
  "from",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "him",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "once",
  "only",
  "or",
  "other",
  "our",
  "out",
  "over",
  "own",
  "same",
  "she",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "too",
  "under",
  "up",
  "us",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

/**
 * Fold one token to its retrieval stem.
 *
 * Inflected forms of a word are one word for retrieval: a question saying
 * "rendered" must reach a turn saying "renders", and "picks" must reach
 * "pick". The fold is symmetric - the query and the turns pass through the
 * same function - so a fold that is linguistically wrong ("boxes" -> "boxe")
 * is still a fold both sides agree on. The doubled-consonant rule exists for
 * the same reason: "hitting" must reach "hit".
 */
function foldToken(token: string): string {
  if (token.length <= 3) return token;
  let stem = token;
  if (stem.endsWith("ies") && stem.length > 4) stem = `${stem.slice(0, -3)}y`;
  else if (stem.endsWith("s") && !stem.endsWith("ss")) stem = stem.slice(0, -1);
  if (stem.endsWith("ing") && stem.length > 5) stem = stem.slice(0, -3);
  else if (stem.endsWith("ed") && stem.length > 4) stem = stem.slice(0, -2);
  const last = stem.at(-1);
  if (/[bdfglmnprt]/.test(last ?? "") && stem.at(-2) === last && stem.length > 3) {
    stem = stem.slice(0, -1);
  }
  return stem;
}

/**
 * Words a document is scored on: letter/number runs, lowercased, stemmed.
 *
 * A hyphen separates words: the owner's compound names ("looping-clanker",
 * "anti-crowd") are two words a question may spell either way, and a tokenizer
 * that keeps the compound as one token can never match its own parts.
 */
export function tokenizeForIndex(text: string): string[] {
  const raw = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens: string[] = [];
  for (const token of raw) {
    if (token.length < 2 && !/\d/.test(token)) continue;
    tokens.push(foldToken(token));
  }
  return tokens;
}

/**
 * Query terms: the document tokens minus function words. Duplicates collapse,
 * so a word typed twice scores once.
 */
export function askQueryTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const token of tokenizeForIndex(query)) {
    if (STOPWORDS.has(token)) continue;
    seen.add(token);
  }
  return [...seen];
}

export interface AskHit {
  turn: CorpusTurn;
  score: number;
  /** Query terms this turn carries. */
  matched: string[];
}

export interface AskResult {
  query: string;
  /** Query terms after the function-word filter. */
  terms: string[];
  /** Terms that occur in the searched population. */
  matched_terms: string[];
  /** Terms that occur nowhere in the searched population. */
  unmatched_terms: string[];
  hits: AskHit[];
  /** Whether the index could answer at all (at least one hit). */
  answered: boolean;
  population: {
    turns: number;
    sessions: number;
    projects: string[];
    /** Oldest and newest shard build time in the population. */
    built_oldest: string;
    built_newest: string;
    shards: number;
  };
  freshness: CorpusFreshness;
  filters: { project: string | null; since: string | null };
  /** True when the caller's own session was withheld from the results. */
  self_excluded: boolean;
}

export interface AskOptions {
  /** Project label filter; null reads every shard the store loaded. */
  project?: string | null;
  /** Inclusive lower bound on the turn's date (YYYY-MM-DD). */
  since?: string | null;
  limit?: number;
  /** Session file never returned to itself. */
  excludeSession?: string | null;
  freshness: CorpusFreshness;
}

/** BM25 score of one document against the query terms. */
function scoreDocument(
  termFrequencies: Map<string, number>,
  docLength: number,
  averageLength: number,
  idf: Map<string, number>,
): { score: number; matched: string[] } {
  const lengthNorm = averageLength > 0 ? 1 - BM25_B + (BM25_B * docLength) / averageLength : 1;
  let score = 0;
  const matched: string[] = [];
  for (const [term, frequency] of termFrequencies) {
    const weight = idf.get(term);
    if (weight === undefined) continue;
    matched.push(term);
    score += (weight * (frequency * (BM25_K1 + 1))) / (frequency + BM25_K1 * lengthNorm);
  }
  return { score, matched };
}

/**
 * Retrieve the turns that answer a question, with citations.
 *
 * The population searched is stated in the result, so a refusal can show what
 * it looked at. `df` and the average document length are computed over the
 * filtered population: an index narrowed by `--project` or `--since` is the
 * corpus the answer claims, not a sample of a larger one it never read.
 */
export function askCorpusIndex(shards: LoadedShard[], query: string, opts: AskOptions): AskResult {
  const terms = askQueryTerms(query);
  const allowed = new Set(terms);
  const candidates: CorpusTurn[] = [];
  const projects = new Set<string>();
  const builtAt = new Set<string>();
  for (const shard of shards) {
    projects.add(shard.manifest.project);
    builtAt.add(shard.manifest.built_at);
    for (const turn of shard.turns) {
      if (opts.excludeSession && turn.session === opts.excludeSession) continue;
      if (opts.since && turn.ts.slice(0, 10) < opts.since) continue;
      candidates.push(turn);
    }
  }

  const sessions = new Set<string>();
  for (const turn of candidates) sessions.add(turn.session);

  // One pass: term frequencies for the query terms, and the document's length.
  const frequencies: Array<Map<string, number>> = new Array(candidates.length);
  const lengths: number[] = new Array(candidates.length);
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  for (let i = 0; i < candidates.length; i++) {
    const tokens = tokenizeForIndex((candidates[i] as CorpusTurn).text);
    lengths[i] = tokens.length;
    totalLength += tokens.length;
    const counts = new Map<string, number>();
    for (const token of tokens) {
      if (!allowed.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    frequencies[i] = counts;
    for (const term of counts.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const total = candidates.length;
  const averageLength = total > 0 ? totalLength / total : 0;
  const idf = new Map<string, number>();
  for (const [term, df] of documentFrequency) {
    idf.set(term, Math.log(1 + (total - df + 0.5) / (df + 0.5)));
  }

  const limit = Math.max(1, opts.limit ?? MAX_ASK_HITS);
  const scored: AskHit[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const counts = frequencies[i];
    const turn = candidates[i];
    if (!counts || !turn || counts.size === 0) continue;
    const { score, matched } = scoreDocument(counts, lengths[i] ?? 0, averageLength, idf);
    if (score <= 0) continue;
    scored.push({ turn, score, matched });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.turn.ts.localeCompare(a.turn.ts) ||
      a.turn.session.localeCompare(b.turn.session) ||
      a.turn.line - b.turn.line,
  );

  const matchedTerms = terms.filter((term) => (documentFrequency.get(term) ?? 0) > 0);
  return {
    query,
    terms,
    matched_terms: matchedTerms,
    unmatched_terms: terms.filter((term) => !matchedTerms.includes(term)),
    hits: scored.slice(0, limit),
    answered: scored.length > 0,
    population: {
      turns: total,
      sessions: sessions.size,
      projects: [...projects].sort(),
      built_oldest: [...builtAt].sort()[0] ?? "",
      built_newest: [...builtAt].sort().at(-1) ?? "",
      shards: shards.length,
    },
    freshness: opts.freshness,
    filters: { project: opts.project ?? null, since: opts.since ?? null },
    self_excluded: Boolean(opts.excludeSession),
  };
}

/** One passage, trimmed around the best-matching term. */
function passage(text: string, matched: string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= PASSAGE_CHARS) return flat;
  const anchor = matched.find((term) => flat.toLowerCase().includes(term)) ?? "";
  const at = anchor ? flat.toLowerCase().indexOf(anchor) : -1;
  if (at < 0) return `${flat.slice(0, PASSAGE_CHARS)}...`;
  const start = Math.max(0, at - Math.floor(PASSAGE_CHARS / 3));
  const end = Math.min(flat.length, start + PASSAGE_CHARS);
  return `${start > 0 ? "..." : ""}${flat.slice(start, end)}${end < flat.length ? "..." : ""}`;
}

/** Freshness in one phrase, or null when the index is current. */
function freshnessNote(freshness: CorpusFreshness): string | null {
  const parts: string[] = [];
  if (freshness.changed > 0) parts.push(`${freshness.changed} changed`);
  if (freshness.added > 0) parts.push(`${freshness.added} new`);
  if (freshness.removed > 0) parts.push(`${freshness.removed} gone`);
  if (parts.length === 0) return null;
  const newest = freshness.newest_change ? `, newest ${freshness.newest_change}` : "";
  return `${parts.join(", ")} session file(s) since the build${newest}; rerun the index build for them`;
}

function number(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Render the answer: cited passages, or a refusal that names the population it
 * searched and the terms it found.
 */
export function formatAskResult(result: AskResult): string {
  const population =
    `${number(result.population.turns)} user turns from ` +
    `${number(result.population.sessions)} sessions across ` +
    `${result.population.projects.length} project(s)`;
  const built =
    result.population.built_oldest === result.population.built_newest
      ? `built ${result.population.built_newest}`
      : `shards built ${result.population.built_oldest} to ${result.population.built_newest}`;
  const note = freshnessNote(result.freshness);
  const header = [
    `**Ask:** ${result.query}`,
    `Index: ${population}; ${built}.${note ? `\nStaleness: ${note}.` : ""}`,
    result.filters.project || result.filters.since
      ? `Filters: project=${result.filters.project ?? "all"}, since=${result.filters.since ?? "none"}`
      : "",
    result.self_excluded ? "Withheld: this session's own turns." : "",
  ].filter(Boolean);

  if (!result.answered) {
    const found =
      result.matched_terms.length > 0
        ? `terms found elsewhere in the population: ${result.matched_terms.join(", ")}`
        : "none of the query terms appear in the population";
    const missing =
      result.unmatched_terms.length > 0
        ? `terms not found: ${result.unmatched_terms.join(", ")}`
        : "every term was found, but no turn carries them together";
    return [
      ...header,
      "",
      "**The index cannot answer this.**",
      `Searched ${population}.`,
      `Result: ${found}; ${missing}.`,
      "Widen the words used, drop the project filter, or rebuild the index if the sessions are newer than the build.",
    ].join("\n");
  }

  const blocks = result.hits.map((hit, index) => {
    const where =
      `**${index + 1}.** ${hit.turn.project} - ${hit.turn.ts} - line ${hit.turn.line}\n` +
      `Session: \`${hit.turn.session}\``;
    return `${where}\n> ${passage(hit.turn.text, hit.matched)}`;
  });
  const lines = [
    ...header,
    "",
    `${result.hits.length} turn(s) carry the query, ranked by BM25:`,
    "",
    blocks.join("\n\n"),
  ];
  if (result.unmatched_terms.length > 0) {
    lines.push(
      "",
      `Terms found in no turn (the lexical index cannot see them): ${result.unmatched_terms.join(", ")}.`,
    );
  }
  return lines.join("\n");
}
