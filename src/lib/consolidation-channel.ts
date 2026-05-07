/**
 * Consolidation Channel — Phase 3 Self-Evolution
 *
 * Infrastructure for selecting, scoring, and scheduling experiences
 * for consolidation from episodic memory to experiential memory.
 *
 * Based on: Contextual Agentic Memory (2604.27707), MARS (2601.11974)
 *
 * Architecture:
 *   Experience → Episodic Store (memory_store)
 *                   ↓
 *            [Consolidation Channel]
 *                   ↓
 *            Selection → Scoring → Queue → Scheduling
 *                   ↓
 *            Weight Update (LoRA/MEMIT — future)
 */

import { createLogger } from "./logger.js";
import { eventBus } from "./event-bus.js";

const log = createLogger("consolidation");

// ── Types ──────────────────────────────────────────────────────────────────

export interface ConsolidationCandidate {
  /** Episode ID from three-memory-stores */
  episodeId: string;
  /** Task that was solved */
  task: string;
  /** Outcome of the episode */
  outcome: "success" | "failure" | "partial";
  /** Strategic SOP (high-level strategy) */
  strategicSOP?: string;
  /** Functional SOP (mid-level steps) */
  functionalSOP?: string[];
  /** Quality score 0-1 */
  quality: number;
  /** Value score 0-1: how valuable is this experience? */
  valueScore: number;
  /** Confidence score 0-1: how reliable is the SOP? */
  confidenceScore: number;
  /** Novelty score 0-1: how different from existing patterns? */
  noveltyScore: number;
  /** Composite consolidation score 0-1 */
  consolidationScore: number;
  /** When this was queued */
  queuedAt: number;
  /** Status */
  status: "pending" | "consolidating" | "completed" | "skipped";
}

export interface ConsolidationConfig {
  /** Minimum quality for consideration */
  minQuality: number;
  /** Minimum value score for selection */
  minValueScore: number;
  /** Minimum confidence for selection */
  minConfidence: number;
  /** Maximum candidates to queue per tick */
  maxCandidatesPerTick: number;
  /** Maximum queue size */
  maxQueueSize: number;
  /** Heartbeat interval between consolidations (turns) */
  consolidationInterval: number;
  /** Enable auto-consolidation */
  enabled: boolean;
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  minQuality: 0.5,
  minValueScore: 0.6,
  minConfidence: 0.7,
  maxCandidatesPerTick: 3,
  maxQueueSize: 50,
  consolidationInterval: 20,
  enabled: true,
};

// ── Consolidation Queue ─────────────────────────────────────────────────────

class ConsolidationQueue {
  private queue: ConsolidationCandidate[] = [];
  private history: ConsolidationCandidate[] = [];

  enqueue(candidate: ConsolidationCandidate): boolean {
    if (this.queue.length >= DEFAULT_CONSOLIDATION_CONFIG.maxQueueSize) {
      return false;
    }
    // Avoid duplicates
    if (this.queue.some((c) => c.episodeId === candidate.episodeId)) {
      return false;
    }
    this.queue.push(candidate);
    return true;
  }

  dequeue(): ConsolidationCandidate | undefined {
    return this.queue.shift();
  }

  peek(): ConsolidationCandidate | undefined {
    return this.queue[0];
  }

  get size(): number {
    return this.queue.length;
  }

  get all(): ConsolidationCandidate[] {
    return [...this.queue];
  }

  complete(candidate: ConsolidationCandidate): void {
    candidate.status = "completed";
    this.history.push(candidate);
  }

  skip(candidate: ConsolidationCandidate): void {
    candidate.status = "skipped";
    this.history.push(candidate);
  }

  get completedCount(): number {
    return this.history.filter((c) => c.status === "completed").length;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue = [];
  }
}

// ── Scoring Engine ─────────────────────────────────────────────────────────

