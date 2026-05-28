/**
 * Advice Tracker — records advice predictions and evaluates accuracy.
 *
 * Dreamer predicts "stuck" or "failure" outcomes. MARS flags tool overuse.
 * This module tracks those predictions, evaluates them after N turns,
 * and adjusts thresholds to reduce noise over time.
 *
 * Feedback loop:
 *   1. Advice emitted → recorded with prediction + turn
 *   2. N turns later → check if prediction was correct
 *   3. Update accuracy metrics
 *   4. Adjust source thresholds if accuracy drops below 0.5
 */

import { createLogger } from "./logger.js";

const log = createLogger("advice-tracker");

// ── Types ──────────────────────────────────────────────────────────────────

export interface AdviceRecord {
  id: string;
  source: "dreamer" | "mars" | "compaction";
  prediction: string;
  tool?: string;
  turn: number;
  timestamp: number;
  evaluated: boolean;
  correct?: boolean;
  evaluatedAt?: number;
}

interface AdviceTrackerState {
  records: AdviceRecord[];
  accuracy: Map<string, { correct: number; total: number }>;
}

// Module-level state (process-wide — advice tracking doesn't need session scoping)
const _state: AdviceTrackerState = {
  records: [],
  accuracy: new Map(),
};

// ── Threshold configs (mutable — adjusted by feedback loop) ────────────────

/** Dreamer cooldown in ms. Starts at 60s, adjusted by accuracy. */
export let dreamerCooldownMs = 60_000;

/** MARS overuse multiplier. Starts at 3, adjusted by accuracy. */
export let marsOveruseMultiplier = 3;

/** Turns to wait before evaluating a prediction. */
export const EVALUATION_DELAY_TURNS = 10;

/** Minimum predictions before threshold adjustment kicks in. */
export const MIN_PREDICTIONS_FOR_ADJUSTMENT = 5;

// ── Recording ──────────────────────────────────────────────────────────────

let _idCounter = 0;

export function recordAdvice(
  source: "dreamer" | "mars" | "compaction",
  prediction: string,
  turn: number,
  tool?: string,
): string {
  const id = `adv-${source}-${++_idCounter}-${Date.now()}`;
  _state.records.push({
    id,
    source,
    prediction,
    tool,
    turn,
    timestamp: Date.now(),
    evaluated: false,
  });

  // Keep only last 100 records
  if (_state.records.length > 100) {
    _state.records = _state.records.slice(-100);
  }

  return id;
}

// ── Evaluation ─────────────────────────────────────────────────────────────

export interface EvaluationContext {
  currentTurn: number;
  consecutiveErrorTurns: number;
  toolLog: string[];
  uniqueToolsCount: number;
}

/**
 * Evaluate all pending advice records that are due for evaluation.
 * Returns the number of records evaluated.
 */
export function evaluatePendingAdvice(ctx: EvaluationContext): number {
  let evaluated = 0;

  for (const record of _state.records) {
    if (record.evaluated) continue;
    if (ctx.currentTurn - record.turn < EVALUATION_DELAY_TURNS) continue;

    record.evaluated = true;
    record.evaluatedAt = Date.now();
    evaluated++;

    // Evaluate based on source
    if (record.source === "dreamer") {
      record.correct = evaluateDreamerPrediction(record, ctx);
    } else if (record.source === "mars") {
      record.correct = evaluateMarsPrediction(record, ctx);
    } else if (record.source === "compaction") {
      // Compaction outcomes are evaluated immediately (success/failure known at emit time)
      record.correct = record.prediction === "success";
      record.evaluated = true;
    }

    // Update accuracy metrics
    const key = `${record.source}:${record.prediction}`;
    if (!_state.accuracy.has(key)) {
      _state.accuracy.set(key, { correct: 0, total: 0 });
    }
    const metrics = _state.accuracy.get(key)!;
    metrics.total++;
    if (record.correct) metrics.correct++;
  }

  // Adjust thresholds after evaluation
  if (evaluated > 0) {
    adjustThresholds();
  }

  return evaluated;
}

function evaluateDreamerPrediction(record: AdviceRecord, ctx: EvaluationContext): boolean {
  // Dreamer predicts "stuck" (self-loop) or "failure" (error)
  // Correct if the predicted outcome DID happen

  if (record.prediction === "stuck") {
    // Stuck = same tool repeated in recent tool log, or very low unique tools
    const recentTools = ctx.toolLog.slice(-5);
    const uniqueRecent = new Set(recentTools).size;
    return (
      uniqueRecent <= 1 ||
      (recentTools.length > 0 && recentTools.every((t) => t === recentTools[0]))
    );
  }

  if (record.prediction === "failure") {
    // Failure = consecutive errors
    return ctx.consecutiveErrorTurns >= 2;
  }

  // Unknown prediction type — can't evaluate
  return false;
}

