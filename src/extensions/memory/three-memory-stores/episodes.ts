/**
 * Episode Store - case-based reasoning from past tasks.
 *
 * Paper: 2604.14475 Evo-MedAgent
 * Key finding: Episode memory outperforms single memory.
 * MCQ accuracy 0.68 -> 0.79.
 */

import { createLogger } from "../../../lib/core/logger.js";
import { eventBus } from "../../../lib/events/event-bus.js";
import type { MemoryStoresState, Episode } from "./types.js";
import { nextId } from "../../../lib/utils/id.js";

const log = createLogger("three-memory-stores:episodes");

/**
 * Sanitize a string by decoding literal `\uXXXX` escape sequences that
 * may have been written by a previous code path that double-encoded
 * unicode (BUG-M3). The agent-facing `recall_search` and `episodes_search`
 * displays otherwise show literal `\u2192` instead of the real character
 * `->`. Applied at load time AND at write time (in `addEpisode`) so both
 * existing data files and new writes are healed.
 *
 * The previous implementation used `JSON.parse('"' + s + '"')` for safety
 * (verify round-trip changes the value before accepting). That approach
 * silently FAILED for any string containing raw newline/control characters
 * -- which is the common case for task and solution fields that contain
 * multi-line text. JSON.parse throws on raw \n inside string literals.
 * The sanitizer returned the input unchanged, so the literal `\u2192`
 * remained in agent-facing output.
 *
 * Current implementation: regex-replace each `\uXXXX` with the decoded
 * code point. Detection: only run if the string contains at least one
 * `\uXXXX` pattern. The safety trade-off: legitimate backslash-u text
 * (rare in episode data) would also be decoded. Acceptable for this
 * store; episode content is model output and natural language, not
 * regex patterns.
 */
export function unescapeUnicodeIfDoubleEncoded(s: string): string {
  if (typeof s !== "string") return s;
  if (!/\\u[0-9a-fA-F]{4}/.test(s)) return s;
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
}

/**
 * Apply unescapeUnicodeIfDoubleEncoded to all string-bearing fields of
 * an episode. Used at load time and write time to ensure no literal
 * `\u2192` sequences leak into agent-facing output.
 */
export function sanitizeEpisode(ep: Episode): Episode {
  return {
    ...ep,
    task: unescapeUnicodeIfDoubleEncoded(ep.task),
    solution: unescapeUnicodeIfDoubleEncoded(ep.solution),
    // outcome is a small enum, not affected
    // toolSequence, tags, etc. are arrays - recurse over string entries
    toolSequence: ep.toolSequence?.map(unescapeUnicodeIfDoubleEncoded),
    tags: ep.tags?.map(unescapeUnicodeIfDoubleEncoded),
    project: unescapeUnicodeIfDoubleEncoded(ep.project),
    strategicSOP: ep.strategicSOP ? unescapeUnicodeIfDoubleEncoded(ep.strategicSOP) : undefined,
    functionalSOP: ep.functionalSOP?.map(unescapeUnicodeIfDoubleEncoded),
    atomicSOP: ep.atomicSOP?.map(unescapeUnicodeIfDoubleEncoded),
  };
}

