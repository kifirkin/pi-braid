/**
 * Consolidated Input Critic -- single LLM call for all 4 input quality checks.
 *
 * Replaces 4 parallel classify() calls (code-heavy, well-written, clarity,
 * ambiguity) with one structured-output LLM call that returns all four
 * verdicts as JSON. Falls back to individual heuristic fallbacks on failure.
 *
 * Benefits:
 *   - 4x fewer LLM calls -> ~75% latency reduction, ~75% cost reduction
 *   - Single system prompt shared across all dimensions
 *   - Model can cross-reference dimensions (e.g., code is never "well-written")
 *   - Same CritiqueResult interface -- drop-in replacement for input-critic.ts
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { callLlm } from "../../../lib/ai/llm-call.js";
import { resolveUtilityModel } from "../../../lib/ai/model-resolver.js";
import { createLogger } from "../../../lib/core/logger.js";
import { recordCriticCall } from "../../../lib/ai/critic-stats.js";
import {
  inputCodeHeavyFallback,
  inputWellWrittenFallback,
  inputClarityFallback,
  inputAmbiguityFallback,
} from "../../../lib/ai/critic-fallbacks.js";
import type { CritiqueResult } from "./input-critic.js";

const log = createLogger("consolidated-input-critic");

// ── Consolidated Prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a text quality analyzer. You do one thing: " +
  "read text inside <text> tags and rate it on four binary dimensions. " +
  "Respond with a valid JSON object containing exactly these four fields. " +
  "No explanation, no markdown, no other text.";

const USER_PROMPT =
  'Analyze the text below and respond with valid JSON only:\n' +
  '{\n' +
  '  "isCode": true|false,        // Is this text primarily code (not natural language)?\n' +
  '  "isWellWritten": true|false, // Is this well-written English (correct grammar, spelling, structure)?\n' +
  '  "isClear": true|false,       // Is this clearly communicated (logical flow, coherent intent)?\n' +
  '  "isAmbiguous": true|false    // Is this vague or ambiguous (underspecified, multiple interpretations)?\n' +
  '}\n\n' +
  "<text>\n{{text}}\n</text>";

// ── Types ────────────────────────────────────────────────────────────────────

interface ConsolidatedVerdict {
  isCode: boolean;
  isWellWritten: boolean;
  isClear: boolean;
  isAmbiguous: boolean;
}

// ── Main Function ────────────────────────────────────────────────────────────

/**
 * Consolidated critique -- single LLM call for all 4 dimensions.
 *
 * Fallback strategy (graceful degradation):
 *   1. Try utility model with consolidated JSON prompt
 *   2. If utility fails, try session model
 *   3. If both fail, fall through to individual heuristic fallbacks
 */
