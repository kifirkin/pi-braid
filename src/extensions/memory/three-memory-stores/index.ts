/**
 * Three Memory Stores Extension
 *
 * Paper: 2604.14475 Evo-MedAgent
 * Key finding: Three complementary stores (Episodes + Heuristics + ToolReliability)
 * outperform single memory. MCQ accuracy 0.68 → 0.79.
 *
 * Architecture:
 * 1. Retrospective Episodes — case-based reasoning from past tasks
 * 2. Adaptive Procedural Heuristics — priority-tagged rules that evolve
 * 3. Tool Reliability Controller — per-tool trustworthiness tracking
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { createLogger } from "../../../lib/logger.js";
import { getExtensionState } from "../../../lib/extension-state.js";
import { sendTrackedMessage } from "../../../lib/injection-tracker.js";
import * as os from "node:os";
import { readFile as fsReadFilePromise } from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";

const log = createLogger("three-memory-stores");

// ── Helpers ──────────────────────────────────────────────────────────────────

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface Episode {
  id: string;
  task: string;
  solution: string;
  outcome: "success" | "failure" | "partial";
  similarity: number;
  timestamp: number;
  toolSequence: string[];
  tags: string[];
  /** Project path where this episode was created. Provenance tag (HaluMem 2511.03506). */
  project: string;
  /** Session ID — enables cross-session contamination filtering. */
  sessionId: string;
}

export interface HeuristicRule {
  id: string;
  condition: string;
  action: string;
  priority: number;
  successRate: number;
  uses: number;
  successes: number;
  lastUsed: number;
  created: number;
}

export interface ToolStat {
  tool: string;
  taskType: string;
  attempts: number;
  successes: number;
  lastAttempt: number;
  avgDuration: number;
}

interface MemoryStoresState {
  episodes: Episode[];
  heuristics: HeuristicRule[];
  toolStats: Map<string, ToolStat>;
  currentSessionTools: string[];
  sessionStartTime: number;
  lastSkillType: string; // R6: track tool→skill transitions for proactive recall
  skillTransitionCount: number; // R6: count skill transitions this session
  recentErrors: string[]; // R6: recent error types for retry-recovery recall
  /** Current session ID — enables cross-session contamination filtering (P1.7). */
  currentSessionId: string;
}

// ── Factory ──────────────────────────────────────────────────────────────────

function createMemoryStoresState(): MemoryStoresState {
  return {
    episodes: [],
    heuristics: [],
    toolStats: new Map(),
    currentSessionTools: [],
    sessionStartTime: Date.now(),
    lastSkillType: "",
    skillTransitionCount: 0,
    recentErrors: [],
    currentSessionId: "",
  };
}

export function getState(ctx: ExtensionContext): MemoryStoresState {
  return getExtensionState(ctx, "three-memory-stores", createMemoryStoresState);
}

// ── Episode Store ────────────────────────────────────────────────────────────

