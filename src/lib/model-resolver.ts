/**
 * Shared model resolution utilities.
 *
 * These functions resolve the utility and vision model directly from an ExtensionContext,
 * without depending on any patched methods. Safe to call from any tool or command handler.
 *
 * Priority for utilityModel:
 *   1. Check .pi/settings.json for "utilityModel" custom key
 *   2. Fall back to current model
 *   3. Fall back to cheapest available model (non-reasoning, lowest cost)
 *
 * Priority for visionModel:
 *   1. Check .pi/settings.json for "visionModel" custom key
 *   2. Fall back to current model if vision-capable
 *   3. Fall back to first available vision-capable model
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";

/** Custom settings keys - must match polyfill extension */
const UTILITY_MODEL_KEY = "utilityModel";
const VISION_MODEL_KEY = "visionModel";

/**
 * Cross-module shared map for custom model role keys (utilityModel / visionModel).
 *
 * The polyfill extension (/utility-model and /vision-model commands) stores
 * selections here because SettingsManager is not accessible from ExtensionContext.
 * This module reads them to resolve the effective model.
 *
 * Using a unique Symbol key on the global to avoid collisions.
 */
const CUSTOM_KEYS_MAP = Symbol.for("pi-braid:custom-model-keys");

function getCustomModelKeys(): Map<string, string> {
	if (!(globalThis as any)[CUSTOM_KEYS_MAP]) {
		(globalThis as any)[CUSTOM_KEYS_MAP] = new Map<string, string>();
	}
	return (globalThis as any)[CUSTOM_KEYS_MAP];
}

function getCustomModelKey(key: string): string | undefined {
	return getCustomModelKeys().get(key);
}

/**
 * Resolve a model from a pattern like "provider/model-id" or just "model-id".
 */
function resolveFromPattern(ctx: ExtensionContext, pattern: string): Model<Api> | undefined {
	const slashIndex = pattern.indexOf("/");
	if (slashIndex >= 0) {
		const provider = pattern.slice(0, slashIndex);
		const modelId = pattern.slice(slashIndex + 1);
		return ctx.modelRegistry.find(provider, modelId);
	}
	// Try to find by model ID alone
	const all = ctx.modelRegistry.getAll();
	return all.find((m) => m.id === pattern || m.id.endsWith(`/${pattern}`));
}

/**
 * Get the best utility model.
 * Priority:
 *   1. Custom utilityModel setting (from /utility-model command)
 *   2. defaultModel/defaultProvider (from /model or built-in selector)
 *   3. Current model
 *   4. Cheapest available non-reasoning model
 */
export function resolveUtilityModel(ctx: ExtensionContext): Model<Api> | undefined {
	// 1. Custom role key set by /utility-model command (polyfill extension)
	const customPattern = getCustomModelKey(UTILITY_MODEL_KEY);
	if (customPattern) {
		const resolved = resolveFromPattern(ctx, customPattern);
		if (resolved) return resolved;
	}

	// 2. defaultModel/defaultProvider (set by built-in model selector or /model command)
	const defaultProvider = (ctx as any).settingsManager?.getDefaultProvider?.();
	const defaultModel = (ctx as any).settingsManager?.getDefaultModel?.();
	if (defaultModel && defaultProvider) {
		const resolved = ctx.modelRegistry.find(defaultProvider, defaultModel);
		if (resolved) return resolved;
	}

	// 3. Current model — ONLY if non-reasoning (reasoning models too expensive for preprocessing)
	if (ctx.model && !ctx.model.reasoning) return ctx.model;

	// 4. Cheapest available non-reasoning model (always filtered — never use reasoning for preprocessing)
	const available = ctx.modelRegistry.getAvailable();
	const nonReasoning = available.filter((m) => !m.reasoning);
	if (nonReasoning.length > 0) {
		nonReasoning.sort(
			(a, b) =>
				(a.cost?.input ?? 0) + (a.cost?.output ?? 0) -
				((b.cost?.input ?? 0) + (b.cost?.output ?? 0)),
		);
		return nonReasoning[0];
	}

	// 5. Any available (exhausted non-reasoning options)
	return available[0];
}

/**
 * Get the best vision model.
 * Priority:
 *   1. Custom visionModel setting (from /vision-model command)
 *   2. defaultModel/defaultProvider if it supports image input
 *   3. Current model if vision-capable
 *   4. First available vision model
 */
export function resolveVisionModel(ctx: ExtensionContext): Model<Api> | undefined {
	// 1. Custom role key set by /vision-model command (polyfill extension)
	const customPattern = getCustomModelKey(VISION_MODEL_KEY);
	if (customPattern) {
		const resolved = resolveFromPattern(ctx, customPattern);
		if (resolved?.input?.includes("image")) return resolved;
	}

	// 2. defaultModel/defaultProvider - only if it supports image input
	const defaultProvider = (ctx as any).settingsManager?.getDefaultProvider?.();
	const defaultModel = (ctx as any).settingsManager?.getDefaultModel?.();
	if (defaultModel && defaultProvider) {
		const resolved = ctx.modelRegistry.find(defaultProvider, defaultModel);
		if (resolved?.input?.includes("image")) return resolved;
	}

	// 3. Current model if vision-capable
	if (ctx.model?.input?.includes("image")) return ctx.model;

	// 4. First available vision model
	const available = ctx.modelRegistry.getAvailable();
	return available.find((m) => m.input?.includes("image"));
}
