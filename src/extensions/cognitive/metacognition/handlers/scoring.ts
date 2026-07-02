// ── Hypothesis Scoring ─────────────────────────────────────────────────────────
// Heuristic + evidence-pool scoring for ranking hypotheses.
// Extracted from metacognition/index.ts for decomposition.

import { tokenOverlap } from "../../../../lib/store/evidence-pool.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getEvidence } from "../../../../lib/store/evidence-pool.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScoredHypothesis {
  index: number;
  title: string;
  score: number; // 0-1 weighted score
  heuristicScore: number; // 0-1 from keyword signals
  evidenceScore: number; // 0-1 from evidence pool
  signals: string[];
  evidenceMatches: Array<{ claim: string; source: string; reliability: number; overlap: number }>;
  /** Parsed "What evidence would CONFIRM" lines from hypotheses output. */
  evidenceFor?: string[];
  /** Parsed "What evidence would DISPROVE" lines from hypotheses output. */
  evidenceAgainst?: string[];
}

// ── Heuristic Signals (existing) ────────────────────────────────────────────

/** Score a single hypothesis block against evidence using heuristic signals. */
function scoreHeuristic(
  llmOutput: string,
  evidence: string,
): Pick<ScoredHypothesis, "signals" | "heuristicScore"> {
  const signals: string[] = [];
  let score = 0.5; // baseline

  // Signal: mentions specific file or function
  const fileRefs = llmOutput.match(/\b[\w/.-]+\.(ts|js|json|py|rs|go)\b/g) ?? [];
  if (fileRefs.length > 0) {
    score += 0.1;
    signals.push("specific-files");
  }

  // Signal: references evidence in reasoning
  const evidenceTokens = evidence.split(/\s+/).slice(0, 3).join(" ").toLowerCase().slice(0, 30);
  if (evidence && llmOutput.toLowerCase().includes(evidenceTokens)) {
    score += 0.15;
    signals.push("evidence-cited");
  }

  // Signal: proposes verification steps
  if (/verify|check|test|confirm|reproduce/i.test(llmOutput)) {
    score += 0.1;
    signals.push("verification-plan");
  }

  // Signal: explains root cause mechanism
  if (/because|caused by|due to|root cause|underlying/i.test(llmOutput)) {
    score += 0.05;
    signals.push("causal-reasoning");
  }

  // Signal: proper solution (not workaround)
  if (/proper|maintainable|clean|refactor|fix.*properly/i.test(llmOutput)) {
    score += 0.05;
    signals.push("proper-solution");
  }

  // Signal: considers edge cases
  if (/edge case|boundary|corner case|failure mode/i.test(llmOutput)) {
    score += 0.05;
    signals.push("edge-case-aware");
  }

  return { heuristicScore: Math.min(score, 1), signals };
}

// ── Evidence Pool Scoring ────────────────────────────────────────────────────

/**
 * Score a hypothesis block against the evidence pool.
 *
 * Scoring dimensions:
 * 1. Evidence overlap - token overlap between hypothesis and evidence items
 * 2. Source reliability - evidence from code/docs outweighs memory/web
 * 3. Recency - recent evidence (within 5 min) gets +0.1 weight boost
 */
function scoreEvidencePool(
  hypothesisText: string,
  ctx: ExtensionContext | undefined,
): { score: number; matches: ScoredHypothesis["evidenceMatches"] } {
  if (!ctx) {
    return { score: 0, matches: [] };
  }

  const matches: ScoredHypothesis["evidenceMatches"] = [];
  let totalEvidenceScore = 0;
  let evidenceCount = 0;

  const allEvidence = getEvidence(ctx);
  if (allEvidence.length === 0) {
    return { score: 0, matches: [] };
  }

  for (const evidence of allEvidence) {
    const overlap = tokenOverlap(hypothesisText, evidence.claim);
    if (overlap < 0.2) continue; // Only meaningful overlap

    // Recency boost: evidence from the last 5 minutes gets +0.1 weight
    const ageMs = Date.now() - (evidence.timestamp ?? 0);
    const recencyBoost = ageMs < 5 * 60 * 1000 ? 0.1 : 0;

    // Source reliability weight
    const sourceWeights: Record<string, number> = {
      code: 1.0,
      docs: 0.85,
      memory: 0.7,
      web: 0.6,
      session: 0.5,
      unknown: 0.4,
    };
    const sourceWeight = sourceWeights[evidence.source] ?? 0.5;

    // Evidence score: overlap x reliability x recency boost
    const evidenceScore = overlap * sourceWeight * evidence.reliability + recencyBoost;
    totalEvidenceScore += evidenceScore;
    evidenceCount++;

    matches.push({
      claim: evidence.claim,
      source: evidence.source,
      reliability: evidence.reliability,
      overlap: Math.round(overlap * 100),
    });
  }

  const rawScore = evidenceCount > 0 ? totalEvidenceScore / evidenceCount : 0;
  const score = Math.min(rawScore * 2, 1); // Diminishing returns, capped at 1.0
  return { score, matches };
}

// ── Evidence extraction helpers ────────────────────────────────────────────

