/**
 * Tool Sequence Predictor - simple Markov transition model
 *
 * Simulates likely next tool from historical single-step transitions.
 * Uses a 1-deep Markov chain: given the last tool, what tool typically follows?
 * Outcome prediction is heuristic (self-loop rate thresholding).
 *
 * Not a cognitive simulation - a simple histogram-based predictor.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../state/extension-state.js";
import { dreamerCooldownMs as dynamicCooldown } from "../reasoning/advice-tracker.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SimulatedPath {
  sequence: string[];
  probability: number;
  outcome: "success" | "failure" | "stuck";
  estimatedTurns: number;
}

export interface DreamAdvice {
  message: string;
  priority: number; // 1-10
  action: string;
  confidence: number; // 0-1
  /** Prediction type for feedback loop: "stuck" | "failure" */
  prediction?: string;
}

interface DreamerState {
  pathHistory: SimulatedPath[];
  lastDreamAt: number;
}

function getState(ctx: ExtensionContext): DreamerState {
  return getExtensionState(ctx, "dreamer", () => ({
    pathHistory: [],
    lastDreamAt: 0,
  }));
}

// ── Path Simulation ─────────────────────────────────────────────────────────

/** Minimum number of transitions out of a tool before we trust any rate. */
const MIN_SAMPLE_FOR_PREDICTION = 5;

/** Minimum consecutive same-tool calls in the CURRENT sequence to flag as a loop. */
const MIN_CURRENT_LOOP_LENGTH = 4;

/**
 * Compute the longest run of consecutive identical tool names at the tail
 * of the current sequence. Returns the length and the tool name.
 *
 * Example: `["a", "b", "read", "read", "read"]` → `{ tool: "read", length: 3 }`
 * Example: `["a", "b", "c"]` → `{ tool: null, length: 0 }`
 */
function tailRun(seq: string[]): { tool: string | null; length: number } {
  if (seq.length === 0) return { tool: null, length: 0 };
  const last = seq[seq.length - 1];
  let length = 0;
  for (let i = seq.length - 1; i >= 0; i--) {
    if (seq[i] === last) length++;
    else break;
  }
  return { tool: last, length };
}

/**
 * Simulate likely future paths from current tool sequence.
 * Uses simple Markov-style transition probabilities from historical data.
 */
export function simulatePaths(
  currentSequence: string[],
  historicalSequences: string[][] = [],
): SimulatedPath[] {
  if (currentSequence.length === 0) return [];

  const lastTool = currentSequence[currentSequence.length - 1];

  // Build transition frequencies from history
  const transitions: Map<string, Map<string, number>> = new Map();
  for (const seq of historicalSequences) {
    for (let i = 0; i < seq.length - 1; i++) {
      const from = seq[i];
      const to = seq[i + 1];
      if (!transitions.has(from)) transitions.set(from, new Map());
      const counts = transitions.get(from)!;
      counts.set(to, (counts.get(to) ?? 0) + 1);
    }
  }

  // Generate possible next steps from last tool
  const nextCounts = transitions.get(lastTool);
  if (!nextCounts || nextCounts.size === 0) return [];

  const total = [...nextCounts.values()].reduce((a, b) => a + b, 0);

  // Refuse to predict with too few observations. With `total` of 1, every
  // observed transition is "100%" and the prediction is noise.
  if (total < MIN_SAMPLE_FOR_PREDICTION) return [];

  const paths: SimulatedPath[] = [];
  for (const [nextTool, count] of nextCounts) {
    const prob = count / total;

    // Simulate 3-step lookahead
    const extended = [...currentSequence, nextTool];
    const nextNext = transitions.get(nextTool);
    let outcome: SimulatedPath["outcome"] = "success";
    let estimatedTurns = 1;

    if (nextNext) {
      const nextTotal = [...nextNext.values()].reduce((a, b) => a + b, 0);
      // Only flag a self-loop pattern when we have enough data to trust it.
      // The next-tool's sample must also meet the minimum.
      if (nextTotal < MIN_SAMPLE_FOR_PREDICTION) {
        outcome = "success";
      } else {
        // If next step leads to high-frequency same-tool transitions → stuck
        const selfLoopRate = (nextNext.get(nextTool) ?? 0) / nextTotal;
        if (selfLoopRate > 0.5) {
          outcome = "stuck";
          estimatedTurns = 5;
        } else if (selfLoopRate > 0.3) {
          outcome = "failure";
          estimatedTurns = 3;
        }
      }
    }

    paths.push({
      sequence: extended,
      probability: prob,
      outcome,
      estimatedTurns,
    });
  }

  // Sort by probability descending
  return paths.sort((a, b) => b.probability - a.probability).slice(0, 5);
}

