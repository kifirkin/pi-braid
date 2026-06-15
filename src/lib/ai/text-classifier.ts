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
  /**
   * Tier policy controls when the heuristic is consulted.
   *  - "prefer-heuristic" (default): try heuristic first, fall through to LLM on ambiguity.
   *  - "fallback-only": heuristic is best-effort and its label is treated as low-confidence
   *    (0.5). Used when the heuristic is known-fragile but still useful.
   *  - "always-llm": skip heuristic entirely. Required for accuracy-critical classifiers
   *    where a wrong heuristic answer is worse than an LLM cost.
   */
  tierPolicy?: "prefer-heuristic" | "fallback-only" | "always-llm";
  /**
   * Optional whitelist of valid labels. If set and the heuristic returns a label
   * NOT in this set, fall through to the LLM. Useful for multi-class classifiers
   * where the heuristic might guess a wrong category.
   */
  validLabels?: string[];
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
  // Skipped entirely when tierPolicy === "always-llm" (accuracy-critical
  // classifiers where a wrong heuristic answer is worse than LLM cost).
  if (options?.fallback && options?.tierPolicy !== "always-llm") {
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
      // If a validLabels whitelist is set, the heuristic's answer must
      // match. Otherwise fall through to LLM. This prevents the
      // tier-1 widening bug from silently accepting wrong categories.
      const inValidSet =
        !options.validLabels || options.validLabels.includes(lower);
      if (inValidSet) {
        // tierPolicy === "fallback-only" reduces confidence to 0.5 to
        // signal the heuristic is known-fragile; downstream code can
        // treat this as "trust but verify".
        const confidence = options.tierPolicy === "fallback-only" ? 0.5 : 0.7;
        const latency = Date.now() - start;
        log.debug(`[text-classifier] TIER 1 (heuristic): "${lower}" ${latency}ms`);
        if (options.label) recordCriticCall(options.label, "heuristic", latency);
        return {
          label: lower,
          confidence,
          raw: heuristicLabel,
          tier: "heuristic",
          latencyMs: latency,
        };
      }
      log.debug(
        `[text-classifier] TIER 1 heuristic "${lower}" not in validLabels, falling to TIER 2`,
      );
    }
    // Heuristic was ambiguous - fall through to LLM
    log.debug("[text-classifier] Heuristic ambiguous, falling to TIER 2");
  } else if (options?.tierPolicy === "always-llm") {
    log.debug("[text-classifier] TIER 1 skipped (tierPolicy=always-llm)");
  }

  // ── Tier 2: Configured utility model ────────────────────────────────────
  const utilityModel = resolveUtilityModel(ctx);
  let tier2FailureReason: string | null = null;
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
    if (tier1 && tier1.ok) {
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
    // Capture the actual failure reason so the WARN line tells the
    // user WHY the tier failed, not just THAT it failed. The user
    // shouldn't have to dig into /logs to find out.
    tier2FailureReason = tier1 && !tier1.ok ? tier1.reason : "unknown failure";
    log.warn(
      `[text-classifier] TIER 2 failed (utility model '${utilityModel.id}'): ${tier2FailureReason}. Falling to TIER 3.`,
    );
  }

  // ── Tier 3: Session model ───────────────────────────────────────────────
  const sessionModel = ctx.model;
  let tier3FailureReason: string | null = null;
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
    if (tier2 && tier2.ok) {
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
    tier3FailureReason = tier2 && !tier2.ok ? tier2.reason : "unknown failure";
    log.warn(
      `[text-classifier] TIER 3 failed (session model '${sessionModel.id}'): ${tier3FailureReason}.`,
    );
  }

  const latency = Date.now() - start;
  log.warn(
    `[text-classifier] ALL TIERS FAILED - returning "unknown" ${latency}ms. ` +
      `TIER 2: ${tier2FailureReason ?? "no utility model configured"}. ` +
      `TIER 3: ${tier3FailureReason ?? "no session model"}.`,
  );
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
): Promise<
  | { ok: true; raw: string; label: string }
  | { ok: false; reason: string }
  | null
> {
  try {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
    if (!apiKey) return { ok: false, reason: `no API key for provider ${model.provider}` };

    const result = await callLlm(model, apiKey, systemPrompt, userMessage, {
      maxTokens,
      temperature: 0,
      timeoutMs,
      maxRetries,
    });

    if ("error" in result) {
      // Surface the actual error to the caller's log so the operator
      // can diagnose why the classifier is failing. The classify()
      // function threads this into the TIER 2/3 failed warn so the
      // user sees the actual underlying error in the TUI without
      // having to dig into /logs.
      log.debug(`[text-classifier] ${model.id} callLlm error: ${result.error}`);
      return { ok: false, reason: result.error };
    }

    const raw = result.text.trim();
    const label = normalizeLabel(raw);
    if (!label) {
      // Model responded but with unparseable text. Surface the raw
      // text in the log so we can tell if the prompt needs tuning.
      log.debug(
        `[text-classifier] ${model.id} returned unparseable label: ${JSON.stringify(raw).slice(0, 200)}`,
      );
      return { ok: false, reason: `unparseable label: ${JSON.stringify(raw).slice(0, 80)}` };
    }

    return { ok: true, raw, label };
  } catch (e) {
    const message = (e as Error).message;
    log.debug(`[text-classifier] ${model.id} threw: ${message}`);
    return { ok: false, reason: `threw: ${message}` };
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
