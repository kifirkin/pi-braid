import { createLogger } from "../../../lib/logger.js";

const log = createLogger("metacognition");
// ── Hypothesis Scoring ────────────────────────────────────────────────────────
// Heuristic signals for ranking hypotheses by quality.
// Extracted from metacognition/index.ts for decomposition.

export interface ScoredHypothesis {
	index: number;
	title: string;
	score: number;
	signals: string[];
}

/** Score a single hypothesis block against evidence using heuristic signals. */
export function scoreHypothesis(llmOutput: string, evidence: string): ScoredHypothesis {
	const signals: string[] = [];
	let score = 0.5; // baseline

	// Signal: mentions specific file or function
	const fileRefs = llmOutput.match(/\b[\w/.-]+\.(ts|js|json|py|rs|go)\b/g) ?? [];
	if (fileRefs.length > 0) {
		score += 0.1;
		signals.push("specific-files");
	}

	// Signal: references evidence in reasoning
	if (evidence && llmOutput.toLowerCase().includes(evidence.split(/\s+/).slice(0, 3).join(" ").toLowerCase().slice(0, 30))) {
		score += 0.15;
		signals.push("evidence-cited");
	}

	// Signal: proposes verification steps
	if (/verify|check|test|confirm|reproduce/i.test(llmOutput)) {
		score += 0.1;
		signals.push("verification-plan");
	}

	// Signal: explains root cause mechanism
	if (/because|caused by|due to|root cause|underlying/i.test(llmOutput)) {
		score += 0.05;
		signals.push("causal-reasoning");
	}

	// Signal: proper solution (not workaround)
	if (/proper|maintainable|clean|refactor|fix.*properly/i.test(llmOutput)) {
		score += 0.05;
		signals.push("proper-solution");
	}

	// Signal: considers edge cases
	if (/edge case|boundary|corner case|failure mode/i.test(llmOutput)) {
		score += 0.05;
		signals.push("edge-case-aware");
	}

	// Extract title from first line
	const title = llmOutput.split("\n")[0]?.slice(0, 80) ?? "Untitled hypothesis";

	return { index: -1, title, score: Math.min(score, 1), signals };
}

/** Score an entire LLM hypothesis output (may contain multiple hypotheses). */
export function scoreHypothesisOutput(llmOutput: string, evidence: string): { scored: ScoredHypothesis[]; annotated: string } {
	const scored: ScoredHypothesis[] = [];

	// Split into hypothesis blocks
	const blocks = llmOutput.split(/(?=Hypothesis\s+\d+)/i);

	if (blocks.length > 1) {
		// Multiple hypotheses — score each
		let annotated = "";
		for (let i = 0; i < blocks.length; i++) {
			if (!blocks[i].trim()) continue;
			const s = scoreHypothesis(blocks[i], evidence);
			s.index = i;
			annotated += blocks[i] + `\n[Score: ${(s.score * 100).toFixed(0)}% | Signals: ${s.signals.join(", ")}]\n\n`;
			scored.push(s);
		}
		return { scored, annotated: annotated.trim() };
	}

	// Single block — score as one
	const s = scoreHypothesis(llmOutput, evidence);
	s.index = 0;
	const annotated = `${llmOutput}\n[Score: ${(s.score * 100).toFixed(0)}% | Signals: ${s.signals.join(", ")}]`;
	scored.push(s);

	return { scored, annotated };
}
