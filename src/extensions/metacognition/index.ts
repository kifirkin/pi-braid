/**
 * Metacognition Extension
 *
 * The agent's self-awareness layer:
 * - think: structured reasoning recording
 * - hypothesize: utility-model hypothesis generation
 * - finalize: required completion signal
 *
 * Note: scratchpad is registered by the scratchpad extension, not here.
 *
 * Tools inlined from ../../tools/: think.ts, utility-hypothesize.ts, finalize.ts
 */

import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { resolveUtilityModel } from "../../lib/model-resolver.js";

// =============================================================================
// think.ts - inlined
// =============================================================================

const thinkSchema = Type.Object({
	observation: Type.String({ description: "What you observed or discovered" }),
	decision: Type.String({ description: "What you decided to do" }),
	reason: Type.String({ description: "Why this decision" }),
	thought_id: Type.Optional(Type.String({ description: "Unique identifier for this thought (auto-generated if not provided)" })),
	parent_id: Type.Optional(Type.String({ description: "ID of parent thought to create threaded reasoning chains" })),
	type: Type.Optional(
		Type.Union(
			[
				Type.Literal("insight", { description: "Key learning or realization" }),
				Type.Literal("question", { description: "Something to investigate" }),
				Type.Literal("assumption", { description: "Assumed fact or constraint" }),
				Type.Literal("conclusion", { description: "Final determination" }),
				Type.Literal("hypothesis", { description: "Proposed explanation to test" }),
				Type.Literal("plan", { description: "Implementation plan or approach" }),
				Type.Literal("quick", { description: "Quick thinking without deep analysis" }),
				Type.Literal("deep", { description: "Deep analysis with utility model review" }),
			],
			{ description: "Categorize the thought type", default: "insight" },
		),
	),
	confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Confidence level 0-1 (optional)" })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization and search" })),
	depth: Type.Optional(
		Type.Union(
			[
				Type.Literal("quick", { description: "Quick thinking, agent's own analysis only" }),
				Type.Literal("deep", { description: "Deep thinking - also invoke utility model for fresh-eyes review" }),
			],
			{ description: "Analysis depth: 'quick' (default) or 'deep' (includes utility model perspective)", default: "quick" },
		),
	),
	ask_utility_model: Type.Optional(
		Type.Boolean({ description: "Explicit opt-in to call the utility model for additional perspective. Takes precedence over depth when true." }),
	),
});

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
[Your analysis here - be direct about any concerns or blind spots]

### What Looks Solid
[What the agent got right]

### What to Consider
[Risks, missing context, or alternative approaches]`;

function createThinkTool(
	modelGetter: (ctx: ExtensionContext | undefined) => Model<any> | undefined,
	apiKeyGetter: (ctx: ExtensionContext | undefined) => Promise<string | undefined>,
): ToolDefinition<typeof thinkSchema> {
	return {
		name: "think",
		label: "Think",
		description: "Record structured thinking: observation, decision, reason. Use depth='deep' or ask_utility_model=true to also invoke the utility model for a fresh-eyes perspective.",
		parameters: thinkSchema,
		execute: async (_toolCallId: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext | undefined) => {
			const { observation, decision, reason } = params;
			const thoughtId = params.thought_id ?? randomUUID();
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

					const context = {
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

// =============================================================================
// utility-hypothesize.ts - inlined
// =============================================================================

const hypothesizeSchema = Type.Object({
	problem: Type.String({ description: "The problem or issue to generate hypotheses about" }),
	evidence: Type.String({ description: "Relevant evidence, error messages, or observations" }),
	maxHypotheses: Type.Optional(Type.Number({ description: "Maximum number of hypotheses to generate (default: 3)" })),
});

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

function createHypothesizeTool(
	modelGetter: (ctx: ExtensionContext | undefined) => Model<any> | undefined,
	apiKeyGetter: (ctx: ExtensionContext | undefined) => Promise<string | undefined>,
): ToolDefinition<typeof hypothesizeSchema> {
	return {
		name: "hypothesize",
		label: "Hypothesize",
		description: `Structure your debugging approach by generating hypotheses about root causes.
