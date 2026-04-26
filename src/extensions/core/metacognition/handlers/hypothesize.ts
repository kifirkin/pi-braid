// ── Hypothesize Tool ──────────────────────────────────────────────────────────
// Generate structured hypotheses about root causes using the session model.

import { Type } from "typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { scoreHypothesisOutput } from "./scoring.js";
import { createLogger } from "../../../../lib/logger.js";

const log = createLogger("metacognition");

const hypothesizeSchema = Type.Object({
	problem:      Type.String({ description: "The problem or issue to generate hypotheses about" }),
	evidence:     Type.String({ description: "Relevant evidence, error messages, or observations" }),
	maxHypotheses: Type.Optional(Type.Number({ description: "Maximum number of hypotheses to generate (default: 3)" })),
});

const HYPOTHESIS_PROMPT = `Analyze this problem and generate {maxHypotheses} testable hypotheses about the root cause.

Problem: {problem}

Evidence:
{evidence}

For each hypothesis:
1. State the hypothesis clearly
2. Explain WHY this could be the root cause (mechanism, not correlation)
3. What evidence would CONFIRM this hypothesis?
4. What evidence would DISPROVE this hypothesis?
5. How to fix it (proper solution, not a workaround)

Rank hypotheses by likelihood (most likely first).
You aim for proper, well-designed solutions — not quick patches or workarounds.`;

export function createHypothesizeTool() {
	return {
		name: "hypothesize" as const,
		label: "Hypothesize",
		description:
			"Structure your debugging approach by generating hypotheses about root causes. " +
			"This uses the session model to analyze the problem and suggest hypotheses.\n" +
			"Use this to:\n" +
			"- Organize multiple hypotheses about a problem\n" +
			"- Analyze error messages and stack traces\n" +
			"- Identify potential issues in code paths\n" +
			"- Brainstorm PROPER solutions before implementing\n\n" +
			"Hypotheses should lead to proper solutions.\n" +
			"Returns structured analysis with ranked hypotheses.",
		parameters: hypothesizeSchema,
		execute: async (_toolCallId: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext | undefined) => {
			const { problem, evidence, maxHypotheses = 3 } = params;

			if (!ctx?.model) {
				const lines: string[] = [
					`## Hypothesis Analysis: ${problem}`, "",
					"### Evidence", evidence, "",
					`### Hypotheses (generate ${maxHypotheses} and rank by likelihood)`,
					...Array.from({ length: maxHypotheses }, (_, i) => `${i + 1}. `), "",
					"For each hypothesis, explain: why it's likely, and why the solution is proper.",
					"Focus on proper solutions over quick fixes.", "",
					"_Note: No model available. This is a template — use your own analysis._",
				];
				return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { problem, hypotheses: maxHypotheses, modelUsed: "template" } };
			}

			try {
				const prompt = HYPOTHESIS_PROMPT
					.replace("{problem}", problem)
					.replace("{evidence}", evidence)
					.replace("{maxHypotheses}", String(maxHypotheses));

				const response = await complete(
					ctx.model,
					{
						systemPrompt: "You are an expert debugging assistant that analyzes problems and generates testable hypotheses.",
						messages: [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }],
					},
					{ maxTokens: 2048, temperature: 0.3 },
				);

				const text = Array.isArray(response)
					? response.map((r) => (r as { text?: string }).text || "").join("\n")
					: typeof response === "string"
						? response
						: "";

				// Score hypotheses with heuristic signals
				const { scored, annotated } = scoreHypothesisOutput(text || "No analysis produced.", evidence);

				return {
					content: [{ type: "text" as const, text: annotated }],
					details: {
						problem,
						hypotheses: maxHypotheses,
						modelUsed: ctx.model.id,
						scores: scored.map((s) => ({ rank: s.index, title: s.title, score: s.score, signals: s.signals })),
					},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text" as const, text: `Hypothesis generation error: ${message}` }], details: { problem, hypotheses: maxHypotheses, modelUsed: ctx.model?.id, error: message } };
			}
		},
	};
}
