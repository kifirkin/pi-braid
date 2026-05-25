/**
 * @fileoverview Bidirectional verification tool.
 *
 * Cross-checks agent claims against retrieved context, detects contradictions,
 * unsupported assertions, and hedge word issues. Designed to prevent the
 * "braid paper" failure mode where agents produce fluent but off-topic output.
 *
 * Part of TIER 1 infrastructure activation.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../../lib/logger.js";
import { classify } from "../../../lib/text-classifier.js";

const log = createLogger("verification");

// ── Hedge words that need verification ────────────────────────────────────────

const HEDGE_WORDS = [
  "should",
  "probably",
  "likely",
  "typically",
  "usually",
  "always",
  "never",
  "must",
  "guaranteed",
  "certainly",
  "definitely",
  "obviously",
  "clearly",
  "everyone",
  "no one",
  "all",
  "none",
  "impossible",
  "essential",
] as const;

const HEDGE_SEVERITY: Record<string, "low" | "medium" | "high"> = {
  always: "high",
  never: "high",
  must: "medium",
  guaranteed: "high",
  certainly: "low",
  definitely: "medium",
  obviously: "low",
  clearly: "low",
  everyone: "medium",
  no_one: "medium",
  all: "medium",
  none: "medium",
  impossible: "high",
  essential: "medium",
  should: "low",
  probably: "low",
  likely: "low",
  typically: "low",
  usually: "low",
};

const STOP_WORDS = new Set([
  // core English stop words
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "had",
  "her",
  "was",
  "one",
  "our",
  "out",
  "get",
  "has",
  "him",
  "his",
  "how",
  "its",
  "may",
  "new",
  "now",
  "old",
  "see",
  "way",
  "who",
  "did",
  "let",
  "put",
  "say",
  "she",
  "too",
  "use",
  "that",
  "with",
  "have",
  "this",
  "from",
  "they",
  "will",
  "would",
  "there",
  "their",
  "what",
  "been",
  "more",
  "when",
  "your",
  "come",
  "could",
  "only",
  "other",
  "than",
  "into",
  "some",
  "them",
  "then",
  "these",
  "take",
  "made",
  "very",
  "just",
  "over",
  "such",
  "also",
  "back",
  "after",
  "work",
  "first",
  "well",
  "even",
  "want",
  "because",
  "any",
  "between",
  "don't",
  "it's",
  "should",
  "about",
  "going",
  // missing common stop words that add noise
  "is",
  "in",
  "at",
  "on",
  "to",
  "of",
  "it",
  "as",
  "by",
  "an",
  "or",
  "no",
  "if",
  "up",
  "be",
  "so",
  "do",
  "he",
  "my",
  "me",
  "we",
  "am",
  "us",
  "i'",
  "its",
  "has",
  "can",
  "was",
  "had",
  "were",
  "been",
  "being",
  "does",
  "done",
  "doing",
  // days (accidental stop words from previous list — keep for consistency)
  "day",
  "boy",
]);

// ── Utility Model Criteria ─────────────────────────────────────────────────────

const CONTRADICTION_CRITERIA = {
  systemPrompt:
    "You are a contradiction detector. Determine if the given claim contradicts the given " +
    "context. Consider positive/negative polarity: if the claim says something is true " +
    "but the context says it is false (or vice versa), that is a contradiction.\n" +
    "Answer only 'yes' or 'no'. Do not explain.",
  userPrompt: "Claim: {{claim}}\nContext: {{context}}\nDoes the claim contradict the context?",
};

/** Heuristic fallback: preserve original negation pattern + MATCH_PAIRS logic */
function contradictionFallback(claim: string, context: string): string {
  const claimLower = claim.toLowerCase();
  const contextLower = context.toLowerCase();

  // Phase 1 (heuristic): Pattern-based negation detection
  const negationPattern =
    /\b(not|n't|never|no|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|won't|wouldn't|can't|cannot|couldn't|shouldn't)\s+(\w{3,})/gi;

  const claimNegations: Array<{ word: string; negated: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = negationPattern.exec(claimLower)) !== null) {
    claimNegations.push({ word: match[1], negated: match[2] });
  }
  const contextNegations: Array<{ word: string; negated: string }> = [];
  while ((match = negationPattern.exec(contextLower)) !== null) {
    contextNegations.push({ word: match[1], negated: match[2] });
  }

  const claimFeatures = extractFeatures(claim);

  for (const ctxNeg of contextNegations) {
    for (const cf of claimFeatures) {
      if (ctxNeg.negated.includes(cf) || cf.includes(ctxNeg.negated)) {
        return "yes";
      }
    }
  }

  // Phase 2 (heuristic): Hardcoded positive-negation pair matching
  const MATCH_PAIRS: [string, string][] = [
    ["works", "doesn't work"],
    ["works", "fails"],
    ["supported", "not supported"],
    ["compatible", "incompatible"],
    ["can use", "cannot use"],
    ["is defined", "is not defined"],
    ["exists", "doesn't exist"],
    ["succeeds", "fails"],
    ["passes", "fails"],
    ["correct", "incorrect"],
  ];

  for (const [pos, neg] of MATCH_PAIRS) {
    if (claimLower.includes(pos) && contextLower.includes(neg)) return "yes";
    if (claimLower.includes(neg) && contextLower.includes(pos)) return "yes";
  }

  return "no";
}

