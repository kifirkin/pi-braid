/**
 * Topic Drift Detector
 *
 * Detects when the conversation has drifted from its original task context.
 * Uses the triple-critic LLM classification system (lib/critic-registry.ts)
 * with three-tier fallback: heuristic → utility model → session model.
 *
 * The class API (setTaskContext, addTurn, check, generateWhisper, reset)
 * is preserved for backward compatibility. Only the internal detection
 * algorithm changes — from Jaccard token overlap to LLM-based critics.
 *
 * Drift detection flow:
 *   1. Three parallel classify() calls (topicCoverage, topicDivergence, topicCompleteness)
 *   2. Consensus: 2/3 critics agree → drift confirmed
 *   3. Heuristic fallback (conservative: assume no drift) when LLM is unavailable
 *
 * Whisper message format:
 *   [SUBTLE] Topic drift detected. Task: {task}. Reason: {reason}.
 *   Consider refocusing or updating task context.
 */

import { createLogger } from "../core/logger.js";
import { classify } from "../ai/text-classifier.js";
import { CRITICS } from "../ai/critic-registry.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

const _log = createLogger("topic-drift");

export interface DriftCheck {
  drifted: boolean;
  task: string;
  current: string;
  severity: "subtle" | "moderate" | "strong";
  reason: string;
}

export interface DriftDetectorOptions {
  /** Minimum conversation turns before checking */
  minTurns?: number;
}

const DEFAULT_OPTIONS: Required<DriftDetectorOptions> = {
  minTurns: 3,
};

/**
 * Lazy-loaded extension context for classify() calls.
 * Since TopicDriftDetector is created in session-state.ts where ctx
 * isn't available, callers must setCtx() before calling check().
 */
let _ctx: ExtensionContext | undefined;

export function setCriticCtx(ctx: ExtensionContext | undefined): void {
  _ctx = ctx;
}

export class TopicDriftDetector {
  private taskContext: string = "";
  private options: Required<DriftDetectorOptions>;
  private conversationHistory: string[] = [];
  private lastDriftWarning: number = 0;
  private driftCooldownMs: number = 30 * 1000; // Don't warn more than once per 30s

  constructor(options: DriftDetectorOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Set the original task context to compare against.
   */
  setTaskContext(task: string): void {
    this.taskContext = task.trim();
    this.conversationHistory = [];
    _log.debug(`Task context set: ${this.taskContext.slice(0, 80)}...`);
  }

  /**
   * Add a conversation turn (user message) to history.
   */
  addTurn(userMessage: string): void {
    const cleaned = userMessage.trim();
    if (!cleaned || cleaned.startsWith("/")) return;
    this.conversationHistory.push(cleaned);
    // Keep last 20 turns
    if (this.conversationHistory.length > 20) {
      this.conversationHistory.shift();
    }
  }

  /**
   * Check if conversation has drifted from task context.
   *
   * Uses triple-critic LLM classification:
   *   1. Three parallel classify() calls (coverage, divergence, completeness)
   *   2. Consensus: 2/3 critics agree → drift confirmed
   *   3. Falls back to conservative heuristic when LLM unavailable
   *
   * Now returns a Promise to support async classify() calls.
   */
  async check(): Promise<DriftCheck> {
    if (this.conversationHistory.length < this.options.minTurns) {
      return {
        drifted: false,
        task: this.taskContext,
        current: "",
        severity: "subtle",
        reason: "too_few_turns",
      };
    }

    if (!this.taskContext) {
      return {
        drifted: false,
        task: "",
        current: "",
        severity: "subtle",
        reason: "no_task_context",
      };
    }

    // Check cooldown
    if (Date.now() - this.lastDriftWarning < this.driftCooldownMs) {
      return {
        drifted: false,
        task: this.taskContext,
        current: "",
        severity: "subtle",
        reason: "cooldown",
      };
    }

    // Get recent conversation focus
    const recentTurns = this.conversationHistory.slice(-5);
    const currentText = recentTurns.join(" ").slice(0, 1000);

    // ── Triple-critic LLM classification ──────────────────────────────
    let drifted = false;
    let reason = "semantic_drift";
    let severity: "subtle" | "moderate" | "strong" = "subtle";

    if (_ctx) {
      try {
        const [coverageResult, divergenceResult, completenessResult] = await Promise.all([
          classify(
            _ctx,
            CRITICS.topicCoverage.criteria,
            { original: this.taskContext, response: currentText },
            { maxTokens: 5, timeoutMs: 5000, fallback: CRITICS.topicDriftFallback },
          ),
          classify(
            _ctx,
            CRITICS.topicDivergence.criteria,
            { original: this.taskContext, response: currentText },
            { maxTokens: 5, timeoutMs: 5000, fallback: CRITICS.topicDriftFallback },
          ),
          classify(
            _ctx,
            CRITICS.topicCompleteness.criteria,
            { original: this.taskContext, response: currentText },
            { maxTokens: 5, timeoutMs: 5000, fallback: CRITICS.topicDriftFallback },
          ),
        ]);

        // Consensus: 2/3 critics agree → drift confirmed
        const driftedVotes = [coverageResult, divergenceResult, completenessResult].filter(
          (r) => r.label === "yes",
        ).length;

        // coverage="yes" means coverage is BAD (does NOT address request)
        // divergence="yes" means divergence (has shifted)
        // completeness="no" means incomplete
        const coverageBad = coverageResult.label === "no";
        const diverged = divergenceResult.label === "yes";
        const incomplete = completenessResult.label === "no";
        const negativeVotes = [coverageBad, diverged, incomplete].filter(Boolean).length;

        drifted = negativeVotes >= 2;

        if (drifted) {
          // Confidence-weighted severity
          const allTiers = [coverageResult, divergenceResult, completenessResult];
          const hasHeuristic = allTiers.some((r) => r.tier === "heuristic");
          severity = hasHeuristic ? "subtle" : driftedVotes >= 3 ? "strong" : "moderate";
        }

        _log.debug(
          `[topic-drift] Critics: coverage=${coverageResult.label}/${coverageResult.tier}, ` +
            `divergence=${divergenceResult.label}/${divergenceResult.tier}, ` +
            `completeness=${completenessResult.label}/${completenessResult.tier} ` +
            `→ drifted=${drifted}`,
        );
      } catch {
        // LLM call failed — conservative fallback (no drift)
        drifted = false;
        severity = "subtle";
        reason = "too_short";
      }
    } else {
      // No ctx available — conservative fallback (no drift)
      severity = "subtle";
      reason = "no_task_context";
    }

    if (drifted) {
      this.lastDriftWarning = Date.now();
    }

    return {
      drifted,
      task: this.taskContext.slice(0, 100),
      current: currentText.slice(0, 100),
      severity,
      reason,
    };
  }

  /**
   * Generate whisper message for drift detection.
   */
  generateWhisper(check: DriftCheck): string | null {
    if (!check.drifted) return null;

    const severityTag = check.severity === "strong" ? "[WARN]" : "[SUBTLE]";
    const taskPreview = check.task.length > 50 ? check.task.slice(0, 50) + "..." : check.task;

    return `${severityTag} Topic drift detected. Task: "${taskPreview}". Reason: ${check.reason}. Consider refocusing or updating context.`;
  }

  /** Reset conversation history */
  reset(): void {
    this.conversationHistory = [];
    this.lastDriftWarning = 0;
  }
}