/**
 * @fileoverview Topic Drift Detector.
 *
 * Detects when agent output diverges from the original user request.
 * Uses consolidated single-LLM-call critique returning coverage,
 * divergence, and completeness in one structured JSON response.
 *
 * Model tier strategy (in consolidatedTopicCritique):
 *   session -> utility -> max-power -> conservative defaults.
 *
 * The 3-parallel classifyWithOffline fallback was removed in P2-7
 * because the consolidated call covers the same model tiers and
 * produces equivalent defaults when all LLM tiers are down.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../../lib/core/logger.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { onEvent } from "../../../lib/events/event-types.js";
import { ANCHOR_TURNS_BEFORE_RESET } from "../../../lib/constants/session-thresholds.js";
import { consolidatedTopicCritique } from "../../../lib/detection/consolidated-topic-critic.js";
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

// ── Core logic (consolidated critic) ─────────────────────────────────────────

/**
 * Detect topic drift using consolidated single-LLM-call critique.
 *
 * Uses a single LLM call returning structured JSON with all three
 * verdicts (coverage, divergence, completeness). No 3-parallel
 * fallback needed because the consolidated call already tries all
 * available model tiers (session, utility, max-power) before
 * falling back to conservative defaults.
 *
 * Consensus: 2/3 negative signals -> drift confirmed.
 *
 * ROADMAP P2-7 / DR-H-9: the 3-parallel fallback was removed because
 * the consolidated call covers the same model tiers and produces the
 * same conservative defaults when all LLM tiers fail. The only edge
 * case (transient error on the consolidated call) is handled by the
 * consolidated call's own tier retry — no information is lost.
 *
 * @param ctx - Extension context (for classify() LLM calls)
 * @param original - The original user request
 * @param output - The agent's response text
 * @returns drift verdict with similarity and missing topics
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
   * True when the consolidated critic call failed on all 3 model
   * tiers. Never silently default to "no problem" when the
   * classifier is down. Surface the offline state to the agent
   * (via tool result) and to the operator (via the /logs command).
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

  // ── SINGLE PATH: consolidated single-LLM-call ─────────────────────────
  // The consolidated call tries session -> utility -> max-power model
  // tiers. If all fail, it returns conservative defaults with
  // classifierDown=true. No 3-parallel fallback needed (P2-7).
  try {
    const consolidated = await consolidatedTopicCritique(truncOriginal, truncOutput, ctx);

    // Derive verdicts regardless of classifierDown state — the
    // consolidated call returns reasonable defaults even when down.
    const coverageBad = !consolidated.coverage;
    const diverged = consolidated.divergence;
    const incomplete = !consolidated.completeness;
    const negativeVotes = [coverageBad, diverged, incomplete].filter(Boolean).length;
    const drifted = negativeVotes >= 2;
    const similarity = drifted ? 0.3 : 0.8;

    const missingAnchors: string[] = [];
    if (drifted) {
      const clues: string[] = [];
      if (coverageBad) clues.push("coverage");
      if (diverged) clues.push("divergence");
      if (incomplete) clues.push("incomplete");
      missingAnchors.push(...clues);
    }

    log.debug(
      `[topic-drift] Consolidated: coverage=${consolidated.coverage}, ` +
        `divergence=${consolidated.divergence}, completeness=${consolidated.completeness} ` +
        `-> drifted=${drifted} classifierDown=${consolidated.classifierDown}`,
    );

    return {
      drifted,
      similarity,
      missingAnchors,
      classifierDown: consolidated.classifierDown,
    };
  } catch (err) {
    log.warn(`[topic-drift] Consolidated call failed: ${err}`);
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
  log.info("Topic drift detector registering (consolidated critic)");

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

      // Use consolidated critic detection (async, with LLM)
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

function createTopicDriftTool(): ToolDefinition<any, any, any> {
  return {
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
  };
}

// ── Tools ────────────────────────────────────────────────────────────────

pi.registerTool(createTopicDriftTool());
  log.info("Topic drift detector registered: topic_drift (check + reset actions)");
}
