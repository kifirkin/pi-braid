/**
 * Behavioral Drift Detection — flags when tool-use patterns shift significantly
 * from the session baseline.
 *
 * Why this matters: Agents that suddenly change their tool-use patterns (e.g.,
 * switching from code tools to browser tools, or stopping verification calls)
 * may be drifting from the task or responding to implicit nudges rather than
 * task requirements. Detecting this early allows course correction.
 *
 * Approach:
 *   1. Build a frequency distribution of tool categories during the first 10 turns
 *   2. Compare current window (last 5 turns) against that baseline
 *   3. Flag when Jensen-Shannon divergence exceeds threshold
 */

import type { CognitiveModule, ModuleContext } from "../types.js";
import { createLogger } from "../../../../lib/logger.js";

const log = createLogger("heartbeat:behavioral-drift");

// ── Tool categorization ──────────────────────────────────────────────────────

type ToolCategory = "code" | "search" | "memory" | "browser" | "context" | "cognitive" | "other";

const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  // Code tools
  read: "code",
  write: "code",
  edit: "code",
  bash: "code",
  repl: "code",
  diff: "code",
  // Search tools
  grep: "search",
  find: "search",
  ls: "search",
  "code-search": "search",
  // Memory tools
  memory_store: "memory",
  memory_recall: "memory",
  memory_list: "memory",
  memory_get: "memory",
  memory_episodes: "memory",
  // Browser tools
  browser_navigate: "browser",
  browser_snapshot: "browser",
  browser_eval: "browser",
  browser_screenshot: "browser",
  browser_content: "browser",
  web_fetch: "browser",
  // Context tools
  context_compact: "context",
  context_prune: "context",
  context_archive: "context",
  context_snapshot: "context",
  scratchpad: "context",
  // Cognitive tools
  think: "cognitive",
  verify: "cognitive",
  hypothesize: "cognitive",
  verify_claim: "cognitive",
};

function categorizeTool(toolName: string): ToolCategory {
  return TOOL_CATEGORIES[toolName] ?? "other";
}

// ── Distribution comparison (Jensen-Shannon divergence) ──────────────────────

function buildDistribution(calls: string[]): Record<ToolCategory, number> {
  const dist: Record<ToolCategory, number> = {
    code: 0,
    search: 0,
    memory: 0,
    browser: 0,
    context: 0,
    cognitive: 0,
    other: 0,
  };
  if (calls.length === 0) return dist;

  for (const call of calls) {
    dist[categorizeTool(call)]++;
  }

  // Normalize
  const total = calls.length;
  for (const key of Object.keys(dist) as ToolCategory[]) {
    dist[key] /= total;
  }
  return dist;
}

function klDivergence(p: number, q: number): number {
  if (p === 0) return 0;
  if (q === 0) return 0;
  return p * Math.log2(p / q);
}

function jensenShannon(
  p: Record<ToolCategory, number>,
  q: Record<ToolCategory, number>,
): number {
  const m: Record<ToolCategory, number> = {} as Record<ToolCategory, number>;
  const keys = Object.keys(p) as ToolCategory[];
  for (const k of keys) {
    m[k] = (p[k] + q[k]) / 2;
  }
  let d = 0;
  for (const k of keys) {
    d += klDivergence(p[k], m[k]) + klDivergence(q[k], m[k]);
  }
  return d / 2;
}

function dominantCategory(dist: Record<ToolCategory, number>): ToolCategory {
  let best: ToolCategory = "other";
  let bestVal = 0;
  for (const [k, v] of Object.entries(dist) as [ToolCategory, number][]) {
    if (v > bestVal) {
      bestVal = v;
      best = k;
    }
  }
  return best;
}

// ── Drift state ──────────────────────────────────────────────────────────────

interface DriftState {
  /** Tool calls collected during the baseline window (first ~10 turns). */
  baselineCalls: string[];
  /** Baseline distribution (computed once baseline is established). */
  baselineDist: Record<ToolCategory, number> | null;
  /** Recent tool calls (rolling window). */
  recentCalls: string[];
  /** Whether baseline has been established. */
  baselineEstablished: boolean;
  /** Number of drift warnings emitted this session. */
  warningCount: number;
}

const BASELINE_WINDOW = 10; // turns to build baseline
const RECENT_WINDOW = 20; // recent calls to compare
const DRIFT_THRESHOLD = 0.25; // JS divergence threshold (0-1 scale; 0.25 = significant shift)
const MAX_WARNINGS = 3; // cap warnings per session

export const behavioralDriftModule: CognitiveModule = {
  name: "behavioral-drift",
  description: "Detects shifts in tool-use patterns from session baseline",
  priority: 0.3,

  shouldActivate(context): boolean {
    // Only activate after baseline window and every 5 turns
    return context.turnCount > BASELINE_WINDOW && context.turnCount % 5 === 0;
  },

  async activate(context): Promise<void> {
    const ctx = context.ctx;
    const state = (
      ctx as unknown as {
        getExtensionState?: (
          key: string,
          factory: () => DriftState,
        ) => DriftState;
      }
    ).getExtensionState?.("behavioral-drift", () => ({
      baselineCalls: [],
      baselineDist: null,
      recentCalls: [],
      baselineEstablished: false,
      warningCount: 0,
    }));

    if (!state) {
      // No state API available, skip drift detection
      return;
    }

    // Collect tool calls
    const recentTools = context.toolCallsSinceLastTick ?? [];
    state.recentCalls.push(...recentTools);

    // Build baseline during first window
    if (!state.baselineEstablished) {
      state.baselineCalls.push(...recentTools);

      if (context.turnCount >= BASELINE_WINDOW && state.baselineCalls.length >= 5) {
        state.baselineDist = buildDistribution(state.baselineCalls);
        state.baselineEstablished = true;
        log.info(
          `Baseline established: ${state.baselineCalls.length} calls, ` +
            `dominant: ${dominantCategory(state.baselineDist)}`,
        );
      }
      return;
    }

    // Compare recent window against baseline
    if (state.recentCalls.length < 5) return;

    const recentDist = buildDistribution(
      state.recentCalls.slice(-RECENT_WINDOW),
    );
    const divergence = jensenShannon(state.baselineDist!, recentDist);

    // Trim recent calls to prevent unbounded growth
    if (state.recentCalls.length > RECENT_WINDOW * 2) {
      state.recentCalls = state.recentCalls.slice(-RECENT_WINDOW);
    }

    if (divergence > DRIFT_THRESHOLD && state.warningCount < MAX_WARNINGS) {
      state.warningCount++;

      const fromDom = dominantCategory(state.baselineDist!);
      const toDom = dominantCategory(recentDist);

      const msg =
        `Tool pattern shifted from ${fromDom}-dominant to ${toDom}-dominant ` +
        `(divergence: ${divergence.toFixed(2)}). ` +
        `If this shift isn't from task requirements, consider whether implicit ` +
        `signals are redirecting behavior.`;

      ctx.whisper?.(msg, { category: "cognitive", priority: "low" });
      log.info(msg);
    }
  },
};
