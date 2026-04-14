/**
 * Think Tool
 *
 * Records structured thinking: observation, decision, reason.
 * The agent calls this to explain what it's doing and why.
 *
 * v2 additions (backward compatible):
 * - thought_id: unique identifier for referencing and threading
 * - parent_id: link to parent thought for conversation threads
 * - type: categorize thoughts (insight/question/assumption/conclusion/hypothesis)
 * - confidence: certainty level 0-1 (optional)
 * - tags: array of tags for organization
 *
 * v3 addition:
 * - depth: "quick" | "deep" — when "deep", also calls utility model for fresh-eyes review
 * - ask_utility_model: boolean — explicit opt-in for utility model analysis
 */

import { randomUUID } from "node:crypto";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";

const thinkSchema = Type.Object({
	observation: Type.String({
		description: "What you observed or discovered",
	}),
	decision: Type.String({
		description: "What you decided to do",
	}),
	reason: Type.String({
		description: "Why this decision",
	}),
	// v2 additions (all optional for backward compatibility)
	thought_id: Type.Optional(
		Type.String({
			description: "Unique identifier for this thought (auto-generated if not provided)",
		}),
	),
	parent_id: Type.Optional(
		Type.String({
			description: "ID of parent thought to create threaded reasoning chains",
		}),
	),
	type: Type.Optional(
		Type.Union(
			[
				Type.Literal("insight", { description: "Key learning or realization" }),
				Type.Literal("question", { description: "Something to investigate" }),
				Type.Literal("assumption", { description: "Assumed fact or constraint" }),
				Type.Literal("conclusion", { description: "Final determination" }),
				Type.Literal("hypothesis", { description: "Proposed explanation to test" }),
			],
			{
				description: "Categorize the thought type",
				default: "insight",
			},
		),
	),
	confidence: Type.Optional(
		Type.Number({
			minimum: 0,
			maximum: 1,
			description: "Confidence level 0-1 (optional)",
		}),
	),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization and search" })),
	// v3 addition — deep analysis via utility model
	depth: Type.Optional(
		Type.Union(
			[
				Type.Literal("quick", { description: "Quick thinking, agent's own analysis only" }),
				Type.Literal("deep", { description: "Deep thinking — also invoke utility model for fresh-eyes review" }),
			],
			{
				description: "Analysis depth: 'quick' (default) or 'deep' (includes utility model perspective)",
				default: "quick",
			},
		),
	),
	ask_utility_model: Type.Optional(
		Type.Boolean({
			description: "Explicit opt-in to call the utility model for additional perspective. Takes precedence over depth when true.",
		}),
	),
});

export type ThinkToolInput = {
	observation: string;
	decision: string;
	reason: string;
	// v2 fields
	thought_id?: string;
	parent_id?: string;
	type?: "insight" | "question" | "assumption" | "conclusion" | "hypothesis";
	confidence?: number;
	tags?: string[];
	// v3 fields
	depth?: "quick" | "deep";
	ask_utility_model?: boolean;
};

const thinkDescription =
	"Record structured thinking: observation, decision, reason. Use depth='deep' or ask_utility_model=true to also invoke the utility model for a fresh-eyes perspective.";

/**
 * Fresh eyes prompt template — used when calling the utility model
 */
const FRESH_EYES_PROMPT = `You are a fresh-eyes reviewer. An agent was working through a problem and recorded their thinking. Review it with a critical eye and provide a second perspective.

## Agent's Thinking
**What they observed:** {observation}
**What they decided:** {decision}
**Why they decided this:** {reason}

## Your Task
1. Identify any blind spots or assumptions in the agent's reasoning
2. Suggest what they might be missing
3. Point out any risks or concerns with the approach
4. Offer an alternative perspective if warranted

Be constructive but direct. The goal is to help the agent avoid mistakes.

## Response format
### Fresh Eyes Review
[Your analysis here — be direct about any concerns or blind spots]

### What Looks Solid
[What the agent got right]

### What to Consider
[Risks, missing context, or alternative approaches]`;

/**
 * Create the think tool with optional utility model deep analysis.
 *
 * @param modelGetter - Gets the utility model from ExtensionContext at execution time
 * @param apiKeyGetter - Gets the API key from ExtensionContext at execution time
 */
export function createThinkTool(
	modelGetter: (ctx: ExtensionContext | undefined) => Model<any> | undefined,
	apiKeyGetter: (ctx: ExtensionContext | undefined) => Promise<string | undefined>,
): ToolDefinition<typeof thinkSchema> {
	return {
		name: "think",
		label: "Think",
		description: thinkDescription,
		parameters: thinkSchema,
		execute: async (
			_toolCallId: string,
			params: ThinkToolInput,
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext | undefined,
		) => {
			const { observation, decision, reason } = params;
			const thoughtId = params.thought_id ?? randomUUID();
			const depth = params.depth ?? "quick";
			const useUtilityModel = params.ask_utility_model === true || depth === "deep";

			const result: Record<string, unknown> = {
				thought_id: thoughtId,
			};
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

			// v3: Deep analysis via utility model
			if (useUtilityModel) {
				const utilityModel = modelGetter(ctx);
				const apiKey = await apiKeyGetter(ctx);

				if (utilityModel && apiKey) {
					const prompt = FRESH_EYES_PROMPT.replace("{observation}", observation)
						.replace("{decision}", decision)
						.replace("{reason}", reason);

					const context = {
						systemPrompt:
							"You are a sharp, critical thinker who reviews the reasoning of other agents.",
						messages: [
							{
								role: "user" as const,
								content: [{ type: "text" as const, text: prompt }],
								timestamp: Date.now(),
							},
						],
					};

					try {
						const response = await completeSimple(utilityModel as Model<Api>, context, {
							apiKey,
							maxTokens: 1024,
							temperature: 0.4,
						});

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
					lines.push("", `[_No utility model configured. Add one via /utility-model or in settings._]`);
					result.modelUsed = false;
				} else {
					lines.push("", `[_Utility model ${utilityModel.id} has no API key available._]`);
					result.modelUsed = utilityModel.id;
					result.modelError = "no_api_key";
				}
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: {
					observation,
					decision,
					reason,
					...result,
				} as const,
			};
		},
	};
}

/**
 * Legacy export — prefer createThinkTool() with getters for new code.
 * Uses a factory pattern to maintain type safety.
 */
export function createThinkToolFactory(): (
	modelGetter: (ctx: ExtensionContext | undefined) => Model<any> | undefined,
	apiKeyGetter: (ctx: ExtensionContext | undefined) => Promise<string | undefined>,
) => ToolDefinition<typeof thinkSchema> {
	return createThinkTool;
}
