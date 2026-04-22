/**
 * Shared Judge Infrastructure
 *
 * Common utilities for both response analysis (judge.ts) and
 * work verification (verification-judge.ts).
 */

import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("judge-utils");

/**
 * Get a suitable model for judge analysis.
 * Prioritizes: utility model > current model > cheapest non-reasoning model
 */
export function getJudgeModel(ctx: ExtensionContext): Model<Api> | undefined {
	let model: Model<Api> | undefined;
	try {
		model = (ctx as unknown as { getUtilityModel?(): Model<Api> | undefined }).getUtilityModel?.();
	} catch {
		// Polyfill not patched yet (no session_start in -p mode)
 /* Non-fatal: tool description unavailable */
	}

	if (!model) {
		model = ctx.model;
		if (model?.reasoning) {
			const availableModels = ctx.modelRegistry.getAvailable();
			const nonReasoning = availableModels.filter((m) => !m.reasoning);
			nonReasoning.sort((a, b) => (a.cost?.input ?? 0) + (a.cost?.output ?? 0) - ((b.cost?.input ?? 0) + (b.cost?.output ?? 0)));
			model = nonReasoning[0];
		}
	}

	return model;
}

/**
 * Extract and clean JSON from LLM output.
 * Handles markdown code blocks, non-JSON prefixes/suffixes.
 */
export function extractJson(raw: string): string | null {
	if (!raw || typeof raw !== "string") return null;

	let jsonStr = raw.trim();

	// Remove markdown code blocks
	const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (jsonMatch?.[1]) {
		jsonStr = jsonMatch[1].trim();
	}

	// Find JSON start
	const jsonStartMatch = jsonStr.match(/[[{]/);
	if (jsonStartMatch) {
		jsonStr = jsonStr.slice(jsonStartMatch.index!);
	}

	// Find JSON end
	const lastBrace = jsonStr.lastIndexOf("}");
	const lastBracket = jsonStr.lastIndexOf("]");
	const jsonEnd = Math.max(lastBrace, lastBracket);
	if (jsonEnd > 0 && jsonEnd < jsonStr.length - 1) {
		jsonStr = jsonStr.slice(0, jsonEnd + 1);
	}

	if (!jsonStr || jsonStr.length < 10) return null;

	return jsonStr;
}

/**
 * Run a completeSimple call with timeout and error handling.
 */
export async function callLlm(
	ctx: ExtensionContext,
	systemPrompt: string,
	userPrompt: string,
	options: {
		timeoutMs?: number;
		maxTokens?: number;
		temperature?: number;
	} = {},
): Promise<{ text: string } | { error: string }> {
	const model = getJudgeModel(ctx);
	if (!model) return { error: "No model available" };

	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
	if (!apiKey) return { error: "No API key available" };

	const maxTokens = options.maxTokens ?? Math.min(Math.max(500, Math.floor(userPrompt.length / 8)), 2000);
	const timeoutMs = options.timeoutMs ?? 30000;

	const context: Context = {
		systemPrompt,
		messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
	};

	const timeoutPromise = new Promise<never>((_, reject) => {
		setTimeout(() => reject(new Error("Judge timeout")), timeoutMs);
	});

	try {
		const result = await Promise.race([
			completeSimple(model as Model<Api>, context, {
				apiKey,
				maxTokens,
				temperature: options.temperature ?? 0.1,
			}),
			timeoutPromise,
		]);

		if (result.errorMessage) {
			log.error("LLM error:", result.errorMessage);
			return { error: result.errorMessage };
		}

		const textContent = result.content.filter((c): c is { type: "text"; text: string } => c.type === "text");
		const text = textContent.length > 0 ? textContent[0].text : "";

		return { text };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.error("Analysis failed:", message);
		return { error: message };
	}
}

/**
 * Clamp a number to a range.
 */
export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
