/**
 * Metacognition Extension
 *
 * The agent's self-awareness layer:
 * - think: structured reasoning recording
 * - hypothesize: utility-model hypothesis generation
 *
 * Note: scratchpad is registered by the scratchpad extension, not here.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createThinkTool } from "../../tools/think.js";
import { createHypothesizeTool } from "../../tools/utility-hypothesize.js";
import { resolveUtilityModel } from "../../lib/model-resolver.js";

export default function metacognitionExtension(pi: ExtensionAPI) {
	// Think tool - passes ctx-getters for deep analysis support
	const thinkTool = createThinkTool(
		// Get utility model from ExtensionContext at execution time — direct resolution, no patching
		(ctx) => {
			if (!ctx) return undefined;
			return resolveUtilityModel(ctx);
		},
		// Get API key from ctx at execution time
		async (ctx) => {
			if (!ctx) return undefined;
			const model = resolveUtilityModel(ctx);
			if (!model) return undefined;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			return auth.ok && auth.apiKey ? auth.apiKey : undefined;
		},
	);
	pi.registerTool({
		name: thinkTool.name,
		label: thinkTool.label,
		description: thinkTool.description,
		parameters: thinkTool.parameters,
		execute: thinkTool.execute,
	});

	// Hypothesize tool - accesses utility model from ctx at execution time
	const hypothesizeTool = createHypothesizeTool(
		// Get utility model from ExtensionContext at execution time — direct resolution, no patching
		(ctx) => {
			if (!ctx) return undefined;
			return resolveUtilityModel(ctx);
		},
		// Get API key from ctx at execution time
		async (ctx) => {
			if (!ctx) return undefined;
			const model = resolveUtilityModel(ctx);
			if (!model) return undefined;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			return auth.ok && auth.apiKey ? auth.apiKey : undefined;
		},
	);
	pi.registerTool({
		name: hypothesizeTool.name,
		label: hypothesizeTool.label,
		description: hypothesizeTool.description,
		parameters: hypothesizeTool.parameters,
		execute: hypothesizeTool.execute,
	});
}
