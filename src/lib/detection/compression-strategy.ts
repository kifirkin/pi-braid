/**
 * Adaptive Compression Strategy (2604.15877) - Experience Compression Spectrum
 * Different temporal scales require different compression strategies.
 *
 * Levels:
 *   short-term  - pruning: remove noise, collapse repetitions (BCR)
 *   medium-term - reasoning summarization: chains → conclusions
 *   long-term   - episodic: extract patterns to memory
 *
 * Compression level determination uses an LLM judge via classify() with
 * the compressionUrgency critic. Falls back to static thresholds when
 * LLM is unavailable (compressionUrgencyFallback in critic-registry.ts).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify } from "../ai/text-classifier.js";
import { CRITICS } from "../ai/critic-registry.js";
import { evaluateContextDensity } from "../detection/context-density.js";
import { compressionUrgencyFallback } from "../ai/critic-fallbacks.js";

export type CompressionLevel = "short-term" | "medium-term" | "long-term";
export type CompressionTrigger = "bcr" | "reasoning" | "episodic" | "density";

export interface CompressionDecision {
  level: CompressionLevel;
  trigger: CompressionTrigger;
  turnsSinceCompression: number;
  reason: string;
  estimatedSavings: number;
}

/**
 * Determine the appropriate compression level using an LLM judge.
 *
 * Uses classify() with the compressionUrgency critic to get a semantic
 * assessment of compression need. Falls back to the legacy static
 * threshold logic when LLM is unavailable.
 */
export async function determineCompressionLevel(
  ctx: ExtensionContext,
  opts: {
    turnCount: number;
    turnsSinceCompression: number;
    consecutiveFailures: number;
    reasoningChainDepth: number;
    messageCount: number;
  } = {
    turnCount: 0,
    turnsSinceCompression: Infinity,
    consecutiveFailures: 0,
    reasoningChainDepth: 0,
    messageCount: 0,
  },
): Promise<CompressionDecision> {
  const density = evaluateContextDensity(ctx);

  // Try LLM judge first
  try {
    const result = await classify(
      ctx,
      CRITICS.compressionUrgency.criteria,
      {
        turnsSinceCompression: String(opts.turnsSinceCompression),
        totalTurns: String(opts.turnCount),
        consecutiveFailures: String(opts.consecutiveFailures),
        reasoningDepth: String(opts.reasoningChainDepth),
        messageCount: String(opts.messageCount),
      },
      {
        timeoutMs: 5000,
        label: CRITICS.compressionUrgency.label,
        // Q9 B-class: compressionUrgencyFallback has 4-way classification
        // (AGGRESSIVE/SEMANTIC/CONSERVATIVE/NONE) from threshold-based
        // heuristic. tierPolicy: fallback-only downweights to 0.5.
        fallback: () =>
          compressionUrgencyFallback({
            turnsSinceCompression: opts.turnsSinceCompression,
            totalTurns: opts.turnCount,
            consecutiveFailures: opts.consecutiveFailures,
            reasoningDepth: opts.reasoningChainDepth,
            messageCount: opts.messageCount,
          }),
        tierPolicy: "fallback-only",
      },
    );

    const label = result.label.toUpperCase();
    if (label === "AGGRESSIVE") {
      return {
        level: "long-term",
        trigger: opts.consecutiveFailures >= 3 ? "bcr" : density.density >= 0.7 ? "density" : "episodic",
        turnsSinceCompression: opts.turnsSinceCompression,
        reason: `LLM judge: aggressive compression needed (${result.tier})`,
        estimatedSavings: 0.65,
      };
    }
    if (label === "SEMANTIC") {
      return {
        level: "medium-term",
        trigger: "reasoning",
        turnsSinceCompression: opts.turnsSinceCompression,
        reason: `LLM judge: semantic compression suitable (${result.tier})`,
        estimatedSavings: 0.55,
      };
    }
    if (label === "CONSERVATIVE") {
      return {
        level: "short-term",
        trigger: "density",
        turnsSinceCompression: opts.turnsSinceCompression,
        reason: `LLM judge: conservative prune only (${result.tier})`,
        estimatedSavings: 0.35,
      };
    }
    // NONE
    return {
      level: "short-term",
      trigger: "bcr",
      turnsSinceCompression: opts.turnsSinceCompression,
      reason: "LLM judge: no compression needed",
      estimatedSavings: 0,
    };
  } catch {
    // LLM unavailable - fall through to heuristic below
  }

  // Fallback: detect consecutive failures (always compress)
  if (opts.consecutiveFailures >= 3) {
    return {
      level: "short-term",
      trigger: "bcr",
      turnsSinceCompression: opts.turnsSinceCompression,
      reason: `${opts.consecutiveFailures}x consecutive failures - collapse error pattern.`,
      estimatedSavings: 0.4,
    };
  }

  // Fallback: late session / high density → compress
  if (opts.turnCount >= 80 || density.density >= 0.7) {
    return {
      level: "long-term",
      trigger: "episodic",
      turnsSinceCompression: opts.turnsSinceCompression,
      reason:
        opts.turnCount >= 80
          ? "Late session (≥80 turns) - extract to episodic memory."
          : `High density (${Math.round(density.density * 100)}%) - aggressive compression.`,
      estimatedSavings: 0.65,
    };
  }

  // Fallback: mid-session with deep reasoning
  if (opts.turnCount >= 30 && opts.reasoningChainDepth > 3) {
    return {
      level: "medium-term",
      trigger: "reasoning",
      turnsSinceCompression: opts.turnsSinceCompression,
      reason: `Deep reasoning chain (${opts.reasoningChainDepth} steps) - medium-term compression opportunity.`,
      estimatedSavings: 0.55,
    };
  }

  // Fallback: long since last compression
  if (opts.turnCount >= 30 && opts.turnsSinceCompression > 40) {
    return {
      level: "medium-term",
      trigger: "density",
      turnsSinceCompression: opts.turnsSinceCompression,
      reason: "40+ turns since compression - prevent bloat.",
      estimatedSavings: 0.35,
    };
  }

  // Default: no compression needed
  return {
    level: "short-term",
    trigger: "bcr",
    turnsSinceCompression: opts.turnsSinceCompression,
    reason: "Session healthy.",
    estimatedSavings: 0,
  };
}