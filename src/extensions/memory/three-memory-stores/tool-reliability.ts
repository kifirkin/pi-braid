/**
 * Tool Reliability Controller — per-tool trustworthiness tracking.
 *
 * Paper: 2604.14475 Evo-MedAgent
 * Tracks attempt/success counts per tool+task type. Used for tool selection.
 */

import type { MemoryStoresState } from "./types.js";

export function recordToolCall(
  state: MemoryStoresState,
  tool: string,
  taskType: string,
  success: boolean,
  duration: number = 0,
): void {
  const key = `${tool}:${taskType}`;
  let stat = state.toolStats.get(key);

  if (!stat) {
    stat = { tool, taskType, attempts: 0, successes: 0, lastAttempt: 0, avgDuration: 0 };
    state.toolStats.set(key, stat);
  }

  stat.attempts++;
  if (success) stat.successes++;
  stat.lastAttempt = Date.now();
  stat.avgDuration = stat.avgDuration === 0 ? duration : (stat.avgDuration + duration) / 2;
}

export function getToolReliability(
  state: MemoryStoresState,
  tool: string,
  taskType: string,
): number {
  const stat = state.toolStats.get(`${tool}:${taskType}`);
  if (!stat || stat.attempts === 0) return 0.5;
  return stat.successes / stat.attempts;
}

export function selectBestTool(
  state: MemoryStoresState,
  taskType: string,
  candidates: string[],
): string | null {
  let bestTool: string | null = null;
  let bestReliability = -1;

  for (const tool of candidates) {
    const reliability = getToolReliability(state, tool, taskType);
    if (reliability > bestReliability) {
      bestReliability = reliability;
      bestTool = tool;
    }
  }

  return bestTool;
}
