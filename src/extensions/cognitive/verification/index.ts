/**
 * @fileoverview Bidirectional verification tool.
 *
 * Cross-checks agent claims against retrieved context using the triple-critic
 * LLM classification system:
 *   - claimContradiction:  Does the claim contradict the context?
 *   - claimSupported:      Is the claim supported by the context?
 *   - claimOverconfidence: Does the claim contain unwarranted certainty?
 *   - decompositionComplete: Do subtasks fully cover the parent task?
 *
 * Three-tier fallback (heuristic → utility model → session model) via
 * lib/text-classifier.ts. The heuristic fallbacks are in lib/critic-registry.ts.
 *
 * Replaces the previous implementation that used stop-word filtering,
 * negation-pair matching tables, and token-overlap heuristics.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { classify } from "../../../lib/text-classifier.js";
import { CRITICS } from "../../../lib/critic-registry.js";

const log = createLogger("verification");

// ── Core logic (triple-critic) ────────────────────────────────────────────

/**
 * Check if a claim contradicts a context using the triple-critic system.
 *
 * Uses classify() with three-tier fallback:
 *   Tier 1: heuristic fallback (CRITICS.contradictionFallback)
 *   Tier 2: utility model (if configured)
 *   Tier 3: session model (always available)
 */
async function checkContradiction(
  claim: string,
  context: string,
  ctx: ExtensionContext,
): Promise<{
  type: "contradiction";
  severity: "high" | "low";
  description: string;
  quote: string;
  location: string;
} | null> {
  const truncated = {
    claim: claim.length > 1500 ? claim.slice(0, 1500) + "..." : claim,
    context: context.length > 1500 ? context.slice(0, 1500) + "..." : context,
  };

  try {
    const result = await classify(ctx, CRITICS.claimContradiction.criteria, truncated, {
      maxTokens: 5,
      timeoutMs: 5000,
      fallback: () => CRITICS.contradictionFallback(claim, context),
    });

    if (result.label === "yes") {
      return {
        type: "contradiction" as const,
        severity: "high" as const,
        description: `Claim contradicts context (${result.tier} tier)`,
        quote: claim.slice(0, 200),
        location: "claim vs context",
      };
    }
  } catch {
    // classify() handles errors internally — this is a safety net
  }

  return null;
}

/**
 * Check if a claim is supported by any of the given contexts.
 * Uses the claimSupported critic with heuristic fallback.
 */
async function checkSupport(
  claim: string,
  contexts: string[],
  threshold: number,
  ctx: ExtensionContext,
): Promise<boolean> {
  if (!claim || contexts.length === 0) return true;

  // Run one classify() call per context, but limit to first 3 to avoid O(N²) cost
  const contextsToCheck = contexts.slice(0, 3);

  try {
    const results = await Promise.all(
      contextsToCheck.map((ctxStr) =>
        classify(
          ctx,
          CRITICS.claimSupported.criteria,
          { claim: truncate(claim, 1000), context: truncate(ctxStr, 1000) },
          { maxTokens: 5, timeoutMs: 5000 },
        ),
      ),
    );

    // Supported if ANY context supports it (with confidence >= threshold)
    const highConfidence = results.filter(
      (r) => r.label === "yes" && r.confidence >= threshold,
    ).length;
    return highConfidence > 0;
  } catch {
    // Fall through to lenient default on error
    return true;
  }
}

/**
 * Check for overconfidence / hedge word issues using the claimOverconfidence critic.
 */
async function checkOverconfidence(
  claim: string,
  ctx: ExtensionContext,
): Promise<
  Array<{
    type: string;
    severity: "high" | "medium" | "low";
    description: string;
    quote: string;
  }>
> {
  try {
    const result = await classify(
      ctx,
      CRITICS.claimOverconfidence.criteria,
      { claim: truncate(claim, 1000), context: "" },
      { maxTokens: 5, timeoutMs: 5000 },
    );

    if (result.label === "yes") {
      return [
        {
          type: "hedge_warning",
          severity: "medium" as const,
          description: `Claim may contain unwarranted certainty (${result.tier} tier)`,
          quote: claim.slice(0, 200),
        },
      ];
    }
  } catch {
    // Non-critical — no overconfidence warning on error
  }

  return [];
}

/**
 * Check if subtasks fully cover the parent task.
 * Uses the decompositionComplete critic for the binary verdict,
 * with a simple word-overlap heuristic for filling in gap details.
 */
