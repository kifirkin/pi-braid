/**
 * Reflection Consolidator - reflection and knowledge consolidation after sustained work.
 *
 * Analyzes tool usage patterns, generates reflection insights,
 * adds memory episodes for cross-session pattern learning.
 */

import type { CognitiveModule } from "../types.js";
import { createLogger } from "../../../../lib/core/logger.js";
import { getMemoryState } from "../state.js";
import {
  addEpisode as addMemoryEpisode,
  addHeuristicRule,
} from "../../../memory/three-memory-stores/index.js";

const log = createLogger("heartbeat:reflection-consolidator");

export const reflectionConsolidatorModule: CognitiveModule = {
  name: "reflection-consolidator",
  description: "Reflection and knowledge consolidation after sustained work",
  priority: 0.4,

  shouldActivate(context): boolean {
    const lastActivation = context.lastActivation.get("reflection-consolidator") ?? 0;
    const turnsSinceActivation = context.turnCount - lastActivation;
    if (turnsSinceActivation < 25 || context.totalToolCalls < 15) return false;

    const memState = getMemoryState(context.ctx);
    if (!memState) return context.totalToolCalls > 20;

    return memState.currentSessionTools.length >= 5;
  },

  async activate(context): Promise<void> {
    const memState = getMemoryState(context.ctx);
    if (!memState) return;

    const toolsUsed = memState.currentSessionTools;
    const uniqueTools = new Set(toolsUsed);

    const verificationTools = [
      "grep",
      "find",
      "read",
      "document_parse",
      "browser_content",
      "fetch_content",
    ];
    const verificationCount = toolsUsed.filter((t: string) => verificationTools.includes(t)).length;
    const codeTools = ["bash", "write", "edit"];
    const codeCount = toolsUsed.filter((t: string) => codeTools.includes(t)).length;

    const insights: string[] = [];
    if (verificationCount < 3 && codeCount > 10) {
      insights.push("Code-heavy session with minimal verification.");
    }
    if (codeCount > 15) {
      insights.push("Significant code generation. Verify correctness.");
    }
    if (uniqueTools.size < 5 && toolsUsed.length > 20) {
      insights.push("Repetitive tool usage. Consider alternative approaches.");
    }

    const task =
      `${toolsUsed.length} tool calls (${uniqueTools.size} unique), ` +
      `${verificationCount} verifications, ${codeCount} code ops in ${context.turnCount} turns`;
    const solution = insights.join(" ") || "Self-reflection on tool usage patterns";

    addMemoryEpisode(memState, task, solution, "partial", toolsUsed, [
      "self-reflection",
      "reflection-consolidator",
      `turns-${context.turnCount}`,
    ]);

    log.info(
      `${toolsUsed.length} tool calls, ${uniqueTools.size} unique tools, ` +
        `${verificationCount} verifications, ${codeCount} code ops - added reflection episode`,
    );

    if (insights.length > 0) {
      context.whisper(`Self-reflection: ${insights.join(" ")}`, { category: "cognitive" });
    }

    try {
      const episodes = memState.episodes ?? [];
      if (episodes.length > 3) {
        const currentSet = new Set(toolsUsed);
        const similarEpisodes: any[] = [];

        for (const ep of episodes) {
          if (!ep.tags || ep.tags.length === 0) continue;
          const epSet = new Set(ep.tags);
          let intersection = 0;
          for (const t of currentSet) {
            if (epSet.has(t)) intersection++;
          }
          const union = currentSet.size + epSet.size - intersection;
          const jaccard = union > 0 ? intersection / union : 0;
          if (jaccard >= 0.5) similarEpisodes.push(ep);
        }

        if (similarEpisodes.length >= 2) {
          const toolNames = [...currentSet].slice(0, 5).join(", ");
          const msg = `Consider a different approach: tool pattern {${toolNames}} repeats across ${similarEpisodes.length} sessions`;
          addHeuristicRule(memState, toolNames, msg, 0.3);
          log.info(`Cross-session pattern: ${msg}`);
        }
      }
    } catch {
      // Cross-session pattern mining reads optional stores; if they are
      // absent or malformed, skipping the heuristic is the correct degrade.
    }
  },
};
