/**
 * @fileoverview Topic Drift Detector.
 *
 * Detects when agent output diverges from the original user request.
 * Uses the triple-critic LLM classification system with three parallel
 * classify() calls: topicCoverage, topicDivergence, topicCompleteness.
 *
 * Three-tier fallback: heuristic → utility model → session model.
 * Heuristic fallback (conservative: no drift) when no LLM available.
 *
 * Replaces the previous implementation that used stop-word filtering
 * and token-overlap heuristics. The exported function signatures are
 * preserved for backward compatibility - callers unchanged.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { classify } from "../../../lib/ai/text-classifier.js";
import { CRITICS } from "../../../lib/ai/critic-registry.js";
import { onEvent } from "../../../lib/events/event-types.js";
import { ANCHOR_TURNS_BEFORE_RESET } from "../../../lib/constants/session-thresholds.js";
import { topicDriftFallback } from "../../../lib/ai/critic-fallbacks.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { BRAID_INJECTED, BRAID_SOURCE } from "../../../lib/constants/injection-details.js";

const log = createLogger("topic-drift");

// ── State types ───────────────────────────────────────────────────────────────

interface DriftState {
  /** The original request text (used by critics directly - no token extraction needed). */
  originalRequest: string;
  /** History of drift checks for observability. */
  driftHistory: DriftRecord[];
  /** Turns since last anchor reset. */
  turnsSinceAnchor: number;
}

interface DriftRecord {
  turn: number;
  similarity: number;
  drifted: boolean;
  missingCount: number;
}

// ── Configuration ───────────────────────────────────────────────────────────

const DRIFT_THRESHOLD = 0.5;
// ANCHOR_TURNS_BEFORE_RESET is now imported from
// lib/constants/session-thresholds.ts. See that file for the source of truth.

// ── Core logic (triple-critic) ──────────────────────────────────────────────

/**
 * Detect topic drift using triple-critic LLM classification.
 *
 * Runs three parallel classify() calls:
 *   coverage:     Does the response address the original request?
 *   divergence:   Has the response shifted to a different topic?
 *   completeness: Does the response cover all key topics?
 *
 * Consensus: 2/3 negative signals → drift confirmed.
 *
 * @param ctx - Extension context (for classify() LLM calls)
 * @param original - The original user request
 * @param output - The agent's response text
 * @returns drift verdict with fallback similarity and missing topics
 */
