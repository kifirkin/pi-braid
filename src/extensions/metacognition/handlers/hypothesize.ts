/**
 * hypothesize tool — structured debugging via root-cause hypothesis generation.
 *
 * Uses the session's current model (ctx.model) for analysis.
 * Research (docs/research/bicameral-mind-analysis.md) shows maintaining
 * a separate utility model is overhead — the default model handles
 * both main reasoning and structured analysis tasks effectively.
 */

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

const HYPOTHESIS_PROMPT = `You are a debugging assistant that generates ranked hypotheses about root causes.

Given a problem description and evidence, produce:
1. 2-3 concrete, testable hypotheses about the root cause
2. Each hypothesis must be specific enough to lead to a proper fix (not a workaround)
3. Rank by likelihood and explain reasoning
4. Suggest the most promising investigation path

Format:
H1: [Most likely root cause] — [reasoning]
H2: [Alternative] — [reasoning]
H3: [Less likely but worth checking] — [reasoning]

Recommended: [Which to investigate first and why]`;

export function registerHypothesize(pi: ExtensionContext) {
	(pi as unknown as { registerTool: (name: string, def: unknown) => void }).registerTool(
		"hypothesize",
		{
			name: "hypothesize",
			description:
				"Structure your debugging approach by generating hypotheses about root causes. This uses the session model to analyze the problem and suggest hypotheses. Use this to: organize multiple hypotheses about a problem, analyze error messages and stack traces, identify potential issues in code paths, brainstorm PROPER solutions before implementing. Hypotheses should lead to proper solutions.",
			inputSchema: {
				type: "object",
				properties: {
					problem: { type: "string", description: "The problem or issue to generate hypotheses about" },
					evidence: { type: "string", description: "Relevant evidence, error messages, or observations" },
					maxHypotheses: { type: "number", description: "Maximum number of hypotheses to generate (default: 3)" },
				},
				required: ["problem", "evidence"],
			},
			execute: async (
				toolCallId: string,
				params: Record<string, unknown>,
				signal: AbortSignal,
				onUpdate: (u: unknown) => void,
				_ctx: unknown,
			) => {
				const p = params as { problem: string; evidence: string; maxHypotheses?: number };

				if (!pi.model) {
					return {
						content: [
							{
								type: "text" as const,
								text: "No model available for hypothesis generation.",
							},
						],
						details: { error: true },
					};
				}

				try {
					const maxH = p.maxHypotheses || 3;
					const response = await complete(
						pi.model,
						{
							systemPrompt: HYPOTHESIS_PROMPT,
							messages: [
								{
									role: "user" as const,
									content: `Problem: ${p.problem}\n\nEvidence:\n${p.evidence}\n\nGenerate up to ${maxH} hypotheses.`,
									timestamp: Date.now(),
								},
							],
						},
						{ signal },
					);

					const text = Array.isArray(response)
						? response.map((r) => (r as { text?: string }).text || "").join(" ")
						: typeof response === "string"
							? response
							: "";

					return {
						content: [
							{
								type: "text" as const,
								text: text || "No hypotheses generated.",
							},
						],
					};
				} catch (e) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Hypothesis generation failed: ${e instanceof Error ? e.message : String(e)}`,
							},
						],
						details: { error: true },
					};
				}
			},
		},
	);
}
