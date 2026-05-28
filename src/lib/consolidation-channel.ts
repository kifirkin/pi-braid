/**
 * Experience Consolidation Queue
 *
 * Infrastructure for selecting, scoring, and scheduling experiences
 * for consolidation from episodic memory into reusable patterns.
 *
 * Scoring is heuristic (quality × value × confidence × novelty).
 * Weight update (LoRA/MEMIT) is not implemented — this queues experience
 * data for potential future training pipelines.
 */

import { createLogger } from "./core/logger.js";
import { CONSOLIDATED_HINTS_FILE } from "./config/braid-paths.js";
import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { extractSOP } from "./sop-extractor.js";
import { CRITICS } from "./critic-registry.js";

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

// ── Global Queue Instance ──────────────────────────────────────────────────

const _queue = new ConsolidationQueue();

/** @internal Used by processConsolidationTick */
function getConsolidationQueue(): ConsolidationQueue {
  return _queue;
}

/**
 * Enqueue a scored consolidation candidate for deferred processing.
 * Returns true if enqueued, false if queue full or duplicate.
 */
export function enqueueCandidate(candidate: ConsolidationCandidate): boolean {
  return getConsolidationQueue().enqueue(candidate);
}

// ── SOP Extraction Integration ────────────────────────────────────────────

/**
 * Execute full consolidation pipeline: extract SOP via sop-extractor,
 * score the episode, enqueue for deferred hint writing.
 *
 * This bridges heartbeat episode retrieval with the consolidation queue.
 * The actual hint file write happens asynchronously via processConsolidationTick.
 */
export function executeConsolidation(episode: {
  id: string;
  task: string;
  outcome: "success" | "failure" | "partial";
  project?: string;
  quality?: number;
  trajectory?: { toolName: string; success: boolean; error?: string }[];
  solution?: string;
  strategicSOP?: string;
  functionalSOP?: string[];
  toolSequence?: string[];
}): ConsolidationCandidate | null {
  // Step 1: Extract SOP via sop-extractor if not pre-populated
  let strategicSOP = episode.strategicSOP;
  let functionalSOP = episode.functionalSOP;
  let toolSequence = episode.toolSequence;

  if ((!strategicSOP || !functionalSOP) && episode.trajectory && episode.trajectory.length > 0) {
    try {
      const sop = extractSOP({
        task: episode.task,
        trajectory: episode.trajectory.map((t) => ({
          toolName: t.toolName,
          success: t.success,
          error: t.error,
        })),
        solution: episode.solution ?? `Outcome: ${episode.outcome}`,
        outcome: episode.outcome,
      });
      strategicSOP = sop.strategicSOP;
      functionalSOP = sop.functionalSOP;
      toolSequence = sop.atomicSOP;
      log.info(
        `[consolidation] Extracted SOP for "${episode.task.slice(0, 60)}": ` +
          `${functionalSOP.length} steps, ${toolSequence.length} tools`,
      );
    } catch (err) {
      log.warn(`[consolidation] SOP extraction failed: ${(err as Error).message}`);
    }
  }

  // Step 2: Score the episode with available SOP data
  const candidate = scoreEpisode({
    id: episode.id,
    task: episode.task,
    outcome: episode.outcome,
    project: episode.project,
    quality: episode.quality,
    toolSequence: toolSequence ?? episode.trajectory?.map((t) => t.toolName),
    strategicSOP,
    functionalSOP,
  });

  // Step 3: Enqueue if above quality threshold
  if (candidate.consolidationScore >= DEFAULT_CONSOLIDATION_CONFIG.minQuality) {
    enqueueCandidate(candidate);
    log.info(
      `[consolidation] Enqueued "${episode.task.slice(0, 50)}" ` +
        `(score=${candidate.consolidationScore.toFixed(2)})`,
    );
    return candidate;
  }

  log.debug(
    `[consolidation] Skipped "${episode.task.slice(0, 50)}" ` +
      `(score=${candidate.consolidationScore.toFixed(2)} < min=${DEFAULT_CONSOLIDATION_CONFIG.minQuality})`,
  );
  return null;
}

