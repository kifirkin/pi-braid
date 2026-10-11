/**
 * Model resolution helpers for pi-braid extensions.
 *
 * Resolves the merged auxiliary role (utilityModel) and the deprecated vision
 * alias: a setting may hold one model pattern or an ordered list, and the
 * resolver walks the list with the provider layer deciding per entry.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { getCustomModelKey, UTILITY_MODEL_KEY, VISION_MODEL_KEY } from "../state/global-state.js";
import { callLlm, isModelRouteUsable } from "./llm-call.js";
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
  const all = ctx.modelRegistry.getAll();
  return all.find((m) => m.id === pattern || m.id.endsWith(`/${pattern}`));
}

/**
 * A role setting holds one model pattern or an ordered list of them
 * (settings.json may carry either; see the polyfill's read/write path).
 *
 * Normalise a raw setting value into the ordered list of usable patterns:
 * trims each entry and drops empties and non-strings, so a malformed
 * settings.json value degrades to "fewer candidates", never to a crash. The
 * settings writer normalises through this same function, so what lands on
 * disk is exactly what resolves back.
 */
export function normaliseRoleSetting(raw: unknown): string[] {
  const entries = Array.isArray(raw) ? raw : [raw];
  const patterns: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) patterns.push(trimmed);
  }
  return patterns;
}

/**
 * Resolve a role setting to a single model.
 *
 * A scalar keeps the pre-list behaviour exactly: resolved and returned as-is,
 * with no usability filter (the direct-call paths never consulted one).
 *
 * A list is walked in order and the first entry the provider layer reports
 * usable wins, so a spent provider falls through to the next entry instead of
 * falling to the session model. Nothing usable resolves to undefined, the same
 * as an unresolvable pattern always has.
 *
 * @param requireImage - vision role only: entries must accept image input, so
 *   a list may hold a text-only entry without an image being sent to it.
 */
function resolveRoleModel(
  ctx: ExtensionContext,
  key: string,
  requireImage = false,
): Model<Api> | undefined {
  const raw: unknown = getCustomModelKey(key);
  const patterns = normaliseRoleSetting(raw);
  if (patterns.length === 0) return undefined;

  const acceptable = (model: Model<Api> | undefined): Model<Api> | undefined =>
    model && (!requireImage || model.input?.includes("image")) ? model : undefined;

  if (!Array.isArray(raw)) return acceptable(resolveFromPattern(ctx, patterns[0]));

  for (const pattern of patterns) {
    const model = acceptable(resolveFromPattern(ctx, pattern));
    if (model && isModelRouteUsable(model)) return model;
  }
  return undefined;
}

/**
 * Resolve a role setting to its ordered candidates, for callers that can try
 * more than one (tryModelChain). Entries no provider serves are dropped;
 * usability is deliberately not filtered here, because tryModelChain asks the
 * provider layer per tier and that filtering must live in one place.
 */
export function resolveUtilityModels(ctx: ExtensionContext): Model<Api>[] {
  return normaliseRoleSetting(getCustomModelKey(UTILITY_MODEL_KEY))
    .map((pattern) => resolveFromPattern(ctx, pattern))
    .filter((model): model is Model<Api> => model !== undefined);
}

/**
 * Get the best vision model.
 * Priority:
 *   1. Custom visionModel setting (deprecated alias, honored this release);
 *      when it is an ordered list, the first entry that accepts image input
 *      and whose route the provider layer reports usable
 *   2. Current model if vision-capable
 *   3. The merged role's first image-capable entry whose route the provider
 *      layer reports usable (same ordered-list semantics as any role)
 *   4. First available vision model
 */
export function resolveVisionModel(ctx: ExtensionContext): Model<Api> | undefined {
  // 1. Deprecated role key; still priority 1 for one release
  const custom = resolveRoleModel(ctx, VISION_MODEL_KEY, true);
  if (custom) return custom;

  // 2. Current model if vision-capable
  if (ctx.model?.input?.includes("image")) return ctx.model;

  // 3. The merged role supplies an image-capable entry, so the vision pin is
  // redundant after this release except as a determinism override.
  const role = resolveRoleModel(ctx, UTILITY_MODEL_KEY, true);
  if (role) return role;

  // 4. First available vision model
  const available = ctx.modelRegistry.getAvailable();
  return available.find((m) => m?.input?.includes("image"));
}

/**
 * Get the configured utility model for classification tasks.
 * Priority:
 *   1. Custom utilityModel setting (from /utility-model command or settings.json);
 *      for an ordered list, the first entry the provider layer reports usable
 *   2. Fall back to undefined (caller uses session model)
 */
export function resolveUtilityModel(ctx: ExtensionContext): Model<Api> | undefined {
  return resolveRoleModel(ctx, UTILITY_MODEL_KEY);
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
 * eagerly. This is important because the role model may not be configured
 * (resolveUtilityModel returns undefined), and the session model (ctx.model)
 * is always available.
 *
 * The chain short-circuits on the first success: if the role model returns a
 * valid response, the session model is never called.
 *
 * @example
 *   // Role model first, session as backup
 *   const result = await tryModelChain(ctx, [
 *     () => resolveUtilityModel(ctx),
 *     () => ctx.model,
 *   ], systemPrompt, userPrompt, { temperature: 0.1 });
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
): Promise<
  | {
      text: string;
      stopReason?: string;
      usage?: { input?: number; output?: number; totalTokens?: number };
    }
  | { error: string }
> {
  if (resolvers.length === 0) return { error: "No model resolvers provided" };

  let lastError: string | undefined;
  // The last tier the provider layer declared unable to serve. When every tier
  // is skipped there is no provider error to return, so the chain error must
  // still name the pair that was refused; the skip notice already went to the
  // log when the pair was skipped.
  let lastUnusable: string | undefined;

  for (const resolve of resolvers) {
    const model = resolve();
    if (!model) continue;

    // The provider layer can answer that a (provider, model) pair cannot serve
    // a request right now (every key spent, or a request it just rejected). An
    // auxiliary call cannot be steered onto another route the way a session
    // turn can, so skip this tier and let the next resolver try. Nothing
    // published, or a provider with nothing to say, leaves the loop unchanged.
    if (!isModelRouteUsable(model)) {
      lastUnusable = `${model.provider ?? "unknown"}/${model.id}`;
      continue;
    }

    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider).catch(() => null);
    if (!apiKey) continue;

    const result = await callLlm(model, apiKey, systemPrompt, userPrompt, options);

    if (!("error" in result) && result.text.trim().length > 0) return result;

    lastError = "error" in result ? result.error : "Empty response from model";
  }

  return {
    error:
      lastError ??
      (lastUnusable
        ? `All models in chain failed: ${lastUnusable} reported unusable`
        : "All models in chain failed"),
  };
}