export function addEpisode(
  state: MemoryStoresState,
  task: string,
  solution: string,
  outcome: Episode["outcome"],
  toolSequence: string[],
  tags: string[] = [],
  project?: string,
  strategicSOP?: string,
  functionalSOP?: string[],
  atomicSOP?: string[],
): Episode {
  const outcomeScore = { success: 1.0, partial: 0.5, failure: 0.2 }[outcome];
  const uniqueTools = new Set(toolSequence).size;
  const toolDiversity = toolSequence.length > 0 ? uniqueTools / toolSequence.length : 0;
  const reasoningDensity =
    toolSequence.length > 0 ? Math.min(1, solution.length / (toolSequence.length * 200)) : 0.5;
  const quality =
    Math.round(outcomeScore * (toolDiversity * 0.4 + 0.6) * (reasoningDensity * 0.4 + 0.6) * 100) /
    100;

  // Sanitize string fields before storing so newly-added episodes
  // never reintroduce literal \uXXXX sequences (BUG-M3 hardening).
  // The load-time sanitizer in index.ts:loadPastEpisodes handles
  // already-stored entries.
  const episode: Episode = sanitizeEpisode({
    id: nextId('ep'),
    task,
    solution,
    outcome,
    similarity: 0,
    timestamp: Date.now(),
    toolSequence,
    tags,
    project: project ?? "unknown",
    sessionId: state.currentSessionId || "unknown",
    quality,
    strategicSOP,
    functionalSOP,
    atomicSOP,
  });
  state.episodes.push(episode);

  if (state.episodes.length > 500) {
    pruneEpisodes(state);
  }

  log.debug(`Added episode: "${task.slice(0, 50)}..." (${outcome}, quality=${quality})`);
  return episode;
}

// ── Memory Condensation (Decocted Experience 2604.03213) ─────────────────────

export function condenseInsights(episode: Episode, maxTokens = 150): string {
  const outcomeLabel =
    episode.outcome === "success"
      ? "SUCCESS"
      : episode.outcome === "failure"
        ? "FAILURE"
        : "PARTIAL";
  const toolSummary =
    episode.toolSequence.length > 0
      ? `[${episode.toolSequence.slice(0, 5).join(" -> ")}${episode.toolSequence.length > 5 ? ` (+${episode.toolSequence.length - 5} more)` : ""}]`
      : "";

  const insight = episode.solution
    .split(/[.!?]\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10 && s.length < 200)
    .slice(0, 3)
    .join(". ");

  const condensed = `* ${episode.task.slice(0, 80)} [${outcomeLabel}] ${toolSummary}\n  Insight: ${insight.slice(0, maxTokens * 3)}`;
  return condensed.length > maxTokens * 4 ? condensed.slice(0, maxTokens * 4) + "..." : condensed;
}

// ── Retrieval ────────────────────────────────────────────────────────────────

