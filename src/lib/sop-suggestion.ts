/**
 * SOP Retrieval & Suggestion — Consolidation Channel Phase 2
 *
 * Queries three-memory-stores for relevant SOPs when a new task starts,
 * surfaces them via whisper (injected context) so the agent benefits
 * from past experiences without explicit retrieval commands.
 *
 * Flow:
 *   turn_start → extract task keywords from user message
 *             → query episodic memory for relevant episodes
 *             → extract SOPs from matching episodes
 *             → inject top SOPs as hint messages
 *
 * This implements the "suggestion" half of the consolidation pipeline:
 *   Phase 1: Extraction (sop-extractor.ts) ✓
 *   Phase 2: Retrieval + Suggestion ← you are here
 *   Phase 3: Periodic consolidation (consolidation-channel.ts) ✓
 */

import { createLogger } from "./logger.js";
import { sendTrackedMessage } from "./injection-tracker.js";
import { eventBus } from "./event-bus.js";
import type { Episode } from "../extensions/memory/three-memory-stores/types.js";

const log = createLogger("sop-suggestion");

// ── Types ──────────────────────────────────────────────────────────────────

export interface SopSuggestionConfig {
  /** Max SOPs to inject per turn */
  maxSuggestionsPerTurn: number;
  /** Min similarity score to consider (0-1) */
  minSimilarity: number;
  /** Max tokens for all SOP text combined */
  maxTotalTokens: number;
  /** Only suggest for tasks matching these patterns (empty = all) */
  taskIncludePatterns: RegExp[];
  /** Skip suggestions for these task patterns */
  taskExcludePatterns: RegExp[];
  /** Enable/disable suggestions */
  enabled: boolean;
}

export interface RetrievedSop {
  episode: Episode;
  similarity: number;
  strategicSOP: string | undefined;
  functionalSOPs: string[];
  matchedKeywords: string[];
}

export const DEFAULT_SOP_CONFIG: SopSuggestionConfig = {
  maxSuggestionsPerTurn: 1,
  minSimilarity: 0.3,
  maxTotalTokens: 800,
  taskIncludePatterns: [],
  taskExcludePatterns: [/\/retry/, /^\[retry\]/], // eslint-disable-line no-useless-escape
  enabled: true,
};

// ── Keyword Extraction ──────────────────────────────────────────────────────

/**
 * Extract task keywords from user message text.
 * Strips common stopwords and boilerplate, returns meaningful identifiers.
 */
function extractKeywords(text: string): string[] {
  if (!text || text.length < 5) return [];

  const stopwords = new Set([
    "the",
    "a",
    "an",
    "this",
    "that",
    "these",
    "those",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "can",
    "could",
    "should",
    "may",
    "might",
    "shall",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "at",
    "by",
    "from",
    "as",
    "into",
    "through",
    "during",
    "before",
    "after",
    "about",
    "between",
    "under",
    "over",
    "and",
    "but",
    "or",
    "nor",
    "not",
    "so",
    "yet",
    "if",
    "then",
    "else",
    "when",
    "where",
    "why",
    "how",
    "all",
    "each",
    "every",
    "both",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "only",
    "own",
    "same",
    "just",
    "also",
    "very",
    "too",
    "really",
    "please",
    "help",
    "need",
    "want",
    "like",
    "make",
    "get",
    "use",
    "let",
    "know",
    "see",
    "check",
    "look",
    "write",
    "create",
    "find",
    "fix",
    "update",
    "add",
    "remove",
    "change",
    "implement",
    "hello",
    "hi",
    "thanks",
    "thank",
    "yes",
    "no",
    "ok",
    "okay",
    "sure",
    "right",
    "well",
    "now",
    "here",
  ]);

  // Extract words, filter stopwords & short words
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_\-./\\]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopwords.has(w) && !/^[0-9]+$/.test(w));

  // Deduplicate
  return [...new Set(words)];
}

/**
 * Extract project-specific keywords from a path string.
 * Returns directory names, filenames (without extension), framework names.
 */
function extractProjectKeywords(text: string): string[] {
  const keywords: string[] = [];

  // Extract file paths (e.g., src/lib/foo.ts)
  const paths = text.match(/[a-zA-Z0-9_\-./]+\.[a-zA-Z]+/g) || [];
  for (const p of paths) {
    const parts = p.replace(/\\/g, "/").split("/");
    // Add directory names
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i].length > 2) keywords.push(parts[i]);
    }
    // Add filename without extension
    const name = parts[parts.length - 1].replace(/\.[^.]+$/, "");
    if (name.length > 2) keywords.push(name.toLowerCase());
  }

  // Extract camelCase/PascalCase identifiers (function names, class names)
  const identifiers = text.match(/[a-z][a-zA-Z0-9]{2,}|[A-Z][a-z]{2,}[a-zA-Z0-9]*/g) || [];
  for (const id of identifiers) {
    if (id.length > 2) keywords.push(id.toLowerCase());
  }

  return [...new Set(keywords)];
}

// ── Similarity Scoring ──────────────────────────────────────────────────────

/**
 * Compute a simple keyword-overlap similarity between query keywords
 * and an episode's task description.
 *
 * Uses Jaccard similarity on keyword sets.
 */
function computeSimilarity(queryKeywords: string[], episodeTask: string): number {
  if (queryKeywords.length === 0 || !episodeTask) return 0;

  const episodeWords = episodeTask
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const episodeSet = new Set(episodeWords);
  let matches = 0;

  for (const kw of queryKeywords) {
    // Direct match
    if (episodeSet.has(kw)) {
      matches += 2; // Direct keyword match is strong signal
      continue;
    }
    // Substring match (e.g., "debounce" matches "debounce function")
    for (const ew of episodeWords) {
      if (ew.includes(kw) || kw.includes(ew)) {
        matches += 1;
        break;
      }
    }
  }

  const union = queryKeywords.length + episodeSet.size;
  return union > 0 ? matches / union : 0;
}

