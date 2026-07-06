/**
 * Evolver Module - evolves heuristics based on session performance (Hyperagents pattern).
 *
 * After sufficient turns, evaluates session performance, boosts successful
 * heuristics, penalizes failing ones, and applies diversity penalty.
 */

import type { CognitiveModule } from "../types.js";
import { createLogger } from "../../../../lib/core/logger.js";
import { getMemoryState } from "../state.js";
import { isDegraded } from "../../../../lib/detection/degradation-detector.js";
import {
  collectAllFailureSignatures,
  getHarnessState,
  mineWeaknesses,
  summarizeClusters,
} from "../../../../lib/harness/index.js";

const log = createLogger("heartbeat:evolver");

export const evolverModule: CognitiveModule = {
  name: "evolver",
  description: "Evolves heuristics based on session performance (Hyperagents pattern)",
  priority: 0.3,

  shouldActivate(context): boolean {
    const lastEvolve = context.lastActivation.get("evolver") ?? 0;
    if (context.turnCount >= 30 && lastEvolve === 0) return true;
    if (lastEvolve === 0 && isDegraded(context.ctx) && context.turnCount >= 10) return true;
    return false;
  },

  async activate(context): Promise<void> {
    const memState = getMemoryState(context.ctx);
    if (!memState) return;

    // Evolve: boost successful rules, penalize failing ones
    for (const rule of memState.heuristics) {
      if (rule.uses > 0 && rule.successRate > 0.6) {
        rule.priority = Math.min(10, rule.priority + 0.1);
      }
      if (rule.uses > 3 && rule.successRate < 0.3) {
        rule.priority = Math.max(0, rule.priority - 0.2);
      }
    }

    // Diversity penalty: reduce dominant heuristic's priority
    const totalUses = memState.heuristics.reduce((sum, h) => sum + h.uses, 0);
    for (const rule of memState.heuristics) {
      if (totalUses > 0 && rule.uses / totalUses > 0.5) {
        rule.priority *= 0.95;
      }
    }

    // ── Self-Harness: Collect failure signatures, mine weaknesses ──────
    const collected = collectAllFailureSignatures(context.ctx);
    const harnessState = getHarnessState(context.ctx);

    if (harnessState.totalCollected > 0 && context.turnCount - harnessState.lastMiningTurn >= 20) {
      const clusters = mineWeaknesses(harnessState.signatures, context.turnCount);
      harnessState.clusters = clusters;
      harnessState.lastMiningTurn = context.turnCount;
      harnessState.hasMined = true;

      const summary = summarizeClusters(clusters);
      const actionableCount = clusters.filter((c) => c.severity >= 0.5).length;

      log.info(
        `Weakness mining: ${clusters.length} clusters, ${actionableCount} actionable ` +
        `(${harnessState.totalCollected} total signatures)`,
      );

      context.whisper(summary, { category: "cognitive" });
    }

    log.info(
      `Evolver: archived session (${context.turnCount} turns, ` +
        `${memState.heuristics.filter((h) => h.uses > 0).length}/${memState.heuristics.length} heuristics used, ` +
        `${harnessState.totalCollected} failure signatures collected)`,
    );

    context.whisper(
      `Meta-learning: session archived. ${memState.heuristics.filter((h) => h.uses > 0).length}/${memState.heuristics.length} heuristics applied. ` +
      `${harnessState.totalCollected} failure signatures. ${harnessState.clusters.length} weakness clusters.`,
      { category: "cognitive" },
    );
  },
};
