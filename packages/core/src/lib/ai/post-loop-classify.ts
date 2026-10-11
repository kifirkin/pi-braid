/**
 * Post-Loop Classifier - bundles the 4 post-loop LLM-call guarantees so a
 * post-loop call site (session summary, end-of-turn reflection, dreamer
 * analysis, etc.) cannot get them wrong by hand-rolling them:
 *
 *     1. ESC / session-shutdown abort propagation
 *        - Inherited from classify() -> tryModelCall -> callLlm which
 *          already threads ctx.signal. No work needed here.
 *     2. Abort demotion in callLlm
 *        - Inherited from llm-call.ts. No work needed here.
 *     3. Tier-failure fallback
 *        - classify() returns { tier: "failed", label: "unknown" }
 *          when ALL tiers fail. Without an explicit check, "unknown"
 *          would be embedded in the strategic SOP. This wrapper
 *          checks tier and invokes `onFailure` to give the caller a
 *          safe default. THIS IS THE PRIMARY ADDED VALUE.
 *     4. 30s timeout
 *        - Post-loop work runs when the session model is busy with
 *          finalization; 30s is the default. Total worst-case when
 *          both tiers run is 60s, at the upper end of the "a minute
 *          or more" budget post-loop work may take.
 *
 * Usage:
 *   const result = await postLoopClassify(ctx, criteria, subs, {
 *     onFailure: () => detectPattern(tools), // heuristic fallback
 *     label: "trajectoryPattern", // for critic-stats analytics
 *     // timeoutMs defaults to 30000
 *   });
 *   // result.label is always defined (either LLM label or fallback).
 *   // result.tier is "failed" iff onFailure was invoked.
 *
 * @see test/runtime/lib/test-post-loop-classify.mjs for contract pins.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify, type ClassificationResult } from "./text-classifier.js";
import { createLogger } from "../core/logger.js";
import { getPostLoopTimeoutMs } from "../state/global-state.js";

const log = createLogger("post-loop-classify");

/**
 * Resolve the effective post-loop timeout: explicit caller override
 * wins, otherwise the process-global default from
 * `getPostLoopTimeoutMs()`. The default is 30s and is tunable at
 * runtime via `setPostLoopTimeoutMs()` so the value can be changed
 * without code changes (e.g. from a /command or startup config).
 *
 * The 30s default gives full headroom for worst-case post-loop paths;
 * total worst-case latency when both tiers run is 60s. Post-loop work
 * is best-effort by definition; waiting longer is the right tradeoff
 * against false-failure ERROR noise at turn end.
 *
 * If 60s turns out to be too long in practice, drop to 15-20s via
 * `setPostLoopTimeoutMs(20_000)`. Run `npm test` to verify any
 * change doesn't break the behavioral timeout tests.
 */

export interface PostLoopClassifyOptions<T extends string = string> {
  /**
   * Invoked when ALL LLM tiers fail (heuristic + utility + session all
   * unavailable, timed out, or aborted). The result of this function
   * becomes the returned label. Should return a value that's safe to
   * embed in downstream artifacts (e.g. a heuristic pattern name, an
   * empty string, a "skipped" marker).
   *
   * The reason parameter is for diagnostics; production callers can
   * ignore it. It contains the failure reason and latency in ms.
   *
   * This callback is the ONLY added-value of postLoopClassify over
   * raw classify(). Everything else (signal thread, abort demotion,
   * timeout) is inherited from existing layers.
   */
  onFailure: (reason: { latencyMs: number }) => T;

  /**
   * Per-LLM-tier timeout in ms. Defaults to the value returned by
   * `getPostLoopTimeoutMs()` (currently 30_000, tunable via
   * `setPostLoopTimeoutMs()`). Total budget when both utility and
   * session are tried: 2x = 60s by default. For best-effort
   * post-loop work this is acceptable - we want to bound total
   * time but not so tight that slow models always fail.
   */
  timeoutMs?: number;

  /**
   * Whitelist of valid labels. Multi-class path: any label in this set
   * is accepted verbatim. Without it, the binary yes/no path is used.
   */
  validLabels?: string[];

  /**
   * Analytics label for critic-stats tracking. Required for Q16 cost
   * attribution. The classifier routes this to recordCriticCall().
   */
  label?: string;

  /**
   * When true, suppress the post-failure debug log. Use for callers
   * that already log their own diagnostics on the failure path
   * (avoids duplicate log lines).
   *
   * Default: false (log debug line on failure for diagnostic value).
   */
  silent?: boolean;
}

export interface PostLoopClassifyResult<T extends string> {
  /**
   * The label - either the LLM's verdict OR the onFailure callback's
   * return value. Always defined; never null/undefined.
   */
  label: T;
  /**
   * Which tier produced this result. "failed" means onFailure was
   * invoked (the LLM tiers all failed). "heuristic"/"utility"/"session"/
   * "cache" means the LLM (or a prior cache hit) produced the label.
   */
  tier: ClassificationResult["tier"];
  /** Latency of the underlying classify() call. 0 if tier === "failed" was instant. */
  latencyMs: number;
  /** Raw model output (empty string if tier === "failed"). */
  raw: string;
  /** Confidence: utility=0.9, session=0.6, heuristic=0.7, failed=0. */
  confidence: number;
}

/**
 * Run classify() with the four post-loop guarantees pre-applied.
 *
 * See the BACKGROUND section at the top of this file for why this
 * exists. The contract is verified by
 * `test/runtime/lib/test-post-loop-classify.mjs`.
 */
export async function postLoopClassify<T extends string = string>(
  ctx: ExtensionContext,
  criteria: { systemPrompt: string; userPrompt: string },
  substitutions: Record<string, string>,
  options: PostLoopClassifyOptions<T>,
): Promise<PostLoopClassifyResult<T>> {
  const result = await classify(ctx, criteria, substitutions, {
    // Inherited guarantees - DO NOT override these in callers:
    bestEffort: true, // demote TIER failure warns to debug
    // The TIER 1 fallback below is a no-op: we want the LLM to run.
    // The real fallback is the onFailure callback below, consulted
    // when ALL LLM tiers fail. We use `() => ""` because:
    //   - "" is not in any validLabels whitelist
    //   - "" is not "yes"/"no"
    //   - so classify() skips TIER 1 (it requires a valid short label
    //     OR an empty-but-trustworthy heuristic, and we don't have one)
    //   - and proceeds to TIER 2 (utility) and TIER 3 (session).
    fallback: () => "",
    // Pass through caller options:
    timeoutMs: options.timeoutMs ?? getPostLoopTimeoutMs(),
    validLabels: options.validLabels,
    label: options.label,
  });

  if (result.tier === "failed") {
    const fallbackLabel = options.onFailure({
      latencyMs: result.latencyMs,
    });
    if (!options.silent) {
      log.debug(
        `[post-loop-classify] LLM tiers failed (label="${options.label ?? "?"}", ` +
          `latencyMs=${result.latencyMs}), using onFailure -> "${fallbackLabel}"`,
      );
    }
    return {
      label: fallbackLabel,
      tier: "failed",
      latencyMs: result.latencyMs,
      raw: result.raw,
      confidence: 0,
    };
  }

  return {
    label: result.label as T,
    tier: result.tier,
    latencyMs: result.latencyMs,
    raw: result.raw,
    confidence: result.confidence,
  };
}