export async function consolidatedCritiqueInput(
  text: string,
  ctx: ExtensionContext,
): Promise<CritiqueResult> {
  const truncated = text.length > 2000 ? text.slice(0, 2000) + "..." : text;
  const start = Date.now();

  // ── Attempt consolidated LLM call ──────────────────────────────────────
  const verdict = await tryConsolidatedCall(truncated, ctx, start);

  if (verdict) {
    const latency = Date.now() - start;
    recordCriticCall("consolidated-input", "utility", latency);
    log.debug(`[consolidated-input] OK ${latency}ms: ${JSON.stringify(verdict)}`);
    return {
      isCode: verdict.isCode,
      isWellWritten: verdict.isWellWritten,
      isClear: verdict.isClear,
      isAmbiguous: verdict.isAmbiguous,
      tier: "utility",
      checks: {
        codeHeavy: { label: verdict.isCode ? "yes" : "no", confidence: 0.9, raw: "", tier: "utility", latencyMs: latency },
        wellWritten: { label: verdict.isWellWritten ? "yes" : "no", confidence: 0.9, raw: "", tier: "utility", latencyMs: latency },
        clarity: { label: verdict.isClear ? "yes" : "no", confidence: 0.9, raw: "", tier: "utility", latencyMs: latency },
        ambiguity: { label: verdict.isAmbiguous ? "yes" : "no", confidence: 0.9, raw: "", tier: "utility", latencyMs: latency },
      },
    };
  }

  // ── Fallback: per-dimension heuristic fallbacks ────────────────────────
  log.debug("[consolidated-input] LLM failed, falling to heuristics");
  const heuristicStart = Date.now();
  const codeResult = inputCodeHeavyFallback(truncated);
  const wellWrittenResult = inputWellWrittenFallback(truncated);
  const clarityResult = inputClarityFallback(truncated);
  const ambiguityResult = inputAmbiguityFallback(truncated);
  const heuristicLatency = Date.now() - heuristicStart;

  recordCriticCall("consolidated-input", "heuristic", heuristicLatency);
  return {
    isCode: codeResult === "yes",
    isWellWritten: wellWrittenResult === "yes",
    isClear: clarityResult === "yes",
    isAmbiguous: ambiguityResult === "yes",
    tier: "heuristic",
    checks: {
      codeHeavy: { label: codeResult, confidence: 0.7, raw: "", tier: "heuristic", latencyMs: heuristicLatency },
      wellWritten: { label: wellWrittenResult, confidence: 0.7, raw: "", tier: "heuristic", latencyMs: heuristicLatency },
      clarity: { label: clarityResult, confidence: 0.7, raw: "", tier: "heuristic", latencyMs: heuristicLatency },
      ambiguity: { label: ambiguityResult, confidence: 0.7, raw: "", tier: "heuristic", latencyMs: heuristicLatency },
    },
  };
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Try the consolidated LLM call with utility model, then session model.
 */
async function tryConsolidatedCall(
  text: string,
  ctx: ExtensionContext,
  startMs: number,
): Promise<ConsolidatedVerdict | null> {
  const userMessage = USER_PROMPT.replace("{{text}}", text);

  // Try utility model first
  const utilityModel = resolveUtilityModel(ctx);
  if (utilityModel) {
    const result = await tryModel(userMessage, ctx, utilityModel, startMs);
    if (result) return result;
  }

  // Fall through to session model
  const sessionModel = ctx.model;
  if (sessionModel) {
    const result = await tryModel(userMessage, ctx, sessionModel, startMs);
    if (result) return result;
  }

  return null;
}

/**
 * Try a single model call and parse JSON response.
 * Uses the same pattern as text-classifier.ts: callLlm(model, apiKey, systemPrompt, userMessage, options).
 */
async function tryModel(
  userMessage: string,
  ctx: ExtensionContext,
  model: Model<Api>,
  startMs: number,
): Promise<ConsolidatedVerdict | null> {
  try {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
    if (!apiKey) {
      log.debug(`[consolidated-input] No API key for ${model.provider}/${model.id}`);
      return null;
    }

    const result = await callLlm(
      model,
      apiKey,
      SYSTEM_PROMPT,
      userMessage,
      {
        maxTokens: 200,
        timeoutMs: 60_000,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
    );

    // Handle discriminated union return type
    if ("error" in result) {
      log.debug(`[consolidated-input] Model ${model.id} error: ${result.error}`);
      return null;
    }

    const elapsed = Date.now() - startMs;
    const responseText = result.text.trim();
    // Extract JSON from the response (handle possible markdown fences)
    const jsonStr = extractJson(responseText);
    if (!jsonStr) {
      log.debug(`[consolidated-input] No JSON found in response from ${model.id} ${elapsed}ms: ${responseText.slice(0, 100)}`);
      return null;
    }

    const parsed: ConsolidatedVerdict = JSON.parse(jsonStr);
    // Validate: all 4 fields must be boolean
    if (
      typeof parsed.isCode === "boolean" &&
      typeof parsed.isWellWritten === "boolean" &&
      typeof parsed.isClear === "boolean" &&
      typeof parsed.isAmbiguous === "boolean"
    ) {
      return parsed;
    }

    log.debug(`[consolidated-input] Invalid fields from ${model.id}: ${jsonStr}`);
    return null;
  } catch (err) {
    const elapsed = Date.now() - startMs;
    log.debug(`[consolidated-input] Model ${model.id} failed ${elapsed}ms: ${err}`);
    return null;
  }
}

/**
 * Extract a JSON object from a string, handling markdown fences and
 * leading/trailing text.
 */
function extractJson(text: string): string | null {
  // Try ```json ... ``` fence first
  const fenceMatch = text.match(/```(?:json)?\s*\n?(\{[\s\S]*?\})\n?\s*```/);
  if (fenceMatch) return fenceMatch[1];

  // Try raw {...} from start
  const braceMatch = text.match(/\{[\s\S]*?\}/);
  if (braceMatch) return braceMatch[0];

  return null;
}