/**
 * Critic Gate - cheap classify() pre-check before expensive generative LLM calls.
 *
 * Pattern: before firing a heavy generative call (hypothesize, fresh-eyes review,
 * session recall query), run a quick classify() to determine if the call is
 * needed and at what depth. Saves tokens and latency when the answer is trivial.
 *
 * Usage:
 *   const gate = await criticGate(ctx, {
 *     name: "hypothesis-precheck",
 *     criteria: { systemPrompt, userPrompt },
 *     input: { problem, evidence },
 *     fallback: () => "yes",
 *   });
 *   if (!gate.shouldProceed) return earlyResult(gate.message);
 *   // else proceed with full generative call at gate.suggestedDepth
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify } from "./text-classifier.js";
import type { CriticTier } from "./critic-stats.js";

/**
 * Normalize a classify() tier for critic-gate consumption.
 * Maps "gate" and "cache" to "heuristic" since they represent the same
 * semantic level (fast, cheap, no LLM generation).
 */
function normalizeTier(tier: string): CriticTier {
  if (tier === "failed") return "heuristic";
  if (tier === "gate" || tier === "cache") return "heuristic";
  return tier as CriticTier;
}

export interface CriticGateOptions {
  /** Human-readable label for observability (critic-stats). */
  name: string;
  /** Classifier criteria with {{key}} placeholders. */
  criteria: { systemPrompt: string; userPrompt: string };
  /** Input data for the classify() call. */
  input: Record<string, string>;
  /** Heuristic fallback returning "yes" | "no" | depth string. */
  fallback: () => string | Promise<string>;
  /**
   * Hard cap for the classify call. When unset, callLlm sizes the first
   * attempt from the prompt (1000-4000) and the classifier's one-shot retry
   * covers a completion that ends at its own ceiling with no text. Set it
   * only when the caller deliberately wants a cap; it disables the retry.
   */
  maxTokens?: number;
  /** Timeout in ms (default: 60_000). ESC/signal is the primary cancel path; timeout is a fallback. */
  timeoutMs?: number;
  /**
   * Tier policy passed through to classify(). P2-11: B-class
   * gates (e.g., the think/hypothesize depth heuristics) should
   * use "fallback-only" to downweight the heuristic to 0.5
   * confidence. A-class gates should use "always-llm" to skip
   * Tier 1 entirely.
   */
  tierPolicy?: "prefer-heuristic" | "fallback-only" | "always-llm";
  /**
   * Model preference for tier ordering strategy, passed through to classify().
   * Use "quality" for accuracy-sensitive pre-checks (session first, then
   * the merged role as fallback).
   */
  modelPreference?: "balanced" | "quality" | "speed" | "max";
}

export interface CriticGateResult {
  /** Whether to proceed with the expensive generative call. */
  shouldProceed: boolean;
  /** Suggested depth/scope: "deep" | "normal" | "skip". */
  suggestedDepth: "deep" | "normal" | "skip";
  /** Descriptive message for the agent if skipped. */
  message: string;
  /** Which tier the decision came from (normalized: "gate" and "cache" map to "heuristic"). */
  tier: CriticTier;
}

/**
 * Build and read more info: https://docs.pi.ai/critic-gate
 *
 * Run a cheap classify() gate before an expensive generative LLM call.
 *
 * The classify() call asks: "Is this input worth a full generative response?"
 * Returns "yes" (proceed), "no" (skip), or a depth indicator.
 */
export async function criticGate(
  ctx: ExtensionContext,
  opts: CriticGateOptions,
): Promise<CriticGateResult> {
  const result = await classify(ctx, opts.criteria, opts.input, {
    // No default cap: a 5-token ceiling is spent on the thinking channel of
    // a model whose thinkingLevelMap declares no "off" level (clampThinkingLevel
    // walks "off" up to the lowest declared level), so the completion returns
    // empty text with stopReason=length and the label is lost. Unset lets
    // callLlm size the first attempt from the prompt (1000-4000) and
    // text-classifier.ts retry once when a completion ends at its ceiling with
    // no text at all. An explicit opts.maxTokens stays the caller's hard cap,
    // which is also the classifier's documented retry boundary.
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    timeoutMs: opts.timeoutMs ?? 60_000,
    label: opts.name,
    fallback: opts.fallback,
    tierPolicy: opts.tierPolicy,
    modelPreference: opts.modelPreference,
  });

  const label = result.label;

  if (label === "no" || label === "skip" || label === "shallow") {
    return {
      shouldProceed: false,
      suggestedDepth: "skip",
      message: `[critic-gate] ${opts.name}: skipped (${result.tier})`,
      tier: normalizeTier(result.tier),
    };
  }

  if (label === "deep") {
    return {
      shouldProceed: true,
      suggestedDepth: "deep",
      message: `[critic-gate] ${opts.name}: deep analysis requested (${result.tier})`,
      tier: normalizeTier(result.tier),
    };
  }

  // Default: "yes" -> proceed with normal depth
  return {
    shouldProceed: true,
    suggestedDepth: "normal",
    message: `[critic-gate] ${opts.name}: proceeding (${result.tier})`,
    tier: normalizeTier(result.tier),
  };
}