/** Parse confirm/disprove evidence from a hypothesis block. */
function extractEvidences(block: string): { evidenceFor: string[]; evidenceAgainst: string[] } {
  const evidenceFor: string[] = [];
  const evidenceAgainst: string[] = [];

  const forMatch = block.match(
    /(?:What evidence would CONFIRM|Evidence.*confirm|To confirm|Confirm).*?\n?([\s\S]*?)(?=\d+\.\s|What evidence would DISPROVE|Evidence.*disprove|To disprove|How to fix|$)/i,
  );
  if (forMatch) {
    forMatch[1]
      .split(/\n/)
      .map((l) => l.replace(/^[-**]\s*/, "").trim())
      .filter((l) => l.length > 5)
      .forEach((l) => evidenceFor.push(l));
  }

  const againstMatch = block.match(
    /(?:What evidence would DISPROVE|Evidence.*disprove|To disprove).*?\n?([\s\S]*?)(?=\d+\.\s|How to fix|$)/i,
  );
  if (againstMatch) {
    againstMatch[1]
      .split(/\n/)
      .map((l) => l.replace(/^[-**]\s*/, "").trim())
      .filter((l) => l.length > 5)
      .forEach((l) => evidenceAgainst.push(l));
  }

  return { evidenceFor, evidenceAgainst };
}

// ── Combined Scoring ────────────────────────────────────────────────────────────

function scoreHypothesisBlock(
  llmOutput: string,
  evidence: string,
  ctx: ExtensionContext | undefined,
): ScoredHypothesis {
  const title = llmOutput.split("\n")[0]?.slice(0, 80) ?? "Untitled hypothesis";
  const heuristic = scoreHeuristic(llmOutput, evidence);
  const { score: evidenceScore, matches } = scoreEvidencePool(llmOutput, ctx);
  const { evidenceFor, evidenceAgainst } = extractEvidences(llmOutput);

  // Combined weighted score: 60% heuristic, 40% evidence pool
  const score = heuristic.heuristicScore * 0.6 + evidenceScore * 0.4;

  return {
    index: -1,
    title,
    score: Math.min(score, 1),
    heuristicScore: heuristic.heuristicScore,
    evidenceScore,
    signals: heuristic.signals,
    evidenceMatches: matches,
    evidenceFor: evidenceFor.length > 0 ? evidenceFor : undefined,
    evidenceAgainst: evidenceAgainst.length > 0 ? evidenceAgainst : undefined,
  };
}

// ── Main Entry Point ──────────────────────────────────────────────────────────

/**
 * Score an entire LLM hypothesis output (may contain multiple hypotheses).
 * Returns scored hypotheses re-ranked by combined score, plus annotated text.
 */
export function scoreHypothesisOutput(
  llmOutput: string,
  evidence: string,
  ctx?: ExtensionContext,
): { scored: ScoredHypothesis[]; annotated: string } {
  const blocks = llmOutput.split(/(?=Hypothesis\s+\d+)/i).filter((b) => b.trim());

  if (blocks.length <= 1) {
    const s = scoreHypothesisBlock(llmOutput, evidence, ctx);
    s.index = 0;
    const annotated = `${llmOutput}\n\n---\n**Analysis Score: ${(s.score * 100).toFixed(0)}%** (heuristic: ${(s.heuristicScore * 100).toFixed(0)}% | evidence: ${(s.evidenceScore * 100).toFixed(0)}%)\nSignals: ${s.signals.join(", ") || "none"}${s.evidenceMatches.length ? "\nEvidence matches: " + s.evidenceMatches.map((m) => `[${m.source}:${m.overlap}%] "${m.claim}"`).join(", ") : ""}`;
    return { scored: [s], annotated };
  }

  const scored = blocks.map((block) => scoreHypothesisBlock(block, evidence, ctx));

  // Re-rank by combined score (descending)
  scored.sort((a, b) => b.score - a.score);
  scored.forEach((s, i) => {
    s.index = i;
  });

  // Build annotated output with rank indicators
  let annotated = "";
  for (const s of scored) {
    const rankEmoji =
      s.index === 0 ? "🥇" : s.index === 1 ? "🥈" : s.index === 2 ? "🥉" : `  ${s.index + 1}.`;
    const badge = s.evidenceMatches.length > 0 ? " [📊evidence-matched]" : "";
    const evidenceLine =
      s.evidenceMatches.length > 0
        ? `\n   Evidence: ${s.evidenceMatches.map((m) => `${m.source}:${m.overlap}%`).join(", ")}`
        : "";

    const forLine =
      s.evidenceFor && s.evidenceFor.length > 0
        ? `\n   ✅ Confirm: ${s.evidenceFor.slice(0, 2).join("; ")}`
        : "";
    const againstLine =
      s.evidenceAgainst && s.evidenceAgainst.length > 0
        ? `\n   ❌ Disprove: ${s.evidenceAgainst.slice(0, 2).join("; ")}`
        : "";

    annotated +=
      `${rankEmoji} ${s.title}${badge}\n` +
      `   Score: ${(s.score * 100).toFixed(0)}% (heuristic: ${(s.heuristicScore * 100).toFixed(0)}% | evidence: ${(s.evidenceScore * 100).toFixed(0)}%)${forLine}${againstLine}\n` +
      `   Signals: ${s.signals.join(", ") || "none"}${evidenceLine}\n\n`;
  }

  return { scored, annotated };
}

// Backward-compatible alias: returns heuristic score as `score` (no evidence pool ctx available in tests)
/** @deprecated Use scoreHypothesisOutput instead. Kept to avoid breaking imports but never called. */
export function scoreHypothesis(
  llmOutput: string,
  evid?: string,
): {
  annotated: string;
  scores: ScoredHypothesis[];
  score: number;
  signals: string[];
  title: string;
  index: number;
} {
  const result = scoreHypothesisOutput(llmOutput, evid ?? "", undefined);
  const first = result.scored[0];
  return {
    annotated: result.annotated,
    scores: result.scored,
    score: first?.heuristicScore ?? 0.5,
    signals: first?.signals ?? [],
    title: first?.title ?? "",
    index: first?.index ?? 0,
  };
}
