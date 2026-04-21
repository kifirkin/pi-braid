// ── Think Tool ────────────────────────────────────────────────────────────────
// Records structured thinking with optional utility model "fresh eyes" review.
// Extracted from metacognition/index.ts for decomposition.

import { Type, Static } from "@sinclair/typebox";
import type { AgentToolResult, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Model, Api, Context } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import { createLogger } from "../../../lib/logger.js";

const log = createLogger("metacognition");

const thinkSchema = Type.Object({
	thought_id: Type.Optional(Type.String({ description: "Unique identifier (auto-generated if omitted)" })),
	parent_id: Type.Optional(Type.String({ description: "Parent thought ID for threaded reasoning chains" })),
	type: Type.Optional(Type.String({ description: "Categorize the thought type", enum: ["insight", "question", "assumption", "conclusion", "hypothesis", "plan", "quick", "deep"] })),
	observation: Type.Optional(Type.String({ description: "What you observed or decided to do" })),
	decision: Type.String({ description: "What you decided to do" }),
	reason: Type.Optional(Type.String({ description: "Why this decision" })),
	confidence: Type.Optional(Type.Number({ description: "Confidence level 0-1", minimum: 0, maximum: 1 })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
	depth: Type.Optional(Type.String({ enum: ["quick", "deep"], description: "Analysis depth" })),
	ask_utility_model: Type.Optional(Type.Boolean({ description: "Explicit opt-in to utility model" })),
});

type ModelGetter = (ctx: ExtensionContext | undefined) => Model<any> | undefined;
type ApiKeyGetter = (ctx: ExtensionContext | undefined) => Promise<string | undefined>;

const FRESH_EYES_PROMPT = `You are a sharp, critical thinker who reviews the reasoning of other agents.

Review this thinking entry:
- Observation: {observation}
- Decision: {decision}
- Reason: {reason}

Provide a brief, honest critique:
1. Is the reasoning sound?
2. What assumptions might be wrong?
3. What could go wrong with this decision?
4. Any better alternatives?

Keep it concise - 3-5 sentences max.`;

export function createThinkTool(
	modelGetter: ModelGetter,
	apiKeyGetter: ApiKeyGetter,
) {
	return {
		name: "think" as const,
		label: "Think",
		description:
			"Record structured thinking: decision (required), observation and reason (optional). Use depth='deep' or ask_utility_model=true to also invoke the utility model for a fresh-eyes perspective.",
		parameters: thinkSchema,
		execute: async (_toolCallId: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext | undefined) => {
			const observation = params.observation ?? params.decision ?? "";
			const decision = params.decision ?? "";
			const reason = params.reason ?? "";
			const thoughtId = params.thought_id ?? crypto.randomUUID();
			const depth = params.depth ?? "quick";
			const useUtilityModel = params.ask_utility_model === true || depth === "deep";

			const result: Record<string, unknown> = { thought_id: thoughtId };
			if (params.parent_id) result.parent_id = params.parent_id;
			if (params.type) result.type = params.type;
			if (params.confidence !== undefined) result.confidence = params.confidence;
			if (params.tags) result.tags = params.tags;

			const lines: string[] = [
				`Thinking recorded (${params.type ?? "insight"}):`,
				`- Observed: ${observation}`,
				`- Decided: ${decision}`,
				`- Reason: ${reason}`,
				`- ID: ${thoughtId}${params.parent_id ? `\n- Parent: ${params.parent_id}` : ""}`,
			];

			if (useUtilityModel) {
				const utilityModel = modelGetter(ctx);
				const apiKey = await apiKeyGetter(ctx);

				if (utilityModel && apiKey) {
					const prompt = FRESH_EYES_PROMPT.replace("{observation}", observation)
						.replace("{decision}", decision)
						.replace("{reason}", reason);

					const context: Context = {
						systemPrompt: "You are a sharp, critical thinker who reviews the reasoning of other agents.",
						messages: [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }],
					};

					try {
						const response = await completeSimple(utilityModel as Model<Api>, context, { apiKey, maxTokens: 1024, temperature: 0.4 });
						if (!response.errorMessage) {
							const utilityText = response.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("\n");
							if (utilityText) {
								lines.push("", "---");
								lines.push("**Fresh Eyes (utility model):**", utilityText);
								result.modelUsed = utilityModel.id;
							}
						} else {
							lines.push("", `[_Utility model call failed: ${response.errorMessage}_]`);
							result.modelError = response.errorMessage;
						}
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						lines.push("", `[_Utility model error: ${message}_]`);
						result.modelError = message;
					}
				} else if (!utilityModel) {
					lines.push("", "[_No utility model configured. Add one via /utility-model or in settings._]");
					result.modelUsed = false;
				} else {
					lines.push("", `[_Utility model ${utilityModel.id} has no API key available._]`);
					result.modelUsed = utilityModel.id;
					result.modelError = "no_api_key";
				}
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { observation, decision, reason, ...result },
			};
		},
	};
}
