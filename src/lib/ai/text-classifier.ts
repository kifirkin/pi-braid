/**
 * Text Classifier - lightweight classification with configurable utility model.
 *
 * Three-tier fallback (heuristic-first):
 *   Tier 1: Heuristic fallback callback (caller-provided). Fast, free.
 *           If it returns a clear "yes"/"no", use it with 0.7 confidence.
 *   Tier 2: Configured utility model (if set via /utility-model or settings.json)
 *   Tier 3: Session model (ctx.model) with minimal token budget
 *
 * The heuristic tier is preferred because it's instant and costs nothing.
 * LLM tiers are only consulted when the heuristic can't decide.
 */

import { callLlm } from "../ai/llm-call.js";
import { resolveUtilityModel } from "../ai/model-resolver.js";
import { createLogger } from "../core/logger.js";
import { recordCriticCall } from "./critic-stats.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

const log = createLogger("text-classifier");

// ── Types ────────────────────────────────────────────────────────────────────

export interface ClassifierCriteria {
  /** System prompt: role description for the classifier model. */
  systemPrompt: string;
  /** User prompt with {{key}} placeholders for substitution. */
  userPrompt: string;
}

export interface ClassificationResult {
  /** Parsed label - "yes" | "no" | fallback value. */
  label: string;
  /** Confidence estimate: utility=0.9, session=0.6, heuristic=0.7, failed=0. */
  confidence: number;
  /** Raw model output text. */
  raw: string;
  /** Which tier produced this result. */
  tier: "utility" | "session" | "heuristic" | "failed";
  /** Latency in milliseconds. */
  latencyMs: number;
}

export interface ClassifierOptions {
  maxTokens?: number;
  timeoutMs?: number;
  /** Heuristic fallback function - called first. If it returns a clear yes/no, skip LLM. */
  fallback?: () => Promise<string> | string;
  /** Optional human-readable label for runtime observability (critic-stats tracking). */
  label?: string;
}

// ── Classify ─────────────────────────────────────────────────────────────────

/**
 * Classify text using the three-tier fallback system (heuristic-first).
 *
 * Tier 1 (heuristic) runs first - it's fast and free. Only if the heuristic
 * returns something ambiguous or isn't provided do we consult LLM tiers.
 *
 * @param ctx - Extension context for model resolution + API keys.
 * @param criteria - Prompt templates (system + user with {{key}} placeholders).
 * @param substitutions - Key-value pairs to replace `{{key}}` in prompts.
 * @param options - Optional: maxTokens, timeoutMs, heuristic fallback.
 * @returns ClassificationResult with label, confidence, tier, and latency.
 */
