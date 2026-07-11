/**
 * Model resolution helpers for pi-braid extensions.
 *
 * Provides safe fallbacks for vision model resolution that
 * respects user settings (via /vision-model command)
 * and falls back to sensible defaults when not configured.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { getCustomModelKey, UTILITY_MODEL_KEY, VISION_MODEL_KEY, MAX_POWER_MODEL_KEY } from "../state/global-state.js";
import { callLlm } from "./llm-call.js";
import type { LlmCallOptions } from "./llm-call.js";

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
 * Get the best vision model.
 * Priority:
 *   1. Custom visionModel setting (from /vision-model command)
 *   2. Current model if vision-capable
 *   3. First available vision model
 */
export function resolveVisionModel(ctx: ExtensionContext): Model<Api> | undefined {
  // 1. Custom role key set by /vision-model command (polyfill extension)
  const customPattern = getCustomModelKey(VISION_MODEL_KEY);
  if (customPattern) {
    const resolved = resolveFromPattern(ctx, customPattern);
    if (resolved?.input?.includes("image")) return resolved;
  }

  // 2. Current model if vision-capable
  if (ctx.model?.input?.includes("image")) return ctx.model;

  // 3. First available vision model
  const available = ctx.modelRegistry.getAvailable();
  return available.find((m) => m?.input?.includes("image"));
}

/**
 * Get the configured utility model for classification tasks.
 * Priority:
 *   1. Custom utilityModel setting (from /utility-model command or settings.json)
 *   2. Fall back to undefined (caller uses session model)
 */
export function resolveUtilityModel(ctx: ExtensionContext): Model<Api> | undefined {
  const customPattern = getCustomModelKey(UTILITY_MODEL_KEY);
  if (customPattern) {
    const resolved = resolveFromPattern(ctx, customPattern);
    if (resolved) return resolved;
  }
  return undefined;
}

/**
 * Get the configured max-power model for accuracy-critical tasks.
 * Priority:
 *   1. Custom maxPowerModel setting (from /max-power-model command or settings.json)
 *   2. Fall back to undefined (not configured -- callers fall through to session model)
 *
 * The max-power model is activated by modelPreference strategies:
 *   - "balanced" (default): tries it AFTER utility -> session
 *   - "quality": tries it AFTER session -> utility
 *   - "max": tries it FIRST
 *   - "speed": never tries it
 */
export function resolveMaxPowerModel(ctx: ExtensionContext): Model<Api> | undefined {
  const customPattern = getCustomModelKey(MAX_POWER_MODEL_KEY);
  if (customPattern) {
    const resolved = resolveFromPattern(ctx, customPattern);
    if (resolved) return resolved;
  }
  return undefined;
}

// ── Model Chain (try models in priority order) ───────────────────────────────

/**
 * A resolver function that returns a model or undefined.
 * Used by tryModelChain to lazily resolve models in priority order.
 */
export type ModelResolver = () => Model<Api> | undefined;

/**
 * Try models in priority order, returning the first successful response.
 *
 * Each resolver is a lazy callback — models are resolved on demand, not
 * eagerly. This is important because the max-power model may not be
 * configured (resolveMaxPowerModel returns undefined), and the session
 * model (ctx.model) is always available.
 *
 * The chain short-circuits on the first success: if the max-power model
 * returns a valid response, cheaper models are never called.
 *
 * @example
 *   // Try max-power first, fall back to utility, then session
 *   const result = await tryModelChain(ctx, [
 *     () => resolveMaxPowerModel(ctx),
 *     () => resolveUtilityModel(ctx),
 *     () => ctx.model,
 *   ], systemPrompt, userPrompt, { temperature: 0.1 });
 *
 * @example
 *   // Fallback-only: utility first, then session, max-power only on error
 *   const result = await tryModelChain(ctx, [
 *     () => resolveUtilityModel(ctx),
 *     () => ctx.model,
 *     () => resolveMaxPowerModel(ctx),
 *   ], systemPrompt, userPrompt, { signal });
 *
 * @param ctx - Extension context (for API key resolution)
 * @param resolvers - Ordered list of model resolver callbacks
 * @param systemPrompt - System prompt for the LLM call
 * @param userPrompt - User message for the LLM call
 * @param options - Optional callLlm options (temperature, signal, etc.)
 * @returns First successful result, or the last error if all fail
 */
export async function tryModelChain(
  ctx: ExtensionContext,
  resolvers: ModelResolver[],
  systemPrompt: string,
  userPrompt: string,
  options: LlmCallOptions = {},
): Promise<{ text: string; stopReason?: string; usage?: { input?: number; output?: number; totalTokens?: number } } | { error: string }> {
  if (resolvers.length === 0) return { error: "No model resolvers provided" };

  let lastError: string | undefined;

  for (const resolve of resolvers) {
    const model = resolve();
    if (!model) continue;

    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider).catch(() => null);
    if (!apiKey) continue;

    const result = await callLlm(model, apiKey, systemPrompt, userPrompt, options);

    if (!("error" in result) && result.text.trim().length > 0) return result;

    lastError = "error" in result ? result.error : "Empty response from model";
  }

  return { error: lastError ?? "All models in chain failed" };
}
