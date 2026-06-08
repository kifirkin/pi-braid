/**
 * Critic Helpers — shared utilities used by critic definitions in
 * critic-registry.ts.
 *
 * Extracted from critic-registry.ts to keep that file focused on
 * the CRITICS object (the prompt definitions themselves).
 *
 * Contains:
 *  - ENTITY_VERBS: shared verb-extraction regex (used by entity-detection fallback)
 *  - STOP_WORDS_LEGACY: shared stop-word list (used by normalizeText)
 *  - criticLabel: lookup helper to get a critic's human-readable label
 */

import { CRITICS } from "./critic-registry.js";

/** Shared verb-extraction regex used by entity-extraction heuristic fallback. */
export const ENTITY_VERBS = /\b(is|was|will|can|does|has|should|must|returns|takes|uses|creates|handles|supports|needs|exports|works|fails|validates|initializes|configures|implements|generates|deploys)\b/i;

export const STOP_WORDS_LEGACY = new Set([
  "the",
  "a",
  "an",
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
  "could",
  "should",
  "may",
  "might",
  "must",
  "shall",
  "can",
  "need",
  "dare",
  "that",
  "this",
  "these",
  "those",
  "what",
  "which",
  "who",
  "whom",
  "with",
  "without",
  "from",
  "into",
  "onto",
  "in",
  "out",
  "on",
  "off",
  "over",
  "under",
  "above",
  "below",
  "to",
  "for",
  "of",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "when",
  "where",
  "how",
  "why",
  "not",
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
  "nor",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "also",
  "now",
  "here",
  "there",
  "then",
  "implement",
  "add",
  "create",
  "build",
  "make",
  "write",
  "fix",
  "update",
  "day",
  "boy",
]);

/**
 * Return the human-readable label for a critic, if available.
 * Only works for CriticDef entries (not fallback functions).
 */
export function criticLabel(key: string): string | undefined {
  const entry = (CRITICS as Record<string, unknown>)[key];
  if (entry && typeof entry === "object" && "label" in entry) {
    return (entry as { label?: string }).label;
  }
  return undefined;
}
