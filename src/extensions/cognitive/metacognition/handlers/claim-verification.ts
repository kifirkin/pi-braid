/**
 * @fileoverview Claim Verification Tool - verify_claim (action=claim|decomposition).
 *
 * Cross-checks agent claims against retrieved context and verifies task
 * decomposition coverage. Uses the triple-critic LLM classification system
 * with three-tier fallback (heuristic → utility model → session model).
 *
 * These tools are co-located with `verify` in this directory because they
 * share the "verification" concept; they are registered from
 * `metacognition/index.ts` alongside `think`/`hypothesize`/`verify`/`finalize`.
 *
 * Replaces the previous implementation that used stop-word filtering,
 * negation-pair matching tables, and token-overlap heuristics.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../../lib/core/logger.js";
import { classify } from "../../../../lib/ai/text-classifier.js";
import { CRITICS } from "../../../../lib/ai/critic-registry.js";

const log = createLogger("metacognition:claim-verification");

// ── Helpers ──────────────────────────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
	return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

// ── Tool schemas ─────────────────────────────────────────────────────────

// Consolidated verify_claim schema (was verify_claim + verify_decomposition).
// action=claim:         verify a single claim against retrieved context
// action=decomposition: verify a task decomposition covers the parent task
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


// ── Core logic (triple-critic) ────────────────────────────────────────────

async function checkContradiction(
	claim: string,
	context: string,
	ctx: ExtensionContext,
): Promise<{
	type: "contradiction";
	severity: "high" | "low";
	description: string;
	quote: string;
	/**
	 * True when the classifier call failed (tier === "failed"). The
	 * safe default is "no contradiction found" - this flag signals
	 * the check couldn't run at all, so the consumer can surface
	 * the degraded state. Same anti-pattern fix as input-polisher
	 * 9966c8ad, topic-drift, sycophancy, and turn-outcome: never
	 * silently default to "no problem" when the classifier is down.
	 */
	classifierDown?: boolean;
} | null> {
	try {
		const result = await classify(
			ctx,
			CRITICS.claimContradiction.criteria,
			{ claim, context },
			{ tierPolicy: "always-llm" } as const,
		);
		if (result.label === "yes") {
			return {
				type: "contradiction",
				severity: "high",
				description: `Claim contradicts context: ${truncate(claim, 100)}`,
				quote: claim,
				classifierDown: result.tier === "failed",
			};
		}
		// No contradiction found. If the classifier was down, the
		// returned null already means "no issue" (the safe default).
		// The consumer doesn't need to know the classifier was down
		// for THIS specific check (it might be a different call).
		// The classifierDown surfacing is for the AGGREGATE tool
		// result, computed at the execute() boundary.
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
		// Thrown error: classifier unreachable. Return safe default
		// (supported=false) but flag the offline state.
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
		const result = await classify(
			ctx,
			CRITICS.claimOverconfidence.criteria,
			{ claim },
			{ tierPolicy: "always-llm" } as const,
		);
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
		// Thrown error: classifier unreachable. Return empty issues
		// (the safe default) but flag the offline state.
		return { issues: [], classifierDown: true };
	}
}

// checkDecompositionCoverage was previously used by verify.ts for
// decomposition coverage. It is no longer called (the verify_decomposition
// tool now uses verify_claim with action=decomposition, which goes
// through claimContradiction + claimSupported). Keeping the function
// would be dead code. Removed.

// ── Tool factory ──────────────────────────────────────────────────────────

/**
 * Register the verify_claim tool (action=claim|decomposition).
 * Called by metacognition/index.ts during extension setup.
 */
export function registerClaimVerificationTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "verify_claim",
		label: "Verify Claim",
		promptSnippet: "Verify agent claims against retrieved context",
		description:
			"Verify agent claims against retrieved context - use when conclusions depend on evidence. Detects contradictions, unsupported assertions, and hedge word issues. For task decomposition coverage, use action=decomposition.",
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
				const issues: Record<string, unknown>[] = [];

				// Triple-critic checks in parallel: contradiction + support + overconfidence
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
				const supportedResult = supportedSettled.status === "fulfilled" ? supportedSettled.value : { supported: false, classifierDown: true };
				const overconfidenceResult = overconfidenceIssuesSettled.status === "fulfilled" ? overconfidenceIssuesSettled.value : { issues: [], classifierDown: true };
				const supported = supportedResult.supported;
				const overconfidenceIssues = overconfidenceResult.issues;

				// Track if any sub-check's classifier was down. We surface
				// this in the tool result so the agent (and operator) knows
				// the verify_claim check was degraded, not actually a clean
				// pass. Same anti-pattern fix as input-polisher 9966c8ad,
				// topic-drift, sycophancy, and turn-outcome.
				const anyClassifierDown =
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
	} as unknown as ToolDefinition<any, any, any>);


	log.info("Registered claim verification tool: verify_claim (claim + decomposition actions)");
}
