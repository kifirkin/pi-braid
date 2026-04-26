// ── Think Tool ────────────────────────────────────────────────────────────────
// Records structured thinking with optional "fresh eyes" review.
// Uses the session model (ctx.model) directly — no separate utility model.

import { Type } from "typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { createLogger } from "../../../../lib/logger.js";

const log = createLogger("metacognition");

/** Per-step effort calibration: depth → (maxTokens, guidance) */
const DEPTH_BUDGETS: Record<string, { tokens: number; guidance: string }> = {
	minimal: { tokens: 128, guidance: "One-line summary only." },
	low:    { tokens: 256, guidance: "Brief: 1-2 sentences." },
	quick:  { tokens: 512, guidance: "Concise reasoning." },
	medium: { tokens: 1024, guidance: "Standard analysis." },
	high:   { tokens: 2048, guidance: "Thorough analysis with alternatives." },
	max:    { tokens: 4096, guidance: "Deep analysis with critique, alternatives, and failure modes." },
	deep:   { tokens: 4096, guidance: "Deep analysis with critique, alternatives, and failure modes." },
};

function getBudget(depth: string) {
	return DEPTH_BUDGETS[depth] ?? DEPTH_BUDGETS.quick;
}

const thinkSchema = Type.Object({
	thought_id:   Type.Optional(Type.String({ description: "Unique identifier (auto-generated if omitted)" })),
	parent_id:    Type.Optional(Type.String({ description: "Parent thought ID for threaded reasoning chains" })),
	type:         Type.Optional(Type.String({ description: "Type of thinking", enum: ["observation", "planning", "execution", "reflection", "conclusion", "debugging", "design"] })),
	observation:  Type.Optional(Type.String({ description: "What you observed or decided to do" })),
	decision:     Type.String({ description: "What you decided to do" }),
	reason:       Type.Optional(Type.String({ description: "Why this decision" })),
	confidence:   Type.Optional(Type.Number({ description: "Confidence level 0-1", minimum: 0, maximum: 1 })),
	tags:         Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
	depth:        Type.Optional(Type.String({ enum: ["minimal", "low", "medium", "high", "max", "quick", "deep"], description: "Analysis depth" })),
	ask_utility_model: Type.Optional(Type.Boolean({ description: "Explicit opt-in to session-model review (fresh-eyes perspective)" })),
	alternatives: Type.Optional(Type.Array(Type.String(), { description: "Alternative approaches considered" })),
	on_failure:   Type.Optional(Type.String({ enum: ["diagnose", "propose_fix"], description: "What to do on failure" })),
	outcome:      Type.Optional(Type.String({ enum: ["success", "failure", "pending"], description: "Task outcome for closed-loop learning" })),
});

const FRESH_EYES_PROMPT = `You are a sharp, critical thinker who reviews the reasoning of other agents.

## Context
You are reviewing thinking from an agent working on a TypeScript/Node.js codebase (pi-braid agent framework).
Available tools include: think, hypothesize, read, write, edit, bash, grep, browser_*, memory_*, evolve tools.

## Thinking Entry
- Observation: {observation}
- Decision: {decision}
- Reason: {reason}

## Critique
Provide a brief, honest critique:
1. Is the reasoning sound given the codebase context?
2. What assumptions might be wrong given the tools and patterns?
3. What could go wrong with this decision in practice?
4. Any better alternatives given what's been tried?

Keep it concise - 4-6 sentences max. Focus on what matters for a TypeScript codebase.`;

export function createThinkTool() {
	return {
		name: "think" as const,
		label: "Think",
		description:
			"Record structured thinking: decision (required), observation and reason (optional). Use depth='deep' or ask_utility_model=true to also invoke the session model for a fresh-eyes perspective.",
		parameters: thinkSchema,
		execute: async (_toolCallId: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext | undefined) => {
			const observation = params.observation ?? params.decision ?? "";
			const decision = params.decision ?? "";
			const reason = params.reason ?? "";
			const thoughtId = params.thought_id ?? crypto.randomUUID();
			const depth = params.depth ?? "quick";
			const budget = getBudget(depth);
			const useDeepReview = params.ask_utility_model === true || depth === "deep";

			const result: Record<string, unknown> = { thought_id: thoughtId };
			if (params.parent_id) result.parent_id = params.parent_id;
			if (params.type) result.type = params.type;
			if (params.confidence !== undefined) result.confidence = params.confidence;
			if (params.alternatives) result.alternatives = params.alternatives;
			result.outcome = "pending";

			const lines: string[] = [
				`Thinking recorded (${params.type ?? "insight"}):`,
				`- Observed: ${observation}`,
				`- Decided: ${decision}`,
				`- Reason: ${reason}`,
				`- Depth: ${depth} (${budget.guidance})`,
				`- ID: ${thoughtId}${params.parent_id ? `\n- Parent: ${params.parent_id}` : ""}`,
			];

			if (useDeepReview && ctx?.model) {
				try {
					const prompt = FRESH_EYES_PROMPT
						.replace("{observation}", observation)
						.replace("{decision}", decision)
						.replace("{reason}", reason);

					const response = await complete(
						ctx.model,
						{
							systemPrompt: "You are a sharp, critical thinker who reviews the reasoning of other agents.",
							messages: [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }],
						},
						{ maxTokens: budget.tokens, temperature: 0.4 },
					);

					const reviewText = Array.isArray(response)
						? response.map((r) => (r as { text?: string }).text || "").join("\n")
						: typeof response === "string"
							? response
							: "";

					if (reviewText) {
						lines.push("", "---");
						lines.push("**Fresh Eyes (session model):**", reviewText);
						result.modelUsed = ctx.model.id;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					lines.push("", `[_Session model review error: ${message}_]`);
					result.modelError = message;
				}
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { observation, decision, reason, ...result },
			};
		},
	};
}
