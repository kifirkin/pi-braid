/**
 * Belief policy rules.
 *
 * Extracted from belief-policy-engine.ts (was 177 lines inline). Each
 * rule inspects the current signals and beliefs, returning zero or
 * more PolicyRecommendations. The engine iterates through these
 * rules on each evaluation cycle.
 *
 * Rules are pure functions of the input state - no side effects,
 * no I/O. The engine handles persistence, dedup, and emission.
 */

import type { SystemSignal, Belief, PolicyRecommendation } from "./belief-types.js";

export interface PolicyRule {
  name: string;
  evaluate(signals: SystemSignal[], beliefs: Map<string, Belief>): PolicyRecommendation[];
}

export const POLICY_RULES: PolicyRule[] = [
  // Rule 1: Consecutive stability decline → reasoning collapse warning
  {
    name: "stability_decline",
    evaluate(signals, _beliefs): PolicyRecommendation[] {
      const stabilitySignals = signals.filter(
        (s) => s.source === "stability" && s.type === "decline",
      );
      if (stabilitySignals.length >= 3) {
        const trend = stabilitySignals.slice(-3).map((s) => (s.data.overlap as number) ?? 0);
        return [
          {
            id: `pr-${Date.now()}-sd`,
            type: "stability_decline",
            priority: Math.min(9, 5 + stabilitySignals.length),
            message: `[stability] Reasoning coherence declining (overlap: ${trend[0]?.toFixed(1)} → ${trend[2]?.toFixed(1)}). Consider: step back and verify assumptions.`,
            beliefs: ["stability:declining", "reasoning:possible-collapse"],
            timestamp: Date.now(),
          },
        ];
      }
      return [];
    },
  },

  // Rule 2: Unresolved conflicts accumulate → epistemic debt warning
  {
    name: "conflict_accumulation",
    evaluate(signals, _beliefs): PolicyRecommendation[] {
      const conflictSignals = signals.filter((s) => s.source === "conflict");
      const unresolved = conflictSignals.filter((s) => s.type === "unresolved");
      if (unresolved.length >= 5) {
        return [
          {
            id: `pr-${Date.now()}-ca`,
            type: "conflict_accumulation",
            priority: Math.min(9, 4 + Math.floor(unresolved.length / 3)),
            message: `[epistemic] ${unresolved.length} unresolved source conflicts. Epistemic debt accumulating. Consider: resolve one conflict explicitly.`,
            beliefs: ["conflicts:unresolved-multiple", "epistemic:debt"],
            timestamp: Date.now(),
          },
        ];
      }
      return [];
    },
  },

  // Rule 3: Topic drift + tool overuse → scatter warning
  {
    name: "drift_plus_scatter",
    evaluate(signals, _beliefs): PolicyRecommendation[] {
      const recent = signals.slice(-10);
      const hasDrift = recent.some((s) => s.source === "topic-drift" && s.severity !== "info");
      const toolSignals = recent.filter((s) => s.source === "tool-use" && s.type === "overuse");
      if (hasDrift && toolSignals.length >= 2) {
        return [
          {
            id: `pr-${Date.now()}-ds`,
            type: "drift_plus_scatter",
            priority: 7,
            message: `[focus] Topic drift + tool scatter detected. Consider: explicitly reaffirm the current task goal before continuing.`,
            beliefs: ["topic:drifted", "tool:scattered"],
            timestamp: Date.now(),
          },
        ];
      }
      return [];
    },
  },

  // Rule 4: Calibration error high → confidence miscalibration
  {
    name: "calibration_error",
    evaluate(signals, _beliefs): PolicyRecommendation[] {
      const calSignals = signals.filter(
        (s) => s.source === "calibration" && s.type === "high-error",
      );
      if (calSignals.length >= 2) {
        const recent = calSignals.slice(-2);
        const avgError =
          recent.reduce((s, sig) => s + ((sig.data.error as number) ?? 0), 0) / recent.length;
        return [
          {
            id: `pr-${Date.now()}-ce`,
            type: "calibration_error",
            priority: 6,
            message: `[calibration] Prediction error consistently high (avg: ${(avgError * 100).toFixed(0)}%). Consider being less confident in plans before executing.`,
            beliefs: ["calibration:miscalibrated", "confidence:inflated"],
            timestamp: Date.now(),
          },
        ];
      }
      return [];
    },
  },

  // Rule 5: REMOVED (2026-06-22) - "reflection_gap"
  // This rule fired on 8+ tool calls without a think(type="reflection")
  // interspersed. It is now subsumed by lib/detection/tool-loop-detector,
  // which catches the same condition (8+ consecutive same-tool calls) with
  // a unified whisper message. Keeping this rule produced a contradictory
  // `[reflection] 8+ consecutive tool calls without reflection ...`
  // whisper alongside the detector's `## Tool Loop Detected ...` for the
  // same condition. See ROADMAP DR-NEW (tool-loop-detector consolidation).

  // Rule 6: Reasoning decline + conflict → believe carefully
  {
    name: "reasoning_plus_conflict",
    evaluate(signals, _beliefs): PolicyRecommendation[] {
      const recent = signals.slice(-15);
      const hasDecline = recent.some((s) => s.source === "reasoning" && s.type === "decline");
      const hasConflict = recent.some((s) => s.source === "conflict");
      if (hasDecline && hasConflict) {
        return [
          {
            id: `pr-${Date.now()}-rc`,
            type: "reasoning_plus_conflict",
            priority: 8,
            message: `[careful] Reasoning coherence declining AND source conflicts present. Recommend: slow down, verify facts, acknowledge uncertainty explicitly.`,
            beliefs: ["reasoning:declining", "conflicts:present", "epistemic:uncertain"],
            timestamp: Date.now(),
          },
        ];
      }
      return [];
    },
  },
  // Rule 7: Memory contamination - only warn on repeated cross-session recall (3+ signals)
  {
    name: "memory_contamination",
    evaluate(signals, _beliefs): PolicyRecommendation[] {
      const recent = signals.slice(-20);
      const contamination = recent.filter(
        (s) => s.source === "memory" && s.type === "contamination",
      );
      // Only surface if 3+ contamination signals in recent window
      if (contamination.length >= 3) {
        const count = contamination.length;
        return [
          {
            id: `pr-${Date.now()}-mc`,
            type: "memory_contamination",
            priority: 5,
            message: `[memory] ${count} cross-session memory recall(s) - verify relevant to current project before acting.`,
            beliefs: ["memory:contamination", "memory:verify-before-act"],
            timestamp: Date.now(),
          },
        ];
      }
      return [];
    },
  },
];
