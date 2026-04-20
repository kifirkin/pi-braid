// ── Cognition Evaluator ───────────────────────────────────────────────────────
// Evaluates think/hypothesize/finalize quality from session evidence.
// Measures: reasoning depth, hypothesis coverage, verification rigor.

export interface CognitionMetrics {
	thinks: number;
	hypothesizes: number;
	finalizes: number;
	avgConfidence: number;
	hypothesesGenerated: number;
	hypothesesWithVerification: number;
	finalizationsBlocked: number;
	depthDistribution: Record<string, number>;
	reasoningTags: Record<string, number>;
}

export interface CognitionScore {
	overall: number;         // 0-100
	reasoningDepth: number;  // 0-100
	hypothesisQuality: number; // 0-100
	verificationRigor: number; // 0-100
	recommendations: string[];
}

/** Evaluate cognition quality from collected metrics. */
export function evaluateCognition(metrics: CognitionMetrics): CognitionScore {
	const recommendations: string[] = [];

	// 1. Reasoning depth (30% weight)
	let reasoningDepth = 50;
	if (metrics.thinks > 0) {
		const deepRatio = (metrics.depthDistribution["deep"] ?? 0) / metrics.thinks;
		reasoningDepth = Math.min(100, 30 + deepRatio * 70);
		// Bonus for diverse types
		const typeCount = Object.keys(metrics.reasoningTags).length;
		reasoningDepth = Math.min(100, reasoningDepth + typeCount * 5);
	} else {
		recommendations.push("No think calls recorded — agent may be acting without reflection");
	}

	// 2. Hypothesis quality (35% weight)
	let hypothesisQuality = 50;
	if (metrics.hypothesizes > 0) {
		const avgHypothesesPerCall = metrics.hypothesesGenerated / metrics.hypothesizes;
		hypothesisQuality = Math.min(100, 20 + avgHypothesesPerCall * 20);
		// Bonus for verification
		if (metrics.hypothesesWithVerification > 0) {
			const verifRatio = metrics.hypothesesWithVerification / metrics.hypothesesGenerated;
			hypothesisQuality = Math.min(100, hypothesisQuality + verifRatio * 30);
		} else {
			recommendations.push("Hypotheses generated without verification steps");
		}
	} else if (metrics.thinks > 5) {
		// Lots of thinking but no hypotheses — might be overthinking
		recommendations.push("Many think calls but no hypotheses — consider structured analysis");
	}

	// 3. Verification rigor (35% weight)
	let verificationRigor = 50;
	if (metrics.finalizes > 0) {
		const blockRatio = metrics.finalizationsBlocked / metrics.finalizes;
		// Some blocks are healthy — shows the critic is working
		if (blockRatio > 0 && blockRatio < 0.5) {
			verificationRigor = 80;
		} else if (blockRatio === 0) {
			verificationRigor = 60;
			recommendations.push("All finalizations passed — critic may not be strict enough");
		} else {
			verificationRigor = 40;
			recommendations.push("Many finalizations blocked — ensure work quality before finalizing");
		}
	}

	// Weighted overall score
	const overall = reasoningDepth * 0.3 + hypothesisQuality * 0.35 + verificationRigor * 0.35;

	if (overall < 40) recommendations.push("Low cognition score — agent may benefit from more structured thinking");
	if (metrics.thinks === 0 && metrics.hypothesizes === 0) {
		recommendations.push("No metacognitive tools used — agent is acting purely reactively");
	}

	return {
		overall: Math.round(overall),
		reasoningDepth: Math.round(reasoningDepth),
		hypothesisQuality: Math.round(hypothesisQuality),
		verificationRigor: Math.round(verificationRigor),
		recommendations,
	};
}
