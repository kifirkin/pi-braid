// ── Metacognition Extension ───────────────────────────────────────────────────
// Tools for structured thinking, hypothesis generation, and task finalization.
// Decomposed from monolithic 760L → 4 handler modules + slim index.

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { resolveUtilityModel } from "../../lib/model-resolver.js";
import { getExtensionState } from "../../lib/extension-state.js";
import { createThinkTool } from "./handlers/think.js";
import { createHypothesizeTool } from "./handlers/hypothesize.js";
import { createFinalizeTool } from "./handlers/finalize.js";
import { evaluateCognition } from "../../lib/cognition-evaluator.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("metacognition");

function getUtilityModel(ctx: ExtensionContext | undefined): Model<any> | undefined {
	if (!ctx) return undefined;
	return resolveUtilityModel(ctx);
}

async function getApiKey(ctx: ExtensionContext | undefined): Promise<string | undefined> {
	if (!ctx) return undefined;
	const model = getUtilityModel(ctx);
	if (!model) return undefined;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as unknown as Model<Api>);
	return auth.ok ? (auth as { apiKey?: string }).apiKey : undefined;
}

// ── Per-session metrics tracking ──────────────────────────────────────────────
interface MetaMetrics {
	thinks: number;
	hypothesizes: number;
	finalizes: number;
	totalConfidence: number;
	hypothesesGenerated: number;
	hypothesesWithVerification: number;
	finalizationsBlocked: number;
	depthDistribution: Record<string, number>;
	reasoningTags: Record<string, number>;
}

function getMetaState(ctx: ExtensionContext): MetaMetrics {
	return getExtensionState<MetaMetrics>(ctx, "metacognition-metrics", () => ({
		thinks: 0,
		hypothesizes: 0,
		finalizes: 0,
		totalConfidence: 0,
		hypothesesGenerated: 0,
		hypothesesWithVerification: 0,
		finalizationsBlocked: 0,
		depthDistribution: {},
		reasoningTags: {},
	}));
}

// ── Extension entry point ─────────────────────────────────────────────────────
export default function metacognitionExtension(pi: any): void {
	const thinkTool = createThinkTool(getUtilityModel, getApiKey);
	const hypothesizeTool = createHypothesizeTool(getUtilityModel, getApiKey);
	const finalizeTool = createFinalizeTool();

	pi.registerTool(thinkTool);
	pi.registerTool(hypothesizeTool);
	pi.registerTool(finalizeTool);

	// Track think/hypothesize/finalize usage for evaluation
	pi.on("tool_end", (event: any, ctx: ExtensionContext) => {
		const toolName = event?.toolName ?? "";
		if (!ctx) return;
		const state = getMetaState(ctx);

		if (toolName === "think") {
			state.thinks++;
			const depth = event?.params?.depth ?? "quick";
			state.depthDistribution[depth] = (state.depthDistribution[depth] ?? 0) + 1;
			const tags: string[] = event?.params?.tags ?? [];
			for (const tag of tags) {
				state.reasoningTags[tag] = (state.reasoningTags[tag] ?? 0) + 1;
			}
			if (event?.params?.confidence !== undefined) {
				state.totalConfidence += event.params.confidence;
			}
		} else if (toolName === "hypothesize") {
			state.hypothesizes++;
			state.hypothesesGenerated += event?.params?.maxHypotheses ?? 3;
			if (event?.details?.scores?.some((s: any) => s.signals?.includes("verification-plan"))) {
				state.hypothesesWithVerification++;
			}
		} else if (toolName === "finalize") {
			state.finalizes++;
			if (event?.details?.blocked) {
				state.finalizationsBlocked++;
			}
		}
	});

	// Evaluation tool — measures cognition quality from session metrics
	pi.registerTool({
		name: "cognition_evaluate",
		label: "Heuristics Evaluate",
		description:
			"Evaluate which heuristics were followed in the current session. " +
			"Call after task completion to record outcomes.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("evaluate"), Type.Literal("compliance")]),
			task_type: Type.Optional(Type.String({ description: "Task type to evaluate" })),
		}),
		execute: async (_id: string, params: any, _sig: unknown, _upd: unknown, ctx: ExtensionContext | undefined) => {
			if (!ctx) return { content: [{ type: "text" as const, text: "No context available" }], details: {} };
			const state = getMetaState(ctx);
			const result = evaluateCognition({
				thinks: state.thinks,
				hypothesizes: state.hypothesizes,
				finalizes: state.finalizes,
				avgConfidence: state.thinks > 0 ? state.totalConfidence / state.thinks : 0,
				hypothesesGenerated: state.hypothesesGenerated,
				hypothesesWithVerification: state.hypothesesWithVerification,
				finalizationsBlocked: state.finalizationsBlocked,
				depthDistribution: state.depthDistribution,
				reasoningTags: state.reasoningTags,
			});

			const lines = [
				"Cognition Evaluation Report",
				"=".repeat(40),
				"",
				`Overall Score: ${result.overall}/100`,
				`  Reasoning Depth: ${result.reasoningDepth}/100`,
				`  Hypothesis Quality: ${result.hypothesisQuality}/100`,
				`  Verification Rigor: ${result.verificationRigor}/100`,
				"",
				`Usage: ${state.thinks} thinks, ${state.hypothesizes} hypotheses, ${state.finalizes} finalizes`,
				`Avg Confidence: ${(state.thinks > 0 ? state.totalConfidence / state.thinks : 0).toFixed(2)}`,
				`Depth: ${JSON.stringify(state.depthDistribution)}`,
				`Tags: ${Object.keys(state.reasoningTags).join(", ") || "none"}`,
			];

			if (result.recommendations.length > 0) {
				lines.push("", "Recommendations:");
				for (const r of result.recommendations) lines.push(`  - ${r}`);
			}

			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: result };
		},
	});
}
