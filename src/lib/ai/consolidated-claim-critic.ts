/**
 * Consolidated Claim Critic -- single LLM call for all 3 claim-verification checks.
 *
 * Replaces 3+ parallel classify() calls (claimContradiction, claimSupported,
 * claimOverconfidence) with one structured-output LLM call that returns all
 * three verdicts as JSON. Falls back to individual classify() calls on failure.
 *
 * Benefits:
 *   - 3x fewer LLM calls -> ~66% latency reduction for verify_claim
 *   - Single system prompt shared across all three dimensions
 *   - Model can cross-reference (e.g., contradiction vs support)
 *   - Same return interface -- drop-in replacement for claim-verification.ts
 *
 * Pattern from: consolidated-input-critic.ts, consolidated-topic-critic.ts
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { callLlm } from "./llm-call.js";
import { resolveUtilityModel, resolveMaxPowerModel } from "./model-resolver.js";
import { createLogger } from "../core/logger.js";
import { recordCriticCall } from "./critic-stats.js";

const log = createLogger("consolidated-claim-critic");

// ── Consolidated Prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a claim verification analyzer. You do one thing: " +
  "read a claim and context inside XML tags, and rate the claim on three " +
  "binary dimensions. Respond with a valid JSON object containing exactly " +
  "these three fields. No explanation, no markdown, no other text.";

const USER_PROMPT =
  'Analyze the claim against the context. Respond with valid JSON only:\n' +
  '{\n' +
  '  "contradiction": true|false,   // Does the claim directly contradict the context? ' +
  '(true = yes, they conflict)\n' +
  '  "supported": true|false,       // Is the claim supported by the context? ' +
  '(true = yes, context backs it up)\n' +
  '  "overconfidence": true|false   // Does the claim contain unwarranted certainty ' +
  '("always", "never", "guaranteed", "definitely", etc.)?\n' +
  '}\n\n' +
  "<claim>\n{{claim}}\n</claim>\n\n" +
  "<context>\n{{context}}\n</context>";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConsolidatedClaimVerdict {
  /** true = claim directly contradicts context */
  contradiction: boolean;
  /** true = claim is supported by context */
  supported: boolean;
  /** true = claim contains overconfident language */
  overconfidence: boolean;
}

export interface ConsolidatedClaimResult {
  contradiction: boolean;
  supported: boolean;
  overconfidence: boolean;
  classifierDown: boolean;
}

// ── Main Function ────────────────────────────────────────────────────────────

/**
 * Consolidated claim critique -- single LLM call for all 3 dimensions.
 *
 * Model tier strategy (modelPreference: "quality"):
 *   1. Try session model (cheap, may already be powerful)
 *   2. If session fails, try utility model
 *   3. If both fail, try max-power model (accuracy-critical safety net)
 *   4. If all fail, return null so caller falls through to individual calls
 */
export async function consolidatedClaimCritique(
  claim: string,
  context: string,
  ctx: ExtensionContext,
): Promise<ConsolidatedClaimResult | null> {
  const truncatedClaim = claim.length > 2000 ? claim.slice(0, 2000) + "..." : claim;
  const truncatedContext = context.length > 3000 ? context.slice(0, 3000) + "..." : context;
  const start = Date.now();

  // ── Attempt consolidated LLM call ──────────────────────────────────────
  const verdict = await tryConsolidatedCall(truncatedClaim, truncatedContext, ctx, start);

  if (verdict) {
    const latency = Date.now() - start;
    recordCriticCall("consolidated-claim", "utility", latency);
    log.debug(`[consolidated-claim] OK ${latency}ms: ${JSON.stringify(verdict)}`);
    return {
      contradiction: verdict.contradiction,
      supported: verdict.supported,
      overconfidence: verdict.overconfidence,
      classifierDown: false,
    };
  }

  // ── Fallback: return null so caller falls through to individual calls ──
  log.debug("[consolidated-claim] LLM failed, returning null for fallback");
  return null;
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Try the consolidated LLM call with quality tier ordering:
 * session model first, then utility, then max-power as safety net.
 */
async function tryConsolidatedCall(
  claim: string,
  context: string,
  ctx: ExtensionContext,
  startMs: number,
): Promise<ConsolidatedClaimVerdict | null> {
  const userMessage = USER_PROMPT
    .replace("{{claim}}", claim)
    .replace("{{context}}", context);

  // Tier 1: session model (conversation model, may already be powerful)
  const sessionModel = ctx.model;
  if (sessionModel) {
    const result = await tryModel(userMessage, ctx, sessionModel, startMs);
    if (result) return result;
  }

  // Tier 2: utility model (cheap fallback)
  const utilityModel = resolveUtilityModel(ctx);
  if (utilityModel) {
    const result = await tryModel(userMessage, ctx, utilityModel, startMs);
    if (result) return result;
  }

  // Tier 3: max-power model (accuracy-critical safety net)
  const maxPowerModel = resolveMaxPowerModel(ctx);
  if (maxPowerModel) {
    const result = await tryModel(userMessage, ctx, maxPowerModel, startMs);
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
): Promise<ConsolidatedClaimVerdict | null> {
  try {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
    if (!apiKey) {
      log.debug(`[consolidated-claim] No API key for ${model.provider}/${model.id}`);
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
      log.debug(`[consolidated-claim] Model ${model.id} error: ${result.error}`);
      return null;
    }

    const elapsed = Date.now() - startMs;
    const responseText = result.text.trim();
    // Extract JSON from the response (handle possible markdown fences)
    const jsonStr = extractJson(responseText);
    if (!jsonStr) {
      log.debug(`[consolidated-claim] No JSON found in response from ${model.id} ${elapsed}ms: ${responseText.slice(0, 100)}`);
      return null;
    }

    const parsed: ConsolidatedClaimVerdict = JSON.parse(jsonStr);
    // Validate: all 3 fields must be boolean
    if (
      typeof parsed.contradiction === "boolean" &&
      typeof parsed.supported === "boolean" &&
      typeof parsed.overconfidence === "boolean"
    ) {
      return parsed;
    }

    log.debug(`[consolidated-claim] Invalid fields from ${model.id}: ${jsonStr}`);
    return null;
  } catch (err) {
    const elapsed = Date.now() - startMs;
    log.debug(`[consolidated-claim] Model ${model.id} failed ${elapsed}ms: ${err}`);
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