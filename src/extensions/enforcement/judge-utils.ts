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

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callLlm as sharedCallLlm } from "../../lib/ai/llm-call.js";
import { resolveUtilityModel } from "../../lib/ai/model-resolver.js";
import type { LlmCallOptions } from "../../lib/ai/llm-call.js";

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
  // Prefer utility model if configured (cheaper, faster for judgment tasks)
  const utilityModel = resolveUtilityModel(ctx);
  const model = utilityModel ?? getJudgeModel(ctx);
  if (!model) return { error: "No model available" };

  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
  if (!apiKey) return { error: "No API key available" };

  return sharedCallLlm(model, apiKey, systemPrompt, userPrompt, options);
}

/**
 * Extract and clean JSON from LLM output.
 *
 * Handles three wrappers in order:
 *   1. Markdown code blocks: ```json ... ```
 *   2. Leading prose / explanations before the JSON starts
 *   3. Trailing prose / explanations after the JSON ends
 *
 * The trailing-prose trim is the subtle part: we can't just use
 * `lastIndexOf("}")` because a JSON string value may legitimately
 * contain a `}` character (e.g. `{"key": "a}b"}`). Instead we walk
 * the string tracking string context (with backslash-escape handling)
 * and depth, returning the substring from the opening bracket to the
 * matching closing bracket.
 *
 * Returns null if no balanced JSON object/array is found.
 */
export function extractJson(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;

  let s = raw;

  // 1. Strip markdown code block wrapper if present.
  const codeBlock = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock?.[1]) {
    s = codeBlock[1];
  }

  // 2. Find the first opening bracket (object or array).
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{" || ch === "[") {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  s = s.slice(start);

  // 3. Walk forward, respecting string contexts, to find the matching
  //    closing bracket. Handles:
  //    - String literals with escape sequences ("a\"b")
  //    - Nested objects and arrays
  //    - Trailing prose after the JSON
  const openCh = s[0];
  const closeCh = openCh === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (inString) {
      // Inside a string literal: only the closing unescaped quote ends it.
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === openCh) {
      depth++;
    } else if (ch === closeCh) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) return null;
  const jsonStr = s.slice(0, end + 1).trim();
  if (jsonStr.length < 2) return null;
  return jsonStr;
}

/**
 * Clamp a number to a range.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
