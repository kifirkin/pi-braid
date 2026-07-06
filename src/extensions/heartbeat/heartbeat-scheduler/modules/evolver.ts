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
  generateAllPendingProposals,
  generateAllPendingValidations,
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

      // ── Harness Proposal Generation (Phase 2) ──────────────────────────
      // Generate proposals for up to 1 actionable cluster per heartbeat.
      // This keeps latency bounded — the LLM call for proposal generation
      // is the only slow operation in the evolver.
      if (actionableCount > 0 && context.turnCount - harnessState.lastProposalTurn >= 20) {
        const newProposals = await generateAllPendingProposals(
          context.ctx,
          clusters,
          harnessState.proposals,
          context.turnCount,
          1, // maxClusters: 1 per heartbeat to keep latency reasonable
        );

        if (newProposals.length > 0) {
          harnessState.proposals.push(...newProposals);
          harnessState.lastProposalTurn = context.turnCount;

          const totalCandidates = newProposals.reduce(
            (sum, p) => sum + p.candidates.length, 0
          );

          log.info(
            `Generated ${newProposals.length} proposal(s) with ${totalCandidates} candidate(s)`,
          );

          // Mark processed clusters so they aren't re-proposed
          for (const prop of newProposals) {
            const cluster = clusters.find((c) => c.id === prop.clusterId);
            if (cluster) cluster.hasProposal = true;
          }

          context.whisper(
            `Self-Harness: generated ${newProposals.length} proposal(s) ` +
            `(${totalCandidates} candidate edits). Validating candidates...`,
            { category: "cognitive" },
          );

          // ── Harness Proposal Validation (Phase 3) ──────────────────────────
          // Validate pending candidates. Kept at 1 proposal per tick to bound
          // latency (each candidate costs 1 LLM call).
          if (context.turnCount - harnessState.lastValidationTurn >= 10) {
            const validationResults = await generateAllPendingValidations(
              context.ctx,
              harnessState.proposals,
              harnessState.validationResults,
              harnessState.clusters,
              context.turnCount,
              1, // maxProposals: 1 per heartbeat
            );

            if (validationResults.length > 0) {
              harnessState.validationResults.push(...validationResults);
              harnessState.lastValidationTurn = context.turnCount;

              const accepted = validationResults.filter((r) => r.accepted);
              const rejected = validationResults.filter((r) => !r.accepted);

              log.info(
                `Validation: ${accepted.length} accepted, ${rejected.length} rejected ` +
                `(total: ${harnessState.validationResults.length} results)`,
              );

              if (accepted.length > 0) {
                context.whisper(
                  `Self-Harness: ${accepted.length} candidate(s) ACCEPTED. ` +
                  `Apply via: update target surfaces.`,
                  { category: "cognitive" },
                );
              }
            }
          }
        }
      }
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
