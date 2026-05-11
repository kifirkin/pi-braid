/**
 * Shared Judge Infrastructure
 *
 * Common utilities for both response analysis (judge.ts) and
 * work verification (verification-judge.ts).
 *
 * LLM calls are delegated to the shared callLlm utility (src/lib/llm-call.ts)
 * which provides two-tier retry + rate-limit circuit breaker.
 *
 * This module retains judge-specific logic:
 * - getJudgeModel() — picks a non-reasoning model when the session model is reasoning
 * - extractJson() — parses structured JSON from LLM output
 * - clamp() — number clamping
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { callLlm as sharedCallLlm } from "../../../lib/llm-call.js";
import type { LlmCallOptions } from "../../../lib/llm-call.js";

export type { LlmCallOptions };

/**
 * Get a suitable model for judge analysis.
 * Uses the session's current model (ctx.model).
 * If the current model is a reasoning model, falls back to the cheapest
 * non-reasoning model to avoid expensive judge calls.
 */
export function getJudgeModel(ctx: ExtensionContext): Model<Api> | undefined {
  let model = ctx.model;
  if (model?.reasoning) {
    const availableModels = ctx.modelRegistry.getAvailable();
    const nonReasoning = availableModels.filter((m) => !m.reasoning);
    nonReasoning.sort(
      (a, b) =>
        (a.cost?.input ?? 0) +
        (a.cost?.output ?? 0) -
        ((b.cost?.input ?? 0) + (b.cost?.output ?? 0)),
    );
    model = nonReasoning[0];
  }
  return model;
}

/**
 * Make a judge LLM call with model resolution, two-tier retry, and
 * rate-limit circuit breaker.
 *
 * Resolves model via getJudgeModel() and API key automatically.
 */
export async function callLlm(
  ctx: ExtensionContext,
  systemPrompt: string,
  userPrompt: string,
  options: LlmCallOptions = {},
): Promise<{ text: string } | { error: string }> {
  const model = getJudgeModel(ctx);
  if (!model) return { error: "No model available" };

  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
  if (!apiKey) return { error: "No API key available" };

  return sharedCallLlm(model, apiKey, systemPrompt, userPrompt, options);
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
 * Clamp a number to a range.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}