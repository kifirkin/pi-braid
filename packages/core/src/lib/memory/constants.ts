/**
 * Cognitive Memory - constants and configuration.
 */

import { SEMANTIC_MEMORY_FILE, MEMORY_DIR as BRAID_MEMORY_DIR } from "../config/braid-paths.js";
import type { CognitiveMemoryType } from "./types.js";

// Storage paths - consolidated under ~/.pi/agent/braid/memory/
// Precomputed read-side defaults: `os.homedir()` is folded once, at import.
// A caller that WRITES the store must resolve through the braid-paths
// accessors (semanticMemoryFilePath(), memoryDir()) so a relative or blank
// home refuses and BRAID_HOME pinning is honored — see lib/config/braid-paths.ts.
export const MEMORY_DIR = BRAID_MEMORY_DIR;
export const MEMORY_FILE = SEMANTIC_MEMORY_FILE;

// No legacy path constant here: that read resolves per call through
// braid-paths' legacyMemoryFilePath(), so a pinned braid home keeps its own
// predecessor instead of the default tree's store.

// Constraints
export const MAX_ENTRIES = 200;
export const MIN_UTILITY_THRESHOLD = 0.15;
export const CONSOLIDATION_INTERVAL = 5;

// ── Recall scoring ───────────────────────────────────────────────────────────

/**
 * Shortest token the matcher looks at. One- and two-character tokens carry no
 * topic in any language this store sees, and matching them turns a query into
 * a scan of nearly every entry.
 */
export const QUERY_MIN_TOKEN_LENGTH = 3;

/**
 * English function words, dropped from a query before matching. They name no
 * topic, and counting each as a full word match is what let a long entry
 * outrank a short quote that shared the question's actual subject.
 *
 * Generic vocabulary only. A word that names anything about this deployment,
 * its files, or its roles belongs to that owner, not in a shared matcher.
 */
export const QUERY_STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "about",
  "above",
  "across",
  "after",
  "against",
  "all",
  "along",
  "also",
  "am",
  "among",
  "an",
  "and",
  "another",
  "any",
  "are",
  "aren't",
  "around",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "behind",
  "being",
  "below",
  "beneath",
  "beside",
  "between",
  "beyond",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doesn't",
  "doing",
  "done",
  "don't",
  "during",
  "each",
  "either",
  "every",
  "except",
  "few",
  "for",
  "from",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "hers",
  "him",
  "his",
  "how",
  "however",
  "i",
  "if",
  "in",
  "inside",
  "into",
  "is",
  "isn't",
  "it",
  "its",
  "just",
  "many",
  "may",
  "me",
  "might",
  "mine",
  "more",
  "most",
  "much",
  "must",
  "my",
  "near",
  "neither",
  "no",
  "nor",
  "not",
  "of",
  "off",
  "on",
  "one",
  "only",
  "onto",
  "or",
  "other",
  "our",
  "ours",
  "out",
  "outside",
  "over",
  "own",
  "per",
  "same",
  "shall",
  "she",
  "should",
  "since",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "throughout",
  "till",
  "to",
  "too",
  "toward",
  "two",
  "under",
  "until",
  "up",
  "upon",
  "us",
  "very",
  "via",
  "was",
  "wasn't",
  "we",
  "were",
  "weren't",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "whose",
  "why",
  "will",
  "with",
  "within",
  "without",
  "would",
  "yet",
  "you",
  "your",
  "yours",
]);

/**
 * What a query-named tag is worth, in matched-word units: two ordinary terms.
 * The shipped matcher counted a word as 1 and a tag as 2, so 2 keeps the
 * shipped meaning now that a word's weight is a rarity weight instead.
 */
export const MEMORY_TAG_BONUS_WORDS = 2;

/**
 * Document-frequency fraction that fixes the "ordinary term" the weights are
 * expressed in: a token carried by this share of the store. At 0.5 the
 * reference weight is ln(1 + 1 / 0.5) = ln 3, and a tag is worth
 * MEMORY_TAG_BONUS_WORDS of those.
 */
export const MEMORY_REFERENCE_DF_FRACTION = 0.5;

/**
 * Defaults for `braid.memory.reservedProvenance`. The partition ships OFF:
 * which entries carry a provenance class is a property of the writer that
 * filed them, so the operator names it with a source prefix. An empty prefix
 * and a zero slot count both mean "no partition", leaving the prune as it was.
 */
export const RESERVED_PROVENANCE_DEFAULTS = { prefix: "", slots: 0 } as const;

export const CATEGORY_BASE_UTILITY: Record<CognitiveMemoryType, number> = {
  goal: 0.9,
  error: 0.8,
  pattern: 0.7,
  episodic: 0.6,
  insight: 0.6,
  semantic: 0.5,
  preference: 0.5,
  procedural: 0.5,
};