// ── Core logic ────────────────────────────────────────────────────────────────

function extractFeatures(text: string): Set<string> {
  // Extract content-bearing tokens (min 3 chars), skip stop words
  const normalized = text.toLowerCase();
  const words = normalized.split(/[^\w]+/).filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  return new Set(words);
}

/**
 * Compute claim recall: what fraction of claim features appear in the context.
 * Uses Jaccard on features but this is only for the getContradiction fallback.
 * For checkSupport, we use claimRecall() directly (not penalized by long contexts).
 */
function featureIntersection(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) {
    if (b.has(token) || Array.from(b).some((bt) => token.includes(bt) || bt.includes(token))) {
      count++;
    }
  }
  return count;
}

function claimRecall(claimFeatures: Set<string>, contextFeatures: Set<string>): number {
  if (claimFeatures.size === 0) return 1;
  const found = featureIntersection(claimFeatures, contextFeatures);
  return found / claimFeatures.size;
}

function symmetricOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = featureIntersection(a, b);
  return intersection / (a.size + b.size - intersection);
}

async function checkContradiction(claim: string, context: string, ctx: ExtensionContext) {
  const claimFeatures = extractFeatures(claim);
  const contextFeatures = extractFeatures(context);

  // Primary: classify via utility model
  const truncated = {
    claim: claim.length > 1500 ? claim.slice(0, 1500) + "..." : claim,
    context: context.length > 1500 ? context.slice(0, 1500) + "..." : context,
  };

  const result = await classify(ctx, CONTRADICTION_CRITERIA, truncated, {
    maxTokens: 5,
    timeoutMs: 5000,
    fallback: () => contradictionFallback(claim, context),
  });

  if (result.label === "yes") {
    return {
      type: "contradiction" as const,
      severity: "high" as const,
      description: `Claim contradicts context (${result.tier} tier)`,
      quote: claim,
      location: "claim vs context",
    };
  }

  // Phase 3: Semantic overlap check (topic drift — separate concern)
  const overlap = symmetricOverlap(claimFeatures, contextFeatures);

  if (overlap < 0.1 && claimFeatures.size > 3) {
    return {
      type: "contradiction" as const,
      severity: "low" as const,
      description: `Claim and context share very few features (${(overlap * 100).toFixed(0)}% overlap). Possible topic drift.`,
      quote: claim,
      location: "semantic mismatch",
    };
  }

  return null;
}

function checkSupport(claim: string, contexts: string[], threshold = 0.4): boolean {
  const claimFeatures = extractFeatures(claim);
  if (claimFeatures.size === 0) return true;
  for (const ctx of contexts) {
    const recall = claimRecall(claimFeatures, extractFeatures(ctx));
    if (recall >= threshold) return true;
  }
  return false;
}

function checkHedgeWords(claim: string) {
  const issues = [];
  const claimLower = claim.toLowerCase();
  for (const hedge of HEDGE_WORDS) {
    if (claimLower.includes(hedge)) {
      issues.push({
        type: "hedge_warning",
        severity: HEDGE_SEVERITY[hedge] ?? "low",
        description: `Contains qualifier "${hedge}" — verify this is warranted by context`,
        quote: claim,
      });
    }
  }
  return issues;
}

function extractTaskFeatures(task: string): string[] {
  const normalized = task.toLowerCase();
  const words = normalized.split(/[^\w]+/).filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  const compounds = normalized.match(/\w{4,}/g) || [];
  return [...words, ...compounds].sort((a, b) => b.length - a.length).slice(0, 15);
}

function checkDecompositionCoverage(
  parentTask: string,
  subtasks: string[],
  _constraints?: string[],
) {
  const parentFeatures = new Set(extractTaskFeatures(parentTask));
  const subtaskFeatures = subtasks.map((st) => new Set(extractTaskFeatures(st)));
  const allSubtaskFeatures = new Set<string>();
  for (const sf of subtaskFeatures) for (const f of sf) allSubtaskFeatures.add(f);

  const covered = new Set<string>();
  for (const pf of parentFeatures) {
    for (const sf of allSubtaskFeatures) {
      if (pf.includes(sf) || sf.includes(pf) || pf === sf) {
        covered.add(pf);
        break;
      }
    }
  }

  const gaps = [...parentFeatures].filter((pf) => !covered.has(pf));
  const coverage = parentFeatures.size > 0 ? covered.size / parentFeatures.size : 1.0;

  const coverageBySubtask = subtasks.map((st, i) => {
    const sf = subtaskFeatures[i];
    let coveredByThis = 0;
    for (const pf of parentFeatures) {
      for (const f of sf) {
        if (pf.includes(f) || f.includes(pf) || pf === f) {
          coveredByThis++;
          break;
        }
      }
    }
    return {
      subtask: st.substring(0, 80),
      featuresCovered: coveredByThis,
      featuresMissing: parentFeatures.size - coveredByThis,
    };
  });

  const suggestions = gaps.map(
    (g) => `Add subtask addressing: "${g}" (no subtask currently covers this aspect)`,
  );

  return { complete: gaps.length === 0, coverage, gaps, coverageBySubtask, suggestions };
}