function evaluateMarsPrediction(record: AdviceRecord, ctx: EvaluationContext): boolean {
  // MARS predicts a tool is overused and should be reduced
  // Correct if the agent reduced usage of that tool after the nudge

  if (!record.tool) return false;

  // Get tool usage before and after the advice
  const allToolLog = ctx.toolLog;
  const beforeAdvice = allToolLog.slice(0, record.turn);
  const afterAdvice = allToolLog.slice(record.turn);

  const countBefore = beforeAdvice.filter((t) => t === record.tool).length;
  const countAfter = afterAdvice.filter((t) => t === record.tool).length;

  // Avoid division by zero
  if (countBefore === 0 && countAfter === 0) return true; // No usage either way
  if (countBefore === 0) return false; // Only used after advice

  // If usage rate decreased, the advice was correct
  const rateBefore = countBefore / beforeAdvice.length;
  const rateAfter = afterAdvice.length > 0 ? countAfter / afterAdvice.length : 0;

  return rateAfter < rateBefore;
}

// ── Threshold Adjustment ───────────────────────────────────────────────────

function adjustThresholds(): void {
  // Dreamer threshold
  const dreamerAccuracy = getSourceAccuracy("dreamer");
  if (dreamerAccuracy.total >= MIN_PREDICTIONS_FOR_ADJUSTMENT) {
    const rate = dreamerAccuracy.correct / dreamerAccuracy.total;
    if (rate < 0.3) {
      // Too many false positives — increase cooldown to reduce frequency
      dreamerCooldownMs = Math.min(300_000, dreamerCooldownMs * 1.5);
      log.info(
        `[advice-tracker] Dreamer accuracy ${(rate * 100).toFixed(0)}% — increased cooldown to ${(dreamerCooldownMs / 1000).toFixed(0)}s`,
      );
    } else if (rate > 0.7 && dreamerCooldownMs > 30_000) {
      // Good accuracy — allow more frequent advice
      dreamerCooldownMs = Math.max(30_000, dreamerCooldownMs * 0.8);
      log.info(
        `[advice-tracker] Dreamer accuracy ${(rate * 100).toFixed(0)}% — decreased cooldown to ${(dreamerCooldownMs / 1000).toFixed(0)}s`,
      );
    }
  }

  // MARS threshold
  const marsAccuracy = getSourceAccuracy("mars");
  if (marsAccuracy.total >= MIN_PREDICTIONS_FOR_ADJUSTMENT) {
    const rate = marsAccuracy.correct / marsAccuracy.total;
    if (rate < 0.3) {
      // Too many false positives — increase multiplier to reduce sensitivity
      marsOveruseMultiplier = Math.min(10, marsOveruseMultiplier + 1);
      log.info(
        `[advice-tracker] MARS accuracy ${(rate * 100).toFixed(0)}% — increased overuse multiplier to ${marsOveruseMultiplier}`,
      );
    } else if (rate > 0.7 && marsOveruseMultiplier > 2) {
      // Good accuracy — allow more sensitivity
      marsOveruseMultiplier = Math.max(2, marsOveruseMultiplier - 1);
      log.info(
        `[advice-tracker] MARS accuracy ${(rate * 100).toFixed(0)}% — decreased overuse multiplier to ${marsOveruseMultiplier}`,
      );
    }
  }
}

// ── Querying ───────────────────────────────────────────────────────────────

export function getSourceAccuracy(source: "dreamer" | "mars" | "compaction"): {
  correct: number;
  total: number;
} {
  let total = 0;
  let correct = 0;

  for (const [key, metrics] of _state.accuracy) {
    if (key.startsWith(`${source}:`)) {
      total += metrics.total;
      correct += metrics.correct;
    }
  }

  return { correct, total };
}

export function getPendingAdvice(): AdviceRecord[] {
  return _state.records.filter((r) => !r.evaluated);
}

export function resetAdviceTracker(): void {
  _state.records = [];
  _state.accuracy.clear();
  dreamerCooldownMs = 60_000;
  marsOveruseMultiplier = 3;
}