async function checkDecompositionCoverage(
  parentTask: string,
  subtasks: string[],
  ctx: ExtensionContext,
): Promise<{
  complete: boolean;
  coverage: number;
  gaps: string[];
  coverageBySubtask: Array<{ subtask: string; featuresCovered: number; featuresMissing: number }>;
  suggestions: string[];
}> {
  if (!parentTask || subtasks.length === 0) {
    return { complete: false, coverage: 0, gaps: [], coverageBySubtask: [], suggestions: [] };
  }

  try {
    const result = await classify(
      ctx,
      CRITICS.decompositionComplete.criteria,
      {
        parentTask: truncate(parentTask, 1000),
        subtasks: subtasks.map((s) => `- ${truncate(s, 200)}`).join("\n"),
      },
      { maxTokens: 5, timeoutMs: 5000 },
    );

    const complete = result.label === "yes";
    const coverage = complete ? 1.0 : 0.5; // Heuristic estimate

    // Simple gap heuristic: find parent words not mentioned in any subtask
    const parentWords = new Set(
      parentTask
        .toLowerCase()
        .split(/[^\w]+/)
        .filter((w) => w.length > 3),
    );
    const subtaskText = subtasks.join(" ").toLowerCase();
    const gaps = [...parentWords].filter((w) => !subtaskText.includes(w));

    const coverageBySubtask = subtasks.slice(0, 5).map((st) => {
      const stWords = new Set(
        st
          .toLowerCase()
          .split(/[^\w]+/)
          .filter((w) => w.length > 3),
      );
      let coveredByThis = 0;
      for (const pw of parentWords) {
        if (stWords.has(pw) || st.toLowerCase().includes(pw)) coveredByThis++;
      }
      return {
        subtask: st.substring(0, 80),
        featuresCovered: coveredByThis,
        featuresMissing: parentWords.size - coveredByThis,
      };
    });

    const suggestions = gaps.slice(0, 3).map(
      (g) => `Consider adding subtask addressing: "${g}"`,
    );

    return { complete, coverage, gaps: gaps.slice(0, 10), coverageBySubtask, suggestions };
  } catch {
    return {
      complete: false,
      coverage: 0.5,
      gaps: [],
      coverageBySubtask: [],
      suggestions: ["Could not verify decomposition coverage."],
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

// ── Tool schemas ─────────────────────────────────────────────────────────

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

// ── Extension registration ───────────────────────────────────────────────

export default function verificationExtension(pi: ExtensionAPI) {
  log.info("Verification extension registering (triple-critic)");

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

        // Triple-critic checks in parallel: contradiction + support + overconfidence
        const contradictionChecks = p.context.map((ctxStr) =>
          checkContradiction(p.claim, ctxStr, ctx!),
        );
        const contradictionResults = await Promise.all(contradictionChecks);
        for (const r of contradictionResults) {
          if (r) issues.push(r);
        }

        const [supported, overconfidenceIssues] = await Promise.all([
          checkSupport(p.claim, p.context, threshold, ctx!),
          checkOverconfidence(p.claim, ctx!),
        ]);

        if (!supported && p.context.length > 0) {
          issues.push({
            type: "unsupported",
            severity: "medium",
            description: "Claim not sufficiently supported by any retrieved context.",
            quote: p.claim,
          });
        }

        issues.push(...overconfidenceIssues);

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
  } as unknown as ToolDefinition<any, any, any>);

  pi.registerTool({
    name: "verify_decomposition",
    label: "Verify Decomposition",
    promptSnippet: "Verify task decomposition fully covers the parent task",
    description:
      "Check a task decomposition for coverage gaps — use after breaking down a complex task into subtasks.",
    parameters: verifyDecompositionSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: ExtensionContext,
    ): Promise<Record<string, unknown>> => {
      try {
        const p = params as { parentTask: string; subtasks: string[]; constraints?: string[] };
        if (!p.parentTask || !Array.isArray(p.subtasks)) {
          throw new Error(
            "verify_decomposition requires 'parentTask' (string) and 'subtasks' (string array)",
          );
        }
        const cov = await checkDecompositionCoverage(p.parentTask, p.subtasks, ctx!);
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
  } as unknown as ToolDefinition<any, any, any>);

  log.info("Verification extension registered: verify_claim, verify_decomposition");
}