// ── Tool schemas ───────────────────────────────────────────────────────────────

const verifyClaimSchema = Type.Object({
  claim: Type.String({ description: "The claim or statement to verify" }),
  context: Type.Array(Type.String(), {
    description: "Retrieved context strings to verify against",
  }),
  claimId: Type.Optional(Type.String({ description: "Optional ID for tracking this claim" })),
  threshold: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description: "Confidence threshold (0-1). Default: 0.5",
    }),
  ),
});

const verifyDecompositionSchema = Type.Object({
  parentTask: Type.String({ description: "Original task description" }),
  subtasks: Type.Array(Type.String(), { description: "List of subtask descriptions" }),
  constraints: Type.Optional(
    Type.Array(Type.String(), { description: "Optional known constraints" }),
  ),
});

// ── Extension registration ─────────────────────────────────────────────────────

export default function verificationExtension(pi: ExtensionAPI) {
  log.info("Verification extension registering");

  pi.registerTool({
    name: "verify_claim",
    label: "Verify Claim",
    promptSnippet: "Verify agent claims against retrieved context",
    description:
      "Verify agent claims against retrieved context — use when conclusions depend on evidence. Detects contradictions, unsupported assertions, and hedge word issues.",
    parameters: verifyClaimSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: ExtensionContext,
    ): Promise<Record<string, unknown>> => {
      try {
        const p = params as {
          claim: string;
          context: string[];
          claimId?: string;
          threshold?: number;
        };
        if (!p.claim || !Array.isArray(p.context)) {
          throw new Error("verify_claim requires 'claim' (string) and 'context' (string array)");
        }
        const claimId = p.claimId ?? `claim-${Date.now()}`;
        const threshold = p.threshold ?? 0.5;
        const issues: Record<string, unknown>[] = [];

        for (const ctxStr of p.context) {
          const result = await checkContradiction(p.claim, ctxStr, ctx!);
          if (result) issues.push(result);
        }

        const supported = checkSupport(p.claim, p.context, threshold);
        if (!supported && p.context.length > 0) {
          issues.push({
            type: "unsupported",
            severity: "medium",
            description: "Claim not sufficiently supported by any retrieved context.",
            quote: p.claim,
          });
        }

        issues.push(...checkHedgeWords(p.claim));

        const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
        issues.sort((a: any, b: any) => severityOrder[a.severity] - severityOrder[b.severity]);

        const highIssues = issues.filter((i: any) => i.severity === "high");
        const summary =
          highIssues.length > 0
            ? `${highIssues.length} high-severity issue(s): ${highIssues.map((i: any) => i.description).join("; ")}`
            : issues.length > 0
              ? `${issues.length} issue(s): ${issues.map((i: any) => `${i.type}(${i.severity})`).join(", ")}`
              : "Claim verified: no contradictions, supported by context.";

        return {
          content: [{ type: "text" as const, text: summary }],
          details: {
            claimId,
            verified: highIssues.length === 0,
            issues,
            summary,
            checks: {
              contradictions: issues.filter((i: any) => i.type === "contradiction").length,
              unsupported: issues.filter((i: any) => i.type === "unsupported").length,
              hedgeWarnings: issues.filter((i: any) => i.type === "hedge_warning").length,
              gaps: 0,
            },
          },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`verify_claim failed: ${msg}`);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          details: { verified: false, issues: [], summary: `Error: ${msg}`, error: msg },
        };
      }
    },
  } as any);

  pi.registerTool({
    name: "verify_decomposition",
    label: "Verify Decomposition",
    promptSnippet: "Verify task decomposition fully covers the parent task",
    description:
      "Check a task decomposition for coverage gaps — use after breaking down a complex task into subtasks.",
    parameters: verifyDecompositionSchema,
    execute: async (_toolCallId: string, params: any): Promise<Record<string, unknown>> => {
      try {
        const p = params as { parentTask: string; subtasks: string[]; constraints?: string[] };
        if (!p.parentTask || !Array.isArray(p.subtasks)) {
          throw new Error(
            "verify_decomposition requires 'parentTask' (string) and 'subtasks' (string array)",
          );
        }
        const cov = checkDecompositionCoverage(p.parentTask, p.subtasks, p.constraints);
        const text = cov.complete
          ? `Coverage complete (${(cov.coverage * 100).toFixed(0)}%).`
          : `Gaps: ${cov.gaps.length}. Coverage: ${(cov.coverage * 100).toFixed(0)}%. ${cov.suggestions.slice(0, 3).join("; ")}`;
        return { content: [{ type: "text" as const, text }], details: cov };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`verify_decomposition failed: ${msg}`);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          details: { complete: false, coverage: 0, gaps: [], error: msg },
        };
      }
    },
  } as any);

  log.info("Verification extension registered: verify_claim, verify_decomposition");
}
