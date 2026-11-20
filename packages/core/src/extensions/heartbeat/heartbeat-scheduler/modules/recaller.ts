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

/**
 * Function words that carry no task information. A condition made only of
 * these would match every task, which is the failure mode this matcher is
 * here to avoid; a condition term list that empties out is never selected.
 */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "when",
  "then",
  "than",
  "your",
  "you",
  "are",
  "was",
  "were",
  "have",
  "has",
  "will",
  "should",
  "must",
  "can",
  "not",
  "but",
  "all",
  "any",
  "its",
  "our",
  "their",
  "them",
  "they",
  "these",
  "those",
  "before",
  "after",
  "over",
  "under",
  "about",
  "while",
  "where",
  "which",
  "what",
  "how",
  "per",
  "via",
  "use",
  "using",
  "also",
]);

/** Content terms of a text: lowercase words that can name a subject. */
function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length > 2 && !STOPWORDS.has(word)) out.add(word);
  }
  return out;
}

/**
 * How specifically a heuristic's condition speaks to this task, or 0 when it
 * does not. The whole condition reading as one phrase is the strongest
 * match; otherwise a majority of the condition's content terms must appear
 * in the task text or the recent tool names. One shared word is not enough:
 * `prune the scratchpad` and `prune the dead code` share a verb, not a task.
 */
function conditionMatch(condition: string, taskTerms: Set<string>, taskText: string): number {
  const conditionTerms = [...terms(condition)];
  if (conditionTerms.length === 0) return 0;
  const overlap = conditionTerms.filter((term) => taskTerms.has(term)).length;
  if (overlap === 0) return 0;
  if (taskText.includes(conditionTerms.join(" "))) return conditionTerms.length;
  const needed = Math.floor(conditionTerms.length / 2) + 1;
  return overlap >= needed ? overlap : 0;
}

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
      // The matcher reads the words the agent was actually given: the last
      // user message and the tools this tick saw. A condition that does not
      // overlap with them selects nothing, however long the session is.
      const toolNames = context.toolCallsSinceLastTick ?? [];
      const taskText = `${context.recentUserText ?? ""}\n${toolNames.join(" ")}`.toLowerCase();
      const taskTerms = terms(taskText);
      const applicableHeuristics = memState.heuristics
        .map((h) => ({ heuristic: h, score: conditionMatch(h.condition, taskTerms, taskText) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.heuristic.priority - a.heuristic.priority || b.score - a.score)
        .slice(0, 2)
        .map(({ heuristic }) => heuristic);

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
