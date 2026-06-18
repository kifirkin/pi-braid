/**
 * Context Hygiene Module - proactive context management.
 *
 * Based on SimpleMem (2601.02553) and GenericAgent (2604.17091).
 * Monitors context density, token usage, and duplicate messages.
 * Emits density signals into the S-MMU lifecycle for policy evaluation.
 */

import type { CognitiveModule } from "../types.js";
import { createLogger } from "../../../../lib/core/logger.js";
import { evaluateContextDensity } from "../../../../lib/detection/context-density.js";
import { getExtensionState } from "../../../../lib/state/extension-state.js";
import { eventBus } from "../../../../lib/events/event-bus.js";
import {
  DENSITY_LOW,
  DENSITY_VERY_LOW,
  TOKEN_RATIO_LARGE_CONTEXT,
  HYGIENE_LOW_DENSITY_CONSECUTIVE_MIN,
  HYGIENE_DENSITY_WHISPER_COOLDOWN_TURNS,
  HYGIENE_LARGE_CONTEXT_COOLDOWN_TURNS,
  HYGIENE_AUTO_COMPACT_COOLDOWN_TURNS,
} from "../../../../lib/detection/context-thresholds.js";
import {
  generateDensitySignals,
  evaluateDensityPolicies,
} from "../../../memory/context-lifecycle/policy-engine.js";

const log = createLogger("heartbeat:context-hygiene");

// ── Proactive Detection Constants ───────────────────────────────────────────────

/** Max token snapshots to keep for growth-rate projection. */
const MAX_SNAPSHOTS = 10;

/** If projected full within this many turns, emit proactive warning. */
const PROACTIVE_THRESHOLD_TURNS = 15;

/** The usage ratio at which we consider context "full" (80%). */
const PROJECTION_TARGET_RATIO = 0.8;

/** Default token limit used when limit is unknown. */
const DEFAULT_TOKEN_LIMIT = 100_000;

// Note: density thresholds are imported from context-thresholds.ts:
//   DENSITY_LOW (0.4), DENSITY_VERY_LOW (0.25), TOKEN_RATIO_LARGE_CONTEXT (0.6)

/**
 * Estimate how many turns remain before context hits PROJECTION_TARGET_RATIO.
 * Uses linear regression on the last N token-usage snapshots.
 * Returns Infinity if not enough data or negative growth rate.
 */
function estimateRemainingTurns(
  snapshots: Array<{ turn: number; tokens: number }>,
  currentTokens: number,
  _currentTurn: number,
): number {
  if (snapshots.length < 2) return Infinity;

  // Use only the last few snapshots for a current growth rate
  const window = snapshots.slice(-5);
  if (window.length < 2) return Infinity;

  // Simple linear fit: Δtokens / Δturns
  const first = window[0];
  const last = window[window.length - 1];
  const turnDelta = last.turn - first.turn;
  if (turnDelta <= 0) return Infinity;

  const tokenDelta = last.tokens - first.tokens;
  if (tokenDelta <= 0) return Infinity; // Not growing (compaction may have happened)

  const tokensPerTurn = tokenDelta / turnDelta;
  if (tokensPerTurn <= 0) return Infinity;

  const targetTokens = Math.ceil(PROJECTION_TARGET_RATIO * DEFAULT_TOKEN_LIMIT);
  const remainingTokens = targetTokens - currentTokens;
  if (remainingTokens <= 0) return 0;

  return remainingTokens / tokensPerTurn;
}

/** Replace {placeholder} in message with values from context dict. */
function interpolateMessage(message: string, ctx: Record<string, number | string>): string {
  let result = message;
  for (const [key, value] of Object.entries(ctx)) {
    result = result.replace(new RegExp(`{${key}(?:%|}|[a-zA-Z])`, "g"), String(value));
  }
  for (const [key, value] of Object.entries(ctx)) {
    result = result.replace(new RegExp(`{${key}}`, "g"), String(value));
  }
  return result;
}

