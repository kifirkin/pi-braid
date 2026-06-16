/**
 * Consolidation scoring engine.
 *
 * Extracted from consolidation-channel.ts (was 73 lines inline).
 *
 * Each candidate gets a composite score that determines whether it
 * gets promoted from "pending" to "in-progress" and ultimately
 * persisted as an episode. The score combines:
 *   - value (40%): outcome quality + tool diversity
 *   - confidence (30%): SOP completeness
 *   - novelty (30%): recent similar-candidate penalty
 *
 * Pure functions, no side effects. The channel itself owns the
 * queue, dedup, and persistence.
 */

import type { ConsolidationCandidate } from "./consolidation-channel.js";

/**
 * Compute the value score (0-1) for a candidate based on its
 * outcome, quality, and tool diversity.
 *
 *   - success: +0.5 base
 *   - partial: +0.2 base
 *   - failure: 0 base
 *   - quality bonus: 0-0.3 (linear)
 *   - tool diversity bonus: 0-0.2 (capped at 10 unique tools)
 */
export function computeValue(outcome: string, quality?: number, toolSequence?: string[]): number {
  let value = 0;

  // Outcome-based value
  if (outcome === "success") value += 0.5;
  else if (outcome === "partial") value += 0.2;

  // Quality bonus
  if (quality) value += quality * 0.3;

  // Tool diversity bonus (more diverse = more valuable)
  const uniqueTools = new Set(toolSequence || []);
  const diversity = Math.min(1, uniqueTools.size / 10);
  value += diversity * 0.2;

  return Math.min(1, value);
}

/**
 * Compute the confidence score (0-1) for a candidate based on
 * its SOP (Standard Operating Procedure) completeness.
 *
 *   - base: 0.3
 *   - strategic SOP present: +0.2
 *   - functional SOP: +0.1 each, capped at 0.5
 *   - cap: 1.0
 */
export function computeConfidence(strategicSOP?: string, functionalSOP?: string[]): number {
  let confidence = 0.3; // Base

  // SOP completeness: strategic + functional = higher confidence
  if (strategicSOP) confidence += 0.2;
  if (functionalSOP && functionalSOP.length > 0) {
    confidence += Math.min(0.5, functionalSOP.length * 0.1);
  }

  return Math.min(1, confidence);
}

/**
 * Compute the novelty score (0-1) for a candidate.
 *
 * Currently returns a constant 0.5. The "novelty" dimension was
 * originally meant to penalize recent similar candidates, but that
 * tracking was never wired in. The placeholder remains so the
 * composite-score shape doesn't change.
 */
export function computeNovelty(): number {
  return 0.5;
}

/**
 * Score a candidate episode end-to-end. Returns the full
 * ConsolidationCandidate with value, confidence, novelty, and
 * composite scores.
 */
export function scoreEpisode(episode: {
  id: string;
  task: string;
  outcome: "success" | "failure" | "partial";
  project?: string;
  quality?: number;
  toolSequence?: string[];
  strategicSOP?: string;
  functionalSOP?: string[];
}): ConsolidationCandidate {
  const valueScore = computeValue(episode.outcome, episode.quality, episode.toolSequence);
  const confidenceScore = computeConfidence(episode.strategicSOP, episode.functionalSOP);
  const noveltyScore = computeNovelty();
  const consolidationScore = valueScore * 0.4 + confidenceScore * 0.3 + noveltyScore * 0.3;

  return {
    episodeId: episode.id,
    task: episode.task,
    outcome: episode.outcome,
    project: episode.project,
    strategicSOP: episode.strategicSOP,
    functionalSOP: episode.functionalSOP,
    quality: episode.quality ?? 0,
    valueScore,
    confidenceScore,
    noveltyScore,
    consolidationScore,
    queuedAt: Date.now(),
    status: "pending",
  };
}
