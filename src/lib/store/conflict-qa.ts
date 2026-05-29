/**
 * Conflict QA — Cross-observational Thinking (XoT) two-stage reasoning for knowledge conflicts.
 *
 * Stage 1 (in evidence-pool.ts):
 *   Source identification + conflict classification (direct | implication | reliability)
 *   Reliability-based resolution using SOURCE_RELIABILITY scores.
 *
 * Stage 2 (here):
 *   Generate resolution questions and faithful acknowledgment messages.
 *   Uses tokenOverlap from evidence-pool (imported, not duplicated).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type Conflict,
  type EvidenceSource,
  detectConflicts,
  getUnresolvedConflicts,
  resolveConflict as epResolve,
  tokenOverlap,
} from "./evidence-pool.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type ConflictType = "direct" | "implication" | "reliability";

export type ResolutionStrategy =
  | "favor_for"
  | "favor_against"
  | "favor_recent"
  | "favor_text"
  | "favor_kg"
  | "favor_param"
  | "acknowledge";

export interface ConflictQA {
  id: string;
  conflictId: string;
  question: string;
  answer?: string;
  type: ConflictType;
  resolutionStrategy: ResolutionStrategy;
  sources: Array<{
    type: EvidenceSource | "parametric";
    content: string;
    confidence: number;
  }>;
  createdAt: number;
}

interface QuestionCandidate {
  question: string;
  type: ConflictType;
  strategy: ResolutionStrategy;
}

// ── XoT Stage 1: Conflict Classification ────────────────────────────────────

/**
 * Classify conflict using reliability-based scoring.
 * Imported from evidence-pool.ts via tokenOverlap.
 */
function classifyConflict(conflict: Conflict): ConflictType {
  const forItems = conflict.for ?? [];
  const againstItems = conflict.against ?? [];
  const forText = forItems.map((e) => e.normalized).join(" ");
  const againstText = againstItems.map((e) => e.normalized).join(" ");
  const overlap = tokenOverlap(forText, againstText);
  if (overlap > 0.5) return "direct";

  const forRel = forItems[0]?.reliability ?? 0.5;
  const againstRel = againstItems[0]?.reliability ?? 0.5;
  if (Math.abs(forRel - againstRel) > 0.2) return "reliability";

  return "implication";
}

// ── XoT Stage 2: Question Generation ────────────────────────────────────────

function generateQuestionCandidates(conflict: Conflict): QuestionCandidate[] {
  const type = classifyConflict(conflict);
  const claim = conflict.claim;
  const candidates: QuestionCandidate[] = [];

  // ── Direct conflicts ──────────────────────────────────────────────────────
  if (type === "direct") {
    const forSource = conflict.for?.[0];
    const againstSource = conflict.against?.[0];

    if (forSource?.source === "code" && againstSource?.source !== "code") {
      candidates.push({
        question: `"${claim.slice(0, 60)}" — code evidence contradicts non-code.`,
        type,
        strategy: "favor_text",
      });
    }
    if (againstSource?.source === "code" && forSource?.source !== "code") {
      candidates.push({
        question: `"${claim.slice(0, 60)}" — code evidence contradicts non-code.`,
        type,
        strategy: "favor_text",
      });
    }

    if (forSource && againstSource) {
      if (forSource.timestamp > againstSource.timestamp + 3600000) {
        candidates.push({
          question: `"${claim.slice(0, 60)}" — for evidence is more recent. Trust it?`,
          type,
          strategy: "favor_recent",
        });
      }
      if (againstSource.timestamp > forSource.timestamp + 3600000) {
        candidates.push({
          question: `"${claim.slice(0, 60)}" — against evidence is more recent. Trust it?`,
          type,
          strategy: "favor_recent",
        });
      }
    }

    candidates.push({
      question: `"${claim.slice(0, 60)}" — conflicting sources. Should higher reliability source win?`,
      type,
      strategy: "acknowledge",
    });
  }

  // ── Reliability conflicts ─────────────────────────────────────────────────
  if (type === "reliability") {
    const forBetter =
      (conflict.for[0]?.reliability ?? 0.5) > (conflict.against[0]?.reliability ?? 0.5);
    const lowSource = forBetter ? conflict.against[0] : conflict.for[0];
    const highSource = forBetter ? conflict.for[0] : conflict.against[0];
    const lowRel = ((lowSource?.reliability ?? 0.5) * 100).toFixed(0);
    const highRel = ((highSource?.reliability ?? 0.5) * 100).toFixed(0);

    candidates.push({
      question: `Reliability conflict on "${claim.slice(0, 60)}": ${lowSource?.source ?? "?"} (${lowRel}% reliable) vs ${highSource?.source ?? "?"} (${highRel}% reliable).`,
      type,
      strategy: "acknowledge",
    });
  }

  // ── Implication conflicts ────────────────────────────────────────────────
  if (type === "implication") {
    candidates.push({
      question: `"${claim.slice(0, 60)}" — claims may contradict via implication. Investigate further?`,
      type,
      strategy: "acknowledge",
    });
  }

  return candidates;
}