export const contextHygieneModule: CognitiveModule = {
  name: "context-hygiene",
  description: "Proactive context management (SimpleMem 2601.02553, GenericAgent 2604.17091)",
  priority: 0.9,

  shouldActivate(context): boolean {
    const turns = context.turnCount;
    const threshold = turns < 30 ? 7 : 4;
    const last = context.lastActivation.get("context-hygiene") ?? 0;
    return turns - last >= threshold;
  },

  async activate(context): Promise<void> {
    const ctx = context.ctx;
    const density = evaluateContextDensity(ctx);

    // Emit density signals into S-MMU lifecycle
    const signals = generateDensitySignals(ctx);

    try {
      for (const signal of signals) {
        const state = getExtensionState(ctx, "context-lifecycle", () => ({
          signalQueue: [] as unknown[],
        }));
        state.signalQueue.push(signal);
      }
      const proposals = evaluateDensityPolicies(ctx, signals);
      for (const proposal of proposals) {
        if (proposal.action.type === "propose" && proposal.priority > 55) {
          const msg = interpolateMessage(proposal.action.message, {
            density: Math.round(density.density * 100),
            noise: density.noisyMessages,
            signal: density.signalMessages,
            ratio: Math.round(density.tokenRatio * 100),
            count: density.duplicates,
          });
          context.whisper(msg, { category: "cognitive", priority: "medium" });
        }
      }
    } catch {
      log.debug("Density policies not available, using direct whisper");
    }

    // ── Proactive context_full projection ────────────────────────────────
    // Track token usage snapshots to project when context will be full.
    const state = getExtensionState(ctx, "context-hygiene-projection", () => ({
      snapshots: [] as Array<{ turn: number; tokens: number }>,
      lastProjectedRemaining: Infinity,
      lastProjectionWhisperTurn: -20,
    }));

    const currentTurn = context.turnCount;
    state.snapshots.push({ turn: currentTurn, tokens: density.totalTokens });
    if (state.snapshots.length > MAX_SNAPSHOTS) {
      state.snapshots = state.snapshots.slice(-MAX_SNAPSHOTS);
    }

    const remainingTurns = estimateRemainingTurns(
      state.snapshots,
      density.totalTokens,
      currentTurn,
    );

    if (
      remainingTurns <= PROACTIVE_THRESHOLD_TURNS &&
      remainingTurns < state.lastProjectedRemaining &&
      currentTurn - state.lastProjectionWhisperTurn >= 15
    ) {
      state.lastProjectedRemaining = remainingTurns;
      state.lastProjectionWhisperTurn = currentTurn;

      const projectedUsage =
        density.tokenRatio +
        (PROJECTION_TARGET_RATIO - density.tokenRatio) *
          (1 - remainingTurns / PROACTIVE_THRESHOLD_TURNS);

      try {
        eventBus.emit({
          type: "context_full",
          usagePercent: Math.min(projectedUsage * 100, 100),
          tokensUsed: density.totalTokens,
          tokensLimit: DEFAULT_TOKEN_LIMIT,
        });
      } catch (err) {
        log.warn(`[context-hygiene] Could not emit context_full event: ${err}`);
      }

      const projectedPercent = Math.min(Math.round(projectedUsage * 100), 100);
      context.whisper(
        `[proactive] Context projected at ${projectedPercent}% in ` +
          `${Math.ceil(remainingTurns)} turns (${(density.totalTokens / 1000).toFixed(0)}K tokens, ` +
          `${(density.tokenRatio * 100).toFixed(0)}% now). ` +
          `Pipeline: context_tag → context_checkout to branch before hitting limit.`,
        { category: "cognitive", priority: remainingTurns <= 3 ? "high" : "medium" },
      );
    } else if (remainingTurns > PROACTIVE_THRESHOLD_TURNS * 2) {
      // Reset if we've freed up significant space (compaction happened)
      state.lastProjectedRemaining = Infinity;
    }

    // ── Suggest compaction on sustained low density ─────────────────
    // If density stays < 0.4 for 3+ consecutive ticks, whisper a suggestion
    // to call context_compact() instead of auto-compacting mid-turn.
    // ctx.compact() calls this._disconnectFromAgent() + this.abort() in
    // pi core (agent-session.js:1245), which breaks the agent loop.
    const autoCompactState = getExtensionState(ctx, "context-hygiene-autocompact", () => ({
      consecutiveLowDensity: 0,
      lastAutoCompactTurn: -20,
      lastDensityWhisperTurn: -20,
      lastLargeContextWhisperTurn: -20,
      lastDuplicateWhisperTurn: -20,
    }));

    if (density.density < DENSITY_LOW) {
      autoCompactState.consecutiveLowDensity++;

      if (
        autoCompactState.consecutiveLowDensity >= HYGIENE_LOW_DENSITY_CONSECUTIVE_MIN &&
        currentTurn - autoCompactState.lastAutoCompactTurn >= HYGIENE_AUTO_COMPACT_COOLDOWN_TURNS
      ) {
        const ticks = autoCompactState.consecutiveLowDensity;
        autoCompactState.lastAutoCompactTurn = currentTurn;
        autoCompactState.consecutiveLowDensity = 0;
        // Whisper a high-priority suggestion - don't call ctx.compact()
        // as it aborts the agent mid-turn (agent-session.js:1245)
        context.whisper(
          "Context density still low (" +
            Math.round(density.density * 100) +
            "% signal). " +
            "Noisy: " +
            density.noisyMessages +
            ", Signal: " +
            density.signalMessages +
            ". Pipeline: context_tag → context_checkout → context_archive → compact (last resort).",
          { category: "cognitive", priority: "high" },
        );
        log.info(
          `Low density persisted: ${Math.round(density.density * 100)}% ` +
            `for ${ticks}+ ticks - suggested compaction to agent`,
        );
      } else {
        // Rate-limit: at most one density whisper per 20 turns
        if (
          currentTurn - autoCompactState.lastDensityWhisperTurn >=
          HYGIENE_DENSITY_WHISPER_COOLDOWN_TURNS
        ) {
          autoCompactState.lastDensityWhisperTurn = currentTurn;
          context.whisper(
            "Low context density (" +
              Math.round(density.density * 100) +
              "% signal). " +
              "Noisy: " +
              density.noisyMessages +
              ", Signal: " +
              density.signalMessages +
              ". Pipeline: context_tag → context_checkout to branch.",
            {
              category: "cognitive",
              priority: density.density < DENSITY_VERY_LOW ? "high" : "medium",
            },
          );
        }
      }
    } else {
      autoCompactState.consecutiveLowDensity = 0;
    }

    // ── High-density large context whisper ────
    if (
      density.tokenRatio > TOKEN_RATIO_LARGE_CONTEXT &&
      currentTurn - autoCompactState.lastLargeContextWhisperTurn >=
        HYGIENE_LARGE_CONTEXT_COOLDOWN_TURNS
    ) {
      autoCompactState.lastLargeContextWhisperTurn = currentTurn;
      context.whisper(
        "High density (" +
          Math.round(density.density * 100) +
          "%) but large context (" +
          Math.round(density.tokenRatio * 100) +
          "% of limit). " +
          "context_tag then context_checkout to branch.",
        { category: "cognitive", priority: "low" },
      );
    }

    // ── Duplicate whisper (cooldown) ─────────────────────
    if (
      density.duplicates > 2 &&
      currentTurn - autoCompactState.lastDuplicateWhisperTurn >=
        HYGIENE_DENSITY_WHISPER_COOLDOWN_TURNS
    ) {
      autoCompactState.lastDuplicateWhisperTurn = currentTurn;
      context.whisper(
        density.duplicates +
          " near-duplicate messages in context. " +
          "Consider: context_prune() to remove redundant context.",
        { category: "cognitive", priority: "medium" },
      );
    }
  },
};
