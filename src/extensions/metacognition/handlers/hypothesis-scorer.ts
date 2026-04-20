/**
 * Hypothesis Scorer — extracted from metacognition/index.ts
 *
 * Heuristic-based scoring of LLM-generated hypotheses.
 * Signals: specific_file, specific_error, evidence_overlap, verifiable, vague, root_cause_focus
 */

export interface ScoredHypothesis {
	index: number;
	title: string;
	score: number;
	signals: string[];
}

/** Heuristic signals for hypothesis likelihood */
export function scoreHypothesis(hypothesisText: string, evidence: string): ScoredHypothesis {
	const signals: string[] = [];
	let score = 0.5; // baseline

	// Signal: mentions specific file path (+0.15)
	if (/src\/[\w/-]+\.(ts|js|json)/i.test(hypothesisText)) {
		score += 0.15;
		signals.push("specific_file");
	}

	// Signal: mentions specific error type (+0.1)
	if (/TypeError|ReferenceError|SyntaxError|Error|crash|exception|throw/i.test(hypothesisText)) {
		score += 0.1;
		signals.push("specific_error");
	}

	// Signal: references evidence directly (+0.1)
	const evidenceTokens = evidence.toLowerCase().split(/\W+/).filter((t) => t.length > 4);
	const hypTokens = hypothesisText.toLowerCase().split(/\W+/);
	const overlap = evidenceTokens.filter((t) => hypTokens.includes(t)).length;
	if (overlap > 3) {
		score += 0.1;
		signals.push("evidence_overlap");
	}

	// Signal: proposes concrete verification (+0.1)
	if (/verify|check|test|confirm|reproduce|log|debug/i.test(hypothesisText)) {
		score += 0.1;
		signals.push("verifiable");
	}

	// Signal: vague language penalty (-0.15)
	if (/maybe|might|could be anything|unclear|not sure|possibly/i.test(hypothesisText)) {
		score -= 0.15;
		signals.push("vague");
	}

	// Signal: mentions root cause specifically (+0.05)
	if (/root cause|underlying|actual.*issue|real.*problem/i.test(hypothesisText)) {
		score += 0.05;
		signals.push("root_cause_focus");
	}

	return {
		index: 0,
		title: hypothesisText.split("\n")[0].slice(0, 80),
		score: Math.max(0.1, Math.min(0.95, score)),
		signals,
	};
}

/** Parse LLM hypothesis output into scored hypotheses */
export function scoreHypothesisOutput(
	llmOutput: string,
	evidence: string,
): { scored: ScoredHypothesis[]; annotated: string } {
	// Split on "Hypothesis N:" pattern
	const blocks = llmOutput.split(/(?=Hypothesis \d+)/i);
	const scored: ScoredHypothesis[] = [];
	let annotated = llmOutput;

	if (blocks.length > 1) {
		// Multiple hypotheses found — score each
		const results = blocks
			.filter((b) => b.trim().length > 10)
			.map((block, i) => {
				const s = scoreHypothesis(block, evidence);
				s.index = i;
				s.title = block.split("\n")[0].replace(/^Hypothesis \d+:\s*/i, "").trim().slice(0, 80);
				return { block, scored: s };
			});

		// Sort by score descending
		results.sort((a, b) => b.scored.score - a.scored.score);

		for (const r of results) {
			scored.push(r.scored);
		}

		// Build annotated output: "Hypothesis 1 (score: 0.85, signals: [specific_file, verifiable]): ..."
		const annotatedLines: string[] = [];
		for (const { block, scored: s } of results) {
			annotatedLines.push(
				`[${s.score.toFixed(2)}] ${s.title}`,
				...(block.split("\n").slice(1).map((l) => `    ${l}`)),
				`    Signals: ${s.signals.join(", ")}`,
				"",
			);
		}
		annotated = annotatedLines.join("\n");
	} else {
		// Single hypothesis — score it and annotate
		const s = scoreHypothesis(llmOutput, evidence);
		scored.push(s);
		const signalsStr = s.signals.length > 0 ? ` [${s.signals.join(", ")}]` : "";
		annotated = `[${s.score.toFixed(2)}]${signalsStr}\n${llmOutput}`;
	}

	return { scored, annotated };
}