// ── Hint Quality Filter (triple-critic) ──────────────────────────────────────

/**
 * Check whether a hint's steps are too generic to provide value.
 *
 * Uses the triple-critic system via CRITICS.hintQualityFallback for the
 * sync path (heartbeat tick). The heuristic regex logic (previously inline
 * as GENERIC_STEP_PATTERNS + GENERIC_DEBUG_TRIAD) is now consolidated in
 * critic-registry.ts.
 *
 * For async contexts with ExtensionContext, use assessHintQuality() instead,
 * which calls classify() with CRITICS.hintQuality for three-tier fallback.
 *
 * Replaces 14 inline regex patterns that detected debugging clichés.
 */
function isHintTooGeneric(task: string, steps: string[]): boolean {
  return CRITICS.hintQualityFallback(task, steps) === "no";
}

// ── Heartbeat Integration ──────────────────────────────────────────────────

/**
 * Process consolidation queue on heartbeat tick.
 * Called by heartbeat scheduler on each tick.
 */
export async function processConsolidationTick(): Promise<void> {
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
      await mkdir(dirname(CONSOLIDATED_HINTS_FILE), { recursive: true });

      // Prune: keep only recent, non-stale hints (max 20, under 30 days old)
      const MAX_HINTS = 20;
      const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
      try {
        const existing = await readFile(CONSOLIDATED_HINTS_FILE, "utf-8");
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
          await writeFile(
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
      // Migrated from sync I/O to async fs/promises
      try {
        let existingContent = "";
        try {
          existingContent = await readFile(CONSOLIDATED_HINTS_FILE, "utf-8");
        } catch {
          // File doesn't exist yet
        }
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
        await writeFile(CONSOLIDATED_HINTS_FILE, allLines.join("\n") + "\n");
      } catch (writeErr) {
        log.warn(`Hint append failed: ${(writeErr as Error).message}`);
      }
    } catch (err) {
      log.warn(`Hint write failed: ${(err as Error).message}`);
    }
  }

  queue.complete(candidate);
}

// ═════════════════════════════════════════════════════════════════════════
// OpenSpec archive ingestion (Phase 3)
// ═════════════════════════════════════════════════════════════════════════

export interface ArchiveCandidate {
  changeName: string;
  archivePath: string;
  hasProposal: boolean;
  hasDesign: boolean;
  specCount: number;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan openspec/changes/archive/ for new archives not yet ingested.
 * Returns candidates for ingestion into the consolidation queue.
 */
export async function scanArchives(projectRoot: string): Promise<ArchiveCandidate[]> {
  const archiveDir = join(projectRoot, "openspec", "changes", "archive");
  if (!(await pathExists(archiveDir))) return [];

  const candidates: ArchiveCandidate[] = [];
  try {
    const entries = await readdir(archiveDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const changePath = join(archiveDir, entry.name);
      candidates.push({
        changeName: entry.name,
        archivePath: changePath,
        hasProposal: await pathExists(join(changePath, "proposal.md")),
        hasDesign: await pathExists(join(changePath, "design.md")),
        specCount: await countSpecs(changePath),
      });
    }
  } catch (err) {
    log.warn(`Failed to scan archives: ${(err as Error).message}`);
  }

  return candidates;
}

async function countSpecs(dir: string): Promise<number> {
  const specsDir = join(dir, "specs");
  if (!(await pathExists(specsDir))) return 0;
  let count = 0;
  try {
    const walk = async (d: string): Promise<void> => {
      const entries = await readdir(d, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) await walk(join(d, e.name));
        else if (e.name.endsWith(".md")) count++;
      }
    };
    await walk(specsDir);
  } catch {
    // skip
  }
  return count;
}