function computeValue(outcome: string, quality?: number, toolSequence?: string[]): number {
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

function computeConfidence(strategicSOP?: string, functionalSOP?: string[]): number {
  let confidence = 0.3; // Base

  // SOP completeness: strategic + functional = higher confidence
  if (strategicSOP) confidence += 0.2;
  if (functionalSOP && functionalSOP.length > 0) {
    confidence += Math.min(0.5, functionalSOP.length * 0.1);
  }

  return Math.min(1, confidence);
}

function computeNovelty(): number {
  // Placeholder: in full implementation, compare against existing
  // consolidated patterns. For now return moderate novelty.
  return 0.5;
}

/**
 * Score a single episode for consolidation worthiness.
 */
export function scoreEpisode(episode: {
  id: string;
  task: string;
  outcome: "success" | "failure" | "partial";
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

/**
 * Select the best episodes for consolidation from a list.
 */
export function selectCandidates(
  episodes: Array<{
    id: string;
    task: string;
    outcome: "success" | "failure" | "partial";
    quality?: number;
    toolSequence?: string[];
    strategicSOP?: string;
    functionalSOP?: string[];
  }>,
  config: ConsolidationConfig = DEFAULT_CONSOLIDATION_CONFIG,
): ConsolidationCandidate[] {
  return episodes
    .map(scoreEpisode)
    .filter(
      (c) =>
        c.quality >= config.minQuality &&
        c.valueScore >= config.minValueScore &&
        c.confidenceScore >= config.minConfidence,
    )
    .sort((a, b) => b.consolidationScore - a.consolidationScore)
    .slice(0, config.maxCandidatesPerTick);
}

/**
 * Get the best episode for consolidation from a list.
 */
export function selectBestCandidate(
  episodes: Array<{
    id: string;
    task: string;
    outcome: "success" | "failure" | "partial";
    quality?: number;
    toolSequence?: string[];
    strategicSOP?: string;
    functionalSOP?: string[];
  }>,
  config?: ConsolidationConfig,
): ConsolidationCandidate | null {
  const candidates = selectCandidates(episodes, config);
  return candidates[0] ?? null;
}

// ── Global Queue Instance ──────────────────────────────────────────────────

const _queue = new ConsolidationQueue();

export function getConsolidationQueue(): ConsolidationQueue {
  return _queue;
}

// ── Heartbeat Integration ──────────────────────────────────────────────────

/**
 * Process consolidation queue on heartbeat tick.
 * Called by heartbeat scheduler on each tick.
 */
export function processConsolidationTick(): void {
  if (!DEFAULT_CONSOLIDATION_CONFIG.enabled) return;

  const queue = getConsolidationQueue();

  // Try to consolidate one candidate per tick
  const candidate = queue.dequeue();
  if (!candidate) return;

  log.info(
    `[consolidation] Processing candidate: ${candidate.task} ` +
      `(value=${candidate.valueScore.toFixed(2)}, ` +
      `confidence=${candidate.confidenceScore.toFixed(2)})`,
  );

  // For now, just mark as completed (weight update is future work)
  queue.complete(candidate);
}

/**
 * Add episodes to the consolidation queue.
 */
export function queueForConsolidation(
  episodes: Array<{
    id: string;
    task: string;
    outcome: "success" | "failure" | "partial";
    quality?: number;
    toolSequence?: string[];
    strategicSOP?: string;
    functionalSOP?: string[];
  }>,
): { enqueued: number; skipped: number } {
  const config = DEFAULT_CONSOLIDATION_CONFIG;
  const candidates = selectCandidates(episodes, config);
  const queue = getConsolidationQueue();
  let enqueued = 0;

  for (const candidate of candidates) {
    if (queue.enqueue(candidate)) enqueued++;
  }

  log.info(
    `[consolidation] Queued ${enqueued}/${candidates.length} ` + `(queue size: ${queue.size})`,
  );

  return { enqueued, skipped: candidates.length - enqueued };
}

// ── Diagnostics ────────────────────────────────────────────────────────────

/**
 * Get consolidation channel diagnostics.
 */
export function getConsolidationStatus(): string {
  const queue = getConsolidationQueue();
  const lines: string[] = [];

  lines.push("=== Consolidation Channel ===");
  lines.push(`Enabled: ${DEFAULT_CONSOLIDATION_CONFIG.enabled}`);
  lines.push(`Queue: ${queue.size} pending`);
  lines.push(`Completed: ${queue.completedCount}`);
  lines.push(
    `Config: minQuality=${DEFAULT_CONSOLIDATION_CONFIG.minQuality}, ` +
      `minValue=${DEFAULT_CONSOLIDATION_CONFIG.minValueScore}, ` +
      `minConfidence=${DEFAULT_CONSOLIDATION_CONFIG.minConfidence}`,
  );
  lines.push(`Interval: every ${DEFAULT_CONSOLIDATION_CONFIG.consolidationInterval} turns`);

  if (queue.size > 0) {
    lines.push("");
    lines.push("Top candidates:");
    for (const c of queue.all.slice(0, 3)) {
      lines.push(
        `  ${c.task}: score=${c.consolidationScore.toFixed(2)} ` +
          `(value=${c.valueScore.toFixed(2)}, conf=${c.confidenceScore.toFixed(2)})`,
      );
    }
  }

  return lines.join("\n");
}