function addEpisode(
  state: MemoryStoresState,
  task: string,
  solution: string,
  outcome: Episode["outcome"],
  toolSequence: string[],
  tags: string[] = [],
  project?: string,
): Episode {
  const episode: Episode = {
    id: `ep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    task,
    solution,
    outcome,
    similarity: 0,
    timestamp: Date.now(),
    toolSequence,
    tags,
    project: project ?? "unknown",
    sessionId: state.currentSessionId || "unknown",
  };
  state.episodes.push(episode);

  if (state.episodes.length > 500) {
    pruneEpisodes(state);
  }

  log.debug(`Added episode: "${task.slice(0, 50)}..." (${outcome})`);
  return episode;
}

function retrieveEpisodes(
  state: MemoryStoresState,
  query: string,
  limit: number = 3,
  currentProject?: string,
): Episode[] {
  const queryLower = query.toLowerCase();
  const now = Date.now();
  const scored = state.episodes
    .map((ep) => {
      // HaluMem (2511.03506): Cross-session isolation — same-project bonus
      const baseScore = computeSimilarity(queryLower, ep);
      const projectBonus = currentProject && ep.project === currentProject ? 0.2 : 0;
      const ageHours = (now - ep.timestamp) / 3600000;
      const ageBonus = Math.max(0, 1 - ageHours / 168) * 0.1; // Decay over 7 days
      return { ep, score: baseScore + projectBonus + ageBonus };
    })
    .filter((s) => s.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map((s) => ({ ...s.ep, similarity: s.score }));
}

function computeSimilarity(query: string, episode: Episode): number {
  const queryWords = new Set(query.split(/\s+/).filter((w) => w.length > 2));
  if (queryWords.size === 0) return 0;

  const taskWords = new Set(
    episode.task
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
  const solutionWords = new Set(
    episode.solution
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
  const tagWords = new Set(
    episode.tags.flatMap((t) => t.toLowerCase().split(/\s+/)).filter((w) => w.length > 2),
  );

  let matches = 0;
  for (const word of queryWords) {
    if (taskWords.has(word)) matches += 3;
    if (solutionWords.has(word)) matches += 1;
    if (tagWords.has(word)) matches += 2;
  }

  return matches / (queryWords.size * 3);
}

// ── RUMS Retrieval (paper 2604.14473) ────────────────────────────────────────
// Select memories by mutual information with response, not just semantic similarity.
// Key insight: select memories that MINIMIZE RESPONSE ENTROPY.

/**
 * Estimate pointwise mutual information between a query word and the episode.
 * PMI(word; episode) ≈ log(P(word | episode) / P(word))
 * High PMI = word is informative about this episode context.
 */
function estimatePMI(
  queryWord: string,
  episode: Episode,
  backgroundFreq: Map<string, number>,
  totalDocs: number,
): number {
  const pWord = backgroundFreq.get(queryWord) ?? 1;
  let pWordGivenEpisode = 0;
  if (queryWord.length >= 3) {
    if (episode.task.toLowerCase().includes(queryWord)) pWordGivenEpisode += 0.7;
    if (episode.solution.toLowerCase().includes(queryWord)) pWordGivenEpisode += 0.5;
    if (episode.tags.some((t) => t.toLowerCase().includes(queryWord))) pWordGivenEpisode += 0.3;
  }
  if (pWordGivenEpisode === 0) return 0;
  return Math.log((pWordGivenEpisode * totalDocs) / Math.max(pWord, 1));
}

/**
 * Compute RUMS score for an episode given a query.
 * Combines PMI with outcome consistency and recency.
 *
 * RUMS theory: select memories that maximize I(Response; Memory | Query)
 * which ≈ minimize entropy of expected response conditioned on memory.
 */
function computeRUMS(
  query: string,
  episode: Episode,
  backgroundFreq: Map<string, number>,
  totalDocs: number,
): number {
  const queryWords = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  if (queryWords.length === 0) return 0;

  // 1. PMI-based information gain (60% weight)
  let pmiSum = 0;
  let validWords = 0;
  for (const word of queryWords) {
    const pmi = estimatePMI(word, episode, backgroundFreq, totalDocs);
    if (pmi > 0) {
      pmiSum += pmi;
      validWords++;
    }
  }
  const avgPMI = validWords > 0 ? pmiSum / validWords : 0;
  const pmiScore = Math.min(avgPMI / 5, 1) * 0.6; // [0, 0.6]

  // 2. Outcome consistency bonus (20% weight)
  const outcomeScore =
    episode.outcome === "success" ? 0.2 : episode.outcome === "partial" ? 0.1 : 0.0;

  // 3. Recency bonus (20% weight)
  const ageDays = (Date.now() - episode.timestamp) / (24 * 60 * 60 * 1000);
  const recencyScore = Math.max(0, 1 - ageDays / 30) * 0.2;

  // 4. Solution specificity bonus (10% weight)
  const solutionTokens = episode.solution.split(/\W+/).filter((w) => w.length > 3).length;
  const specificityScore = Math.min(solutionTokens / 20, 1) * 0.1;

  return pmiScore + outcomeScore + recencyScore + specificityScore;
}

/**
 * RUMS-based episode retrieval — information-theoretic selection.
 * Replaces simple token overlap with mutual information scoring.
 */
function retrieveByRUMS(
  state: MemoryStoresState,
  query: string,
  limit: number = 3,
  currentSessionId: string,
): Episode[] {
  if (state.episodes.length === 0) return [];

  // Build background frequency distribution from all episodes
  const backgroundFreq = new Map<string, number>();
  const totalDocs = state.episodes.length;
  for (const ep of state.episodes) {
    const words = new Set(
      (ep.task + " " + ep.solution + " " + ep.tags.join(" "))
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 2),
    );
    for (const word of words) {
      backgroundFreq.set(word, (backgroundFreq.get(word) ?? 0) + 1);
    }
  }

  // Score each episode by RUMS
  const scored = state.episodes.map((ep) => ({
    ep,
    score: computeRUMS(query, ep, backgroundFreq, totalDocs),
  }));

  const results = scored
    .filter((s) => s.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => ({ ...s.ep, similarity: s.score }));

  // P1.7: Tag cross-session contamination risk
  for (const ep of results) {
    (ep as any)._crossSession = ep.sessionId && ep.sessionId !== currentSessionId;
  }

  log.debug(`RUMS retrieved ${results.length} episodes for "${query.slice(0, 30)}..."`);
  return results;
}

function pruneEpisodes(state: MemoryStoresState): void {
  const outcomeScore = (ep: Episode) =>
    (ep.outcome === "success" ? 2 : ep.outcome === "partial" ? 1 : 0) * 0.5 +
    Math.max(0, 1 - (Date.now() - ep.timestamp) / (30 * 24 * 60 * 60 * 1000)) * 0.5;

  state.episodes.map((ep) => ({ ep, score: outcomeScore(ep) })).sort((a, b) => a.score - b.score);

  state.episodes = state.episodes.slice(-500);
}

// ── Heuristics Store ─────────────────────────────────────────────────────────

function addHeuristicRule(
  state: MemoryStoresState,
  condition: string,
  action: string,
  initialPriority: number = 0.5,
): HeuristicRule {
  const rule: HeuristicRule = {
    id: `hr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

function evolveHeuristic(state: MemoryStoresState, ruleId: string, success: boolean): void {
  const rule = state.heuristics.find((r) => r.id === ruleId);
  if (!rule) return;

  rule.uses++;
  if (success) rule.successes++;
  rule.successRate = rule.successes / rule.uses;
  rule.priority = calculateHeuristicPriority(rule);
  rule.lastUsed = Date.now();
}

function calculateHeuristicPriority(rule: HeuristicRule): number {
  const successComponent = rule.successRate * 0.6;
  const recencyComponent =
    Math.max(0, 1 - (Date.now() - rule.lastUsed) / (7 * 24 * 60 * 60 * 1000)) * 0.2;
  const usageComponent = Math.min(rule.uses / 10, 1) * 0.2;
  return successComponent + recencyComponent + usageComponent;
}

function getPrioritizedHeuristics(state: MemoryStoresState): HeuristicRule[] {
  return [...state.heuristics].sort((a, b) => b.priority - a.priority);
}

function getApplicableHeuristics(state: MemoryStoresState, context: string): HeuristicRule[] {
  const contextLower = context.toLowerCase();
  return state.heuristics
    .filter((r) => contextLower.includes(r.condition.toLowerCase()))
    .sort((a, b) => b.priority - a.priority);
}

// ── Tool Reliability Controller ──────────────────────────────────────────────

function recordToolCall(
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

function getToolReliability(state: MemoryStoresState, tool: string, taskType: string): number {
  const stat = state.toolStats.get(`${tool}:${taskType}`);
  if (!stat || stat.attempts === 0) return 0.5;
  return stat.successes / stat.attempts;
}

function selectBestTool(
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

// ── Built-in Heuristic Rules ─────────────────────────────────────────────────

const BUILTIN_HEURISTICS = [
  {
    condition: "think before write",
    action: "Always use think tool before write tool for complex changes",
    priority: 0.8,
  },
  {
    condition: "test after edit",
    action: "Run tests after modifying code files",
    priority: 0.7,
  },
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

// ── Extension ────────────────────────────────────────────────────────────────

export default function threeMemoryStoresExtension(pi: ExtensionAPI) {
  // ── memory_episodes tool ────────────────────────────────────────────

  pi.registerTool({
    name: "memory_episodes",
    label: "Memory Episodes",
    description:
      "Search retrospective episodes for similar past tasks. Returns relevant past solutions and outcomes.",
    parameters: Type.Object({
      action: StringEnum(["search", "add", "list"]),
      query: Type.Optional(
        Type.String({ description: "Task description to search for (search action)" }),
      ),
      task: Type.Optional(Type.String({ description: "Task description (add action)" })),
      solution: Type.Optional(Type.String({ description: "Solution description (add action)" })),
      outcome: Type.Optional(
        StringEnum(["success", "failure", "partial"], {
          description: "Outcome of the task (add action)",
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 3)", default: 3 })),
      tags: Type.Optional(
        Type.Array(Type.String(), { description: "Tags for the episode (add action)" }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const state = getState(ctx);
      const p = params as {
        action: string;
        query?: string;
        task?: string;
        solution?: string;
        outcome?: string;
        limit?: number;
        tags?: string[];
      };
      const { action, query, task, solution, outcome, limit = 3, tags = [] } = p;

      if (action === "search") {
        if (!query) return textResult("Error: query is required for search action");
        const episodes = retrieveEpisodes(state, query, limit, ctx?.cwd ?? "unknown");
        if (episodes.length === 0) return textResult("No relevant episodes found.");

        const lines: string[] = [`Found ${episodes.length} relevant episodes:\n`];
        for (const ep of episodes) {
          const outcomeIcon =
            ep.outcome === "success" ? "✅" : ep.outcome === "failure" ? "❌" : "⚠️";
          const ageMinutes = Math.round((Date.now() - ep.timestamp) / 60000);
          const provenance = `[MEMORY project=${ep.project || "unknown"} ttl=${ageMinutes}m ago]`;
          lines.push(`${provenance} ${outcomeIcon} [${ep.outcome}] ${ep.task}`);
          lines.push(
            `   Solution: ${ep.solution.slice(0, 200)}${ep.solution.length > 200 ? "..." : ""}`,
          );
          lines.push(`   Tools: ${ep.toolSequence.join(" → ")}`);
          lines.push(`   Similarity: ${(ep.similarity * 100).toFixed(0)}%`);
          lines.push("");
        }
        return textResult(lines.join("\n"));
      }

      if (action === "add") {
        if (!task || !solution || !outcome) {
          return textResult("Error: task, solution, and outcome are required for add action");
        }
        const episode = addEpisode(
          state,
          task,
          solution,
          outcome as Episode["outcome"],
          [],
          tags,
          ctx?.cwd ?? "unknown",
        );
        return textResult(`Episode added: "${task.slice(0, 50)}..." (${outcome}) [${episode.id}]`);
      }

      if (action === "list") {
        if (state.episodes.length === 0) return textResult("No episodes stored.");
        const lines: string[] = [`Episodes (${state.episodes.length} total):\n`];
        const recent = state.episodes.slice(-10).reverse();
        for (const ep of recent) {
          const outcomeIcon =
            ep.outcome === "success" ? "✅" : ep.outcome === "failure" ? "❌" : "⚠️";
          lines.push(`${outcomeIcon} ${ep.task.slice(0, 60)}...`);
        }
        return textResult(lines.join("\n"));
      }

      return textResult(`Unknown action: ${action}. Use search, add, or list.`);
    },
  });

  // ── memory_heuristics tool ──────────────────────────────────────────

  pi.registerTool({
    name: "memory_heuristics",
    label: "Memory Heuristics",
    description:
      "View and manage adaptive procedural heuristics. Returns prioritized rules for the current context.",
    parameters: Type.Object({
      action: StringEnum(["list", "add", "evolve"]),
      context: Type.Optional(
        Type.String({ description: "Current context to match rules against (list action)" }),
      ),
      condition: Type.Optional(Type.String({ description: "Rule condition pattern (add action)" })),
      action_text: Type.Optional(
        Type.String({ description: "Rule action description (add action)" }),
      ),
      rule_id: Type.Optional(Type.String({ description: "Rule ID to evolve (evolve action)" })),
      success: Type.Optional(
        Type.Boolean({ description: "Whether the rule application succeeded (evolve action)" }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const state = getState(ctx);
      const hp = params as {
        action: string;
        context?: string;
        condition?: string;
        action_text?: string;
        rule_id?: string;
        success?: boolean;
      };
      const { action, context, condition, action_text, rule_id, success } = hp;

      if (action === "list") {
        const rules = context
          ? getApplicableHeuristics(state, context)
          : getPrioritizedHeuristics(state);

        if (rules.length === 0) return textResult("No heuristics found.");

        const lines: string[] = [`Heuristics (${rules.length} total):\n`];
        for (const rule of rules) {
          lines.push(`[${rule.priority.toFixed(2)}] ${rule.condition}`);
          lines.push(`   → ${rule.action}`);
          lines.push(
            `   Success rate: ${(rule.successRate * 100).toFixed(0)}% (${rule.uses} uses)`,
          );
          lines.push("");
        }
        return textResult(lines.join("\n"));
      }

      if (action === "add") {
        if (!condition || !action_text) {
          return textResult("Error: condition and action_text are required for add action");
        }
        const rule = addHeuristicRule(state, condition, action_text);
        return textResult(`Heuristic added: "${condition}" → "${action_text}" [${rule.id}]`);
      }

      if (action === "evolve") {
        if (!rule_id || success === undefined) {
          return textResult("Error: rule_id and success are required for evolve action");
        }
        evolveHeuristic(state, rule_id, success);
        return textResult(`Heuristic evolved: ${rule_id} (success: ${success})`);
      }

      return textResult(`Unknown action: ${action}. Use list, add, or evolve.`);
    },
  });

  // ── memory_tool_stats tool ──────────────────────────────────────────

  pi.registerTool({
    name: "memory_tool_stats",
    label: "Memory Tool Stats",
    description: "View tool reliability statistics. Shows success rates per tool per task type.",
    parameters: Type.Object({
      action: StringEnum(["list", "reliability", "best"]),
      tool: Type.Optional(Type.String({ description: "Tool name (reliability action)" })),
      task_type: Type.Optional(Type.String({ description: "Task type (reliability/best action)" })),
      candidates: Type.Optional(
        Type.Array(Type.String(), { description: "Candidate tools (best action)" }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const state = getState(ctx);
      const tp = params as {
        action: string;
        tool?: string;
        task_type?: string;
        candidates?: string[];
      };
      const { action, tool, task_type, candidates } = tp;

      if (action === "list") {
        if (state.toolStats.size === 0) return textResult("No tool stats recorded.");

        const lines: string[] = ["Tool Reliability Stats:\n"];
        for (const stat of state.toolStats.values()) {
          const rate =
            stat.attempts > 0 ? ((stat.successes / stat.attempts) * 100).toFixed(0) : "N/A";
          lines.push(
            `${stat.tool} (${stat.taskType}): ${rate}% success (${stat.attempts} attempts)`,
          );
        }
        return textResult(lines.join("\n"));
      }

      if (action === "reliability") {
        if (!tool || !task_type) return textResult("Error: tool and task_type are required");
        const reliability = getToolReliability(state, tool, task_type);
        return textResult(
          `${tool} reliability for "${task_type}": ${(reliability * 100).toFixed(0)}%`,
        );
      }

      if (action === "best") {
        if (!task_type || !candidates || candidates.length === 0) {
          return textResult("Error: task_type and candidates are required");
        }
        const best = selectBestTool(state, task_type, candidates);
        if (!best) return textResult("No tool stats available for candidates");
        const reliability = getToolReliability(state, best, task_type);
        return textResult(
          `Best tool for "${task_type}": ${best} (${(reliability * 100).toFixed(0)}% reliability)`,
        );
      }

      return textResult(`Unknown action: ${action}. Use list, reliability, or best.`);
    },
  });

  // ── Event: session_start ────────────────────────────────────────────

  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    const state = getState(ctx);
    state.currentSessionId = ctx.sessionManager.getSessionFile?.() ?? `session-${Date.now()}`;

    // Load past episodes from disk so recaller has data from previous sessions
    if (state.episodes.length === 0) {
      const loaded = await loadPastEpisodes(state);
      if (loaded > 0) {
        log.info(`Loaded ${loaded} past episodes from disk`);
      }
    }

    if (state.heuristics.length === 0) {
      for (const h of BUILTIN_HEURISTICS) {
        addHeuristicRule(state, h.condition, h.action, h.priority);
      }
      log.info(`Seeded ${BUILTIN_HEURISTICS.length} built-in heuristics`);
    }

    // R9: Load analytics data to pre-populate tool-reliability stats
    // This closes the feedback loop: analytics → tool reliability → agent behavior
    const analyticsPath = path.join(os.homedir(), ".pi", "logs", "braid-metrics.jsonl");
    try {
      if (fs.existsSync(analyticsPath)) {
        const raw = fs.readFileSync(analyticsPath, "utf-8");
        const lines = raw.trim().split("\n").filter(Boolean);
        // Use last N sessions for relevance
        for (const line of lines.slice(-20)) {
          try {
            const entry = JSON.parse(line);
            if (entry.toolMetrics) {
              for (const [toolName, metrics] of Object.entries(entry.toolMetrics)) {
                const m = metrics as any;
                if (m.successCount !== undefined && m.totalCalls !== undefined) {
                  // Populate tool stats using the toolName as key across all task types
                  // (analytics doesn't break down by task type, so we use "*" as generic)
                  const key = `${toolName}:*`;
                  if (!state.toolStats.has(key)) {
                    state.toolStats.set(key, {
                      tool: toolName,
                      taskType: "*",
                      successes: 0,
                      attempts: 0,
                      lastAttempt: 0,
                      avgDuration: 0,
                    });
                  }
                  const stat = state.toolStats.get(key)!;
                  stat.successes += m.successCount;
                  stat.attempts += m.totalCalls;
                }
              }
            }
          } catch {
            // Skip malformed lines
          }
        }
        log.debug(`Loaded ${lines.length} analytics entries for tool reliability pre-population`);
      }
    } catch (err) {
      log.warn(`Could not load analytics data: ${err}`);
    }

    state.sessionStartTime = Date.now();
    state.currentSessionTools = [];
    state.lastSkillType = "";
    state.skillTransitionCount = 0;
    state.recentErrors = [];
  });

  // ── Auto-Recall Cooldown ──────────────────────────────────────────
  // Prevents noise: minimum gap between proactive recall whispers
  const RECALL_COOLDOWN_MS = 10_000; // 10 seconds
  let lastRecallTime = 0;
  const AUTO_RECALL_ENABLED = true; // Master toggle for auto-recall

  // ── Auto-Recall Helper ────────────────────────────────────────────
  function whisperRecall(ctx: ExtensionContext, title: string, episodes: Episode[]): void {
    if (!AUTO_RECALL_ENABLED || episodes.length === 0) return;

    const now = Date.now();
    if (now - lastRecallTime < RECALL_COOLDOWN_MS) return;
    lastRecallTime = now;

    const lines: string[] = [`[recall] ${title}`];
    for (const ep of episodes.slice(0, 2)) {
      const icon = ep.outcome === "success" ? "✅" : ep.outcome === "failure" ? "❌" : "⚠️";
      lines.push(`  ${icon} ${ep.task.slice(0, 80)}`);
      lines.push(`    Solution: ${ep.solution.slice(0, 120)}`);
    }

    sendTrackedMessage(
      pi,
      {
        customType: "memory",
        display: true,
        content: [{ type: "text", text: lines.join("\n") }],
      },
      undefined,
      { type: "memory", source: "three-memory-stores/recall" },
    );
  }

  // ── Event: tool_end (enhanced with auto-recall) ────────────────────

  pi.on(
    "tool_end" as never,
    async (
      event: {
        toolName?: string;
        tool?: string;
        isError?: boolean;
        error?: unknown;
        duration?: number;
      },
      ctx: ExtensionContext,
    ) => {
      const state = getState(ctx);
      const toolName = event?.toolName ?? event?.tool ?? "unknown";
      const isError = event?.isError ?? event?.error != null;
      const duration = event?.duration ?? 0;

      state.currentSessionTools.push(toolName);

      const taskType = inferTaskType(ctx, toolName);
      recordToolCall(state, toolName, taskType, !isError, duration);

      // R6: Track skill transitions (read→edit, grep→bash, etc.)
      if (state.lastSkillType && state.lastSkillType !== taskType) {
        state.skillTransitionCount++;
        // Proactive recall on 3rd skill transition (doing new type of work)
        if (state.skillTransitionCount === 3 && state.episodes.length > 0) {
          const transitionQuery = `${taskType} solution approach`;
          const relevant = retrieveByRUMS(state, transitionQuery, 1, state.currentSessionId);
          if (relevant.length > 0 && relevant[0].similarity > 0.25) {
            whisperRecall(ctx, `Approach hint for ${taskType} tasks:`, relevant);
          }
        }
      }
      state.lastSkillType = taskType;

      if (isError) {
        log.debug(`Tool "${toolName}" failed for task "${taskType}"`);

        // R6: Track recent error types for retry-recovery recall
        state.recentErrors.push(`${toolName}:${taskType}`);
        if (state.recentErrors.length > 5) state.recentErrors.shift();

        // ── R5: Auto-recall on tool error ───────────────────────
        // When a tool fails, search past episodes for similar failures
        // and solutions. This gives the agent immediate prior art.
        const errorQuery = `${toolName} ${taskType} failure error`;
        const similarFailures = retrieveByRUMS(state, errorQuery, 2, state.currentSessionId);
        if (similarFailures.length > 0 && similarFailures[0].similarity > 0.15) {
          whisperRecall(ctx, `Similar past issue with ${toolName}:`, similarFailures);
        }

        // ── R5: Tool-reliability-based alternative suggestion ──
        // If this tool has low reliability for this task type, suggest a better one
        if (toolName !== "bash") {
          const currentReliability = getToolReliability(state, toolName, taskType);
          if (currentReliability < 0.4 && state.toolStats.size > 3) {
            // Find any tool with better reliability for this task type
            let bestAlt: string | null = null;
            let bestRel = 0;
            for (const [key, stat] of state.toolStats) {
              const [t, tt] = key.split(":");
              if (t !== toolName && tt === taskType && stat.successes / stat.attempts > bestRel) {
                bestRel = stat.successes / stat.attempts;
                bestAlt = t;
              }
            }
            if (bestAlt && bestRel > currentReliability + 0.2) {
              sendTrackedMessage(
                pi,
                {
                  customType: "memory",
                  display: true,
                  content: [
                    {
                      type: "text",
                      text: `[recall] ${bestAlt} has better reliability (${(bestRel * 100).toFixed(0)}%) for "${taskType}" than ${toolName} (${(currentReliability * 100).toFixed(0)}%)`,
                    },
                  ],
                },
                undefined,
                { type: "memory", source: "three-memory-stores/reliability" },
              );
            }
          }
        }
      }
    },
  );

  // ── Event: turn_end auto-recall ────────────────────────────────────

  pi.on("turn_end", async (_event: unknown, ctx: ExtensionContext) => {
    const state = getState(ctx);
    if (!AUTO_RECALL_ENABLED || state.currentSessionTools.length < 3) return;

    const now = Date.now();
    if (now - lastRecallTime < RECALL_COOLDOWN_MS) return;

    // R6: Build improved query from tool sequence + recent errors + skill type
    const recentTools = state.currentSessionTools.slice(-5);
    const lastError = state.recentErrors[state.recentErrors.length - 1] ?? "";
    const errorTool = lastError.split(":")[0] ?? "";
    const taskType = inferTaskType(ctx, recentTools[recentTools.length - 1] ?? "");

    // Query: current task type + recent failures → past solutions
    const query = `${taskType} ${errorTool} solution error`.trim();
    const relevant = retrieveByRUMS(state, query, 1, state.currentSessionId);

    if (relevant.length > 0 && relevant[0].similarity > 0.28) {
      lastRecallTime = now;
      whisperRecall(ctx, `Past solution might apply:`, relevant);
    }
  });

  // ── Event: agent_end ────────────────────────────────────────────────

  pi.on("agent_end", async (_event: any, ctx: ExtensionContext) => {
    const state = getState(ctx);

    const uniqueTools = new Set(state.currentSessionTools);
    const duration = Date.now() - state.sessionStartTime;

    log.info(
      `Session ended: ${state.currentSessionTools.length} tool calls, ${uniqueTools.size} unique tools, ${state.episodes.length} episodes, ${state.heuristics.length} heuristics`,
    );

    const topHeuristics = getPrioritizedHeuristics(state).slice(0, 3);
    for (const h of topHeuristics) {
      log.info(`  Top heuristic: "${h.condition}" (priority: ${h.priority.toFixed(2)})`);
    }
  });

  /* ── Event: session_shutdown ──────────────────────────────────────────── */
  // Persist episodes to disk so they survive session rotation
  pi.on("session_shutdown", async (_event: any, ctx: ExtensionContext) => {
    const state = getState(ctx);
    if (state.episodes.length > 0) {
      const diskPath = path.join(os.homedir(), ".pi", "agent", "memory", "episodes.jsonl");
      try {
        const dir = path.dirname(diskPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const lines = state.episodes.map((e: any) => JSON.stringify(e)).join("\n");
        fs.writeFileSync(diskPath, lines, "utf-8");
        log.debug(`Persisted ${state.episodes.length} episodes to disk`);
      } catch (err) {
        log.warn(`Failed to persist episodes: ${err}`);
      }
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function inferTaskType(_ctx: ExtensionContext, _toolName: string): string {
  const toolTypeMap: Record<string, string> = {
    read: "file_read",
    write: "file_write",
    edit: "file_edit",
    bash: "command_execution",
    grep: "search",
    find: "search",
    think: "reasoning",
    memory_recall: "memory_access",
  };

  return toolTypeMap[_toolName] || "general";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Load episodes from cognitive-memory's disk store on session start.
 * This fixes the write-only read bug: episodes from previous sessions are now
 * available to the recaller module immediately, instead of only after the agent
 * explicitly calls memory_episodes.
 */
async function loadPastEpisodes(state: MemoryStoresState): Promise<number> {
  const diskPath = path.join(os.homedir(), ".pi", "memory", "memory.json");
  try {
    const data = await fsReadFilePromise(diskPath, "utf-8");
    const parsed = JSON.parse(data);
    const episodicItems: Array<{
      id: string;
      type: string;
      text: string;
      timestamp?: number;
      task?: string;
      outcome?: "success" | "failure" | "partial";
    }> = Array.isArray(parsed.episodic) ? parsed.episodic : Array.isArray(parsed) ? parsed : [];

    let loaded = 0;
    for (const item of episodicItems) {
      if (state.episodes.some((e) => e.id === item.id)) continue;
      state.episodes.push({
        id: item.id || `disk-${Date.now()}-${loaded}`,
        task: item.task || item.text?.substring(0, 200) || "",
        solution: item.text || "",
        outcome: item.outcome || "partial",
        similarity: 0.5,
        timestamp: item.timestamp || Date.now() - 86400000,
        toolSequence: [],
        tags: ["loaded-from-disk"],
        project: (item as any).project ?? "unknown",
        sessionId: (item as any).sessionId ?? "migrated",
      });
      loaded++;
    }
    return loaded;
  } catch {
    return 0;
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────

export {
  addEpisode,
  retrieveEpisodes,
  addHeuristicRule,
  evolveHeuristic,
  getPrioritizedHeuristics,
  getApplicableHeuristics,
  recordToolCall,
  getToolReliability,
  selectBestTool,
  retrieveByRUMS,
};
