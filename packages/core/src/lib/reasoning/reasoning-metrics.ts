/**
 * Lightweight Reasoning Stability Metrics
 *
 * Approximates reasoning quality WITHOUT logprobs or model internals.
 * Based on: MEASUREMENT_GAP_SOLUTION.md
 *
 * Three metrics:
 * 1. Topic anchor overlap - did the response stay on topic?
 * 2. Bigram entropy - is output repetitive (overconfident) or chaotic (uncertain)?
 * 3. Self-contradiction - did the response contradict itself?
 *
 * Usage:
 * ```ts
 * const result = measureStability(userRequest, agentResponse);
 * if (!result.stable) sendEnforcementWhisper(result.reason);
 * ```
 */

import { isStopWord, tokenize } from "../utils/tokenize.js";

/** Reasons a response can fail the stability check. Source of truth for downstream consumers. */
export type StabilityReason = "ok" | "repetitive" | "topic_drift" | "self_contradiction";

/** Check if a response is reasoning-stable relative to a request */
export function measureStability(
  request: string,
  response: string,
): { stable: boolean; reason: StabilityReason; metrics: StabilityMetrics } {
  const anchors = extractAnchors(request);
  const overlap = anchors.size > 0 ? measureOverlap(response, anchors) : 1.0;
  const entropy = measureBigramEntropy(response);
  const contradictions = countSelfContradictions(response);

  const metrics: StabilityMetrics = { overlap, entropy, contradictions };

  // Thresholds (conservative - warn-only, never block)
  // Entropy check first: repetitive is stronger signal than topic drift
  if (entropy < 0.15) {
    return { stable: false, reason: "repetitive", metrics };
  }
  if (anchors.size > 0 && overlap < 0.15) {
    return { stable: false, reason: "topic_drift", metrics };
  }
  if (contradictions > 2) {
    return { stable: false, reason: "self_contradiction", metrics };
  }

  return { stable: true, reason: "ok", metrics };
}

export interface StabilityMetrics {
  /** Topic anchor overlap (0-1). Low = response drifted from request */
  overlap: number;
  /** Bigram diversity (0-1). Low = repetitive, high = chaotic */
  entropy: number;
  /** Count of detected self-contradictions */
  contradictions: number;
}

/**
 * The words an anchor is not: the request's own function words. Membership is
 * this list's own (it is not the memory read path's list), and the length floor
 * of four characters below is what makes most of them moot.
 *
 * Scope: Latin script. This set is the English list passed to `isStopWord`
 * (lib/utils/tokenize), which answers for the token's own script.
 */
const ANCHOR_STOP_WORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "that",
  "this",
  "with",
  "from",
  "your",
  "have",
  "more",
  "are",
  "was",
  "will",
  "can",
  "for",
  "not",
  "but",
  "they",
  "you",
  "all",
  "get",
  "has",
  "how",
  "its",
  "may",
  "new",
  "now",
  "see",
  "who",
  "did",
  "she",
  "use",
  "our",
  "out",
  "any",
  "just",
  "like",
  "then",
  "also",
  "into",
  "very",
  "what",
  "when",
  "where",
  "which",
  "would",
  "could",
  "should",
  "about",
  "been",
  "being",
  "some",
  "than",
  "them",
  "there",
  "these",
  "those",
  "want",
  "make",
  "made",
  "after",
  "before",
  "between",
  "each",
]);

/**
 * Extract topic anchors (significant words) from text.
 *
 * The split is the shared tokenizer's, and the three functions below all take
 * it together: they are one comparison. While `extractAnchors` split on `\W`
 * and `measureOverlap` did too, a non-Latin request and a non-Latin response
 * both produced no tokens, so the overlap of two empty sets was reported as a
 * stable answer instead of an unmeasurable one.
 */
export function extractAnchors(text: string): Set<string> {
  const tokens = tokenize(text);
  return new Set(tokens.filter((t) => t.length > 3 && !isStopWord(t, ANCHOR_STOP_WORDS)));
}

/** Measure word overlap between text and anchors */
export function measureOverlap(text: string, anchors: Set<string>): number {
  if (anchors.size === 0) return 1.0;
  const tokens = new Set(tokenize(text));
  let matches = 0;
  for (const a of anchors) {
    if (tokens.has(a)) matches++;
  }
  return matches / anchors.size;
}

/** Measure bigram entropy (diversity) of text */
export function measureBigramEntropy(text: string): number {
  const words = tokenize(text);
  if (words.length < 2) return 1.0;

  const bigrams: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.push(`${words[i]} ${words[i + 1]}`);
  }

  const freq = new Map<string, number>();
  for (const bg of bigrams) {
    freq.set(bg, (freq.get(bg) || 0) + 1);
  }

  return freq.size / bigrams.length; // Unique ratio: 1.0 = all unique, 0.0 = all same
}

/** Count self-contradictions in text (negation pattern detection) */
export function countSelfContradictions(text: string): number {
  const sentences = text
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
  let contradictions = 0;

  // Simple heuristic: look for "X is Y" and "X is not Y" or "X will" / "X won't"
  const claims = new Map<string, string[]>();

  for (const sentence of sentences) {
    // Extract "A is B" patterns
    const isMatch = sentence.match(
      /^(\w[\w\s]{2,30}?)\s+(?:is|are|was|were|will|can|should|would)\s+(not\s+)?(.{3,40})$/i,
    );
    if (isMatch) {
      const subject = isMatch[1].trim().toLowerCase();
      const negated = isMatch[2] ? "not_" : "";
      const claim = negated + isMatch[3].trim().toLowerCase();
      if (!claims.has(subject)) claims.set(subject, []);
      claims.get(subject)?.push(claim);
    }
  }

  // Check for contradictions: same subject, opposite claims
  for (const [, claimList] of claims) {
    for (let i = 0; i < claimList.length; i++) {
      for (let j = i + 1; j < claimList.length; j++) {
        const a = claimList[i];
        const b = claimList[j];
        // Direct negation: "not_X" vs "X"
        if (a === "not_" + b || "not_" + a === b) {
          contradictions++;
        }
      }
    }
  }

  return contradictions;
}