// ── Advice Generation ───────────────────────────────────────────────────────

/**
 * Generate proactive advice from simulated paths.
 * Only returns advice if a concerning path is detected with sufficient confidence.
 */
export function dream(
  ctx: ExtensionContext,
  currentSequence: string[],
  historicalSequences?: string[][],
): DreamAdvice | null {
  const state = getState(ctx);
  const now = Date.now();

  // Cooldown check - dynamic threshold adjusted by advice tracker feedback loop
  if (now - state.lastDreamAt < dynamicCooldown) return null;

  // Path 1: detect an actual loop in the current sequence.
  // This is reliable regardless of history size - if the agent has just
  // called the same tool 4+ times in a row, it's likely a loop.
  const run = tailRun(currentSequence);
  if (run.length >= MIN_CURRENT_LOOP_LENGTH) {
    state.lastDreamAt = now;
    return {
      message:
        `[dream] Detected ${run.length} consecutive ${run.tool} calls with no progress. ` +
        `This pattern suggests a stuck loop. Consider: verify approach, switch tool, or ask for clarification.`,
      priority: 7,
      action: "Call think(type='reflection') to verify approach.",
      confidence: 0.8,
      prediction: "stuck",
    };
  }

  // Path 2: Markov-based prediction. Returns [] when sample is too small.
  const paths = simulatePaths(currentSequence, historicalSequences);
  if (paths.length === 0) return null;

  // Find most concerning path. Probability floor is 0.6 - below that, the
  // prediction is too noisy to act on.
  const stuckPaths = paths.filter((p) => p.outcome === "stuck" && p.probability > 0.6);
  const failPaths = paths.filter((p) => p.outcome === "failure" && p.probability > 0.6);

  /**
   * Map a raw probability to a categorical confidence label.
   * Thresholds: 0.6 = "low" (the minimum firing probability), 0.8 = "medium",
   * 0.95 = "high". High confidence now requires genuinely strong evidence.
   */
  function confidenceLabel(p: number): "low" | "medium" | "high" {
    if (p >= 0.95) return "high";
    if (p >= 0.8) return "medium";
    return "low";
  }

  if (stuckPaths.length > 0) {
    const worst = stuckPaths[0];
    state.lastDreamAt = now;
    const pct = (worst.probability * 100).toFixed(0);
    const conf = confidenceLabel(worst.probability);
    return {
      message: `[dream] Likely to get stuck in ${worst.sequence.slice(-2).join("→")} loop (prob: ${pct}%, confidence: ${conf}). Consider: verify approach or ask for clarification.`,
      priority: 7,
      action: "Call think(type='reflection') to verify approach.",
      confidence: worst.probability,
      prediction: "stuck",
    };
  }

  if (failPaths.length > 0) {
    const worst = failPaths[0];
    state.lastDreamAt = now;
    const pct = (worst.probability * 100).toFixed(0);
    const conf = confidenceLabel(worst.probability);
    return {
      message: `[dream] Historical pattern suggests failure path: ${worst.sequence.slice(-2).join("→")} (prob: ${pct}%, confidence: ${conf}). Consider: run tests before more edits.`,
      priority: 6,
      action: "Run verification before proceeding.",
      confidence: worst.probability,
      prediction: "failure",
    };
  }

  return null;
}

/** Reset dreamer state (for testing or session reset) */
export function resetDreamer(ctx: ExtensionContext): void {
  const state = getState(ctx);
  state.pathHistory = [];
  state.lastDreamAt = 0;
}
