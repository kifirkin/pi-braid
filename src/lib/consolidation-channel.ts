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
import { CONSOLIDATED_HINTS_FILE } from "./braid-paths.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const log = createLogger("consolidation");

// ── Types ──────────────────────────────────────────────────────────────────

export interface ConsolidationCandidate {
  /** Episode ID from three-memory-stores */
  episodeId: string;
  /** Task that was solved */
  task: string;
  /** Outcome of the episode */
  outcome: "success" | "failure" | "partial";
  /** Project identifier for cross-project filtering */
  project?: string;
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

/**
 * Select the best episodes for consolidation from a list.
 */
export function selectCandidates(
  episodes: Array<{
    id: string;
    task: string;
    outcome: "success" | "failure" | "partial";
    project?: string;
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
    project?: string;
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

// ── Hint Quality Filter ─────────────────────────────────────────────────────

/**
 * Patterns that indicate a hint is too generic to be useful.
 * These are debugging/development clichés that provide zero information value
 * when presented as behavioral hints across sessions.
 */
const GENERIC_STEP_PATTERNS = [
  /^reproduce\s*bug$/i,
  /^locate\s*root\s*cause$/i,
  /^apply\s*fix$/i,
  /^debug$/i,
  /^isolate\s*(issue|problem|component)?$/i,
  /^identify\s*(issue|problem|bug)?$/i,
  /^fix\s*(it|the\s*issue|the\s*problem|the\s*bug)?$/i,
  /^test\s*(the\s*fix|solution)?$/i,
  /^verify\s*(the\s*fix|solution)?$/i,
  /^check\s*(result|output|it)?$/i,
];

/** The classic three-step generic debugging cliché. */
const GENERIC_DEBUG_TRIAD = [/^reproduce\s*bug$/i, /^locate\s*root\s*cause$/i, /^apply\s*fix$/i];

/**
 * Check whether a hint's steps are too generic to provide value.
 * Rejects hints where all steps match known generic debugging patterns,
 * or where the classic "Reproduce → Locate → Apply" triad is detected.
 * Also rejects hints with fewer than 2 substantive (non-generic) steps.
 */
function isHintTooGeneric(task: string, steps: string[]): boolean {
  if (!steps || steps.length === 0) return true;

  // Check for the classic generic triad pattern (any variation)
  const stepTexts = steps.map((s) => s.trim().toLowerCase());
  let triadMatches = 0;
  for (const pattern of GENERIC_DEBUG_TRIAD) {
    if (stepTexts.some((s) => pattern.test(s))) triadMatches++;
  }
  if (triadMatches >= 3) return true;

  // Count how many steps are just generic patterns
  const genericCount = steps.filter((s) =>
    GENERIC_STEP_PATTERNS.some((p) => p.test(s.trim())),
  ).length;

  // If more than half the steps are generic clichés, reject
  if (genericCount >= steps.length * 0.5) return true;

  // Reject if task description is just a file-specific error fix
  if (
    /^(fix|resolve|address)\s+\w+\s+(error|issue|bug|warning)\s+in\s+\S+\.\w+$/i.test(task.trim())
  ) {
    return true;
  }

  return false;
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

  // Write high-confidence SOPs as behavioral hints for prompt injection.
  // This closes the self-evolution loop: successful patterns → persistent
  // hints → injected into future sessions → agent benefits from experience.
  // Cap at 20 hints, prune stale ones older than 30 days.
  // Quality gate: skip hints whose steps are generic debugging clichés.
  if (
    candidate.consolidationScore > 0.7 &&
    candidate.functionalSOP &&
    !isHintTooGeneric(candidate.task, candidate.functionalSOP)
  ) {
    try {
      mkdirSync(dirname(CONSOLIDATED_HINTS_FILE), { recursive: true });

      // Prune: keep only recent, non-stale hints (max 20, under 30 days old)
      const MAX_HINTS = 20;
      const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
      try {
        const existing = readFileSync(CONSOLIDATED_HINTS_FILE, "utf-8");
        const lines = existing.split("\n").filter((l) => l.trim());
        const now = Date.now();
        const fresh = lines
          .map((l) => JSON.parse(l))
          .filter((h) => now - (h.createdAt ?? 0) < MAX_AGE_MS);
        if (fresh.length >= MAX_HINTS) {
          // Keep the freshest MAX_HINTS-1 to make room for the new one
          const kept = fresh
            .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
            .slice(0, MAX_HINTS - 1);
          writeFileSync(
            CONSOLIDATED_HINTS_FILE,
            kept.map((h) => JSON.stringify(h)).join("\n") + "\n",
          );
        }
      } catch {
        // File doesn't exist yet — that's fine
      }

      const now = Date.now();
      const hint = {
        task: candidate.task,
        project: candidate.project ?? "unknown",
        strategy: candidate.strategicSOP,
        steps: candidate.functionalSOP.slice(0, 5),
        score: Math.round(candidate.consolidationScore * 100),
        source: "consolidation",
        createdAt: now,
      };
      // Use sync write to avoid race with concurrent ticks
      // (appendFile is async and could interleave with readFileSync above)
      try {
        const existingContent = existsSync(CONSOLIDATED_HINTS_FILE)
          ? readFileSync(CONSOLIDATED_HINTS_FILE, "utf-8")
          : "";
        const allLines = existingContent.split("\n").filter((l) => l.trim());
        // Deduplicate: replace existing entry with the same task, or append
        const taskKey = candidate.task;
        const replaced = allLines.some((line, i) => {
          try {
            const existing = JSON.parse(line);
            if (existing.task === taskKey) {
              allLines[i] = JSON.stringify(hint);
              return true;
            }
          } catch {
            // skip malformed lines
          }
          return false;
        });
        if (!replaced) {
          allLines.push(JSON.stringify(hint));
        }
        writeFileSync(CONSOLIDATED_HINTS_FILE, allLines.join("\n") + "\n");
      } catch (writeErr) {
        log.warn(`Hint append failed: ${(writeErr as Error).message}`);
      }
    } catch (err) {
      log.warn(`Hint write failed: ${(err as Error).message}`);
    }
  }

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
