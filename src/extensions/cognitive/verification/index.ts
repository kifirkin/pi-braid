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
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../../lib/logger.js";

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
  "day",
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
  "boy",
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
]);

// ── Core logic ────────────────────────────────────────────────────────────────

function extractFeatures(text: string): Set<string> {
  // Extract tokens (min 2 chars) + compound words for better matching
  const normalized = text.toLowerCase();
  const words = normalized.split(/[^\w]+/).filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  const compounds = normalized.match(/\w{4,}/g) || [];
  return new Set([...words, ...compounds]);
}

function semanticOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token) || Array.from(b).some((bt) => token.includes(bt) || bt.includes(token))) {
      intersection++;
    }
  }
  return intersection / (a.size + b.size - intersection);
}

// Positive-negation pairs to detect contradictions
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

function checkContradiction(claim: string, context: string) {
  const claimLower = claim.toLowerCase();
  const contextLower = context.toLowerCase();

  for (const [pos, neg] of MATCH_PAIRS) {
    if (claimLower.includes(pos) && contextLower.includes(neg)) {
      return {
        type: "contradiction",
        severity: "high" as const,
        description: `Claim uses "${pos}" but context suggests "${neg}"`,
        quote: claim,
        location: "claim vs context",
      };
    }
    if (claimLower.includes(neg) && contextLower.includes(pos)) {
      return {
        type: "contradiction",
        severity: "high" as const,
        description: `Claim uses "${neg}" but context suggests "${pos}"`,
        quote: claim,
        location: "claim vs context",
      };
    }
  }

  // Check semantic overlap
  const claimFeatures = extractFeatures(claim);
  const contextFeatures = extractFeatures(context);
  const overlap = semanticOverlap(claimFeatures, contextFeatures);

  if (overlap < 0.1 && claimFeatures.size > 3) {
    return {
      type: "contradiction",
      severity: "low" as const,
      description: `Claim and context share very few features (${(overlap * 100).toFixed(0)}% overlap). Possible topic drift.`,
      quote: claim,
      location: "semantic mismatch",
    };
  }

  return null;
}

function checkSupport(claim: string, contexts: string[], threshold = 0.3): boolean {
  const claimFeatures = extractFeatures(claim);
  if (claimFeatures.size === 0) return true;
  for (const ctx of contexts) {
    if (semanticOverlap(claimFeatures, extractFeatures(ctx)) >= threshold) return true;
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
    execute: async (_toolCallId: string, params: any): Promise<Record<string, unknown>> => {
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

        for (const ctx of p.context) {
          const result = checkContradiction(p.claim, ctx);
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