This uses the utility model (a cheaper, faster model) to analyze the problem and suggest hypotheses.
Use this to:
- Organize multiple hypotheses about a problem
- Analyze error messages and stack traces
- Identify potential issues in code paths
- Brainstorm PROPER solutions before implementing

All hypotheses must lead to PROPER, well-designed solutions (no shortcuts, no monkey patching).
Returns structured analysis with ranked hypotheses.`,
		parameters: hypothesizeSchema,
		execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext | undefined): Promise<AgentToolResult<any>> => {
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

			const context = {
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
				return { content: [{ type: "text" as const, text: textContent || "No analysis produced." }], details: { problem, hypotheses: maxHypotheses, modelUsed: model.id } };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text" as const, text: `Hypothesis generation error: ${message}` }], details: { problem, hypotheses: maxHypotheses, modelUsed: model.id, error: message } };
			}
		},
	};
}

// =============================================================================
// finalize.ts - inlined
// =============================================================================

const finalizeSchema = Type.Object({
	completed: Type.Boolean({ description: "Whether the task was successfully completed" }),
	summary: Type.String({ description: "Brief summary of what was accomplished" }),
	tasksRemaining: Type.Optional(Type.Array(Type.String(), { description: "Any follow-up tasks that should be done later" })),
});

function createFinalizeTool(
	onFinalize?: (summary: string, completed: boolean) => void,
): {
	name: string;
	label: string;
	description: string;
	parameters: typeof finalizeSchema;
	execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: ExtensionContext | undefined) => Promise<AgentToolResult<any>>;
} {
	return {
		name: "finalize",
		label: "Finalize",
		description: `Mark the current task as complete. You MUST call this when:
- All code is written and tested
- The solution has been verified
- No further work is needed

The task ends after finalize() is called.`,
		parameters: finalizeSchema,
		execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, _ctx: ExtensionContext | undefined): Promise<AgentToolResult<any>> => {
			onFinalize?.(params.summary, params.completed);
			const status = params.completed ? "✅ Task completed" : "⚠️ Task incomplete";
			const message = [
				`${status}: ${params.summary}`,
				params.tasksRemaining?.length ? `\n⚠️ Follow-up needed: ${params.tasksRemaining.join(", ")}` : "",
				"\nSession ending...",
			].join("");
			return {
				content: [{ type: "text" as const, text: message }],
				details: { finalized: true, completed: params.completed, summary: params.summary },
			};
		},
	};
}

// =============================================================================
// Extension registration
// =============================================================================

export default function metacognitionExtension(pi: ExtensionAPI) {
	// Think tool
	const thinkTool = createThinkTool(
		(ctx) => {
			if (!ctx) return undefined;
			return resolveUtilityModel(ctx);
		},
		async (ctx) => {
			if (!ctx) return undefined;
			const model = resolveUtilityModel(ctx);
			if (!model) return undefined;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			return auth.ok && auth.apiKey ? auth.apiKey : undefined;
		},
	);
	pi.registerTool({ name: thinkTool.name, label: thinkTool.label, description: thinkTool.description, parameters: thinkTool.parameters, execute: thinkTool.execute });

	// Hypothesize tool
	const hypothesizeTool = createHypothesizeTool(
		(ctx) => {
			if (!ctx) return undefined;
			return resolveUtilityModel(ctx);
		},
		async (ctx) => {
			if (!ctx) return undefined;
			const model = resolveUtilityModel(ctx);
			if (!model) return undefined;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			return auth.ok && auth.apiKey ? auth.apiKey : undefined;
		},
	);
	pi.registerTool({ name: hypothesizeTool.name, label: hypothesizeTool.label, description: hypothesizeTool.description, parameters: hypothesizeTool.parameters, execute: hypothesizeTool.execute });

	// Finalize tool
	const finalizeTool = createFinalizeTool();
	pi.registerTool({ name: finalizeTool.name, label: finalizeTool.label, description: finalizeTool.description, parameters: finalizeTool.parameters, execute: finalizeTool.execute });
}
