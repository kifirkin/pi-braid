// ── Hypothesize Tool ──────────────────────────────────────────────────────────
// Generate structured hypotheses about root causes using utility model.
// Extracted from metacognition/index.ts for decomposition.

import { Type } from "@sinclair/typebox";
import type { AgentToolResult, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Model, Api, Context } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import { scoreHypothesisOutput } from "./scoring.js";
import { createLogger } from "../../../lib/logger.js";

const log = createLogger("metacognition");

type ModelGetter = (ctx: ExtensionContext | undefined) => Model<any> | undefined;
type ApiKeyGetter = (ctx: ExtensionContext | undefined) => Promise<string | undefined>;

const hypothesizeSchema = Type.Object({
	problem: Type.String({ description: "The problem or issue to generate hypotheses about" }),
	evidence: Type.String({ description: "Relevant evidence, error messages, or observations" }),
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
All hypotheses must lead to PROPER, well-designed solutions - never suggest monkey patching or workarounds.`;

export function createHypothesizeTool(
	modelGetter: ModelGetter,
	apiKeyGetter: ApiKeyGetter,
) {
	return {
		name: "hypothesize" as const,
		label: "Hypothesize",
		description:
			"Structure your debugging approach by generating hypotheses about root causes.\n" +
			"This uses the utility model (a cheaper, faster model) to analyze the problem and suggest hypotheses.\n" +
			"Use this to:\n" +
			"- Organize multiple hypotheses about a problem\n" +
			"- Analyze error messages and stack traces\n" +
			"- Identify potential issues in code paths\n" +
			"- Brainstorm PROPER solutions before implementing\n\n" +
			"All hypotheses must lead to PROPER, well-designed solutions (no shortcuts, no monkey patching).\n" +
			"Returns structured analysis with ranked hypotheses.",
		parameters: hypothesizeSchema,
		execute: async (_toolCallId: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext | undefined): Promise<AgentToolResult<any>> => {
			const { problem, evidence, maxHypotheses = 3 } = params;
			const model = modelGetter(ctx);

			if (!model) {
				const lines: string[] = [
					`## Hypothesis Analysis: ${problem}`, "",
					"### Evidence", evidence, "",
					`### Hypotheses (generate ${maxHypotheses} and rank by likelihood)`,
					...Array.from({ length: maxHypotheses }, (_, i) => `${i + 1}. `), "",
					"For each hypothesis, explain: why it's likely, and why the solution is proper.",
					"Do NOT suggest monkey patches, workarounds, or quick fixes.", "",
					"_Note: No utility model configured. This is a template - use your own analysis._",
				];
				return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { problem, hypotheses: maxHypotheses, modelUsed: "template" } };
			}

			const apiKey = await apiKeyGetter(ctx);
			if (!apiKey) {
				const lines: string[] = [
					`## Hypothesis Analysis: ${problem}`, "",
					"### Evidence", evidence, "",
					`### Hypotheses (generate ${maxHypotheses} and rank by likelihood)`,
					...Array.from({ length: maxHypotheses }, (_, i) => `${i + 1}. `), "",
					"For each hypothesis, explain: why it's likely, and why the solution is proper.",
					"Do NOT suggest monkey patches, workarounds, or quick fixes.", "",
					`_Note: No API key available for utility model (${model.provider}/${model.id}). Use your own analysis._`,
				];
				return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { problem, hypotheses: maxHypotheses, modelUsed: model.id, error: "no_api_key" } };
			}

			const prompt = HYPOTHESIS_PROMPT.replace("{problem}", problem)
				.replace("{evidence}", evidence)
				.replace("{maxHypotheses}", String(maxHypotheses));

			const context: Context = {
				systemPrompt: "You are an expert debugging assistant that analyzes problems and generates testable hypotheses.",
				messages: [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }],
			};

			try {
				const response = await completeSimple(model as Model<Api>, context, { apiKey, maxTokens: 2048, temperature: 0.3 });
				if (response.errorMessage) {
					return { content: [{ type: "text" as const, text: `Hypothesis generation failed: ${response.errorMessage}` }], details: { problem, hypotheses: maxHypotheses, modelUsed: model.id, error: response.errorMessage } };
				}
				const textContent = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");

				// Score hypotheses with heuristic signals
				const { scored, annotated } = scoreHypothesisOutput(textContent || "No analysis produced.", evidence);

				return {
					content: [{ type: "text" as const, text: annotated }],
					details: {
						problem,
						hypotheses: maxHypotheses,
						modelUsed: model.id,
						scores: scored.map((s) => ({ rank: s.index, title: s.title, score: s.score, signals: s.signals })),
					},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text" as const, text: `Hypothesis generation error: ${message}` }], details: { problem, hypotheses: maxHypotheses, modelUsed: model.id, error: message } };
			}
		},
	};
}
