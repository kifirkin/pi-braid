/**
 * Evidence Pool - Tracks knowledge from multiple sources with conflict detection.
 * Uses the triple-critic LLM classification system for evidence conflict
 * detection with three-tier fallback (heuristic -> utility -> session).
 *
 * XoT (Cross-observational Thinking) two-stage decomposition:
 *   Stage 1 - Evidence Explanation: classify conflicts via classify() + CRITICS.evidenceConflict
 *   Stage 2 - Faithful Reasoning: acknowledgment generation (formatConflictMessage)
 *
 * Flow:
 * 1. memory (recall_search), web search, docs reading, code execution -> addEvidence()
 * 2. tool_result -> addEvidence() (calibration tracking)
 * 3. message_end -> detectConflicts() (heuristic O(N^2) pre-filter) ->
 *    classifyConflictsWithLLM() (async triple-critic LLM re-classification)
 * 4. conflict-qa -> Stage 2: question generation + enforcement whisper
 *
 * Conflict detection is a two-phase process:
 *   Phase 1 (sync): O(N^2) token-overlap heuristic pre-filter + classifyConflict()
 *   Phase 2 (async): classifyConflictViaCritic() with classify() + CRITICS.evidenceConflict
 *     upgrades "implication" conflicts to "direct" when LLM detects a real contradiction.
 *
 * Replaces the previous implementation that maintained a local STOP_WORDS
 * copy (80+ words) and used raw token-overlap thresholds for conflict detection.
 * The stop-word list is now shared via import from critic-registry.ts, and
 * conflict classification uses the triple-critic system.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../state/extension-state.js";
import { STOP_WORDS, CRITICS } from "../ai/critic-registry.js";
import { classify } from "../ai/text-classifier.js";
import { nextId } from "../utils/id.js";
import { loadState, saveState } from "../state/async-storage.js";
import { EVIDENCE_POOL_FILE } from "../config/braid-paths.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("evidence-pool");

// ── Cross-session persistence ────────────────────────────────────────────────

let loadedFromDisk = false;

function loadFromDisk(ctx: ExtensionContext): void {
  if (loadedFromDisk) return;
  loadedFromDisk = true;
  loadState<EvidencePoolState>(EVIDENCE_POOL_FILE)
    .then((diskState) => {
      if (!diskState) return;
      const raw = getExtensionState(ctx, "evidence-pool", createEvidencePoolState);
      const state = raw as unknown as EvidencePoolState;
      // Merge: prefer in-memory evidence (current session) over disk
      // but keep unresolved conflicts from previous sessions.
      const existingIds = new Set(state.evidence.map((e) => e.id));
      for (const e of diskState.evidence) {
        if (!existingIds.has(e.id)) {
          state.evidence.push(e);
          existingIds.add(e.id);
        }
      }
      const existingConflictIds = new Set(state.conflicts.map((c) => c.id));
      for (const c of diskState.conflicts) {
        if (!existingConflictIds.has(c.id)) {
          state.conflicts.push(c);
          existingConflictIds.add(c.id);
        }
      }
      if (diskState.lastCleanup > state.lastCleanup) {
        state.lastCleanup = diskState.lastCleanup;
      }
    })
    .catch(() => {
      // File doesn't exist yet - first session, no persistence needed
    });
}

function persistState(state: EvidencePoolState): void {
  saveState(EVIDENCE_POOL_FILE, {
    evidence: state.evidence,
    conflicts: state.conflicts,
    lastCleanup: state.lastCleanup,
  });
}

// ── Types ────────────────────────────────────────────────────────────────────

export type EvidenceSource = "memory" | "web" | "docs" | "code" | "session" | "unknown";

/** How the confidence was derived - affects reliability weighting (XoT Stage 1) */
export type EvidenceConfidenceType = "parametric" | "retrieved" | "observed";

/** XoT Stage 1: Conflict classification */
export type ConflictClassification = "direct" | "implication" | "reliability";

/**
 * Source reliability baseline scores - prior probability that source is accurate.
 * Used as multiplicative factor when computing evidence reliability.
 */
const SOURCE_RELIABILITY: Record<EvidenceSource, number> = {
  code: 0.95, // Executed code is ground truth
  docs: 0.85, // Documentation is highly reliable
  memory: 0.7, // Memory is moderate reliability
  web: 0.6, // Web is variable quality
  session: 0.5, // Session knowledge may be outdated
  unknown: 0.4,
};

