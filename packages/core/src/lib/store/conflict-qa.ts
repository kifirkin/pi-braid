/**
 * Conflict QA - Cross-observational Thinking (XoT) two-stage reasoning for knowledge conflicts.
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
import { nextId } from "../utils/id.js";
import { classify } from "../ai/text-classifier.js";
import { CRITICS } from "../ai/critic-registry.js";

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
        question: `"${claim.slice(0, 60)}" - code evidence contradicts non-code.`,
        type,
        strategy: "favor_text",
      });
    }
    if (againstSource?.source === "code" && forSource?.source !== "code") {
      candidates.push({
        question: `"${claim.slice(0, 60)}" - code evidence contradicts non-code.`,
        type,
        strategy: "favor_text",
      });
    }

    if (forSource && againstSource) {
      if (forSource.timestamp > againstSource.timestamp + 3600000) {
        candidates.push({
          question: `"${claim.slice(0, 60)}" - for evidence is more recent. Trust it?`,
          type,
          strategy: "favor_recent",
        });
      }
      if (againstSource.timestamp > forSource.timestamp + 3600000) {
        candidates.push({
          question: `"${claim.slice(0, 60)}" - against evidence is more recent. Trust it?`,
          type,
          strategy: "favor_recent",
        });
      }
    }

    candidates.push({
      question: `"${claim.slice(0, 60)}" - conflicting sources. Should higher reliability source win?`,
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
      question: `"${claim.slice(0, 60)}" - claims may contradict via implication. Investigate further?`,
      type,
      strategy: "acknowledge",
    });
  }

  return candidates;
}

// ── Public API ─────────────────────────────────────────────────────────────────

// _qaRegistry: PROCESS-GLOBAL map of QA ID -> ConflictQA. processConflicts()
// rebuilds it from the session's current unresolved conflicts at the top of
// every call, so a record generated in one turn disappears on the next if its
// conflict resolves. The lifetime counters below keep that reset visible
// instead of silent; they are process-global for the same reason the registry
// is (the registry is bounded by the live conflict count, so it is not a leak
// risk, and the counters are two numbers).
const _qaRegistry = new Map<string, ConflictQA>();

/** QA records generated since process start, across registry resets. */
let _generatedTotal = 0;
/** QA records discarded by a registry reset while still retained. */
let _droppedByReset = 0;

/**
 * Process all unresolved conflicts and generate QA records.
 * Returns ConflictQA[] for the conflict-qa tool.
 */
export function processConflicts(ctx: unknown): ConflictQA[] {
  if (_qaRegistry.size > 0) {
    _droppedByReset += _qaRegistry.size;
    _qaRegistry.clear();
  }
  const conflicts = getUnresolvedConflicts(ctx as ExtensionContext);
  const qaResults: ConflictQA[] = [];

  for (const conflict of conflicts) {
    const candidates = generateQuestionCandidates(conflict);
    const best = candidates[0];

    const qa: ConflictQA = {
      id: nextId("qa"),
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

    _generatedTotal++;
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
 * Alias for processConflicts - detect new conflicts and generate QA records.
 * Returns the raw Conflict[] for callers that need the evidence pool format.
 */
export function processConflictQAs(ctx: unknown): Conflict[] {
  return detectConflicts(ctx as ExtensionContext);
}

/**
 * Stats for the conflict-qa tool. `totalGenerated` and `droppedByReset` are
 * lifetime counters; the rest describe the registry's current contents.
 */
export function getConflictQAStats(_ctx: unknown): {
  totalGenerated: number;
  totalResolved: number;
  pendingCount: number;
  retainedCount: number;
  droppedByReset: number;
  resolutionsByStrategy: Record<string, number>;
} {
  const qas = [..._qaRegistry.values()];
  const resolved = qas.filter((qa) => qa.answer !== undefined);
  const byStrategy: Record<string, number> = {};
  for (const qa of resolved) {
    byStrategy[qa.resolutionStrategy] = (byStrategy[qa.resolutionStrategy] || 0) + 1;
  }
  return {
    totalGenerated: _generatedTotal,
    totalResolved: resolved.length,
    pendingCount: qas.length - resolved.length,
    retainedCount: qas.length,
    droppedByReset: _droppedByReset,
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

/**
// ── Conflict Resolution Detection ───────────────────────────────────────

// RESOLUTION_CRITERIA and resolutionFallback were moved to CRITICS.conflictResolution
// in lib/ai/critic-registry.ts.

/**
 * Check if a response text contains resolution language for a conflict QA.
 * Uses classify() with three-tier fallback.
 */
export async function checkResponseForResolution(
  ctx: ExtensionContext,
  text: string,
): Promise<"resolved_for" | "resolved_against" | null> {
  const truncated = text.length > 2000 ? text.slice(0, 2000) + "..." : text;

  const result = await classify(
    ctx,
    CRITICS.conflictResolution.criteria,
    { text: truncated },
    {
      timeoutMs: 60_000,
      label: "Conflict Resolution",
      // Q9: keyword overlap heuristic misses nuanced resolution. Always use LLM.
      tierPolicy: "always-llm",
    },
  );

  if (result.label === "resolved_for") return "resolved_for";
  if (result.label === "resolved_against") return "resolved_against";
  return null;
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
 * @deprecated Will be removed in v0.3.0 - use evidence-pool.resolveConflict() directly.
 * Resolve a conflict. Takes 3 args: (ctx, conflictId, verdict).
 * Used by cognitive-systems via `import { resolveQA as resolveConflictQA }`.
 */
export function resolveQA(_ctx: unknown, qaId: string, verdict: string): void {
  // Look up QA to bridge qa-xxx -> c-xxx ID space
  const qa = _qaRegistry.get(qaId);
  if (!qa) return;

  // Evidence-pool resolution keys on the c-xxx conflictId, not the qa id.
  epResolve(
    _ctx as ExtensionContext,
    qa.conflictId,
    verdict as "resolved_for" | "resolved_against" | "uncertain",
    "agent",
  );

  qa.answer = verdict;
}
