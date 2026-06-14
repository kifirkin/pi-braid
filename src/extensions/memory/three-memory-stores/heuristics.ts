/**
 * Heuristics Store - adaptive procedural rules that evolve from experience.
 *
 * Paper: 2604.14475 Evo-MedAgent
 * Heuristics are priority-tagged rules learned from success/failure feedback.
 */

import { createLogger } from "../../../lib/core/logger.js";
import type { MemoryStoresState, HeuristicRule } from "./types.js";
import { nextId } from "../../../lib/utils/id.js";

const log = createLogger("three-memory-stores:heuristics");

export function addHeuristicRule(
  state: MemoryStoresState,
  condition: string,
  action: string,
  initialPriority: number = 0.5,
): HeuristicRule {
  const rule: HeuristicRule = {
    id: nextId('hr'),
    condition,
    action,
    priority: initialPriority,
    successRate: 0.5,
    uses: 0,
    successes: 0,
    lastUsed: 0,
    created: Date.now(),
  };
  state.heuristics.push(rule);
  log.debug(`Added heuristic: "${condition.slice(0, 50)}..."`);
  return rule;
}

export function addPrinciple(
  state: MemoryStoresState,
  principle: string,
  context: string,
): HeuristicRule {
  const rule: HeuristicRule = {
    id: nextId('pr'),
    condition: context,
    action: principle,
    priority: 0.2,
    successRate: 0.1,
    uses: 0,
    successes: 0,
    lastUsed: Date.now(),
    created: Date.now(),
    ruleType: "principle",
  };
  state.heuristics.push(rule);
  log.info(`Added principle: "${principle.slice(0, 50)}..."`);
  return rule;
}

export function evolveHeuristic(state: MemoryStoresState, ruleId: string, success: boolean): void {
  const rule = state.heuristics.find((r) => r.id === ruleId);
  if (!rule) return;
  rule.uses++;
  if (success) rule.successes++;
  rule.successRate = rule.successes / rule.uses;
  rule.priority = calculateHeuristicPriority(rule);
  rule.lastUsed = Date.now();
}

export function calculateHeuristicPriority(rule: HeuristicRule): number {
  const successComponent = rule.successRate * 0.6;
  const recencyComponent =
    Math.max(0, 1 - (Date.now() - rule.lastUsed) / (7 * 24 * 60 * 60 * 1000)) * 0.2;
  const usageComponent = Math.min(rule.uses / 10, 1) * 0.2;
  return successComponent + recencyComponent + usageComponent;
}

export function getPrioritizedHeuristics(state: MemoryStoresState): HeuristicRule[] {
  return [...state.heuristics].sort((a, b) => b.priority - a.priority);
}

export function getApplicableHeuristics(
  state: MemoryStoresState,
  context: string,
): HeuristicRule[] {
  return state.heuristics
    .filter((r) => context.toLowerCase().includes(r.condition.toLowerCase()))
    .sort((a, b) => b.priority - a.priority);
}

export const BUILTIN_HEURISTICS = [
  {
    condition: "think before write",
    action: "Always use think tool before write tool for complex changes",
    priority: 0.8,
  },
  { condition: "test after edit", action: "Run tests after modifying code files", priority: 0.7 },
  {
    condition: "read before edit",
    action: "Read file contents before editing to understand context",
    priority: 0.9,
  },
  {
    condition: "small changes first",
    action: "Make incremental changes and verify each step",
    priority: 0.6,
  },
];
