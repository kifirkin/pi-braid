/**
 * Nudge Analytics - shared helpers for enforcement ↔ analytics decoupling.
 *
 * Both enforcement and heartbeat/analytics import from here instead of directly
 * coupling across modules. If heartbeat is disabled (BRAID_MODULES=-heartbeat),
 * enforcement won't crash - these functions handle missing state gracefully.
 */

import { getExtensionState } from "../state/extension-state.js";
import { getNudgeAnalyticsFallback } from "../state/global-state.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Shared analytics state shape (subset used by enforcement) ──────────────

interface NudgeState {
  nudgesSent: number;
  nudgesSuppressed: number;
  abVariant: string;
  contextDensity: number;
  wasDegraded: boolean;
}

function createNudgeState(): NudgeState {
  return {
    nudgesSent: 0,
    nudgesSuppressed: 0,
    abVariant: "control",
    contextDensity: 0,
    wasDegraded: false,
  };
}

// Module-level `let` removed; see global-state.ts getNudgeAnalyticsFallback().
// The fallback is a process-global mirror of the most recent per-session state,
// used only by callers that no longer hold an ExtensionContext. It is reset
// implicitly by process restart (pi runs all extensions in a single process).
function getNudgeState(ctx?: ExtensionContext): NudgeState {
  if (ctx) {
    const s = getExtensionState(ctx, "nudge-analytics", createNudgeState);
    // Mirror the per-session state into the global fallback so callers
    // without a ctx can still see the most recent values.
    const fallback = getNudgeAnalyticsFallback();
    fallback.nudgesSent = s.nudgesSent;
    fallback.nudgesSuppressed = s.nudgesSuppressed;
    fallback.abVariant = s.abVariant;
    fallback.contextDensity = s.contextDensity;
    fallback.wasDegraded = s.wasDegraded;
    return s;
  }
  const fallback = getNudgeAnalyticsFallback();
  return {
    nudgesSent: fallback.nudgesSent,
    nudgesSuppressed: fallback.nudgesSuppressed,
    abVariant: fallback.abVariant,
    contextDensity: fallback.contextDensity,
    wasDegraded: fallback.wasDegraded,
  };
}

// ── Exported helpers ───────────────────────────────────────────────────────

export function recordNudgeSent(ctx: ExtensionContext): void {
  getNudgeState(ctx).nudgesSent++;
}

export function recordNudgeSuppressed(ctx: ExtensionContext): void {
  getNudgeState(ctx).nudgesSuppressed++;
}

export function getNudgeAnalytics(ctx?: ExtensionContext): {
  nudgesSent: number;
  nudgesSuppressed: number;
  abVariant: string;
  contextDensity: number;
  wasDegraded: boolean;
} {
  const s = getNudgeState(ctx);
  return {
    nudgesSent: s.nudgesSent,
    nudgesSuppressed: s.nudgesSuppressed,
    abVariant: s.abVariant,
    contextDensity: s.contextDensity,
    wasDegraded: s.wasDegraded,
  };
}

export function setAbVariant(ctx: ExtensionContext, variant: string): void {
  getNudgeState(ctx).abVariant = variant;
}

export function setNudgeContextDensity(ctx: ExtensionContext, density: number): void {
  getNudgeState(ctx).contextDensity = Math.round(density * 1000) / 10;
}

export function setNudgeDegraded(ctx: ExtensionContext, degraded: boolean): void {
  getNudgeState(ctx).wasDegraded = degraded;
}
