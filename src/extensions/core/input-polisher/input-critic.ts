/**
 * Input Critic — pre-classification for input-polisher.
 *
 * PRIMARY PATH: consolidated LLM call via consolidated-input-critic.ts
 *   (single JSON response for all 4 dimensions — ~75% fewer LLM calls).
 *
 * FALLBACK PATH: 4 parallel classify() calls with individual critics.
 *   Only used when the consolidated path fails entirely (model error,
 *   JSON parse failure). This preserves backward compatibility and
 *   ensures the polisher never blocks on a model failure.
 *
 * The parallel path still uses the central critic-registry.ts definitions
 * for runtime observability (critic-stats tracking, per-critic call counts).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify, type ClassificationResult } from "../../../lib/ai/text-classifier.js";
import { CRITICS } from "../../../lib/ai/critic-registry.js";
import { inputCodeHeavyFallback } from "../../../lib/ai/critic-fallbacks.js";
import { consolidatedCritiqueInput } from "./consolidated-input-critic.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CritiqueResult {
	/** True if the text is primarily code - skip polishing. */
	isCode: boolean;
	/** True if the text is well-written - skip polishing. */
	isWellWritten: boolean;
	/** True if the text is clearly written and coherent. */
	isClear: boolean;
	/** True if the text is vague or ambiguous - may need clarification prompt. */
	isAmbiguous: boolean;
	/** Lowest-confidence tier across all checks. */
	tier: "utility" | "session" | "heuristic" | "failed";
	/** Per-check results for observability. */
	checks: {
		codeHeavy: ClassificationResult;
		wellWritten: ClassificationResult;
		clarity: ClassificationResult;
		ambiguity: ClassificationResult;
	};
}

/**
 * Run all five classification checks in parallel.
 *
 * Each check runs classify() with the central critic's criteria and a
 * heuristic fallback defined alongside it. If the utility model is
 * configured, all five finish in ~50ms parallel. If not configured, all
 * five use the session model (~100ms parallel). If no model works, all
 * five use heuristics (~0.03ms).
 */
export async function critiqueInput(text: string, ctx: ExtensionContext): Promise<CritiqueResult> {
	// PRIMARY PATH: consolidated single-LLM-call (4 dimensions in one JSON response)
	try {
		const result = await consolidatedCritiqueInput(text, ctx);
		if (result.tier !== "failed") {
			return result;
		}
	} catch {
		// Fall through to parallel path
	}

	// FALLBACK PATH: 4 parallel classify() calls with individual critics
	const truncated = text.length > 2000 ? text.slice(0, 2000) + "..." : text;

	const [codeSettled, wellWrittenSettled, claritySettled, ambiguitySettled] = await Promise.allSettled([
		classify(
			ctx,
			CRITICS.inputCodeHeavy.criteria,
			{ text: truncated },
			{
				timeoutMs: 60_000,
				fallback: () => inputCodeHeavyFallback(text),
			},
		),
		classify(
			ctx,
			CRITICS.inputWellWritten.criteria,
			{ text: truncated },
			{
				timeoutMs: 60_000,
				tierPolicy: "always-llm" as const,
			},
		),
		classify(
			ctx,
			CRITICS.inputClarity.criteria,
			{ text: truncated },
			{
				timeoutMs: 60_000,
				tierPolicy: "always-llm" as const,
			},
		),
		classify(
			ctx,
			CRITICS.inputAmbiguity.criteria,
			{ text: truncated },
			{
				timeoutMs: 60_000,
				tierPolicy: "always-llm" as const,
			},
		),
	]);

	// Unwrap allSettled: a failed call becomes null (treated as 'no' label).
	const unwrap = (r: PromiseSettledResult<Awaited<ReturnType<typeof classify>>>) =>
		r.status === "fulfilled" ? r.value : null;
	const codeResult = unwrap(codeSettled);
	const wellWrittenResult = unwrap(wellWrittenSettled);
	const clarityResult = unwrap(claritySettled);
	const ambiguityResult = unwrap(ambiguitySettled);

	// Determine the overall tier (lowest-confidence across all four).
	const tiers = [codeResult?.tier, wellWrittenResult?.tier, clarityResult?.tier, ambiguityResult?.tier];
	const anySucceeded = tiers.some(t => t === "utility" || t === "session" || t === "heuristic");
	const overallTier: "utility" | "session" | "heuristic" | "failed" = !anySucceeded
		? "failed"
		: tiers.includes("heuristic")
			? ("heuristic" as const)
			: tiers.includes("session")
				? ("session" as const)
				: ("utility" as const);

	return {
		isCode: codeResult?.label === "yes",
		isWellWritten: wellWrittenResult?.label === "yes",
		isClear: clarityResult?.label === "yes",
		isAmbiguous: ambiguityResult?.label === "yes",
		tier: overallTier,
		checks: {
			codeHeavy: codeResult ?? failedResult,
			wellWritten: wellWrittenResult ?? failedResult,
			clarity: clarityResult ?? failedResult,
			ambiguity: ambiguityResult ?? failedResult,
		},
	};
}

// Fallback ClassificationResult for failed (rejected) allSettled calls.
// The label is empty (not "yes"/"no") so consumers can treat it as
// "no signal" rather than misreading it as a positive classification.
const failedResult: ClassificationResult = {
	label: "",
	confidence: 0,
	raw: "",
	tier: "heuristic",
	latencyMs: 0,
};
