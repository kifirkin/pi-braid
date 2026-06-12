/**
 * Input Critic - Utility-model pre-classification for input-polisher.
 *
 * Thin wrapper that runs the five input-polisher critics (registered
 * centrally in lib/ai/critic-registry.ts) in parallel and assembles a
 * CritiqueResult for the polisher's processMessage() handler.
 *
 * Each check is a lightweight yes/no classification call to the configured
 * utility model (or session model fallback). Heuristic fallbacks are also
 * defined in the critic registry as Tier 1 graceful degradation.
 *
 * Centralizing the criteria + fallbacks in critic-registry.ts means:
 * - Every classify() call is automatically tracked in lib/ai/critic-stats.ts
 *   (per-critic call counts, tier distribution, latency).
 * - The criteria are discoverable in one place.
 * - Other extensions can reuse the same critics if needed.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify, type ClassificationResult } from "../../../lib/ai/text-classifier.js";
import { CRITICS } from "../../../lib/ai/critic-registry.js";

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
	tier: "utility" | "session" | "heuristic";
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
	// Truncate very long text to keep prompt tokens reasonable
	const truncated = text.length > 2000 ? text.slice(0, 2000) + "..." : text;

	const [codeResult, wellWrittenResult, clarityResult, ambiguityResult] = await Promise.all([
		classify(
			ctx,
			CRITICS.inputCodeHeavy.criteria,
			{ text: truncated },
			{
				maxTokens: 5,
				timeoutMs: 5000,
				fallback: () => CRITICS.inputCodeHeavyFallback(text),
			},
		),
		classify(
			ctx,
			CRITICS.inputWellWritten.criteria,
			{ text: truncated },
			{
				maxTokens: 5,
				timeoutMs: 5000,
				fallback: () => CRITICS.inputWellWrittenFallback(text),
			},
		),
		classify(
			ctx,
			CRITICS.inputClarity.criteria,
			{ text: truncated },
			{
				maxTokens: 5,
				timeoutMs: 5000,
				fallback: () => CRITICS.inputClarityFallback(text),
			},
		),
		classify(
			ctx,
			CRITICS.inputAmbiguity.criteria,
			{ text: truncated },
			{
				maxTokens: 5,
				timeoutMs: 5000,
				fallback: () => CRITICS.inputAmbiguityFallback(text),
			},
		),
	]);

	// Determine the overall tier (lowest across all four)
	const tiers = [codeResult.tier, wellWrittenResult.tier, clarityResult.tier, ambiguityResult.tier];
	const overallTier = tiers.includes("heuristic")
		? ("heuristic" as const)
		: tiers.includes("session")
			? ("session" as const)
			: ("utility" as const);

	return {
		isCode: codeResult.label === "yes",
		isWellWritten: wellWrittenResult.label === "yes",
		isClear: clarityResult.label === "yes",
		isAmbiguous: ambiguityResult.label === "yes",
		tier: overallTier,
		checks: {
			codeHeavy: codeResult,
			wellWritten: wellWrittenResult,
			clarity: clarityResult,
			ambiguity: ambiguityResult,
		},
	};
}
