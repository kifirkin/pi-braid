/**
 * Topic Drift Detector
 *
 * Detects when the conversation has drifted from its original task context.
 * Uses the triple-critic LLM classification system (lib/critic-registry.ts)
 * with three-tier fallback: heuristic → utility model → session model.
 *
 * The class API (setTaskContext, addTurn, check, generateWhisper, reset)
 * is preserved for backward compatibility. Only the internal detection
 * algorithm changes - from Jaccard token overlap to LLM-based critics.
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
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { topicDriftFallback } from "../ai/critic-fallbacks.js";

const _log = createLogger("topic-drift");

export interface DriftCheck {
  drifted: boolean;
  task: string;
  current: string;
  severity: "subtle" | "moderate" | "strong";
  reason: string;
  /**
   * True when all three LLM classification calls failed (tier === "failed"
   * on every result). The detector could not determine drift with high
   * confidence; the drifted flag is the conservative "no drift" default
   * to avoid false positives. Consumers can check this to emit a "drift
   * detector offline" whisper instead of the usual drift whisper.
   *
   * Pattern matches input-polisher 9966c8ad: don't silently default to
   * "no problem" when the classifier is down. Let the operator know.
   */
  classifierDown?: boolean;
}

export interface DriftDetectorOptions {
  /** Minimum conversation turns before checking */
  minTurns?: number;
  /** Jaccard similarity threshold for heuristic fallback (0-1). Lower = stricter. */
  topicThreshold?: number;
}

const DEFAULT_OPTIONS: Required<DriftDetectorOptions> = {
  minTurns: 3,
  topicThreshold: 0.15,
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
    let classifierDown = false;

    if (_ctx) {
      try {
        const [coverageSettled, divergenceSettled, completenessSettled] = await Promise.allSettled([
          classify(
            _ctx,
            CRITICS.topicCoverage.criteria,
            { original: this.taskContext, response: currentText },
            { timeoutMs: 5000, label: CRITICS.topicCoverage.label, fallback: topicDriftFallback },
          ),
          classify(
            _ctx,
            CRITICS.topicDivergence.criteria,
            { original: this.taskContext, response: currentText },
            { timeoutMs: 5000, label: CRITICS.topicDivergence.label, fallback: topicDriftFallback },
          ),
          classify(
            _ctx,
            CRITICS.topicCompleteness.criteria,
            { original: this.taskContext, response: currentText },
            { timeoutMs: 5000, label: CRITICS.topicCompleteness.label, fallback: topicDriftFallback },
          ),
        ]);

        // Unwrap allSettled: a failed call becomes null (treated as 'no vote').
        const unwrap = (r: PromiseSettledResult<Awaited<ReturnType<typeof classify>>>) =>
          r.status === "fulfilled" ? r.value : null;
        const coverageResult = unwrap(coverageSettled);
        const divergenceResult = unwrap(divergenceSettled);
        const completenessResult = unwrap(completenessSettled);

        // Detect the "all classifiers failed" case. If every result is
        // tier === "failed", the LLM signal is unreliable; we cannot
        // trust the "no drift" default. Surface this so consumers can
        // emit a "detector offline" whisper instead of the usual one.
        // (Same anti-pattern as input-polisher 9966c8ad: never silently
        // default to "no problem" when the classifier is down.)
        const allTiers = [coverageResult, divergenceResult, completenessResult];
        classifierDown = allTiers.every(
          (r) => r === null || r.tier === "failed",
        );

        // Consensus: 2/3 critics agree → drift confirmed
        const driftedVotes = allTiers.filter((r) => r?.label === "yes").length;

        // coverage="yes" means coverage is BAD (does NOT address request)
        // divergence="yes" means divergence (has shifted)
        // completeness="no" means incomplete
        const coverageBad = coverageResult?.label === "no";
        const diverged = divergenceResult?.label === "yes";
        const incomplete = completenessResult?.label === "no";
        const negativeVotes = [coverageBad, diverged, incomplete].filter(Boolean).length;

        drifted = negativeVotes >= 2;

        if (drifted) {
          // Confidence-weighted severity
          const hasHeuristic = allTiers.some((r) => r?.tier === "heuristic");
          severity = hasHeuristic ? "subtle" : driftedVotes >= 3 ? "strong" : "moderate";
        }

        if (classifierDown) {
          reason = "classifier_unavailable";
        }

        _log.debug(
          `[topic-drift] Critics: coverage=${coverageResult?.label}/${coverageResult?.tier}, ` +
            `divergence=${divergenceResult?.label}/${divergenceResult?.tier}, ` +
            `completeness=${completenessResult?.label}/${completenessResult?.tier} ` +
            `→ drifted=${drifted} classifierDown=${classifierDown}`,
        );
      } catch {
        // LLM call failed - conservative fallback (no drift)
        drifted = false;
        severity = "subtle";
        reason = "too_short";
        classifierDown = true;
      }
    } else {
      // No ctx available - use Jaccard similarity heuristic
      const taskWords = new Set(
        this.taskContext.toLowerCase().split(/[^\w]+/).filter(Boolean),
      );
      const currentWords = currentText.toLowerCase().split(/[^\w]+/).filter(Boolean);
      if (taskWords.size > 0 && currentWords.length > 0) {
        const intersection = currentWords.filter((w) => taskWords.has(w)).length;
        const union = new Set([...taskWords, ...currentWords]).size;
        const jaccard = intersection / union;
        drifted = jaccard < this.options.topicThreshold;
        reason = drifted ? `semantic_drift (jaccard=${jaccard.toFixed(2)})` : "on_topic";
        severity = drifted ? (jaccard < this.options.topicThreshold * 0.5 ? "strong" : "moderate") : "subtle";
      } else {
        severity = "subtle";
        reason = "no_task_context";
      }
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
      classifierDown,
    };
  }

  /**
   * Generate whisper message for drift detection.
   */
  generateWhisper(check: DriftCheck): string | null {
    if (check.classifierDown) {
      // Same pattern as input-polisher 9966c8ad: when the classifier is
      // offline, surface that fact to the operator instead of pretending
      // everything is fine. The detector could not determine drift, so
      // we say so explicitly.
      return `[drift-detector] Classifier unavailable - could not check topic drift this turn. Topic monitoring is offline until the utility model recovers. Run /logs level info for the underlying error.`;
    }
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
