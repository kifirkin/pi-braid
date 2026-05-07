/**
 * Shared Judge Infrastructure
 *
 * Common utilities for both response analysis (judge.ts) and
 * work verification (verification-judge.ts).
 */

import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../../lib/logger.js";

const log = createLogger("judge-utils");

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
 * Run a completeSimple call with timeout, error handling, and retry for transient errors.
 *
 * Retries on:
 * - 429 (Rate limited)
 * - 529 (Provider overloaded — Anthropic)
 * - 502/503/504 (Transient server errors)
 * - Timeout
 *
 * Uses exponential backoff with jitter to avoid thundering herd.
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

  const maxTokens =
    options.maxTokens ?? Math.min(Math.max(500, Math.floor(userPrompt.length / 8)), 2000);
  const timeoutMs = options.timeoutMs ?? 30000;

  const context: Context = {
    systemPrompt,
    messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
  };

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
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
        if (attempt < MAX_RETRIES && isRetryableError(result.errorMessage)) {
          const delay = backoffDelay(attempt);
          log.warn(
            `Judge LLM transient error (attempt ${attempt}/${MAX_RETRIES}), ` +
              `retrying in ${delay}ms: ${result.errorMessage}`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        log.error("LLM error:", result.errorMessage);
        return { error: result.errorMessage };
      }

      const textContent = result.content.filter(
        (c): c is { type: "text"; text: string } => c.type === "text",
      );
      const text = textContent.length > 0 ? textContent[0].text : "";

      return { text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES && (message.includes("timeout") || message.includes("Timed"))) {
        const delay = backoffDelay(attempt);
        log.warn(
          `Judge LLM timed out (attempt ${attempt}/${MAX_RETRIES}), ` +
            `retrying in ${delay}ms: ${message}`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      log.error("Analysis failed:", message);
      return { error: message };
    }
  }

  return { error: `Judge LLM failed after ${MAX_RETRIES} attempts` };
}

/**
 * Detect transient LLM errors that should be retried.
 * Matches HTTP status codes known to be transient.
 */
function isRetryableError(message: string): boolean {
  // Match transient HTTP status codes
  const transientCodes = [
    "429", // Too Many Requests (rate limit)
    "529", // Server overloaded (Anthropic-specific)
    "502", // Bad Gateway
    "503", // Service Unavailable
    "504", // Gateway Timeout
  ];
  // Also match textual indicators
  const transientPatterns = [
    "rate limit",
    "too many requests",
    "overloaded",
    "service unavailable",
    "temporarily",
    "try again later",
    "please retry",
    "throttled",
  ];

  const lower = message.toLowerCase();
  return (
    transientCodes.some((code) => message.startsWith(code)) ||
    transientPatterns.some((p) => lower.includes(p))
  );
}

/**
 * Compute exponential backoff delay with jitter.
 * attempt 1: ~1000ms (500-1500ms)
 * attempt 2: ~2000ms (1000-3000ms)
 * attempt 3: ~4000ms (2000-6000ms)
 */
function backoffDelay(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt - 1); // 1000, 2000, 4000
  const jitter = Math.random() * base; // 0 to base added
  return Math.floor(base + jitter);
}

/**
 * Clamp a number to a range.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
