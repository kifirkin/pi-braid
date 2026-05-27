/**
 * Metacognitive State — session-scoped via ExtensionContext
 *
 * Tracks: confidence, knowledge gaps, strengths, weaknesses.
 * Supports ctx-scoped calls AND global fallback (for legacy tool handlers without ctx).
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
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

// ── Global fallback (legacy — for tool handlers without ctx) ────────────────────
const _globalState: MetacognitiveState = DEFAULT_STATE();

// ── State access ────────────────────────────────────────────────────────────────

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

export function recordSuccess(ctx?: ExtensionContext): void {
  adjustConfidence(ctx, 0.02);
}

export function recordFailure(ctx: ExtensionContext | undefined, errorType: string): void {
  adjustConfidence(ctx, -0.1);
  const s = getStateFrom(ctx);
  if (!s.knowledgeGaps.includes(errorType)) {
    s.knowledgeGaps.push(errorType);
  }
}

export function addStrength(ctx: ExtensionContext | undefined, strength: string): void {
  const s = getStateFrom(ctx);
  if (!s.strengths.includes(strength)) {
    s.strengths.push(strength);
    s.lastReviewAt = Date.now();
  }
}

export function addWeakness(ctx: ExtensionContext | undefined, weakness: string): void {
  const s = getStateFrom(ctx);
  if (!s.weaknesses.includes(weakness)) {
    s.weaknesses.push(weakness);
    s.lastReviewAt = Date.now();
  }
}

export function resolveKnowledgeGap(ctx: ExtensionContext | undefined, gap: string): void {
  const s = getStateFrom(ctx);
  s.knowledgeGaps = s.knowledgeGaps.filter((g) => g !== gap);
}

export function shouldRequestHelp(ctx?: ExtensionContext): boolean {
  return getStateFrom(ctx).confidence < 0.3;
}

// ── Lifecycle (no-ops — storage removed) ────────────────────────────────────────

/** @deprecated Will be removed in v0.3.0 — state is now ctx-scoped via getExtensionState. No-op. */
export function initMetacognitiveState(_storageDir?: string): void {
  /* no-op */
}

/** @deprecated State is now ctx-scoped via getExtensionState. No-op. */
export function resetMetacognitiveState(): void {
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