export interface Evidence {
  id: string;
  claim: string;
  normalized: string;
  content: string;
  source: EvidenceSource;
  confidence: number; // Caller-provided confidence (0-1)
  confidenceType: EvidenceConfidenceType;
  reliability: number; // Computed: SOURCE_RELIABILITY[source] x confidence
  /** Project path where this evidence was created. Used for provenance tagging (HaluMem, 2511.03506). */
  project: string;
  timestamp: number;
  turn?: number;
}

export interface Conflict {
  id: string;
  claim: string;
  for: Evidence[];
  against: Evidence[];
  verdict: "unresolved" | "resolved_for" | "resolved_against" | "uncertain";
  resolvedBy?: string;
  resolvedAt?: number;
  detectedAt: number;
  /** XoT Stage 1 result - how the conflict was classified */
  classification: ConflictClassification;
}

export interface EvidencePoolState {
  evidence: Evidence[];
  conflicts: Conflict[];
  lastCleanup: number;
  classifierStats: ConflictClassifierStats;
}

/**
 * Counters for the conflict-classifier's non-fatal failure paths. Each one is
 * a place where a failed LLM check falls back to the heuristic or skips a
 * pair; without the counters those paths are indistinguishable from a run
 * where every classification succeeded.
 */
export interface ConflictClassifierStats {
  /** classifyConflictViaCritic's classify() call threw and the heuristic took over. */
  llmFallbacks: number;
  /** One conflict in classifyConflictsWithLLM failed before classification finished. */
  reclassifyFailures: number;
  /** One candidate pair in detectSemanticConflicts failed its check. */
  semanticFailures: number;
  /** Message from the most recent recorded failure. */
  lastError: string | null;
}

// ── uniform conflicts cap ────────────────────────────────────────
//
// The conflicts array was capped ONLY inside detectConflicts() (20 -> 10);
// the detectConflictsFor (per-evidence) and detectSemanticConflicts paths
// pushed conflicts WITHOUT any cap — so conflicts (which hold Evidence
// references, keeping evicted evidence alive) grew unbounded on the most
// common path (every addEvidence call). This helper applies the SAME
// existing cap semantics after EVERY push path. Disk persistence (persist-)
// State) already mirrors the trimmed array, so disk and memory stay in step
// with the pre-existing cap semantics — no new persistence layer.

const CONFLICTS_CAP = 20;
const CONFLICTS_KEEP = 10;

function trimConflicts(state: EvidencePoolState): void {
  if (state.conflicts.length > CONFLICTS_CAP) {
    state.conflicts = state.conflicts.slice(-CONFLICTS_KEEP);
  }
}

// ── State factory ────────────────────────────────────────────────────────────

function createEvidencePoolState(): EvidencePoolState {
  return {
    evidence: [],
    conflicts: [],
    lastCleanup: Date.now(),
    classifierStats: {
      llmFallbacks: 0,
      reclassifyFailures: 0,
      semanticFailures: 0,
      lastError: null,
    },
  };
}

function getState(ctx: ExtensionContext): EvidencePoolState {
  loadFromDisk(ctx);
  return getExtensionState(ctx, "evidence-pool", createEvidencePoolState);
}

function recordClassifierFailure(
  state: EvidencePoolState,
  kind: "llmFallbacks" | "reclassifyFailures" | "semanticFailures",
  error: unknown,
  context: string,
): void {
  const message = error instanceof Error ? error.message : String(error);
  state.classifierStats[kind]++;
  state.classifierStats.lastError = message;
  log.warn(`[conflict-classifier] ${context}: ${message}`);
}

/**
 * Classifier degradation counters for this session. These are what make a
 * dark classifier tier distinguishable from a quiet one.
 */
export function getConflictClassifierStats(ctx: ExtensionContext): ConflictClassifierStats {
  return { ...getState(ctx).classifierStats };
}

// ── Normalization helpers (uses shared STOP_WORDS from critic-registry) ─

/** Normalize claim for comparison: lowercase, remove stopwords, sort words */
function normalize(text: string): string {
  const tokens = text
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
  return tokens.sort().join(" ");
}

/** Token overlap ratio between two texts. Exported for conflict-qa reuse. */
export function tokenOverlap(a: string, b: string): number {
  const tokensA = new Set(normalize(a).split(" "));
  const tokensB = new Set(normalize(b).split(" "));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let overlap = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) overlap++;
  }
  return overlap / Math.max(tokensA.size, tokensB.size);
}