export function retrieveEpisodes(
  state: MemoryStoresState,
  query: string,
  limit: number = 3,
  currentProject?: string,
): Episode[] {
  const queryLower = query.toLowerCase();
  const now = Date.now();
  const scored = state.episodes
    .map((ep) => {
      const baseScore = computeSimilarity(queryLower, ep);
      const CROSS_PROJECT_PENALTY = -0.7;
      const crossProjectPenalty =
        currentProject && ep.project && ep.project !== currentProject ? CROSS_PROJECT_PENALTY : 0;
      const projectBonus = currentProject && ep.project === currentProject ? 0.2 : 0;
      const ageHours = (now - ep.timestamp) / 3600000;
      const ageBonus = Math.max(0, 1 - ageHours / 168) * 0.1;
      return {
        ep,
        score: baseScore + projectBonus + ageBonus + crossProjectPenalty,
        isCrossProject: crossProjectPenalty < 0,
      };
    })
    .filter((s) => s.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map((s) => {
    const ageHours = (Date.now() - s.ep.timestamp) / 3600000;
    const memoryConfidence = Math.max(0.1, 1 - ageHours / 504);
    return { ...s.ep, similarity: s.score, memoryConfidence };
  });
}

export function computeSimilarity(query: string, episode: Episode): number {
  const queryWords = new Set(query.split(/\s+/).filter((w) => w.length > 2));
  if (queryWords.size === 0) return 0;

  const taskWords = new Set(
    episode.task
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
  const solutionWords = new Set(
    episode.solution
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
  const tagWords = new Set(
    episode.tags.flatMap((t) => t.toLowerCase().split(/\s+/)).filter((w) => w.length > 2),
  );

  let matches = 0;
  for (const word of queryWords) {
    if (taskWords.has(word)) matches += 3;
    if (solutionWords.has(word)) matches += 1;
    if (tagWords.has(word)) matches += 2;
  }

  return matches / (queryWords.size * 3);
}

// ── RUMS Retrieval (paper 2604.14473) ────────────────────────────────────────

export function estimatePMI(
  queryWord: string,
  episode: Episode,
  backgroundFreq: Map<string, number>,
  totalDocs: number,
): number {
  const pWord = backgroundFreq.get(queryWord) ?? 1;
  let pWordGivenEpisode = 0;
  if (queryWord.length >= 3) {
    if (episode.task.toLowerCase().includes(queryWord)) pWordGivenEpisode += 0.7;
    if (episode.solution.toLowerCase().includes(queryWord)) pWordGivenEpisode += 0.5;
    if (episode.tags.some((t) => t.toLowerCase().includes(queryWord))) pWordGivenEpisode += 0.3;
  }
  if (pWordGivenEpisode === 0) return 0;
  return Math.log((pWordGivenEpisode * totalDocs) / Math.max(pWord, 1));
}

export function computeRUMS(
  query: string,
  episode: Episode,
  backgroundFreq: Map<string, number>,
  totalDocs: number,
): number {
  const queryWords = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  if (queryWords.length === 0) return 0;

  let pmiSum = 0;
  let validWords = 0;
  for (const word of queryWords) {
    const pmi = estimatePMI(word, episode, backgroundFreq, totalDocs);
    if (pmi > 0) {
      pmiSum += pmi;
      validWords++;
    }
  }
  const avgPMI = validWords > 0 ? pmiSum / validWords : 0;
  const pmiScore = Math.min(avgPMI / 5, 1) * 0.6;
  const outcomeScore =
    episode.outcome === "success" ? 0.2 : episode.outcome === "partial" ? 0.1 : 0.0;
  const ageDays = (Date.now() - episode.timestamp) / (24 * 60 * 60 * 1000);
  const recencyScore = Math.max(0, 1 - ageDays / 30) * 0.2;
  const solutionTokens = episode.solution.split(/\W+/).filter((w) => w.length > 3).length;
  const specificityScore = Math.min(solutionTokens / 20, 1) * 0.1;

  return pmiScore + outcomeScore + recencyScore + specificityScore;
}

export function retrieveByRUMS(
  state: MemoryStoresState,
  query: string,
  limit: number = 3,
  currentSessionId: string,
): Episode[] {
  if (state.episodes.length === 0) return [];

  const backgroundFreq = new Map<string, number>();
  const totalDocs = state.episodes.length;
  for (const ep of state.episodes) {
    const words = new Set(
      (ep.task + " " + ep.solution + " " + ep.tags.join(" "))
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 2),
    );
    for (const word of words) {
      backgroundFreq.set(word, (backgroundFreq.get(word) ?? 0) + 1);
    }
  }

  const scored = state.episodes.map((ep) => ({
    ep,
    score: computeRUMS(query, ep, backgroundFreq, totalDocs),
  }));

  const results = scored
    .filter((s) => s.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => ({ ...s.ep, similarity: s.score }));

  // Mark cross-session episodes (for display/auto-whisper filtering)
  // but do NOT filter them out - user-initiated memory tool needs them.
  // Callers that want filtering (e.g. auto-whisper) should do it at the call site.
  for (const ep of results) {
    (ep as Record<string, unknown>)._crossSession =
      ep.sessionId && ep.sessionId !== currentSessionId;
  }
  log.debug(`RUMS retrieved ${results.length} episodes for "${query.slice(0, 30)}..."`);
  return results;
}

function pruneEpisodes(state: MemoryStoresState): void {
  const before = state.episodes.length;
  const removed = before - Math.min(before, 500);

  if (removed > 0) {
    // Emit memory_evict event so context-lifecycle can adjust proposal thresholds
    eventBus.emit({
      type: "memory_evict",
      reason: "episode_prune",
      count: removed,
    });
  }

  state.episodes = state.episodes.slice(-500);
}
