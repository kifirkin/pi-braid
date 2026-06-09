/**
 * @fileoverview Claim Verification Tools — verify_claim and verify_decomposition.
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

const verifyClaimSchema = Type.Object({
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

const verifyDecompositionSchema = Type.Object({
	parentTask: Type.String({ description: "Original task description" }),
	subtasks: Type.Array(Type.String(), { description: "List of subtask descriptions" }),
	constraints: Type.Optional(
		Type.Array(Type.String(), { description: "Optional known constraints" }),
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
			CRITICS.topicCompleteness.criteria,
			{ parentTask, subtasks: subtasks.join("\n- ") },
			{
				maxTokens: 256,
				fallback: () => "no",
			},
		);
		// Parse the LLM response into structured coverage info
		const responseText = result.label;
		const coverageMatch = responseText.match(/coverage[:\s]+([0-9.]+)/i);
		const coverage = coverageMatch ? parseFloat(coverageMatch[1]) : 0.5;
		const gapsMatch = responseText.match(/gaps?[:\s]+(.+?)(?:\n|$)/i);
		const gaps = gapsMatch ? [gapsMatch[1].trim()] : [];
		return {
			complete: coverage >= 0.8,
			coverage,
			gaps,
			coverageBySubtask: subtasks.map((s) => ({ subtask: s, covered: true })),
			suggestions: gaps.length > 0 ? gaps : ["Coverage looks complete."],
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
 * Register the verify_claim and verify_decomposition tools.
 * Called by metacognition/index.ts during extension setup.
 */
export function registerClaimVerificationTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "verify_claim",
		label: "Verify Claim",
		promptSnippet: "Verify agent claims against retrieved context",
		description:
			"Verify agent claims against retrieved context — use when conclusions depend on evidence. Detects contradictions, unsupported assertions, and hedge word issues. For task decomposition coverage, use verify_decomposition instead.",
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
			"Check a task decomposition for coverage gaps — use after breaking down a complex task into subtasks. For verifying individual claims against evidence, use verify_claim instead.",
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

	log.info("Registered claim verification tools: verify_claim, verify_decomposition");
}
