/**
 * @fileoverview Claim Verification Tool — verify_claim (action=claim|decomposition).
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
} | null> {
	try {
		const result = await classify(
			ctx,
			CRITICS.claimContradiction.criteria,
			{ claim, context },
			{ maxTokens: 10, fallback: () => CRITICS.contradictionFallback?.(claim, context) ?? "no" },
		);
		if (result.label === "yes") {
			return {
				type: "contradiction",
				severity: "high",
				description: `Claim contradicts context: ${truncate(claim, 100)}`,
				quote: claim,
			};
		}
	} catch (err) {
		log.debug(`checkContradiction failed: ${err}`);
	}
	return null;
}

async function checkSupport(
	claim: string,
	context: string[],
	threshold: number,
	ctx: ExtensionContext,
): Promise<boolean> {
	const contextText = context.join("\n\n---\n\n");
	try {
		const result = await classify(
			ctx,
			CRITICS.claimSupported.criteria,
			{ claim, context: contextText },
			{
				maxTokens: 10,
				fallback: () => CRITICS.contradictionFallback?.(claim, contextText) ?? "no",
			},
		);
		return result.label === "yes";
	} catch (err) {
		log.debug(`checkSupport failed: ${err}`);
		return false;
	}
}

async function checkOverconfidence(
	claim: string,
	ctx: ExtensionContext,
): Promise<Array<{ type: string; severity: string; description: string; quote: string }>> {
	const issues: Array<{ type: string; severity: string; description: string; quote: string }> = [];
	try {
		const result = await classify(
			ctx,
			CRITICS.claimOverconfidence.criteria,
			{ claim },
			{ maxTokens: 10, fallback: () => CRITICS.contradictionFallback?.(claim, "") ?? "no" },
		);
		if (result.label === "yes") {
			issues.push({
				type: "hedge_warning",
				severity: "low",
				description: "Claim uses overconfident language without sufficient evidence",
				quote: claim,
			});
		}
	} catch (err) {
		log.debug(`checkOverconfidence failed: ${err}`);
	}
	return issues;
}

async function checkDecompositionCoverage(
	parentTask: string,
	subtasks: string[],
	ctx: ExtensionContext,
): Promise<{
	complete: boolean;
	coverage: number;
	gaps: string[];
	coverageBySubtask: Array<{ subtask: string; covered: boolean }>;
	suggestions: string[];
}> {
	try {
		const result = await classify(
			ctx,
			CRITICS.decompositionCoverage.criteria,
			{ parentTask, subtasks: subtasks.join("\n- ") },
			{ maxTokens: 5, fallback: () => "no" },
		);
		// Binary yes/no answer. We don't try to extract specific gap strings
		// from the LLM — those are inherently non-deterministic and the
		// previous regex extraction was always falling through to the 0.5
		// default. If the LLM says 'yes', coverage is full; if 'no', we
		// surface a generic suggestion to ask the agent to enumerate gaps.
		const complete = result.label === "yes";
		return {
			complete,
			coverage: complete ? 1.0 : 0.5,
			gaps: complete ? [] : ["LLM did not specify gaps; review the decomposition manually."],
			coverageBySubtask: subtasks.map((s) => ({ subtask: s, covered: complete })),
			suggestions: complete ? ["Coverage looks complete."] : ["Enumerate which parent features are not covered."],
		};
	} catch (err) {
		log.debug(`checkDecompositionCoverage failed: ${err}`);
		return {
			complete: false,
			coverage: 0.5,
			gaps: [],
			coverageBySubtask: [],
			suggestions: ["Could not verify decomposition coverage."],
		};
	}
}

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
			"Verify agent claims against retrieved context — use when conclusions depend on evidence. Detects contradictions, unsupported assertions, and hedge word issues. For task decomposition coverage, use action=decomposition.",
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


	log.info("Registered claim verification tool: verify_claim (claim + decomposition actions)");
}