async function detectDriftWithCritics(
  ctx: ExtensionContext,
  original: string,
  output: string,
): Promise<{
  drifted: boolean;
  similarity: number;
  missingAnchors: string[];
  /**
   * True when all three classifier calls failed (tier === "failed" on
   * every result). Same anti-pattern fix as the lib version in
   * lib/detection/topic-drift-detector.ts (commit b25006f3):
   * never silently default to "no problem" when the classifier is
   * down. Surface the offline state to the agent (via tool result)
   * and to the operator (via the /logs command).
   */
  classifierDown?: boolean;
}> {
  // Truncate long texts to keep prompt tokens reasonable
  const truncOriginal = original.length > 2000 ? original.slice(0, 2000) + "..." : original;
  const truncOutput = output.length > 2000 ? output.slice(0, 2000) + "..." : output;

  // Skip very short outputs
  if (truncOutput.length < 30) {
    return { drifted: false, similarity: 1.0, missingAnchors: [] };
  }

  let classifierDown = false;
  try {
    const [coverageResult, divergenceResult, completenessResult] = await Promise.allSettled([
      classify(
        ctx,
        CRITICS.topicCoverage.criteria,
        { original: truncOriginal, response: truncOutput },
        { timeoutMs: 5000, label: CRITICS.topicCoverage.label, fallback: topicDriftFallback },
      ),
      classify(
        ctx,
        CRITICS.topicDivergence.criteria,
        { original: truncOriginal, response: truncOutput },
        { timeoutMs: 5000, label: CRITICS.topicDivergence.label, fallback: topicDriftFallback },
      ),
      classify(
        ctx,
        CRITICS.topicCompleteness.criteria,
        { original: truncOriginal, response: truncOutput },
        { timeoutMs: 5000, label: CRITICS.topicCompleteness.label, fallback: topicDriftFallback },
      ),
    ]);

    // Unwrap allSettled: failed calls become safe defaults.
    const unwrap = (r: PromiseSettledResult<Awaited<ReturnType<typeof classify>>>) =>
      r.status === "fulfilled" ? r.value : null;
    const coverageValue = unwrap(coverageResult);
    const divergenceValue = unwrap(divergenceResult);
    const completenessValue = unwrap(completenessResult);

    // Detect the "all classifiers failed" case. If every result is
    // tier === "failed" (or null), the LLM signal is unreliable and
    // we cannot trust the "no drift" default. Surface this so the
    // consumer can include a "drift detector offline" hint in the
    // tool result and the operator can see the degraded state.
    const allTiers = [coverageValue, divergenceValue, completenessValue];
    classifierDown = allTiers.every(
      (r) => r === null || r.tier === "failed",
    );

    // Interpret critics:
    //   coverage="no"  → response does NOT address the request (bad)
    //   divergence="yes" → response shifted to different topic (bad)
    //   completeness="no" → response misses key topics (bad)
    const coverageBad = coverageValue?.label === "no";
    const diverged = divergenceValue?.label === "yes";
    const incomplete = completenessValue?.label === "no";
    const negativeVotes = [coverageBad, diverged, incomplete].filter(Boolean).length;

    const drifted = negativeVotes >= 2;

    // Compute similarity proxy: 0.3 if drifted, 0.8 if not (heuristic estimate)
    const similarity = drifted ? 0.3 : 0.8;

    // Collect missing anchors from the completeness critic when drifted
    const missingAnchors: string[] = [];
    if (drifted) {
      // We don't get specific missing anchors from critics (they're yes/no classifiers).
      // Return a qualitative description instead.
      const clues: string[] = [];
      if (coverageBad) clues.push("coverage");
      if (diverged) clues.push("divergence");
      if (incomplete) clues.push("incomplete");
      missingAnchors.push(...clues);
    }

    log.debug(
      `[topic-drift] Critics: coverage=${coverageValue?.label}/${coverageValue?.tier}, ` +
        `divergence=${divergenceValue?.label}/${divergenceValue?.tier}, ` +
        `completeness=${completenessValue?.label}/${completenessValue?.tier} ` +
        `→ drifted=${drifted} classifierDown=${classifierDown}`,
    );

    return { drifted, similarity, missingAnchors, classifierDown };
  } catch (err) {
    log.warn(`[topic-drift] Critic call failed, assuming no drift: ${err}`);
    classifierDown = true;
    return { drifted: false, similarity: 1.0, missingAnchors: [], classifierDown: true };
  }
}

// ── Synchronous detectTopicDrift (backward-compat wrapper) ────────────────────
// Callers that pass a DriftState with originalRequest get a best-effort sync
// result. For full accuracy, use the async detectDriftWithCritics above.

/**
 * Legacy synchronous detectTopicDrift signature.
 *
 * Preserved for backward compatibility - uses heuristic defaults when
 * called without an ExtensionContext. Prefer the async critic-based
 * detection in event handlers where ctx is available.
 *
 * @deprecated Use the async variant with ExtensionContext when available.
 */
export function detectTopicDrift(
  _sessionId: string,
  output: string,
  state: DriftState,
  threshold = DRIFT_THRESHOLD,
): { drifted: boolean; similarity: number; missingAnchors: string[]; shouldReset: boolean } {
  const outputLen = output.length;
  // Conservative heuristic: long output is probably on-topic, short output might not be
  const similarity = outputLen > 200 ? 0.8 : outputLen > 50 ? 0.6 : 0.4;
  const drifted = similarity < threshold;
  const missingAnchors = drifted ? ["topic mismatch"] : [];

  // Only reset when we've had a long session with no meaningful output
  const shouldReset = state.turnsSinceAnchor >= ANCHOR_TURNS_BEFORE_RESET && outputLen < 100;

  state.driftHistory.push({
    turn: state.turnsSinceAnchor,
    similarity,
    drifted,
    missingCount: missingAnchors.length,
  });

  if (state.driftHistory.length > 10) {
    state.driftHistory = state.driftHistory.slice(-10);
  }

  state.turnsSinceAnchor++;
  return { drifted, similarity, missingAnchors, shouldReset };
}