/** Extract the core claim from text (first sentence, stripped) */
function extractClaim(text: string, maxLen = 80): string {
  const first = text.split(/[.!?\n]/)[0].trim();
  return first.length > maxLen ? first.slice(0, maxLen) + "..." : first;
}

// ── XoT Stage 1: Conflict Classification (triple-critic) ──────────────────────

/**
 * Classify a conflict using triple-critic LLM classification.
 * XoT Stage 1: Evidence Explanation.
 *
 * Three-tier fallback:
 *   Tier 1: evidenceConflictFallback (token overlap)
 *   Tier 2: utility model (if configured)
 *   Tier 3: session model (always available)
 */

/**
 * Classify a conflict using source reliability and claim overlap.
 * Kept for backward compatibility (sync callers).
 *
 * @deprecated Prefer classifyConflictViaCritic for async contexts with ExtensionContext.
 */
export function classifyConflict(
  forEvidence: Evidence[],
  againstEvidence: Evidence[],
): ConflictClassification {
  const forText = forEvidence.map((e) => e.normalized).join(" ");
  const againstText = againstEvidence.map((e) => e.normalized).join(" ");
  const overlap = tokenOverlap(forText, againstText);

  // Direct: High overlap between the claims (same topic being contradicted)
  if (overlap > 0.5) return "direct";

  // Reliability: Source reliability difference > 0.2
  const forReliability = forEvidence[0]?.reliability ?? 0.5;
  const againstReliability = againstEvidence[0]?.reliability ?? 0.5;
  if (Math.abs(forReliability - againstReliability) > 0.2) return "reliability";

  // Default: implication-based (one claim may logically contradict another)
  return "implication";
}

/**
 * Classify a conflict using the triple-critic LLM system.
 *
 * The async replacement for classifyConflict(). Uses classify() with
 * CRITICS.evidenceConflict to determine if two pieces of evidence
 * directly contradict each other. When the LLM says "yes", returns
 * "direct". When the LLM says "no" or is unavailable, falls back to
 * the heuristic classifyConflict() result.
 *
 * This is the function that the deprecated classifyConflict() JSDoc
 * tells callers to use -- it was referenced in a comment but never
 * implemented.
 */
export async function classifyConflictViaCritic(
  forEvidence: Evidence[],
  againstEvidence: Evidence[],
  ctx: ExtensionContext,
): Promise<ConflictClassification> {
  const evidenceA = forEvidence.map((e) => e.claim).join("; ");
  const evidenceB = againstEvidence.map((e) => e.claim).join("; ");

  try {
    const result = await classify(
      ctx,
      CRITICS.evidenceConflict.criteria,
      { evidenceA, evidenceB },
      {
        timeoutMs: 60_000,
        label: CRITICS.evidenceConflict.label,
        tierPolicy: "always-llm",
        modelPreference: "quality",
      },
    );

    if (result.label === "yes") return "direct";
  } catch (e) {
    // LLM failure -- fall through to heuristic, but leave a countable trace.
    recordClassifierFailure(getState(ctx), "llmFallbacks", e, "classify() threw; using heuristic");
  }

  return classifyConflict(forEvidence, againstEvidence);
}

/**
 * Re-classify all unresolved conflicts using the triple-critic LLM system.
 * Runs in the background -- does not block the caller. Conflicts where the
 * LLM detects a direct contradiction get upgraded from "implication" to
 * "direct".
 */
export async function classifyConflictsWithLLM(
  ctx: ExtensionContext,
  conflicts: Conflict[],
): Promise<void> {
  for (const conflict of conflicts) {
    if (conflict.verdict !== "unresolved") continue;
    if (conflict.classification === "direct") continue; // already classified

    try {
      const llmResult = await classifyConflictViaCritic(conflict.for, conflict.against, ctx);
      if (llmResult === "direct") {
        conflict.classification = llmResult;
      }
    } catch (e) {
      // Per-conflict errors are non-fatal, but they must not be silent: this
      // conflict was never re-classified.
      recordClassifierFailure(
        getState(ctx),
        "reclassifyFailures",
        e,
        `re-classification failed for conflict ${conflict.id}`,
      );
    }
  }
}

