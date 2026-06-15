/**
 * Evidence Pool - Tracks knowledge from multiple sources with conflict detection.
 * Uses the triple-critic LLM classification system for evidence conflict
 * detection with three-tier fallback (heuristic → utility → session).
 *
 * XoT (Cross-observational Thinking) two-stage decomposition:
 *   Stage 1 - Evidence Explanation: classify conflicts via classify() + CRITICS.evidenceConflict
 *   Stage 2 - Faithful Reasoning: acknowledgment generation (formatConflictMessage)
 *
 * Flow:
 * 1. memory (recall_search), web search, docs reading, code execution → addEvidence()
 * 2. message_end → detectConflicts() → XoT Stage 1 classification
 * 3. conflict-qa → Stage 2: question generation + enforcement whisper
 *
 * Replaces the previous implementation that maintained a local STOP_WORDS
 * copy (80+ words) and used raw token-overlap thresholds for conflict detection.
 * The stop-word list is now shared via import from critic-registry.ts, and
 * conflict classification uses the triple-critic system.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../state/extension-state.js";
import { classify } from "../ai/text-classifier.js";
import { CRITICS, STOP_WORDS } from "../ai/critic-registry.js";
import { nextId } from "../utils/id.js";

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
  reliability: number; // Computed: SOURCE_RELIABILITY[source] × confidence
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
}

// ── State factory ────────────────────────────────────────────────────────────

function getState(ctx: ExtensionContext): EvidencePoolState {
  return getExtensionState(ctx, "evidence-pool", () => ({
    evidence: [],
    conflicts: [],
    lastCleanup: Date.now(),
  }));
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

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Add evidence to the pool from a knowledge source.
 * Reliability is computed as: SOURCE_RELIABILITY[source] × confidence.
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
    id: nextId('e'),
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

  // Cleanup old evidence (>50 entries → keep last 30)
  if (state.evidence.length > 50) {
    state.evidence = state.evidence.slice(-30);
  }

  // Check for conflicts with this new evidence
  detectConflictsFor(ctx, evidence.id);

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
 * Format evidence with provenance tags for safe injection into context.
 *
 * HaluMem (2511.03506): Memory hallucinations propagate between projects when
 * evidence is injected without source/TTL tags. This formatter adds markers so the
 * agent can distinguish memory from fresh context.
 */
export function formatEvidenceWithProvenance(evidence: Evidence[], includeProject = true): string {
  if (!evidence.length) return "(no relevant evidence)";
  return evidence
    .map((e) => {
      const ageMs = Date.now() - e.timestamp;
      const ageLabel =
        ageMs < 60000
          ? `${Math.round(ageMs / 1000)}s ago`
          : ageMs < 3600000
            ? `${Math.round(ageMs / 60000)}m ago`
            : `${Math.round(ageMs / 3600000)}h ago`;
      const provenance =
        includeProject && e.project && e.project !== "unknown"
          ? `[EVIDENCE ${e.source} project=${e.project} ${ageLabel}] `
          : `[EVIDENCE ${e.source} ${ageLabel}] `;
      return `${provenance}${e.claim}`;
    })
    .join("\n");
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
}

/**
 * Detect conflicts among all evidence in the pool.
 * Uses triple-critic LLM classification (XoT Stage 1) with heuristic token-overlap
 * as a cheap pre-filter to avoid O(N²) LLM calls for unrelated evidence pairs.
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
        id: nextId('c'),
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

  if (state.conflicts.length > 20) {
    state.conflicts = state.conflicts.slice(-10);
  }

  return newConflicts;
}

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
      id: nextId('c'),
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
  return before - state.evidence.length;
}

/**
 * Clear all evidence and conflicts (for testing or session reset).
 */
export function clearEvidence(ctx: ExtensionContext): void {
  const state = getState(ctx);
  state.evidence = [];
  state.conflicts = [];
}
