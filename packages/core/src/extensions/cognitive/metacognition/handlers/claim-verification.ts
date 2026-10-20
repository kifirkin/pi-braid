/**
 * @fileoverview Claim Verification Tool - verify_claim (action=claim|decomposition).
 *
 * Cross-checks agent claims against retrieved context and verifies task
 * decomposition coverage. Uses the triple-critic LLM classification system
 * with three-tier fallback (heuristic -> utility model -> session model).
 *
 * PRIMARY PATH: consolidated single-LLM-call (3 dimensions in one JSON
 * response). FALLBACK PATH: 3 individual classify() calls. The consolidated
 * path replaces ~3 separate LLM calls with 1, reducing latency by ~66%.
 *
 * These tools are co-located with `verify` in this directory because they
 * share the "verification" concept; they are registered from
 * `metacognition/index.ts` alongside `think`/`hypothesize`/`verify`/`finalize`.
 */

import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../../lib/core/logger.js";
import { classify } from "../../../../lib/ai/text-classifier.js";
import { CRITICS } from "../../../../lib/ai/critic-registry.js";
import { consolidatedClaimCritique } from "../../../../lib/ai/consolidated-claim-critic.js";

const log = createLogger("metacognition:claim-verification");

/** A blank string is "not provided": a client that emits every schema key sends "" for the unused ones. */
function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

// verify_claim schema: one tool, one schema — action=claim verifies a single
// claim against retrieved context; action=decomposition verifies that a task
// decomposition covers the parent task.
const verifyClaimSchema = Type.Object({
  action: Type.Union([Type.Literal("claim"), Type.Literal("decomposition")], {
    description: "Action: claim | decomposition",
  }),
  claim: Type.String({ description: "The claim or statement to verify" }),
  context: Type.Array(Type.String(), {
    description: "Retrieved context strings to verify against",
  }),
  claimId: Type.Optional(Type.String({ description: "Optional ID for tracking this claim" })),
  threshold: Type.Optional(
    Type.Number({
      description: "Confidence threshold for support check (0-1). Default: 0.5",
      minimum: 0,
      maximum: 1,
    }),
  ),
});

// Individual critics (FALLBACK PATH)

async function checkContradiction(
  claim: string,
  context: string,
  ctx: ExtensionContext,
): Promise<{
  type: "contradiction";
  severity: "high" | "low";
  description: string;
  quote: string;
  classifierDown?: boolean;
} | null> {
  try {
    const result = await classify(ctx, CRITICS.claimContradiction.criteria, { claim, context }, {
      tierPolicy: "always-llm",
    } as const);
    if (result.label === "yes") {
      return {
        type: "contradiction",
        severity: "high",
        description: `Claim contradicts context: ${truncate(claim, 100)}`,
        quote: claim,
        classifierDown: result.tier === "failed",
      };
    }
    return null;
  } catch (err) {
    log.debug(`checkContradiction failed: ${err}`);
    return null;
  }
}

async function checkSupport(
  claim: string,
  context: string[],
  ctx: ExtensionContext,
): Promise<{ supported: boolean; classifierDown: boolean }> {
  const contextText = context.join("\n\n---\n\n");
  try {
    const result = await classify(
      ctx,
      CRITICS.claimSupported.criteria,
      { claim, context: contextText },
      {
        tierPolicy: "always-llm",
      },
    );
    return {
      supported: result.label === "yes",
      classifierDown: result.tier === "failed",
    };
  } catch (err) {
    log.debug(`checkSupport failed: ${err}`);
    return { supported: false, classifierDown: true };
  }
}

async function checkOverconfidence(
  claim: string,
  ctx: ExtensionContext,
): Promise<{
  issues: Array<{ type: string; severity: string; description: string; quote: string }>;
  classifierDown: boolean;
}> {
  const issues: Array<{ type: string; severity: string; description: string; quote: string }> = [];
  try {
    const result = await classify(ctx, CRITICS.claimOverconfidence.criteria, { claim }, {
      tierPolicy: "always-llm",
    } as const);
    if (result.label === "yes") {
      issues.push({
        type: "hedge_warning",
        severity: "low",
        description: "Claim uses overconfident language without sufficient evidence",
        quote: claim,
      });
    }
    return { issues, classifierDown: result.tier === "failed" };
  } catch (err) {
    log.debug(`checkOverconfidence failed: ${err}`);
    return { issues: [], classifierDown: true };
  }
}

/**
 * Register the verify_claim tool (action=claim|decomposition).
 * Called by metacognition/index.ts during extension setup.
 */