export async function classify(
  ctx: ExtensionContext,
  criteria: ClassifierCriteria,
  substitutions: Record<string, string>,
  options?: ClassifierOptions,
): Promise<ClassificationResult> {
  const start = Date.now();
  const maxTokens = options?.maxTokens ?? 10;
  const timeoutMs = options?.timeoutMs ?? 5000;

  // Build prompts (needed early for LLM tiers)
  const userMessage = replacePlaceholders(criteria.userPrompt, substitutions);

  // ── Tier 1: Heuristic fallback (fast, no LLM cost) ──────────────────────
  if (options?.fallback) {
    const heuristicLabel = await options.fallback();
    const lower = heuristicLabel?.trim().toLowerCase();
    // Accept any non-empty short string as a valid fallback label.
    // Previously the check was `=== "yes" || === "no"` which silently
    // dropped fallbacks returning labels like "positive"/"negative",
    // "rate_limit"/"server_error", "SHALL"/"MUST"/"SHOULD"/"MAY",
    // "STABLE"/"DEGRADED", "pipeline"/"loop"/"info"/"edit" — and
    // consulted the LLM anyway, defeating the "fast and free" promise
    // of tier 1 for ~30% of critics.
    //
    // Sanity cap at 20 chars: a real classification label is short;
    // anything longer is probably a verbose error message and should
    // fall through to the LLM.
    if (lower && lower.length > 0 && lower.length <= 20) {
      const latency = Date.now() - start;
      log.debug(`[text-classifier] TIER 1 (heuristic): "${lower}" ${latency}ms`);
      if (options.label) recordCriticCall(options.label, "heuristic", latency);
      return {
        label: lower,
        confidence: 0.7,
        raw: heuristicLabel,
        tier: "heuristic",
        latencyMs: latency,
      };
    }
    // Heuristic was ambiguous - fall through to LLM
    log.debug("[text-classifier] Heuristic ambiguous, falling to TIER 2");
  }

  // ── Tier 2: Configured utility model ────────────────────────────────────
  const utilityModel = resolveUtilityModel(ctx);
  if (utilityModel) {
    const tier1 = await tryModelCall(
      ctx,
      utilityModel,
      criteria.systemPrompt,
      userMessage,
      maxTokens,
      timeoutMs,
      0, // maxRetries: 0 - classify calls should fail fast, not retry
    );
    if (tier1) {
      const latency = Date.now() - start;
      log.debug(
        `[text-classifier] TIER 2 (utility → ${utilityModel.id}): "${tier1.label}" ${latency}ms`,
      );
      if (options?.label) recordCriticCall(options.label, "utility", latency);
      return {
        label: tier1.label,
        confidence: 0.9,
        raw: tier1.raw,
        tier: "utility",
        latencyMs: latency,
      };
    }
    log.warn("[text-classifier] TIER 2 failed (utility model error), falling to TIER 3");
  }

  // ── Tier 3: Session model ───────────────────────────────────────────────
  const sessionModel = ctx.model;
  if (sessionModel) {
    const tier2 = await tryModelCall(
      ctx,
      sessionModel,
      criteria.systemPrompt,
      userMessage,
      maxTokens,
      timeoutMs,
      0, // maxRetries: 0 - classify calls should fail fast, not retry
    );
    if (tier2) {
      const latency = Date.now() - start;
      log.debug(
        `[text-classifier] TIER 3 (session → ${sessionModel.id}): "${tier2.label}" ${latency}ms`,
      );
      if (options?.label) recordCriticCall(options.label, "session", latency);
      return {
        label: tier2.label,
        confidence: 0.6,
        raw: tier2.raw,
        tier: "session",
        latencyMs: latency,
      };
    }
    log.warn("[text-classifier] TIER 3 failed (session model error), returning 'unknown'");
  }

  const latency = Date.now() - start;
  log.warn(`[text-classifier] ALL TIERS FAILED - returning "unknown" ${latency}ms`);
  if (options?.label) recordCriticCall(options.label, "failed", latency);
  return { label: "unknown", confidence: 0, raw: "", tier: "failed", latencyMs: latency };
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * Normalize a model response to "yes" or "no".
 * Returns null if the response doesn't match either pattern.
 * Exported for testing.
 */
export function normalizeLabel(raw: string): string | null {
  const lower = raw.trim().toLowerCase();
  // Prefer whole-word match first, then prefix match
  if (/^yes\b/.test(lower) || lower === "yes") return "yes";
  if (/^no\b/.test(lower) || lower === "no") return "no";
  return null;
}

/**
 * Attempt a single classification model call.
 * Returns the full trimmed lowercase response on success, null on any failure.
 * The caller should use normalizeLabel() to parse the result.
 */
async function tryModelCall(
  ctx: ExtensionContext,
  model: Model<Api>,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  timeoutMs: number,
  maxRetries = 0,
): Promise<{ raw: string; label: string } | null> {
  try {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
    if (!apiKey) return null;

    const result = await callLlm(model, apiKey, systemPrompt, userMessage, {
      maxTokens,
      temperature: 0,
      timeoutMs,
      maxRetries,
    });

    if ("error" in result) return null;

    const raw = result.text.trim();
    const label = normalizeLabel(raw);
    if (!label) return null;

    return { raw, label };
  } catch {
    return null;
  }
}

/**
 * Replace `{{key}}` placeholders with values from the substitutions map.
 * Uses single-pass regex to prevent cross-key injection:
 * if a substitution value contains `{{otherKey}}`, it won't be re-processed.
 * Exported for testing.
 */
export function replacePlaceholders(
  template: string,
  substitutions: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => substitutions[key] ?? `{{${key}}}`);
}