// ── Public API ─────────────────────────────────────────────────────────────────

const _qaRegistry = new Map<string, ConflictQA>();

/**
 * Process all unresolved conflicts and generate QA records.
 * Returns ConflictQA[] for the conflict-qa tool.
 */
export function processConflicts(ctx: unknown): ConflictQA[] {
  _qaRegistry.clear();
  const conflicts = getUnresolvedConflicts(ctx as ExtensionContext);
  const qaResults: ConflictQA[] = [];

  for (const conflict of conflicts) {
    const candidates = generateQuestionCandidates(conflict);
    const best = candidates[0];

    const qa: ConflictQA = {
      id: `qa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      conflictId: conflict.id,
      question: best.question,
      type: best.type,
      resolutionStrategy: best.strategy,
      sources: [
        ...(conflict.for ?? []).map((e) => ({
          type: e.source as EvidenceSource | "parametric",
          content: e.content.slice(0, 200),
          confidence: e.confidence,
        })),
        ...(conflict.against ?? []).map((e) => ({
          type: e.source as EvidenceSource | "parametric",
          content: e.content.slice(0, 200),
          confidence: e.confidence,
        })),
      ],
      createdAt: Date.now(),
    };

    _qaRegistry.set(qa.id, qa);
    qaResults.push(qa);
  }

  return qaResults;
}

/**
 * Generate a faithful conflict acknowledgment whisper.
 * XoT Stage 2: Surfaces disagreement rather than silently selecting one side.
 */
export function formatConflictWhisper(conflicts: ConflictQA | ConflictQA[]): string {
  if (!conflicts) return "";
  if (Array.isArray(conflicts)) {
    if (conflicts.length === 0) return "";
    return conflicts.map((c) => `[conflict-qa] ${c.question}`).join("\n");
  }
  return `[conflict-qa] ${conflicts.question}`;
}

/**
 * Get all QA records for a given conflict.
 */
export function getQAForConflict(conflictId: string): ConflictQA[] {
  return [..._qaRegistry.values()].filter((qa) => qa.conflictId === conflictId);
}

/**
 * Alias for processConflicts — detect new conflicts and generate QA records.
 * Returns the raw Conflict[] for callers that need the evidence pool format.
 */
export function processConflictQAs(ctx: unknown): Conflict[] {
  return detectConflicts(ctx as ExtensionContext);
}

/**
 * Stats for the conflict-qa tool.
 */
export function getConflictQAStats(_ctx: unknown): {
  totalGenerated: number;
  totalResolved: number;
  pendingCount: number;
  resolutionsByStrategy: Record<string, number>;
} {
  const qas = [..._qaRegistry.values()];
  const resolved = qas.filter((qa) => qa.answer !== undefined);
  const byStrategy: Record<string, number> = {};
  for (const qa of resolved) {
    byStrategy[qa.resolutionStrategy] = (byStrategy[qa.resolutionStrategy] || 0) + 1;
  }
  return {
    totalGenerated: qas.length,
    totalResolved: resolved.length,
    pendingCount: qas.length - resolved.length,
    resolutionsByStrategy: byStrategy,
  };
}

export function getRelevantQA(_ctx: unknown, topic: string): ConflictQA | null {
  const qas = [..._qaRegistry.values()].slice(-5);
  const topicTokens = new Set(
    topic
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 2),
  );
  let best: ConflictQA | null = null;
  let bestScore = 0;

  for (const qa of qas) {
    const qaTokens = new Set(
      qa.question
        .toLowerCase()
        .split(/\W+/)
        .filter((t) => t.length > 2),
    );
    let score = 0;
    for (const t of topicTokens) {
      if (qaTokens.has(t)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = qa;
    }
  }

  return bestScore > 0 ? best : null;
}

// ── Legacy aliases for existing callers ──────────────────────────────────────────

/** Alias for getQAForConflict */
export function getPendingQAs(_ctx: unknown): ConflictQA[] {
  return [..._qaRegistry.values()].filter((qa) => !qa.answer);
}

/** Alias for all QA records */
export function getAllQAs(_ctx: unknown): ConflictQA[] {
  return [..._qaRegistry.values()];
}

/**
// ── Conflict Resolution Detection ───────────────────────────────────────

/**
 * Keywords that suggest the agent's response addressed a conflict.
 * When found in an assistant message, we attempt to resolve the conflict.
 */
const RESOLUTION_KEYWORDS = [
  "resolved",
  "conflict resolved",
  "the correct answer is",
  "after further investigation",
  "sources disagree",
];

/**
 * Check if a response text contains resolution language for a conflict QA.
 * Returns the suspected verdict if resolution keywords detected, null otherwise.
 */
export function checkResponseForResolution(
  text: string,
): "resolved_for" | "resolved_against" | null {
  const lower = text.toLowerCase();

  // Check for explicit resolution keywords
  const containsResolution = RESOLUTION_KEYWORDS.some((kw) => lower.includes(kw));
  if (!containsResolution) return null;

  // Determine direction from context
  if (
    lower.includes("based on higher reliability source") ||
    lower.includes("the evidence supports") ||
    lower.includes("confirm that")
  ) {
    return "resolved_for";
  }
  if (lower.includes("evidence does not support") || lower.includes("this claim is incorrect")) {
    return "resolved_against";
  }

  // Default to resolved_for when uncertainty is acknowledged but a decision is made
  return "resolved_for";
}

/**
 * Resolve a conflict by verdict (aliased from evidence-pool.resolveConflict).
 * Takes 3 args: (ctx, conflictId, verdict).
 * Used by cognitive-systems.
 */
export function resolveConflictQA(
  _ctx: unknown,
  conflictId: string,
  verdict: "resolved_for" | "resolved_against" | "uncertain",
): void {
  epResolve(_ctx as ExtensionContext, conflictId, verdict, "agent");
}

/** Alias for getConflictQAStats */
export function getQAStats(_ctx: unknown) {
  return getConflictQAStats(_ctx);
}

/**
 * @deprecated Will be removed in v0.3.0 — use evidence-pool.resolveConflict() directly.
 * Resolve a conflict. Takes 3 args: (ctx, conflictId, verdict).
 * Used by cognitive-systems via `import { resolveQA as resolveConflictQA }`.
 */
export function resolveQA(_ctx: unknown, conflictId: string, verdict: string): void {
  epResolve(
    _ctx as ExtensionContext,
    conflictId,
    verdict as "resolved_for" | "resolved_against" | "uncertain",
    "agent",
  );
  // Mark QA as answered
  const qa = _qaRegistry.get(conflictId);
  if (qa) qa.answer = verdict;
}
