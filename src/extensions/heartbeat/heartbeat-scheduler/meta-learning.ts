/**
 * Meta-Learning: Tick interval adjustment for heartbeat scheduler.
 *
 * Adjusts tick interval based on rolling effectiveness of activated modules.
 * Speeds up when effective, slows down when not.
 */

import type { HeartbeatState } from "./types.js";
import { META_LEARNING } from "./state.js";
import { createLogger } from "../../../lib/core/logger.js";

const log = createLogger("heartbeat:meta-learning");

export function updateMetaLearning(state: HeartbeatState): void {
  const ml = state.metaLearning;

  if (ml.pendingSignals.size === 0) {
    ml.postActivationToolCount = 0;
  }

  if (ml.pendingSignals.size > 0) {
    const resolved: Array<{ module: string; effective: boolean }> = [];

    for (const [moduleName, activationTurn] of ml.pendingSignals) {
      const turnsSinceActivation = state.turnCount - activationTurn;

      if (turnsSinceActivation >= META_LEARNING.signalWindow) {
        const effective = ml.postActivationToolCount > 0;
        resolved.push({ module: moduleName, effective });
        ml.pendingSignals.delete(moduleName);
      }
    }

    if (resolved.length > 0) {
      const batchEffectiveness = resolved.filter((r) => r.effective).length / resolved.length;
      ml.effectivenessHistory.push(batchEffectiveness);
      if (ml.effectivenessHistory.length > META_LEARNING.effectivenessWindowSize) {
        ml.effectivenessHistory.shift();
      }

      const avgEffectiveness =
        ml.effectivenessHistory.reduce((a, b) => a + b, 0) / ml.effectivenessHistory.length;

      if (
        avgEffectiveness >= META_LEARNING.speedUpThreshold &&
        ml.tickInterval > META_LEARNING.MIN_INTERVAL
      ) {
        ml.tickInterval = Math.max(
          META_LEARNING.MIN_INTERVAL,
          ml.tickInterval - META_LEARNING.intervalStep,
        );
        log.info(
          `Effectiveness ${(avgEffectiveness * 100).toFixed(0)}% → speeding up interval to ${ml.tickInterval}`,
        );
      } else if (
        avgEffectiveness <= META_LEARNING.slowDownThreshold &&
        ml.tickInterval < META_LEARNING.MAX_INTERVAL
      ) {
        ml.tickInterval = Math.min(
          META_LEARNING.MAX_INTERVAL,
          ml.tickInterval + META_LEARNING.intervalStep,
        );
        log.info(
          `Effectiveness ${(avgEffectiveness * 100).toFixed(0)}% → slowing down interval to ${ml.tickInterval}`,
        );
      }

      ml.postActivationToolCount = 0;
    }
  }
}

export function getAdaptiveInterval(state: HeartbeatState): number {
  return state.metaLearning.tickInterval;
}