/**
 * Reset drift state with a new request.
 * Stores the raw request text (no token extraction - critics use it directly).
 */
export function resetAnchors(state: DriftState, newRequest: string): void {
  state.originalRequest = newRequest;
  state.turnsSinceAnchor = 0;
  state.driftHistory = [];
  log.info(`[topic-drift] Anchors reset: "${newRequest.slice(0, 60)}..."`);
}

function createDriftState(): DriftState {
  return { originalRequest: "", driftHistory: [], turnsSinceAnchor: 0 };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractOutputText(event: any): string {
  if (typeof event?.result === "string") return event.result;
  if (typeof event?.result?.content === "string") return event.result.content;
  if (typeof event?.result?.text === "string") return event.result.text;
  if (typeof event?.output === "string") return event.output;
  if (typeof event?.text === "string") return event.text;
  // Non-text result (image, binary, structured data). Returning "" causes
  // callers to skip drift detection via the `output.length < 50` early-exit.
  // Previously this returned a JSON.stringify dump that got fed to the LLM
  // classifiers as "the agent's response" - which produced nonsense drift
  // signals. (ROADMAP P0-5 / DR-H-3)
  return "";
}

// ── Tool schemas ───────────────────────────────────────────────────────────

// Consolidated topic_drift schema (was checkDriftSchema + resetAnchorsSchema).
// action=check:   check if output matches original request
// action=reset:   reset anchors to a new request or current context
const topicDriftSchema = Type.Object({
  action: Type.Union([Type.Literal("check"), Type.Literal("reset")], {
    description: "Action: check | reset",
  }),
  output: Type.Optional(
    Type.String({ description: "Output text to check (action=check)" }),
  ),
  newRequest: Type.Optional(
    Type.String({ description: "New request to extract anchors from (action=reset)" }),
  ),
});

// ── Extension ──────────────────────────────────────────────────────────────

export default function topicDriftExtension(pi: ExtensionAPI) {
  log.info("Topic drift detector registering (triple-critic)");

  // ── Event listeners ────────────────────────────────────────────────────

  onEvent(pi, "user_message", (event: any, ctx: ExtensionContext) => {
    try {
      const state = getExtensionState(ctx, "topic-drift", createDriftState);
      const message =
        typeof event?.message === "string" ? event.message : JSON.stringify(event?.message ?? "");
      if (message.length > 20) {
        resetAnchors(state, message);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[topic-drift] user_message handler error: ${msg}`);
    }
  });

  onEvent(pi, "tool_result", async (event: any, ctx: ExtensionContext) => {
    try {
      const state = getExtensionState(ctx, "topic-drift", createDriftState);
      if (!state.originalRequest) return;

      const output = extractOutputText(event);
      if (output.length < 50) return;

      // Use triple-critic detection (async, with LLM)
      const result = await detectDriftWithCritics(ctx, state.originalRequest, output);

      // Surface the "drift detector offline" case as a soft whisper
      // so the agent knows the monitor is degraded. Same pattern as
      // the lib version (b25006f3).
      if (result.classifierDown) {
        // ROADMAP P0-1 / DR-C-1: use sendTrackedMessage instead of
        // ctx.whisper. The latter bypasses the per-source flood cap
        // and injection tracking. The text + customType are identical
        // so downstream consumers (e.g. the TUI) see the same format.
        try {
          sendTrackedMessage(
            pi,
            {
              customType: "topic-drift",
              content: [
                {
                  type: "text" as const,
                  text:
                    `Topic drift monitor is offline (classifier unavailable this turn). ` +
                    `If you suspect you're drifting, self-check against the original request: ` +
                    `"${state.originalRequest.substring(0, 80)}..."`,
                },
              ],
              display: true,
              details: { [BRAID_INJECTED]: true, [BRAID_SOURCE]: "topic-drift/offline" },
            },
            { deliverAs: "steer", triggerTurn: false },
            { type: "context", source: "topic-drift/offline" },
          );
        } catch (err) {
          log.warn(`[topic-drift] offline whisper failed: ${err}`);
        }
        return;
      }

      if (result.drifted && state.driftHistory.length > 1) {
        const recent = state.driftHistory.slice(-3);
        const allRecentDrifted = recent.every((r) => r.drifted);

        if (allRecentDrifted && result.similarity < 0.5) {
          const missing = result.missingAnchors.slice(0, 5).join(", ");
          // ROADMAP P0-1 / DR-C-1: use sendTrackedMessage.
          try {
            sendTrackedMessage(
              pi,
              {
                customType: "topic-drift",
                content: [
                  {
                    type: "text" as const,
                    text:
                      `Your response seems to cover different ground than the original request. ` +
                      `Signal: ${missing || "topic mismatch"}. ` +
                      `Original request: "${state.originalRequest.substring(0, 80)}..."`,
                  },
                ],
                display: true,
                details: { [BRAID_INJECTED]: true, [BRAID_SOURCE]: "topic-drift/drift-detected" },
              },
              { deliverAs: "steer", triggerTurn: false },
              { type: "context", source: "topic-drift/drift-detected" },
            );
          } catch (err) {
            log.warn(`[topic-drift] drift whisper failed: ${err}`);
          }
          log.info(
            `[topic-drift] Drift: similarity=${result.similarity.toFixed(2)}, ` +
              `missing=${result.missingAnchors.length}`,
          );
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[topic-drift] tool_result handler error: ${msg}`);
    }
  });

  // ── Tools ────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "topic_drift",
    label: "Topic Drift",
    promptSnippet: "Check output for topic drift or reset anchors",
    description:
      "Check if output matches the original user request, or reset the topic anchors. " +
      "Use action=check with output before responding to prevent drift. " +
      "Use action=reset with newRequest (or no params) to re-anchor to a new task.",
    parameters: topicDriftSchema,
    execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext): Promise<any> => {
      try {
        switch (params?.action) {
          case "check": {
            const state = getExtensionState(ctx, "topic-drift", createDriftState);
            const output = params.output ?? "";
            let drifted = false;
            let similarity = 1.0;
            let missingAnchors: string[] = [];
            let classifierDown = false;
            if (ctx && state.originalRequest) {
              const critResult = await detectDriftWithCritics(ctx, state.originalRequest, output);
              drifted = critResult.drifted;
              similarity = critResult.similarity;
              missingAnchors = critResult.missingAnchors;
              classifierDown = critResult.classifierDown ?? false;
            } else {
              const syncResult = detectTopicDrift("check", output, state);
              drifted = syncResult.drifted;
              similarity = syncResult.similarity;
              missingAnchors = syncResult.missingAnchors;
            }
            const details = {
              drifted,
              similarity: Math.round(similarity * 100) / 100,
              missingAnchors,
              originalRequest: state.originalRequest,
              driftHistory: state.driftHistory.slice(-5),
              classifierDown,
              recommendations: drifted
                ? [
                    `Response may have drifted from: "${state.originalRequest.slice(0, 60)}..."`,
                    "Verify your response addresses the core request.",
                  ]
                : classifierDown
                  ? [
                      "Topic drift check is offline (classifier unavailable this turn).",
                      "Manually verify your response addresses the original request.",
                    ]
                  : [],
            };
            // Surface the "drift detector offline" case in the text so
            // the agent doesn't read 'No topic drift' and think the
            // check ran normally. Same anti-pattern fix as the lib
            // version (b25006f3).
            const text = classifierDown
              ? `Topic drift check unavailable this turn (classifier offline). Run /logs level info for the underlying error.`
              : drifted
                ? `Topic drift detected (similarity: ${details.similarity}). Signals: ${missingAnchors.slice(0, 5).join(", ") || "topic mismatch"}.`
                : `No topic drift (similarity: ${details.similarity}).`;
            return { content: [{ type: "text" as const, text }], details };
          }
          case "reset": {
            const state = getExtensionState(ctx, "topic-drift", createDriftState);
            const request = params.newRequest ?? state.originalRequest;
            resetAnchors(state, request);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Topic anchors reset to: "${request.slice(0, 60)}..."`,
                },
              ],
              details: { success: true, originalRequest: state.originalRequest },
            };
          }
          default:
            throw new Error(`Unknown topic_drift action: ${params?.action}. Use: check, reset.`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`topic_drift failed: ${msg}`);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          details: { error: msg, action: params?.action },
        };
      }
    },
  } as ToolDefinition<any, any, any>);

  log.info("Topic drift detector registered: topic_drift (check + reset actions)");
}
