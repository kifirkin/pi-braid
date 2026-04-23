/**
 * think tool — structured reflection with optional utility model review.
 *
 * When depth="deep" or ask_utility_model=true, invokes the session's
 * current model (ctx.model) for a fresh-eyes perspective.
 */

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

const DEEP_REVIEW_PROMPT = `You are a critical reviewer reading another AI's reasoning process.
Review the reasoning below and identify:
1. Any logical gaps or unstated assumptions
2. Alternative approaches not considered
3. Premature conclusions
4. Missing edge cases

Be concise but thorough. If the reasoning is sound, say so briefly.`;

export function registerThink(pi: ExtensionContext) {
	(pi as unknown as { registerTool: (name: string, def: unknown) => void }).registerTool(
		"think",
		{
			name: "think",
			description:
				"Record structured thinking: decision (required), observation and reason (optional). Use depth='deep' or ask_utility_model=true to also invoke the session model for a fresh-eyes perspective.",
			inputSchema: {
				type: "object",
				properties: {
					decision: { type: "string", description: "What you decided to do" },
					observation: { type: "string", description: "What you observed or decided to do" },
					reason: { type: "string", description: "Why this decision" },
					depth: { type: "string", enum: ["minimal", "low", "medium", "high", "max", "quick", "deep"] },
					ask_utility_model: { type: "boolean", description: "Invoke session model for fresh-eyes review" },
					confidence: { type: "number", description: "Confidence level 0-1" },
					outcome: { type: "string", enum: ["success", "failure", "pending"] },
					thought_id: { type: "string" },
					parent_id: { type: "string" },
					tags: { type: "array", items: { type: "string" } },
					on_failure: { type: "string", enum: ["diagnose", "propose_fix"] },
					type: { type: "string", enum: ["observation", "planning", "execution", "reflection", "conclusion", "debugging", "design"] },
				},
				required: ["decision"],
			},
			execute: async (
				toolCallId: string,
				params: Record<string, unknown>,
				signal: AbortSignal,
				onUpdate: (u: unknown) => void,
				_ctx: unknown,
			) => {
				const p = params as {
					decision: string;
					observation?: string;
					reason?: string;
					depth?: string;
					ask_utility_model?: boolean;
					confidence?: number;
					outcome?: string;
					thought_id?: string;
					parent_id?: string;
					tags?: string[];
					on_failure?: string;
					type?: string;
				};

				// If deep review requested, use session model for fresh-eyes perspective
				if ((p.depth === "deep" || p.ask_utility_model) && pi.model) {
					try {
						const review = await complete(
							pi.model,
							{
								systemPrompt: DEEP_REVIEW_PROMPT,
								messages: [
									{
										role: "user" as const,
										content: `Decision: ${p.decision}\nReason: ${p.reason || "N/A"}\nObservation: ${p.observation || "N/A"}`,
										timestamp: Date.now(),
									},
								],
							},
							{ signal },
						);
						const reviewText = Array.isArray(review)
							? review.map((r) => (r as { text?: string }).text || "").join(" ")
							: typeof review === "string"
								? review
								: "";
						if (reviewText) {
							onUpdate({
								toolCallId,
								content: [
									{
										type: "text" as const,
										text: `[Fresh-eyes review] ${reviewText}\n\n`,
									},
								],
							});
						}
					} catch {
						// Deep review is best-effort
					}
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `Recorded: ${p.decision}`,
						},
					],
				};
			},
		},
	);
}
