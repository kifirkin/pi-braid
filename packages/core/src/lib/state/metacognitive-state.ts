/**
 * Metacognitive State - session-scoped via ExtensionContext
 *
 * Tracks: confidence, knowledge gaps, strengths, weaknesses.
 * Supports ctx-scoped calls AND global fallback (for legacy tool handlers without ctx).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "./extension-state.js";

export interface MetacognitiveState {
  confidence: number;
  knowledgeGaps: string[];
  strengths: string[];
  weaknesses: string[];
  lastReviewAt?: number;
}

const DEFAULT_STATE = (): MetacognitiveState => ({
  confidence: 0.8,
  knowledgeGaps: [],
  strengths: [],
  weaknesses: [],
});

const _globalState: MetacognitiveState = DEFAULT_STATE();

function getStateFrom(ctx: ExtensionContext | undefined): MetacognitiveState {
  if (ctx) {
    return getExtensionState(ctx, "metacognitive-state", DEFAULT_STATE);
  }
  return _globalState;
}

export function getMetacognitiveState(ctx?: ExtensionContext): MetacognitiveState {
  return { ...getStateFrom(ctx) };
}

export function adjustConfidence(ctx: ExtensionContext | undefined, delta: number): void {
  const s = getStateFrom(ctx);
  s.confidence = Math.max(0, Math.min(1, s.confidence + delta));
  s.lastReviewAt = Date.now();
}

export function recordFailure(ctx: ExtensionContext | undefined, errorType: string): void {
  adjustConfidence(ctx, -0.1);
  const s = getStateFrom(ctx);
  if (!s.knowledgeGaps.includes(errorType)) {
    s.knowledgeGaps.push(errorType);
  }
}

/** @deprecated No-op: state is ctx-scoped via getExtensionState. Kept only until its remaining callers stop calling it. */
export function initMetacognitiveState(_storageDir?: string): void {
  /* no-op */
}

export function getRecommendation(ctx?: ExtensionContext): string | null {
  const s = getStateFrom(ctx);
  if (s.confidence < 0.3) return "Low confidence - consider requesting help or switching approach";
  if (s.knowledgeGaps.length > 5)
    return "Many knowledge gaps - consider research or learning phase";
  if (s.weaknesses.length > 3) return "Multiple weaknesses identified - focus on addressing them";
  return null;
}