/**
 * Detect semantically similar evidence pairs missed by the heuristic
 * token-overlap pre-filter (< 0.3). Uses classify() with CRITICS.evidenceConflict
 * to check if evidence about the same topic (but different wording) contradicts.
 *
 * Limited to MAX_SEMANTIC_CHECKS_PER_TURN (10) per call. Only checks pairs with
 * overlap between SEMANTIC_OVERLAP_MIN (0.1) and SEMANTIC_OVERLAP_MAX (0.3) --
 * pairs below 0.1 are considered truly unrelated.
 *
 * Returns newly detected conflicts.
 */
export async function detectSemanticConflicts(
  ctx: ExtensionContext,
  limit = MAX_SEMANTIC_CHECKS_PER_TURN,
): Promise<Conflict[]> {
  const state = getState(ctx);
  const evidence = state.evidence;
  const newConflicts: Conflict[] = [];

  // Collect candidate pairs with overlap in the semantic gap zone
  const candidates: Array<{ a: Evidence; b: Evidence; overlap: number }> = [];
  for (let i = 0; i < evidence.length; i++) {
    for (let j = i + 1; j < evidence.length; j++) {
      const a = evidence[i];
      const b = evidence[j];

      if (a.source === b.source) continue;

      const overlap = tokenOverlap(a.normalized, b.normalized);
      if (overlap < SEMANTIC_OVERLAP_MIN || overlap >= SEMANTIC_OVERLAP_MAX) continue;

      const reliabilityDiff = Math.abs(a.reliability - b.reliability);
      if (reliabilityDiff < 0.02) continue;

      const existing = state.conflicts.find(
        (c) =>
          c.for.some((e) => e.id === a.id || e.id === b.id) ||
          c.against.some((e) => e.id === a.id || e.id === b.id),
      );
      if (existing) continue;

      candidates.push({ a, b, overlap });
    }
  }

  // Sort by overlap descending -- most likely related first
  candidates.sort((a, b) => b.overlap - a.overlap);

  const toCheck = candidates.slice(0, limit);

  for (const { a, b } of toCheck) {
    try {
      const evidenceA = a.claim;
      const evidenceB = b.claim;

      const result = await classify(
        ctx,
        CRITICS.evidenceConflict.criteria,
        { evidenceA, evidenceB },
        {
          timeoutMs: 60_000,
          label: `semantic-${CRITICS.evidenceConflict.label}`,
          tierPolicy: "always-llm",
          modelPreference: "quality",
        },
      );

      if (result.label !== "yes") continue;

      // LLM confirmed these semantically similar claims contradict
      const forEvidence = a.reliability > b.reliability ? [a] : [b];
      const againstEvidence = a.reliability > b.reliability ? [b] : [a];

      const conflict: Conflict = {
        id: nextId("c"),
        claim: `${a.claim.slice(0, 40)}... vs ${b.claim.slice(0, 40)}...`,
        for: forEvidence,
        against: againstEvidence,
        verdict: "unresolved",
        detectedAt: Date.now(),
        classification: "direct",
      };
      state.conflicts.push(conflict);
      newConflicts.push(conflict);
    } catch (e) {
      // Per-pair errors are non-fatal, but they must not be silent.
      recordClassifierFailure(state, "semanticFailures", e, "semantic pair check failed");
    }
  }

  // Semantic path previously pushed without any cap.
  trimConflicts(state);

  return newConflicts;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Add evidence to the pool from a knowledge source.
 * Reliability is computed as: SOURCE_RELIABILITY[source] x confidence.
 */
export function addEvidence(
  ctx: ExtensionContext,
  claim: string,
  source: EvidenceSource,
  content: string,
  confidence = 0.7,
  confidenceType: EvidenceConfidenceType = "retrieved",
): string {
  const state = getState(ctx);

  const evidence: Evidence = {
    id: nextId("e"),
    claim: extractClaim(claim),
    normalized: normalize(claim),
    content: content.slice(0, 500),
    source,
    confidence,
    confidenceType,
    reliability: SOURCE_RELIABILITY[source] * confidence,
    project: ctx.cwd ?? "unknown",
    timestamp: Date.now(),
  };
  state.evidence.push(evidence);

  // Cleanup old evidence (>50 entries -> keep last 30)
  if (state.evidence.length > 50) {
    state.evidence = state.evidence.slice(-30);
  }

  detectConflictsFor(ctx, evidence.id);

  // DetectConflictsFor pushes conflicts with no cap — apply the
  // uniform cap here too (same 20->10 semantics as detectConflicts).
  trimConflicts(state);

  persistState(state);

  return evidence.id;
}

/**
 * Get all evidence for a given context (optional filter by source).
 */
export function getEvidence(
  ctx: ExtensionContext,
  {
    source,
    project,
    minConfidence,
    maxAgeMs,
  }: { source?: EvidenceSource; project?: string; minConfidence?: number; maxAgeMs?: number } = {},
): Evidence[] {
  const state = getState(ctx);
  const currentProject = ctx.cwd ?? "unknown";
  let result = state.evidence;

  if (source) result = result.filter((e) => e.source === source);
  if (minConfidence !== undefined) result = result.filter((e) => e.confidence >= minConfidence);
  if (maxAgeMs !== undefined) result = result.filter((e) => Date.now() - e.timestamp <= maxAgeMs);

  // HaluMem (2511.03506): Cross-session isolation - project-aware filtering
  if (project !== undefined) {
    result = result.filter((e) => e.project === project);
  } else if (source === undefined) {
    // Default: prefer current project, allow legacy (project="unknown"), allow recent cross-project
    result = result.filter((e) => {
      if (!e.project || e.project === currentProject || e.project === "unknown") return true;
      // Cross-project: only if <1h old and high confidence
      const ageMs = Date.now() - e.timestamp;
      return ageMs < 3600000 && e.confidence >= 0.8;
    });
  }

  return result;
}

/**
 * Get unresolved conflicts.
 */
export function getUnresolvedConflicts(ctx: ExtensionContext): Conflict[] {
  return getState(ctx).conflicts.filter((c) => c.verdict === "unresolved");
}

/**
 * Get all conflicts.
 */
export function getAllConflicts(ctx: ExtensionContext): Conflict[] {
  return [...getState(ctx).conflicts];
}

/**
 * Resolve a conflict with a verdict.
 */
export function resolveConflict(
  ctx: ExtensionContext,
  conflictId: string,
  verdict: "resolved_for" | "resolved_against" | "uncertain",
  resolvedBy: string,
): void {
  const state = getState(ctx);
  const conflict = state.conflicts.find((c) => c.id === conflictId);
  if (!conflict) return;
  conflict.verdict = verdict;
  conflict.resolvedBy = resolvedBy;
  conflict.resolvedAt = Date.now();
  persistState(state);
}

/**
 * Detect conflicts among all evidence in the pool.
 * Uses triple-critic LLM classification (XoT Stage 1) with heuristic token-overlap
 * as a cheap pre-filter to avoid O(N^2) LLM calls for unrelated evidence pairs.
 *
 * Returns newly detected conflicts.
 */
export function detectConflicts(ctx: ExtensionContext): Conflict[] {
  const state = getState(ctx);
  const evidence = state.evidence;
  const newConflicts: Conflict[] = [];

  for (let i = 0; i < evidence.length; i++) {
    for (let j = i + 1; j < evidence.length; j++) {
      const a = evidence[i];
      const b = evidence[j];

      if (a.source === b.source) continue;

      // Cheap pre-filter: token overlap must be substantial
      const overlap = tokenOverlap(a.normalized, b.normalized);
      if (overlap < 0.3) continue;

      const reliabilityDiff = Math.abs(a.reliability - b.reliability);
      if (reliabilityDiff < 0.02) continue;

      const existing = state.conflicts.find(
        (c) =>
          c.for.some((e) => e.id === a.id || e.id === b.id) ||
          c.against.some((e) => e.id === a.id || e.id === b.id),
      );
      if (existing) continue;

      // Higher reliability goes in "for"
      const forEvidence = a.reliability > b.reliability ? [a] : [b];
      const againstEvidence = a.reliability > b.reliability ? [b] : [a];

      const conflict: Conflict = {
        id: nextId("c"),
        claim:
          overlap >= 0.5 ? a.claim : `${a.claim.slice(0, 40)}... vs ${b.claim.slice(0, 40)}...`,
        for: forEvidence,
        against: againstEvidence,
        verdict: "unresolved",
        detectedAt: Date.now(),
        classification: classifyConflict(forEvidence, againstEvidence),
      };
      state.conflicts.push(conflict);
      newConflicts.push(conflict);
    }
  }

  trimConflicts(state);

  persistState(state);

  return newConflicts;
}

/**
 * Maximum semantic conflict checks per turn. Prevents O(N^2) LLM cost when
 * the evidence pool is large. Only the most promising pairs (highest overlap)
 * are checked in each call.
 */
const MAX_SEMANTIC_CHECKS_PER_TURN = 10;

/**
 * Minimum token overlap for semantic conflict detection. Evidence pairs with
 * overlap below this threshold are considered unrelated and skipped.
 */
const SEMANTIC_OVERLAP_MIN = 0.1;

/**
 * Maximum token overlap for semantic conflict detection. Pairs above this
 * threshold are already caught by the heuristic detectConflicts().
 */
const SEMANTIC_OVERLAP_MAX = 0.3;

/** Detect conflicts for a single new evidence entry */
function detectConflictsFor(ctx: ExtensionContext, evidenceId: string): Conflict[] {
  const state = getState(ctx);
  const newEvidence = state.evidence.find((e) => e.id === evidenceId);
  if (!newEvidence) return [];

  const newConflicts: Conflict[] = [];
  for (const existing of state.evidence) {
    if (existing.id === evidenceId) continue;
    if (existing.source === newEvidence.source) continue;

    const overlap = tokenOverlap(newEvidence.normalized, existing.normalized);
    if (overlap < 0.3) continue;

    const reliabilityDiff = Math.abs(newEvidence.reliability - existing.reliability);
    if (reliabilityDiff < 0.02) continue;

    const existingConflict = state.conflicts.find(
      (c) =>
        c.for.some((e) => e.id === evidenceId || e.id === existing.id) ||
        c.against.some((e) => e.id === evidenceId || e.id === existing.id),
    );
    if (existingConflict) continue;

    const forEvidence = newEvidence.reliability > existing.reliability ? [newEvidence] : [existing];
    const againstEvidence =
      newEvidence.reliability > existing.reliability ? [existing] : [newEvidence];

    const conflict: Conflict = {
      id: nextId("c"),
      claim:
        overlap >= 0.5
          ? newEvidence.claim
          : `${newEvidence.claim.slice(0, 40)}... vs ${existing.claim.slice(0, 40)}...`,
      for: forEvidence,
      against: againstEvidence,
      verdict: "unresolved",
      detectedAt: Date.now(),
      classification: classifyConflict(forEvidence, againstEvidence),
    };
    state.conflicts.push(conflict);
    newConflicts.push(conflict);
  }

  return newConflicts;
}

/**
 * Generate a faithful conflict acknowledgment message for enforcement.
 * XoT Stage 2: Faithful reasoning - surfaces disagreement rather than picking sides.
 */
export function formatConflictMessage(conflict: Conflict): string {
  const forSource = conflict.for[0]?.source || "unknown";
  const againstSource = conflict.against[0]?.source || "unknown";
  const forRel = (conflict.for[0]?.reliability ?? 0).toFixed(2);
  const againstRel = (conflict.against[0]?.reliability ?? 0).toFixed(2);

  return (
    `[conflict:${conflict.classification}] Sources disagree: "${conflict.claim.slice(0, 60)}". ` +
    `${forSource} (rel ${forRel}) vs ${againstSource} (rel ${againstRel}). ` +
    `Consider acknowledging: "Sources disagree on X. Based on Y, I conclude Z."`
  );
}

/**
 * Prune evidence entries that are only referenced by resolved conflicts.
 * Cleans up the evidence pool without losing unresolved or validated data.
 */
export function pruneResolvedEvidence(ctx: ExtensionContext): number {
  const state = getState(ctx);
  const unresolvedIds = new Set(
    state.conflicts.filter((c) => c.verdict === "unresolved").map((c) => c.id),
  );
  const activeEvidenceIds = new Set<string>();
  for (const c of state.conflicts) {
    if (unresolvedIds.has(c.id)) {
      for (const e of c.for) activeEvidenceIds.add(e.id);
      for (const e of c.against) activeEvidenceIds.add(e.id);
    }
  }
  // Keep evidence in unresolved conflicts, plus the "for" side of resolved_for conflicts (validated)
  for (const c of state.conflicts) {
    if (c.verdict === "resolved_for") {
      for (const e of c.for) activeEvidenceIds.add(e.id);
    }
    if (c.verdict === "resolved_against") {
      for (const e of c.against) activeEvidenceIds.add(e.id);
    }
  }
  const before = state.evidence.length;
  state.evidence = state.evidence.filter((e) => activeEvidenceIds.has(e.id));
  const removed = before - state.evidence.length;
  persistState(state);
  return removed;
}

/**
 * Clear all evidence and conflicts (for testing or session reset).
 */
export function clearEvidence(ctx: ExtensionContext): void {
  const state = getState(ctx);
  state.evidence = [];
  state.conflicts = [];
  persistState(state);
}
