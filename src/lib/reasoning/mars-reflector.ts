/**
 * Tool Usage Frequency Analyzer
 *
 * Analyzes agent tool usage patterns over a session and generates heuristic
 * advice when a tool is used disproportionately or errors recur.
 * Not based on any specific paper — simple statistical thresholding.
 *
 * Trigger: adaptive (not fixed N turns) — check on every turn_end.
 * Only whispers if actionable advice exists.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState, hasExtensionState } from "../state/extension-state.js";
import { marsOveruseMultiplier as dynamicOveruseMultiplier } from "../reasoning/advice-tracker.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SessionPattern {
  toolDistribution: Map<string, number>;
  errorTypes: Map<string, number>;
  confidenceTrend: number[];
  stabilityTrend: number[];
  errorRate: number;
  consecutiveErrors: number;
}

export interface MARSAdvice {
  type: "tool_overuse" | "error_recurrence" | "confidence_decline" | "stability_decline";
  message: string;
  severity: "info" | "warn";
}

// ── State factory ──────────────────────────────────────────────────────────────

interface MARSState {
  patternSnapshot: SessionPattern | null;
  lastAdviceAt: number;
  adviceCooldownMs: number;
}

function getState(ctx: ExtensionContext): MARSState {
  return getExtensionState(ctx, "mars-reflector", () => ({
    patternSnapshot: null,
    lastAdviceAt: 0,
    adviceCooldownMs: 60_000, // 60s between advice
  }));
}

// ── Constants ────────────────────────────────────────────────────────────────//

/** First N calls of each tool = learning phase, not flagged as pattern */
const LEARNING_PHASE_CALLS = 5;

/**
 * Overuse multiplier. Starts at 3, dynamically adjusted by advice tracker.
 * Accessed via live `let` export from advice-tracker.js.
 */
const OVERUSE_MULTIPLIER = dynamicOveruseMultiplier;

/** Flag as overused only if success rate below this threshold */
const MIN_SUCCESS_RATE_FOR_OVERUSE = 0.5;

// ── Pattern analysis ──────────────────────────────────────────────────────────

/** Build current session pattern from enforcement state */
export function buildPattern(ctx: ExtensionContext): SessionPattern {
  const _state = getState(ctx);
  // Get pattern from enforcement state if available
  const eState = hasExtensionState(ctx, "enforcement")
    ? getExtensionState(
        ctx,
        "enforcement",
        () => ({ consecutiveErrorTurns: 0 }) as Record<string, unknown>,
      )
    : null;
  if (!eState) {
    return {
      toolDistribution: new Map(),
      errorTypes: new Map(),
      confidenceTrend: [],
      stabilityTrend: [],
      errorRate: 0,
      consecutiveErrors: 0,
    };
  }

  // Build tool distribution
  const toolDist = new Map<string, number>();
  for (const tool of (eState.toolLog as string[]) || []) {
    toolDist.set(tool, (toolDist.get(tool) || 0) + 1);
  }

  // Build stability trend from recent stability signals
  const stabilityTrend: number[] = [];
  const signals =
    (eState as { enforcementSignals?: Record<string, unknown> }).enforcementSignals || {};
  for (const [, signal] of Object.entries(signals)) {
    const s = signal as { turn?: number; text?: string };
    if (s?.turn !== undefined && s?.text?.includes("[stability]")) {
      const match = s.text.match(/overlap=([0-9.]+)/);
      if (match) stabilityTrend.push(parseFloat(match[1]));
    }
  }

  return {
    toolDistribution: toolDist,
    errorTypes: new Map(),
    confidenceTrend: [],
    stabilityTrend,
    errorRate: 0,
    consecutiveErrors: (eState as { consecutiveErrors?: number }).consecutiveErrors || 0,
  };
}

/**
 * Generate actionable advice based on pattern.
 *
 * Smart over-use detection:
 * 1. Learning phase: first LEARNING_PHASE_CALLS of each tool = normal (not flagged)
 * 2. Success-adjusted: only flag if tool is failing AND overused
 * 3. Frequency-based: flag only if count > average * OVERUSE_MULTIPLIER
 */
export function generateAdvice(
  current: SessionPattern,
  previous: SessionPattern | null,
  toolSuccessRates?: Map<string, number>,
): MARSAdvice | null {
  // Tool over-reliance: one tool > OVERUSE_MULTIPLIER * average AND failing
  // AND not in learning phase (first N calls)
  if (current.toolDistribution.size > 0) {
    const total = [...current.toolDistribution.values()].reduce((a, b) => a + b, 0);
    const avgPerTool = total / current.toolDistribution.size;

    for (const [tool, count] of current.toolDistribution) {
      // Learning phase: first N calls = normal behavior
      if (count <= LEARNING_PHASE_CALLS) continue;

      // Frequency check: flag only if significantly above average
      const isOverused = count > avgPerTool * OVERUSE_MULTIPLIER;
      if (!isOverused) continue;

      // Success check: flag only if tool is failing (not just being used a lot)
      const successRate = toolSuccessRates?.get(tool) ?? 1.0;
      const isFailing = successRate < MIN_SUCCESS_RATE_FOR_OVERUSE;

      // Only flag if both overused AND failing, or severely overused (>10x average)
      const severeOveruse = count > avgPerTool * 10;
      if (isOverused && (isFailing || severeOveruse)) {
        const successStr = toolSuccessRates ? `${Math.round(successRate * 100)}% success` : "";
        const suggestion = isFailing
          ? "Consider: alternative tools, grep/find vs bash, or step back to verify approach."
          : "Verify this is intentional before continuing.";
        return {
          type: "tool_overuse",
          message: `[mars] ${tool} used ${count}/${total} times (${Math.round((count / total) * 100)}%${successStr ? `, ${successStr}` : ""}). ${suggestion}`,
          severity: "warn",
        };
      }
    }
  }

  // Error recurrence: same error type 3+ times
  if (current.consecutiveErrors >= 3) {
    return {
      type: "error_recurrence",
      message: `[mars] ${current.consecutiveErrors} consecutive errors detected. Consider: think(type="reflection") to identify root cause before continuing.`,
      severity: "warn",
    };
  }

  // Stability decline: trend going down
  if (previous && current.stabilityTrend.length > 2 && previous.stabilityTrend.length > 2) {
    const prevAvg = previous.stabilityTrend.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const currAvg = current.stabilityTrend.slice(-3).reduce((a, b) => a + b, 0) / 3;
    if (currAvg < prevAvg * 0.7) {
      return {
        type: "stability_decline",
        message: `[mars] Response quality declining (avg stability ${currAvg.toFixed(2)} vs ${prevAvg.toFixed(2)} earlier). Consider refocusing on the original task.`,
        severity: "info",
      };
    }
  }

  return null;
}

/** Check if MARS should give advice on this turn */
export function shouldAdvise(ctx: ExtensionContext): MARSAdvice | null {
  const state = getState(ctx);
  const now = Date.now();

  // Cooldown check
  if (now - state.lastAdviceAt < state.adviceCooldownMs) return null;

  const current = buildPattern(ctx);
  const advice = generateAdvice(current, state.patternSnapshot);

  if (advice) {
    state.lastAdviceAt = now;
    state.patternSnapshot = current;
  }

  return advice;
}

/** Reset MARS state for a new session */
export function resetMARS(ctx: ExtensionContext): void {
  const state = getState(ctx);
  state.patternSnapshot = null;
  state.lastAdviceAt = 0;
}
