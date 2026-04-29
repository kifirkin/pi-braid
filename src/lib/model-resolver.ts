/**
 * Model resolution helpers for pi-braid extensions.
 *
 * Provides safe fallbacks for vision model resolution that
 * respects user settings (via /vision-model command)
 * and falls back to sensible defaults when not configured.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";
import { getCustomModelKey, VISION_MODEL_KEY } from "./global-state.js";

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
