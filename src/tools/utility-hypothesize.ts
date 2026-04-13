/**
 * Hypothesize Tool
 *
 * Uses the utility model to generate hypotheses about issues.
 * This offloads analysis to a cheaper model to save context and costs.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";

const hypothesizeSchema = Type.Object({
	problem: Type.String({
		description: "The problem or issue to generate hypotheses about",
	}),
	evidence: Type.String({
		description: "Relevant evidence, error messages, or observations",
	}),
	maxHypotheses: Type.Optional(
		Type.Number({
			description: "Maximum number of hypotheses to generate (default: 3)",
		}),
	),
});

export type HypothesizeInput = {
	problem: string;
	evidence: string;
	maxHypotheses?: number;
};

const hypothesizeDescription = `Structure your debugging approach by generating hypotheses about root causes.
This uses the utility model (a cheaper, faster model) to analyze the problem and suggest hypotheses.
Use this to:
- Organize multiple hypotheses about a problem
- Analyze error messages and stack traces
- Identify potential issues in code paths
- Brainstorm PROPER solutions before implementing

All hypotheses must lead to PROPER, well-designed solutions (no shortcuts, no monkey patching).
Returns structured analysis with ranked hypotheses.`;

const HYPOTHESIS_PROMPT = `You are an expert debugging assistant. Analyze the following problem and evidence to generate hypotheses about the root cause.

## Problem
{problem}

## Evidence
{evidence}

## Instructions
1. Generate exactly {maxHypotheses} distinct hypotheses about ROOT CAUSES
2. Each hypothesis must lead to a PROPER, well-designed solution (no shortcuts, no monkey patching)
3. For each hypothesis:
   - Explain WHY it's likely (reference the evidence)
   - Describe HOW to verify it
   - Explain WHY the solution is proper and maintainable
4. Rank them by likelihood (most likely first)
5. All suggested solutions must be equally maintainable and correct

Return your analysis in the following format:

Hypothesis 1: [Brief summary]
Likelihood: [High/Medium/Low]
Evidence: [Why this fits the observed evidence]
Verification: [How to confirm or rule out]
Solution: [What a proper fix would look like]

...repeat for each hypothesis...`;

/**
 * Create the hypothesize tool with access to the utility model and API key.
 * Falls back to a static template if the model is unavailable.
 *
 * @param modelGetter - Gets the utility model from ExtensionContext at execution time
 * @param apiKeyGetter - Gets the API key from ExtensionContext at execution time
 */
export function createHypothesizeTool(
	modelGetter: (ctx: ExtensionContext | undefined) => Model<any> | undefined,
	apiKeyGetter: (ctx: ExtensionContext | undefined) => Promise<string | undefined>,
): ToolDefinition<typeof hypothesizeSchema> {
	return {
		name: "hypothesize",
		label: "Hypothesize",
		description: hypothesizeDescription,
		parameters: hypothesizeSchema,
		execute: async (
			_toolCallId: string,
			params: HypothesizeInput,
			_signal: any,
			_onUpdate: any,
			ctx: ExtensionContext | undefined,
		): Promise<AgentToolResult<{ problem: string; hypotheses: number; modelUsed: string; error?: string }>> => {
			const { problem, evidence, maxHypotheses = 3 } = params;

			const model = modelGetter(ctx);

			// Fallback: no utility model configured
			if (!model) {
				const lines: string[] = [
					`## Hypothesis Analysis: ${problem}`,
					"",
					`### Evidence`,
					evidence,
					"",
					`### Hypotheses (generate ${maxHypotheses} and rank by likelihood)`,
					...Array.from({ length: maxHypotheses }, (_, i) => `${i + 1}. `),
					"",
					"For each hypothesis, explain: why it's likely, and why the solution is proper.",
					"Do NOT suggest monkey patches, workarounds, or quick fixes.",
					"",
					"_Note: No utility model configured. This is a template - use your own analysis._",
				];
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { problem, hypotheses: maxHypotheses, modelUsed: "template" },
				};
			}

			const apiKey = await apiKeyGetter(ctx);
			if (!apiKey) {
				const lines: string[] = [
					`## Hypothesis Analysis: ${problem}`,
					"",
					`### Evidence`,
					evidence,
					"",
					`### Hypotheses (generate ${maxHypotheses} and rank by likelihood)`,
					...Array.from({ length: maxHypotheses }, (_, i) => `${i + 1}. `),
					"",
					"For each hypothesis, explain: why it's likely, and why the solution is proper.",
					"Do NOT suggest monkey patches, workarounds, or quick fixes.",
					"",
					`_Note: No API key available for utility model (${model.provider}/${model.id}). Use your own analysis._`,
				];
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { problem, hypotheses: maxHypotheses, modelUsed: model.id, error: "no_api_key" },
				};
			}

			// Call the utility model
			const prompt = HYPOTHESIS_PROMPT.replace("{problem}", problem)
				.replace("{evidence}", evidence)
				.replace("{maxHypotheses}", String(maxHypotheses));

			const context = {
				systemPrompt:
					"You are an expert debugging assistant that analyzes problems and generates testable hypotheses.",
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: prompt }],
						timestamp: Date.now(),
					},
				],
			};

			try {
				const response = await completeSimple(model as Model<Api>, context, {
					apiKey,
					maxTokens: 2048,
					temperature: 0.3,
				});

				if (response.errorMessage) {
					return {
						content: [{ type: "text" as const, text: `Hypothesis generation failed: ${response.errorMessage}` }],
						details: { problem, hypotheses: maxHypotheses, modelUsed: model.id, error: response.errorMessage },
					};
				}

				const textContent = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");

				return {
					content: [{ type: "text" as const, text: textContent || "No analysis produced." }],
					details: { problem, hypotheses: maxHypotheses, modelUsed: model.id },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Hypothesis generation error: ${message}` }],
					details: { problem, hypotheses: maxHypotheses, modelUsed: model.id, error: message },
				};
			}
		},
	};
}
