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

export interface CriticGateOptions {
  /** Human-readable label for observability (critic-stats). */
  name: string;
  /** Classifier criteria with {{key}} placeholders. */
  criteria: { systemPrompt: string; userPrompt: string };
  /** Input data for the classify() call. */
  input: Record<string, string>;
  /** Heuristic fallback returning "yes" | "no" | depth string. */
  fallback: () => string | Promise<string>;
  /** Max tokens for the classify call (default: 5). */
  maxTokens?: number;
  /** Timeout in ms (default: 3000). */
  timeoutMs?: number;
}

export interface CriticGateResult {
  /** Whether to proceed with the expensive generative call. */
  shouldProceed: boolean;
  /** Suggested depth/scope: "deep" | "normal" | "skip". */
  suggestedDepth: "deep" | "normal" | "skip";
  /** Descriptive message for the agent if skipped. */
  message: string;
  /** Which tier the decision came from. */
  tier: "utility" | "session" | "heuristic" | "failed" | "cache";
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
    maxTokens: opts.maxTokens ?? 5,
    timeoutMs: opts.timeoutMs ?? 3000,
    label: opts.name,
    fallback: opts.fallback,
  });

  const label = result.label;

  if (label === "no" || label === "skip" || label === "shallow") {
    return {
      shouldProceed: false,
      suggestedDepth: "skip",
      message: `[critic-gate] ${opts.name}: skipped (${result.tier})`,
      tier: result.tier === "failed" ? "heuristic" : result.tier,
    };
  }

  if (label === "deep") {
    return {
      shouldProceed: true,
      suggestedDepth: "deep",
      message: `[critic-gate] ${opts.name}: deep analysis requested (${result.tier})`,
      tier: result.tier === "failed" ? "heuristic" : result.tier,
    };
  }

  // Default: "yes" → proceed with normal depth
  return {
    shouldProceed: true,
    suggestedDepth: "normal",
    message: `[critic-gate] ${opts.name}: proceeding (${result.tier})`,
    tier: result.tier === "failed" ? "heuristic" : result.tier,
  };
}