// ── SOP Retrieval ──────────────────────────────────────────────────────────

/**
 * Query episodic memory for episodes relevant to the current task.
 * Returns episodes sorted by similarity, with computed scores.
 */
export function retrieveRelevantSOPs(
  userMessage: string,
  episodes: Episode[],
  config: SopSuggestionConfig = DEFAULT_SOP_CONFIG,
): RetrievedSop[] {
  if (!config.enabled || episodes.length === 0) return [];

  // Extract keywords
  const keywords = extractKeywords(userMessage);
  const projectKeywords = extractProjectKeywords(userMessage);
  const allKeywords = [...new Set([...projectKeywords, ...keywords])];

  if (allKeywords.length === 0) return [];

  // Score episodes
  const scored: RetrievedSop[] = [];
  for (const ep of episodes) {
    const similarity = computeSimilarity(allKeywords, ep.task);

    if (similarity < config.minSimilarity) continue;

    scored.push({
      episode: ep,
      similarity,
      strategicSOP: ep.strategicSOP,
      functionalSOPs: ep.functionalSOP || [],
      matchedKeywords: allKeywords.slice(0, 5),
    });
  }

  // Sort by similarity descending, take top N
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, config.maxSuggestionsPerTurn);
}

// ── Suggestion Injection ────────────────────────────────────────────────────

/**
 * Format a retrieved SOP as a whisper hint message.
 * Keeps the text concise to avoid polluting context.
 */
function formatSopSuggestion(retrieved: RetrievedSop, maxTokens: number): string {
  const ep = retrieved.episode;
  const lines: string[] = [];

  lines.push("## ⚡ Relevant past experience");

  // Task context
  lines.push(`**Task**: ${ep.task}`);
  lines.push(`**Outcome**: ${ep.outcome}`);
  lines.push(`**Similarity**: ${Math.round(ep.similarity * 100)}%`);

  // Strategic SOP
  if (retrieved.strategicSOP) {
    lines.push("");
    lines.push(`**Strategy**: ${retrieved.strategicSOP.slice(0, 200)}`);
  }

  // Functional SOP (key steps)
  if (retrieved.functionalSOPs.length > 0) {
    lines.push("");
    lines.push("**Approach**:");
    // Only include top functional steps (first 3 max)
    const steps = retrieved.functionalSOPs.slice(0, 3);
    for (const step of steps) {
      lines.push(`  ${step.slice(0, 100)}`);
    }
  }

  // Similarity hint
  lines.push("");
  const pct = Math.round(retrieved.similarity * 100);
  lines.push(`_(matched ${pct}% similarity to current task)_`);

  const text = lines.join("\n");

  // Truncate to token limit
  if (text.length > maxTokens * 4) {
    return text.slice(0, maxTokens * 4) + "\n... _(truncated)_";
  }
  return text;
}

/**
 * Inject SOP suggestions into the agent's context via whisper.
 * Should be called on turn_start before the agent processes the user message.
 */
export function injectSopSuggestions(
  pi: any,
  userMessage: string,
  episodes: Episode[],
  config: SopSuggestionConfig = DEFAULT_SOP_CONFIG,
  alreadySuggestedIds?: Set<string>,
): number {
  if (!config.enabled) return 0;

  const retrieved = retrieveRelevantSOPs(userMessage, episodes, config);
  if (retrieved.length === 0) return 0;

  let totalTokens = 0;
  let injected = 0;

  for (const r of retrieved) {
    // Skip if already suggested this session
    if (alreadySuggestedIds && r.episode.id && alreadySuggestedIds.has(r.episode.id)) continue;

    const formatted = formatSopSuggestion(r, Math.floor(config.maxTotalTokens / retrieved.length));
    const estimatedTokens = Math.ceil(formatted.length / 4);

    if (totalTokens + estimatedTokens > config.maxTotalTokens) break;

    sendTrackedMessage(
      pi,
      {
        customType: "context",
        content: [{ type: "text" as const, text: formatted }],
        display: true, // Whisper — NEVER HIDE from TUI
      },
      { deliverAs: "followUp", triggerTurn: false },
      { type: "context", source: "consolidation/sop-suggestion" },
    );

    totalTokens += estimatedTokens;
    injected++;
    if (alreadySuggestedIds && r.episode.id) {
      alreadySuggestedIds.add(r.episode.id);
    }
  }

  if (injected > 0) {
    log.info(
      `[sop-suggestion] Injected ${injected} SOP(s) (${totalTokens} tokens) ` +
        `for task: ${userMessage.slice(0, 60)}...`,
    );

    // Emit event for analytics
    try {
      eventBus.emit({
        type: "sop_suggestion_injected" as never,
        // @ts-expect-error — custom analytics payload
        details: { count: injected, tokens: totalTokens },
      });
    } catch (err) {
      log.warn(`[sop-suggestion] Could not emit sop_suggestion_injected event: ${err}`);
    }
  }

  return injected;
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

export function getSopSuggestionStatus(): string {
  const lines: string[] = [];
  lines.push("=== SOP Suggestion ===");
  lines.push(`Enabled: ${DEFAULT_SOP_CONFIG.enabled}`);
  lines.push(`Max per turn: ${DEFAULT_SOP_CONFIG.maxSuggestionsPerTurn}`);
  lines.push(`Min similarity: ${DEFAULT_SOP_CONFIG.minSimilarity}`);
  return lines.join("\n");
}
