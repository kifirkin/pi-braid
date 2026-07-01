/**
 * Consolidated Topic Critic — single LLM call for all 3 topic-drift checks.
 *
 * Replaces 3 parallel classify() calls (topicCoverage, topicDivergence,
 * topicCompleteness) with one structured-output LLM call that returns all
 * three verdicts as JSON. Falls back to conservative heuristic fallbacks
 * (topicDriftFallback → "no" for all dimensions) on failure.
 *
 * Benefits:
 *   - 3× fewer LLM calls → ~66% latency reduction at turn_end
 *   - Single system prompt shared across all three dimensions
 *   - Model can cross-reference dimensions (e.g., divergence vs coverage)
 *   - Same return interface — drop-in replacement for both call sites
 *     (lib/detection/topic-drift-detector.ts and the extension handler)
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { callLlm } from "../../lib/ai/llm-call.js";
import { resolveUtilityModel } from "../../lib/ai/model-resolver.js";
import { createLogger } from "../../lib/core/logger.js";
import { topicDriftFallback } from "../../lib/ai/critic-fallbacks.js";

const log = createLogger("consolidated-topic-critic");

// ── Consolidated Prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a topic-drift analyzer. You do one thing: " +
  "read an original request and an agent response inside XML tags, " +
  "and rate the response on three binary dimensions. " +
  "Respond with a valid JSON object containing exactly these three fields. " +
  "No explanation, no markdown, no other text.";

const USER_PROMPT =
  'Analyze the response against the original request. Respond with valid JSON only:\n' +
  '{\n' +
  '  "coversTopic": true|false,   // Does the response still address the original request? (true = yes, still relevant)\n' +
  '  "hasDiverged": true|false,   // Has the response shifted to a substantially different topic? (true = yes, drifted away)\n' +
  '  "isComplete": true|false     // Does the response cover all key topics from the request? (true = complete)\n' +
  '}\n\n' +
  "<original>\n{{original}}\n</original>\n\n" +
  "<response>\n{{response}}\n</response>";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConsolidatedTopicVerdict {
  /** true = still addresses the original request (coverage was "yes") */
  coversTopic: boolean;
  /** true = has shifted to a different topic (divergence was "yes") */
  hasDiverged: boolean;
  /** true = covers all key topics (completeness was "yes") */
  isComplete: boolean;
}

export interface ConsolidatedTopicResult {
  coverage: boolean;   // true = covers topic (good)
  divergence: boolean; // true = has drifted (bad)
  completeness: boolean; // true = complete (good)
  classifierDown: boolean;
}

// ── Main Function ────────────────────────────────────────────────────────────

/**
 * Consolidated topic critique — single LLM call for all 3 drift dimensions.
 *
 * Fallback strategy (graceful degradation):
 *   1. Try utility model with consolidated JSON prompt
 *   2. If utility fails, try session model
 *   3. If both fail, use conservative defaults (no drift detected)
 */
export async function consolidatedTopicCritique(
  original: string,
  response: string,
  ctx: ExtensionContext,
): Promise<ConsolidatedTopicResult> {
  const truncatedOriginal = original.length > 2000 ? original.slice(0, 2000) + "..." : original;
  const truncatedResponse = response.length > 2000 ? response.slice(0, 2000) + "..." : response;
  const start = Date.now();

  // ── Attempt consolidated LLM call ──────────────────────────────────────
  const verdict = await tryConsolidatedCall(truncatedOriginal, truncatedResponse, ctx, start);

  if (verdict) {
    const latency = Date.now() - start;
    log.debug(`[consolidated-topic] OK ${latency}ms: ${JSON.stringify(verdict)}`);
    return {
      // coverage="no" → bad (does NOT address request), so invert coversTopic
      coverage: verdict.coversTopic,
      divergence: verdict.hasDiverged,
      completeness: verdict.isComplete,
      classifierDown: false,
    };
  }

  // ── Fallback: conservative defaults (no drift) ─────────────────────────
  log.debug("[consolidated-topic] LLM failed, using conservative defaults");
  return {
    coverage: true,
    divergence: false,
    completeness: true,
    classifierDown: true,
  };
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Try the consolidated LLM call with utility model, then session model.
 */
async function tryConsolidatedCall(
  original: string,
  response: string,
  ctx: ExtensionContext,
  startMs: number,
): Promise<ConsolidatedTopicVerdict | null> {
  const userMessage = USER_PROMPT
    .replace("{{original}}", original)
    .replace("{{response}}", response);

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
 */
async function tryModel(
  userMessage: string,
  ctx: ExtensionContext,
  model: Model<Api>,
  startMs: number,
): Promise<ConsolidatedTopicVerdict | null> {
  try {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
    if (!apiKey) {
      log.debug(`[consolidated-topic] No API key for ${model.provider}/${model.id}`);
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

    if ("error" in result) {
      log.debug(`[consolidated-topic] Model ${model.id} error: ${result.error}`);
      return null;
    }

    const elapsed = Date.now() - startMs;
    const responseText = result.text.trim();
    const jsonStr = extractJson(responseText);
    if (!jsonStr) {
      log.debug(`[consolidated-topic] No JSON found from ${model.id} ${elapsed}ms: ${responseText.slice(0, 100)}`);
      return null;
    }

    const parsed: ConsolidatedTopicVerdict = JSON.parse(jsonStr);
    if (
      typeof parsed.coversTopic === "boolean" &&
      typeof parsed.hasDiverged === "boolean" &&
      typeof parsed.isComplete === "boolean"
    ) {
      return parsed;
    }

    log.debug(`[consolidated-topic] Invalid fields from ${model.id}: ${jsonStr}`);
    return null;
  } catch (err) {
    const elapsed = Date.now() - startMs;
    log.debug(`[consolidated-topic] Model ${model.id} failed ${elapsed}ms: ${err}`);
    return null;
  }
}

/**
 * Extract a JSON object from a string, handling markdown fences.
 */
function extractJson(text: string): string | null {
  const fenceMatch = text.match(/```(?:json)?\s*\n?(\{[\s\S]*?\})\n?\s*```/);
  if (fenceMatch) return fenceMatch[1];
  const braceMatch = text.match(/\{[\s\S]*?\}/);
  if (braceMatch) return braceMatch[0];
  return null;
}