/**
 * Recaller Module - proactive memory retrieval using RUMS (mutual information).
 *
 * Triggers on: high tool failures, deep decomposition, silent turns, high tool usage.
 * Retrieves relevant episodes and heuristics to guide the agent.
 */

import type { CognitiveModule } from "../types.js";
import { createLogger } from "../../../../lib/core/logger.js";
import { getMemoryState } from "../state.js";
import { retrieveByRUMS } from "../../../memory/three-memory-stores/index.js";
import { deriveProjectIdFromCwd } from "../../../../lib/memory/past-insights.js";
import { fenceMemoryContext } from "../../../../lib/utils/memory-fence.js";

/** Derive a short project id from cwd. */
function deriveProject(cwd: string | undefined): string {
  return typeof cwd === "string" ? deriveProjectIdFromCwd(cwd) : "unknown";
}

const log = createLogger("heartbeat:recaller");

export const recallerModule: CognitiveModule = {
  name: "recaller",
  description: "Proactive memory retrieval using RUMS (mutual information)",
  priority: 0.6,

  shouldActivate(context): boolean {
    const lastRecall = context.lastActivation.get("recaller") ?? 0;
    const turnsSinceRecall = context.turnCount - lastRecall;

    const failureCount = (context.metadata?.toolFailures as number) ?? 0;
    if (failureCount >= 3) return true;

    const depth = (context.metadata?.decompositionDepth as number) ?? 0;
    if (depth >= 4) return true;

    if (context.silentTurns >= 8) return true;

    if (context.totalToolCalls >= 20 && context.totalToolCalls % 10 === 0) return true;

    if (turnsSinceRecall < 15 || context.totalToolCalls < 5) return false;
    const memState = getMemoryState(context.ctx);
    return memState !== null && memState.episodes.length >= 2;
  },

  async activate(context): Promise<void> {
    const memState = getMemoryState(context.ctx);
    if (!memState) return;

    const recentTurns = context.turnCount;
    const contextKeywords = `session work turns:${recentTurns} tools:${context.totalToolCalls}`;

    if (memState.episodes.length >= 2) {
      const rumsResults = retrieveByRUMS(
        memState,
        contextKeywords,
        3,
        memState.currentSessionId,
        deriveProject(context.ctx.cwd),
        "current",
      );
      if (rumsResults.length > 0) {
        log.info(
          `RUMS selected ${rumsResults.length} episodes, top score: ${rumsResults[0].similarity.toFixed(2)}`,
        );
      } else {
        log.info(`${memState.episodes.length} episodes available`);
      }
    }

    if (memState.heuristics.length > 0) {
      const contextLower = contextKeywords.toLowerCase();
      const applicableHeuristics = memState.heuristics
        .filter((h) => {
          const condLower = h.condition.toLowerCase();
          return (
            contextLower.includes(condLower) ||
            condLower.split(" ").some((word) => word.length > 3 && contextLower.includes(word))
          );
        })
        .sort((a, b) => b.priority - a.priority)
        .slice(0, 2);

      if (applicableHeuristics.length > 0) {
        log.info(`${applicableHeuristics.length} applicable heuristics for task suggestion`);
        // Recalled heuristic conditions are fenced non-user context.
        context.whisper(
          fenceMemoryContext(
            `Proactive memory: ${applicableHeuristics.length} heuristics may apply to your current task. Consider: ${applicableHeuristics
              .map((h: any) => h.condition)
              .slice(0, 2)
              .join(", ")}`,
          ),
          { category: "cognitive" },
        );
      }
    }
  },
};
