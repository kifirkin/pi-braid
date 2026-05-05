/**
 * Nudge Analytics — shared helpers for enforcement ↔ analytics decoupling.
 *
 * Both enforcement and heartbeat/analytics import from here instead of directly
 * coupling across modules. If heartbeat is disabled (BRAID_MODULES=-heartbeat),
 * enforcement won't crash — these functions handle missing state gracefully.
 */

import { getExtensionState } from "./extension-state.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

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

let _lastNudgeState: NudgeState | null = null;

function getNudgeState(ctx?: ExtensionContext): NudgeState {
  if (ctx) {
    const s = getExtensionState(ctx, "analytics", createNudgeState);
    _lastNudgeState = s;
    return s;
  }
  if (_lastNudgeState) return _lastNudgeState;
  return createNudgeState();
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
