/**
 * Classifier-Offline Helper
 *
 * Centralizes the "LLM judge failed, surface offline state" pattern that
 * was duplicated in three classifiers (topic-drift, turn-outcome,
 * sycophancy). Per the archive/CODE-QUALITY-REMEDIATION-PLAN.md D-10 decision:
 * never silently default to "no problem" when the classifier is down.
 *
 * The pattern:
 *   1. Call classify() with timeout/fallback
 *   2. Check the result's `tier` -- "failed" means the LLM call did not
 *      produce a usable answer
 *   3. If "failed", return the safe default value + flag `classifierDown:true`
 *   4. The caller surfaces the offline state to the agent (via whisper or
 *      tool result) so they can manually verify or run /logs
 *
 * Use this helper from any new classifier integration. The
 * `CLASSIFIER_OFFLINE_WHISPERS` constants provide the canonical message
 * text per classifier so the format stays consistent.
 *
 * ROADMAP P2-3 / EW-7.4.
 */

import {
  classify,
  type ClassificationResult,
  type ClassifierCriteria,
  type ClassifierOptions,
} from "../ai/text-classifier.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** A classify() call wrapped with offline detection. */
export interface ClassifyWithOfflineResult<T> {
  value: T;
  classifierDown: boolean;
  tier: ClassificationResult["tier"];
  /** Latency of the underlying classify() call in ms (0 if tier === "heuristic" failed before LLM). */
  latencyMs: number;
}

/**
 * Options for classifyWithOffline. Pass-through to classify() for
 * everything except the offline-fallback semantics. The `fallback`
 * is used both as the tier-1 heuristic AND as the safe default
 * returned when the LLM tier fails.
 */
export type ClassifyWithOfflineOptions = Omit<ClassifierOptions, "fallback"> & {
  fallback?: () => string;
};

/**
 * Run a classifier and capture the offline state. The caller passes a
 * `fallback` that returns the safe default value when the LLM call fails
 * (e.g. the conservative "no drift" verdict). The helper never silently
 * swallows failures -- `classifierDown` is always set when `tier === "failed"`.
 *
 * @param ctx          The ExtensionContext (for classify() LLM call)
 * @param criteria     The classifier criteria (systemPrompt + userPrompt) for classify()
 * @param input        Input data for the prompt substitutions
 * @param options      Optional timeout, fallback, tierPolicy, label, validLabels, etc.
 * @returns value (the verdict), classifierDown (true on LLM failure), tier
 *
 * @example
 *   const r = await classifyWithOffline(ctx, CRITICS.topicDivergence.criteria, input, {
 *     timeoutMs: 60_000,
 *     fallback: () => "no",
 *   });
 *   if (r.classifierDown) {
 *     ctx.whisper?.(CLASSIFIER_OFFLINE_WHISPERS.drift, { category: "cognitive" });
 *   }
 */
export async function classifyWithOffline<T extends string>(
  ctx: ExtensionContext,
  criteria: ClassifierCriteria,
  input: Record<string, string>,
  options: ClassifyWithOfflineOptions = {},
): Promise<ClassifyWithOfflineResult<T>> {
  const fallback = options.fallback ?? ((): T => "no" as T);
  const result = await classify(ctx, criteria, input, {
    timeoutMs: options.timeoutMs,
    maxTokens: options.maxTokens,
    tierPolicy: options.tierPolicy,
    validLabels: options.validLabels,
    label: options.label,
    bestEffort: options.bestEffort,
    fallback,
  });
  const tier = result.tier;
  if (tier === "failed") {
    return { value: fallback() as T, classifierDown: true, tier, latencyMs: result.latencyMs };
  }
  return { value: result.label as T, classifierDown: false, tier, latencyMs: result.latencyMs };
}

/**
 * Canonical "classifier unavailable" whisper messages. Use the
 * classifier-specific key to keep the format consistent. Add new entries
 * here when adding new classifier integrations.
 */
export const CLASSIFIER_OFFLINE_WHISPERS = {
  drift:
    "[drift-detector] Classifier unavailable - could not check topic drift this turn. " +
    "If you suspect drift, self-check against the original request.",
  loop:
    "## Loop Detector Offline\n\n" +
    "The loop-detection classifier is unavailable this turn, so this check could not run normally. " +
    "Continue with caution - manually verify you are not in a tool-repetition pattern.",
  sycophancy:
    "[sycophancy] Classifier unavailable - could not check sycophancy risk this turn. " +
    "Continue with the default truth-seeking behavior if it was active.",
  turnOutcome:
    "[turn-outcome] Loop classifier unavailable this turn. " +
    "Tool-error-burst detection still ran (heuristic).",
} as const;
