/**
 * @fileoverview Topic Drift Detector.
 *
 * Detects when agent output diverges from the original user request.
 * Uses lightweight semantic anchor tracking — no LLM needed.
 *
 * Based on the "braid paper" failure mode where agents produce fluent
 * but off-topic output.
 *
 * Part of TIER 1 infrastructure activation.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../../lib/logger.js";
import { getExtensionState } from "../../../lib/extension-state.js";

const log = createLogger("topic-drift");

// ── State types ───────────────────────────────────────────────────────────────

interface DriftState {
  anchors: Set<string>;
  originalRequest: string;
  driftHistory: DriftRecord[];
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
const ANCHOR_TURNS_BEFORE_RESET = 50;
const ANCHOR_MIN_TOKENS = 2;

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "had",
  "her",
  "was",
  "one",
  "our",
  "out",
  "day",
  "get",
  "has",
  "him",
  "his",
  "how",
  "its",
  "may",
  "new",
  "now",
  "old",
  "see",
  "way",
  "who",
  "boy",
  "did",
  "let",
  "put",
  "say",
  "she",
  "too",
  "use",
  "that",
  "with",
  "have",
  "this",
  "from",
  "they",
  "will",
  "would",
  "there",
  "their",
  "what",
  "been",
  "more",
  "when",
  "your",
  "come",
  "could",
  "only",
  "other",
  "than",
  "into",
  "some",
  "them",
  "then",
  "these",
  "take",
  "made",
  "very",
  "just",
  "over",
  "such",
  "also",
  "back",
  "after",
  "work",
  "first",
  "well",
  "even",
  "want",
  "because",
  "any",
  "between",
  "don't",
  "it's",
  "should",
  "about",
  "going",
  "implement",
  "add",
  "create",
  "build",
  "make",
  "write",
  "fix",
  "update",
]);

// ── Core logic ──────────────────────────────────────────────────────────────

export function extractAnchors(request: string): Set<string> {
  const normalized = request.toLowerCase();
  const tokens = normalized
    .split(/[^\w]+/)
    .filter((t) => t.length >= ANCHOR_MIN_TOKENS && !STOP_WORDS.has(t));
  const identifiers = normalized.match(/[a-z][A-Z][a-z]+/g) || [];
  const compounds = normalized.match(/\w{6,}/g) || [];
  return new Set([...tokens, ...identifiers, ...compounds]);
}

export function measureAnchorPresence(output: string, anchors: Set<string>): number {
  if (anchors.size === 0) return 1.0;
  const outputLower = output.toLowerCase();
  const outputTokens = new Set(outputLower.split(/[^\w]+/));
  const identifiers = outputLower.match(/[a-z][A-Z][a-z]+/g) || [];

  let present = 0;
  for (const anchor of anchors) {
    if (
      outputTokens.has(anchor) ||
      outputLower.includes(anchor) ||
      identifiers.some((id) => id.toLowerCase().includes(anchor.toLowerCase()))
    ) {
      present++;
    }
  }
  return present / anchors.size;
}

export function getMissingAnchors(output: string, anchors: Set<string>): string[] {
  const outputLower = output.toLowerCase();
  const outputTokens = new Set(outputLower.split(/[^\w]+/));
  const identifiers = outputLower.match(/[a-z][A-Z][a-z]+/g) || [];

  return [...anchors].filter((anchor) => {
    if (outputTokens.has(anchor) || outputLower.includes(anchor)) return false;
    if (identifiers.some((id) => id.toLowerCase().includes(anchor.toLowerCase()))) return false;
    return true;
  });
}

export function detectTopicDrift(
  _sessionId: string,
  output: string,
  state: DriftState,
  threshold = DRIFT_THRESHOLD,
): { drifted: boolean; similarity: number; missingAnchors: string[]; shouldReset: boolean } {
  const similarity = measureAnchorPresence(output, state.anchors);
  const missingAnchors = getMissingAnchors(output, state.anchors);
  const drifted = similarity < threshold;
  const shouldReset = state.turnsSinceAnchor >= ANCHOR_TURNS_BEFORE_RESET;

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

export function resetAnchors(state: DriftState, newRequest: string): void {
  state.anchors = extractAnchors(newRequest);
  state.originalRequest = newRequest;
  state.turnsSinceAnchor = 0;
  state.driftHistory = [];
  log.info(`[topic-drift] Anchors reset: ${state.anchors.size} tokens`);
}

function createDriftState(): DriftState {
  return { anchors: new Set(), originalRequest: "", driftHistory: [], turnsSinceAnchor: 0 };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractOutputText(event: any): string {
  if (typeof event?.result === "string") return event.result;
  if (typeof event?.result?.content === "string") return event.result.content;
  if (typeof event?.result?.text === "string") return event.result.text;
  if (typeof event?.output === "string") return event.output;
  if (typeof event?.text === "string") return event.text;
  return JSON.stringify(event?.result ?? event ?? "").substring(0, 2000);
}

// ── Tool schemas ───────────────────────────────────────────────────────────

const checkDriftSchema = Type.Object({
  output: Type.String({ description: "Output text to check against anchors" }),
});

const resetAnchorsSchema = Type.Object({
  newRequest: Type.Optional(Type.String({ description: "New request to extract anchors from" })),
});

// ── Extension ──────────────────────────────────────────────────────────────

export default function topicDriftExtension(pi: ExtensionAPI) {
  log.info("Topic drift detector registering");

  // ── Event listeners (use 'any' cast — events exist at runtime) ─────────

  (pi as any).on("user_message", (event: any, ctx: ExtensionContext) => {
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

  (pi as any).on("tool_result", (event: any, ctx: ExtensionContext) => {
    try {
      const state = getExtensionState(ctx, "topic-drift", createDriftState);
      if (state.anchors.size === 0) return;

      const output = extractOutputText(event);
      if (output.length < 50) return;

      const result = detectTopicDrift(ctx.cwd ?? "unknown", output, state);

      if (result.drifted && state.driftHistory.length > 1) {
        const recent = state.driftHistory.slice(-3);
        const allRecentDrifted = recent.every((r) => r.drifted);

        if (allRecentDrifted && result.similarity < 0.3) {
          const missing = result.missingAnchors.slice(0, 5).join(", ");
          ctx.whisper?.(
            `Your response seems to cover different ground than the original request. ` +
              `Missing key topics from request: ${missing || "none detected"}. ` +
              `Original request: "${state.originalRequest.substring(0, 80)}..."`,
            { category: "cognitive", priority: "low" },
          );
          log.info(
            `[topic-drift] Drift: similarity=${result.similarity.toFixed(2)}, ` +
              `missing=${result.missingAnchors.length}`,
          );
        }
      }

      if (result.shouldReset && state.originalRequest) {
        log.info("[topic-drift] Anchors auto-reset after timeout");
        resetAnchors(state, state.originalRequest);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[topic-drift] tool_result handler error: ${msg}`);
    }
  });

  // ── Tools ────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "check_topic_drift",
    label: "Check Topic Drift",
    promptSnippet: "Check if output matches the original user request",
    description: "Check if output still matches the original request — use before responding to prevent topic drift.",
    parameters: checkDriftSchema,
    execute: async (_toolCallId: string, params: any): Promise<any> => {
      try {
        const p = params as { output?: string };
        const state = getExtensionState({ cwd: "check" } as any, "topic-drift", createDriftState);
        const output = p.output ?? "";
        const result = detectTopicDrift("check", output, state);

        const details = {
          drifted: result.drifted,
          similarity: Math.round(result.similarity * 100) / 100,
          missingAnchors: result.missingAnchors,
          anchorCount: state.anchors.size,
          originalRequest: state.originalRequest,
          driftHistory: state.driftHistory.slice(-5),
          recommendations: result.drifted
            ? [
                `Include these topics from the original request: ${result.missingAnchors.slice(0, 5).join(", ")}`,
                "Verify your response addresses the core request.",
              ]
            : [],
        };

        const text = result.drifted
          ? `Topic drift detected (similarity: ${details.similarity}). Missing anchors: ${details.missingAnchors.slice(0, 5).join(", ")}.`
          : `No topic drift (similarity: ${details.similarity}). All anchors present.`;
        return {
          content: [{ type: "text" as const, text }],
          details,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`check_topic_drift failed: ${msg}`);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          details: { drifted: false, similarity: 0, error: msg },
        };
      }
    },
  } as any);

  pi.registerTool({
    name: "reset_topic_anchors",
    label: "Reset Topic Anchors",
    promptSnippet: "Reset topic anchors to a new request or context",
    description: "Reset topic anchors to a new request or the current context — use when the task shifts to prevent false drift detection.",
    parameters: resetAnchorsSchema,
    execute: async (_toolCallId: string, params: any): Promise<any> => {
      try {
        const p = params as { newRequest?: string };
        const state = getExtensionState({ cwd: "reset" } as any, "topic-drift", createDriftState);
        const request = p.newRequest ?? state.originalRequest;
        resetAnchors(state, request);

        return {
          content: [
            {
              type: "text" as const,
              text: `Topic anchors reset: ${state.anchors.size} tokens extracted.`,
            },
          ],
          details: {
            success: true,
            anchorCount: state.anchors.size,
            anchors: [...state.anchors],
            originalRequest: state.originalRequest,
          },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`reset_topic_anchors failed: ${msg}`);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          details: { success: false, error: msg },
        };
      }
    },
  } as any);

  log.info("Topic drift detector registered: check_topic_drift, reset_topic_anchors");
}