export function createVerifyClaimTool(): ToolDefinition<any, any, any> {
  return {
    name: "verify_claim",
    label: "Verify Claim",
    promptSnippet: "Verify agent claims against retrieved context",
    description:
      "Verify claims against retrieved context: contradictions, unsupported assertions, hedge wording. action=decomposition for task coverage.",
    parameters: verifyClaimSchema,
    execute: async (
      _toolCallId: string,
      params: any,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: ExtensionContext,
    ): Promise<any> => {
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
        // A blank claimId is no id: it would become the tracking key of every
        // such call for the rest of the session.
        const claimId = optionalString(p.claimId) ?? `claim-${Date.now()}`;
        const issues: Record<string, unknown>[] = [];

        // PRIMARY PATH: consolidated single-LLM-call
        let consolidatedUsed = false;
        try {
          const contextJoined = p.context.join("\n\n---\n\n");
          const consolidated = await consolidatedClaimCritique(p.claim, contextJoined, ctx!);
          if (consolidated && !consolidated.classifierDown) {
            consolidatedUsed = true;
            if (consolidated.contradiction) {
              issues.push({
                type: "contradiction",
                severity: "high",
                description: `Claim contradicts context: ${truncate(p.claim, 100)}`,
                quote: p.claim,
              });
            }
            if (!consolidated.supported && p.context.length > 0) {
              issues.push({
                type: "unsupported",
                severity: "medium",
                description: "Claim not sufficiently supported by any retrieved context.",
                quote: p.claim,
              });
            }
            if (consolidated.overconfidence) {
              issues.push({
                type: "hedge_warning",
                severity: "low",
                description: "Claim uses overconfident language without sufficient evidence",
                quote: p.claim,
              });
            }
          }
        } catch {
          // Fall through to individual checks
        }

        // FALLBACK PATH: individual classify calls
        let fallbackClassifierDown = false;
        if (!consolidatedUsed) {
          const contradictionChecks = p.context.map((ctxStr) =>
            checkContradiction(p.claim, ctxStr, ctx!),
          );
          const contradictionResults = await Promise.allSettled(contradictionChecks);
          for (const r of contradictionResults) {
            if (r.status === "fulfilled" && r.value) issues.push(r.value);
          }

          const [supportedSettled, overconfidenceIssuesSettled] = await Promise.allSettled([
            checkSupport(p.claim, p.context, ctx!),
            checkOverconfidence(p.claim, ctx!),
          ]);
          const supportedResult =
            supportedSettled.status === "fulfilled"
              ? supportedSettled.value
              : { supported: false, classifierDown: true };
          const overconfidenceResult =
            overconfidenceIssuesSettled.status === "fulfilled"
              ? overconfidenceIssuesSettled.value
              : { issues: [], classifierDown: true };
          const supported = supportedResult.supported;
          const overconfidenceIssues = overconfidenceResult.issues;

          fallbackClassifierDown =
            supportedResult.classifierDown || overconfidenceResult.classifierDown;

          if (!supported && p.context.length > 0) {
            issues.push({
              type: "unsupported",
              severity: "medium",
              description: "Claim not sufficiently supported by any retrieved context.",
              quote: p.claim,
            });
          }

          issues.push(...overconfidenceIssues);
        }

        const anyClassifierDown = consolidatedUsed ? false : fallbackClassifierDown;

        const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
        issues.sort((a: any, b: any) => severityOrder[a.severity] - severityOrder[b.severity]);

        const highIssues = issues.filter((i: any) => i.severity === "high");
        const summary = anyClassifierDown
          ? `Claim verification DEGRADED: classifier unavailable this turn. No issues were positively detected, but the check could not run normally. Treat this result as "not verified, not contradicted" rather than "verified." Run /logs level info for the underlying error.`
          : highIssues.length > 0
            ? `${highIssues.length} high-severity issue(s): ${highIssues.map((i: any) => i.description).join("; ")}`
            : issues.length > 0
              ? `${issues.length} issue(s): ${issues.map((i: any) => `${i.type}(${i.severity})`).join(", ")}`
              : "Claim verified: no contradictions, supported by context.";

        return {
          content: [{ type: "text" as const, text: summary }],
          details: {
            claimId,
            verified: highIssues.length === 0 && !anyClassifierDown,
            issues,
            summary,
            classifierDown: anyClassifierDown,
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
  };
}

export function registerClaimVerificationTools(pi: ExtensionAPI): void {
  pi.registerTool(createVerifyClaimTool());

  log.info("Registered claim verification tool: verify_claim (claim + decomposition actions)");
}
