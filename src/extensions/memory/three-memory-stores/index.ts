/**
 * Three Memory Stores Extension
 *
 * Paper: 2604.14475 Evo-MedAgent
 * Key finding: Three complementary stores (Episodes + Heuristics + ToolReliability)
 * outperform single memory. MCQ accuracy 0.68 → 0.79.
 *
 * Architecture:
 * 1. Retrospective Episodes — case-based reasoning from past tasks (episodes.ts)
 * 2. Adaptive Procedural Heuristics — priority-tagged rules that evolve (heuristics.ts)
 * 3. Tool Reliability Controller — per-tool trustworthiness tracking (tool-reliability.ts)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { createLogger } from "../../../lib/logger.js";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/session-start-queue.js";
import { getExtensionState } from "../../../lib/extension-state.js";
import { emitSignal } from "../../../lib/belief-policy-engine.js";
import { sendTrackedMessage } from "../../../lib/injection-tracker.js";
import * as os from "node:os";
import { readFile as fsReadFilePromise } from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Re-export types ─────────────────────────────────────────────────────────
export type { Episode, HeuristicRule, ToolStat } from "./types.js";
import type { MemoryStoresState, Episode } from "./types.js";

// ── Sub-module imports ──────────────────────────────────────────────────────
import {
  addEpisode,
  retrieveEpisodes,
  retrieveByRUMS,
  condenseInsights,
} from "./episodes.js";
import {
  addHeuristicRule,
  evolveHeuristic,
  getPrioritizedHeuristics,
  getApplicableHeuristics,
  BUILTIN_HEURISTICS,
} from "./heuristics.js";
import {
  recordToolCall,
  getToolReliability,
  selectBestTool,
} from "./tool-reliability.js";

// ── Project Identifier ───────────────────────────────────────────────────────
function deriveProjectId(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 2) return cwd || "unknown";
  return parts.slice(-2).join("/");
}

const log = createLogger("three-memory-stores");

// ── Helpers ──────────────────────────────────────────────────────────────────

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

// ── Factory ──────────────────────────────────────────────────────────────────

function createMemoryStoresState(): MemoryStoresState {
  return {
    episodes: [],
    heuristics: [],
    toolStats: new Map(),
    currentSessionId: "",
    currentSessionTools: [],
    sessionStartTime: Date.now(),
    lastSkillType: "",
    skillTransitionCount: 0,
    recentErrors: [],
  };
}

export function getState(ctx: ExtensionContext): MemoryStoresState {
  return getExtensionState(ctx, "three-memory-stores", createMemoryStoresState);
}

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
      query: Type.Optional(Type.String({ description: "Task description to search for (search action)" })),
      task: Type.Optional(Type.String({ description: "Task description (add action)" })),
      solution: Type.Optional(Type.String({ description: "Solution description (add action)" })),
      outcome: Type.Optional(StringEnum(["success", "failure", "partial"], { description: "Outcome of the task (add action)" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 3)", default: 3 })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for the episode (add action)" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const state = getState(ctx);
      const p = params as { action: string; query?: string; task?: string; solution?: string; outcome?: string; limit?: number; tags?: string[] };
      const { action, query, task, solution, outcome, limit = 3, tags = [] } = p;

      if (action === "search") {
        if (!query) return textResult("Error: query is required for search action");
        const episodes = retrieveEpisodes(state, query, limit, deriveProjectId(ctx?.cwd ?? ""));
        if (episodes.length === 0) return textResult("No relevant episodes found.");

        const lines: string[] = [`Found ${episodes.length} relevant episodes:\n`];
        for (const ep of episodes) {
          const outcomeIcon = ep.outcome === "success" ? "✅" : ep.outcome === "failure" ? "❌" : "⚠️";
          const ageMinutes = Math.round((Date.now() - ep.timestamp) / 60000);
          const provenance = `[MEMORY project=${ep.project || "unknown"} ttl=${ageMinutes}m ago]`;
          const confTag = (ep as any).memoryConfidence != null ? ` conf=${((ep as any).memoryConfidence * 100).toFixed(0)}%` : "";
          const crossTag = (ep as any)._crossSession ? " [CROSS-SESSION]" : "";
          const qualityTag = ep.quality != null ? ` quality=${(ep.quality * 100).toFixed(0)}%` : "";
          lines.push(`${provenance}${confTag}${qualityTag}${crossTag} ${outcomeIcon} [${ep.outcome}] ${ep.task}`);
          lines.push(`   Solution: ${ep.solution.slice(0, 200)}${ep.solution.length > 200 ? "..." : ""}`);
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
        const episode = addEpisode(state, task, solution, outcome as Episode["outcome"], [], tags, deriveProjectId(ctx?.cwd ?? ""));
        return textResult(`Episode added: "${task.slice(0, 50)}..." (${outcome}) [${episode.id}]`);
      }

      if (action === "list") {
        if (state.episodes.length === 0) return textResult("No episodes stored.");
        const lines: string[] = [`Episodes (${state.episodes.length} total):\n`];
        for (const ep of state.episodes.slice(-10).reverse()) {
          const outcomeIcon = ep.outcome === "success" ? "✅" : ep.outcome === "failure" ? "❌" : "⚠️";
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
    description: "View and manage adaptive procedural heuristics. Returns prioritized rules for the current context.",
    parameters: Type.Object({
      action: StringEnum(["list", "add", "evolve"]),
      context: Type.Optional(Type.String({ description: "Current context to match rules against (list action)" })),
      condition: Type.Optional(Type.String({ description: "Rule condition pattern (add action)" })),
      action_text: Type.Optional(Type.String({ description: "Rule action description (add action)" })),
      rule_id: Type.Optional(Type.String({ description: "Rule ID to evolve (evolve action)" })),
      success: Type.Optional(Type.Boolean({ description: "Whether the rule application succeeded (evolve action)" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const state = getState(ctx);
      const hp = params as { action: string; context?: string; condition?: string; action_text?: string; rule_id?: string; success?: boolean };
      const { action, context, condition, action_text, rule_id, success } = hp;

      if (action === "list") {
        const rules = context ? getApplicableHeuristics(state, context) : getPrioritizedHeuristics(state);
        if (rules.length === 0) return textResult("No heuristics found.");
        const lines: string[] = [`Heuristics (${rules.length} total):\n`];
        for (const rule of rules) {
          lines.push(`[${rule.priority.toFixed(2)}] ${rule.condition}`);
          lines.push(`   → ${rule.action}`);
          lines.push(`   Success rate: ${(rule.successRate * 100).toFixed(0)}% (${rule.uses} uses)`);
          lines.push("");
        }
        return textResult(lines.join("\n"));
      }

      if (action === "add") {
        if (!condition || !action_text) return textResult("Error: condition and action_text are required for add action");
        const rule = addHeuristicRule(state, condition, action_text);
        return textResult(`Heuristic added: "${condition}" → "${action_text}" [${rule.id}]`);
      }

      if (action === "evolve") {
        if (!rule_id || success === undefined) return textResult("Error: rule_id and success are required for evolve action");
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
      candidates: Type.Optional(Type.Array(Type.String(), { description: "Candidate tools (best action)" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const state = getState(ctx);
      const tp = params as { action: string; tool?: string; task_type?: string; candidates?: string[] };
      const { action, tool, task_type, candidates } = tp;

      if (action === "list") {
        if (state.toolStats.size === 0) return textResult("No tool stats recorded.");
        const lines: string[] = ["Tool Reliability Stats:\n"];
        for (const stat of state.toolStats.values()) {
          const rate = stat.attempts > 0 ? ((stat.successes / stat.attempts) * 100).toFixed(0) : "N/A";
          lines.push(`${stat.tool} (${stat.taskType}): ${rate}% success (${stat.attempts} attempts)`);
        }
        return textResult(lines.join("\n"));
      }

      if (action === "reliability") {
        if (!tool || !task_type) return textResult("Error: tool and task_type are required");
        const reliability = getToolReliability(state, tool, task_type);
        return textResult(`${tool} reliability for "${task_type}": ${(reliability * 100).toFixed(0)}%`);
      }

      if (action === "best") {
        if (!task_type || !candidates || candidates.length === 0) return textResult("Error: task_type and candidates are required");
        const best = selectBestTool(state, task_type, candidates);
        if (!best) return textResult("No tool stats available for candidates");
        return textResult(`Best tool for "${task_type}": ${best} (${(getToolReliability(state, best, task_type) * 100).toFixed(0)}% reliability)`);
      }

      return textResult(`Unknown action: ${action}. Use list, reliability, or best.`);
    },
  });

  // ── Event: session_start ────────────────────────────────────────────
  registerSessionStartHandler(pi, SessionPhase.MemoryState, async (_event: any, ctx: ExtensionContext) => {
    const state = getState(ctx);
    state.currentSessionId = ctx.sessionManager.getSessionFile?.() ?? `session-${Date.now()}`;

    if (state.episodes.length === 0) {
      const loaded = await loadPastEpisodes(state);
      if (loaded > 0) log.info(`Loaded ${loaded} past episodes from disk`);
    }

    if (state.heuristics.length === 0) {
      for (const h of BUILTIN_HEURISTICS) {
        addHeuristicRule(state, h.condition, h.action, h.priority);
      }
      log.info(`Seeded ${BUILTIN_HEURISTICS.length} built-in heuristics`);
    }

    // R9: Load analytics data to pre-populate tool stats
    const analyticsPath = path.join(os.homedir(), ".pi", "logs", "braid-metrics.jsonl");
    try {
      if (fs.existsSync(analyticsPath)) {
        const raw = fs.readFileSync(analyticsPath, "utf-8");
        for (const line of raw.trim().split("\n").filter(Boolean).slice(-20)) {
          try {
            const entry = JSON.parse(line);
            if (entry.toolMetrics) {
              for (const [toolName, metrics] of Object.entries(entry.toolMetrics)) {
                const m = metrics as any;
                if (m.successCount !== undefined && m.totalCalls !== undefined) {
                  const key = `${toolName}:*`;
                  if (!state.toolStats.has(key)) {
                    state.toolStats.set(key, { tool: toolName, taskType: "*", successes: 0, attempts: 0, lastAttempt: 0, avgDuration: 0 });
                  }
                  const stat = state.toolStats.get(key)!;
                  stat.successes += m.successCount;
                  stat.attempts += m.totalCalls;
                }
              }
            }
          } catch { /* skip malformed */ }
        }
        log.debug(`Loaded analytics entries for tool reliability pre-population`);
      }
    } catch { /* non-fatal */ }

    state.sessionStartTime = Date.now();
    state.currentSessionTools = [];
    state.lastSkillType = "";
    state.skillTransitionCount = 0;
    state.recentErrors = [];
  });

  // ── Auto-Recall Cooldown ──────────────────────────────────────────
  const RECALL_COOLDOWN_MS = 10_000;
  let lastRecallTime = 0;
  const AUTO_RECALL_ENABLED = true;

  function whisperRecall(ctx: ExtensionContext, title: string, episodes: Episode[]): void {
    if (!AUTO_RECALL_ENABLED || episodes.length === 0) return;
    const now = Date.now();
    if (now - lastRecallTime < RECALL_COOLDOWN_MS) return;
    lastRecallTime = now;

    const crossSession = episodes.filter((ep: any) => ep._crossSession);
    if (crossSession.length > 0) {
      emitSignal(ctx, "memory", "contamination", "warn", false, {
        count: crossSession.length,
        sessionIds: crossSession.map((ep: any) => ep.sessionId).slice(0, 3),
      });
    }

    const lines: string[] = [`[recall] ${title}`];
    for (const ep of episodes.slice(0, 2)) {
      const icon = ep.outcome === "success" ? "✅" : ep.outcome === "failure" ? "❌" : "⚠️";
      const crossMark = (ep as any)._crossSession ? " [CROSS-SESSION]" : "";
      const conf = (ep as any).memoryConfidence != null ? ` (conf ${((ep as any).memoryConfidence * 100).toFixed(0)}%)` : "";
      lines.push(`  ${icon}${crossMark}${conf} ${ep.task.slice(0, 80)}`);
      lines.push(`    Solution: ${ep.solution.slice(0, 120)}`);
    }

    sendTrackedMessage(pi, {
      customType: "memory",
      display: true,
      content: [{ type: "text", text: lines.join("\n") }],
    }, undefined, { type: "memory", source: "three-memory-stores/recall" });
  }

  // ── Event: tool_end ────────────────────────────────────────────────
  pi.on("tool_end" as never, async (event: any, ctx: ExtensionContext) => {
    try {
    const state = getState(ctx);
    const toolName = event?.toolName ?? event?.tool ?? "unknown";
    const isError = event?.isError ?? event?.error != null;
    const duration = event?.duration ?? 0;

    state.currentSessionTools.push(toolName);
    const taskType = inferTaskType(ctx, toolName);
    recordToolCall(state, toolName, taskType, !isError, duration);

    if (state.lastSkillType && state.lastSkillType !== taskType) {
      state.skillTransitionCount++;
      if (state.skillTransitionCount === 3 && state.episodes.length > 0) {
        const relevant = retrieveByRUMS(state, `${taskType} solution approach`, 1, state.currentSessionId);
        if (relevant.length > 0 && relevant[0].similarity > 0.25) {
          whisperRecall(ctx, `Approach hint for ${taskType} tasks:`, relevant);
        }
      }
    }
    state.lastSkillType = taskType;

    if (isError) {
      state.recentErrors.push(`${toolName}:${taskType}`);
      if (state.recentErrors.length > 5) state.recentErrors.shift();

      const errorQuery = `${toolName} ${taskType} failure error`;
      const similarFailures = retrieveByRUMS(state, errorQuery, 2, state.currentSessionId);
      if (similarFailures.length > 0 && similarFailures[0].similarity > 0.15) {
        whisperRecall(ctx, `Similar past issue with ${toolName}:`, similarFailures);
      }

      if (toolName !== "bash") {
        const currentReliability = getToolReliability(state, toolName, taskType);
        if (currentReliability < 0.4 && state.toolStats.size > 3) {
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
            sendTrackedMessage(pi, {
              customType: "memory",
              display: true,
              content: [{ type: "text", text: `[recall] ${bestAlt} has better reliability (${(bestRel * 100).toFixed(0)}%) for "${taskType}" than ${toolName} (${(currentReliability * 100).toFixed(0)}%)` }],
            }, undefined, { type: "memory", source: "three-memory-stores/reliability" });
          }
        }
      }
    }
    } catch (err) {
      log.error("[three-mem-tool-end] error:", err);
    }
  });

  // ── Event: turn_end ────────────────────────────────────────────────
  pi.on("turn_end", async (_event: unknown, ctx: ExtensionContext) => {
    try {
    const state = getState(ctx);
    if (!AUTO_RECALL_ENABLED || state.currentSessionTools.length < 3) return;

    const now = Date.now();
    if (now - lastRecallTime < RECALL_COOLDOWN_MS) return;

    const recentTools = state.currentSessionTools.slice(-5);
    const lastError = state.recentErrors[state.recentErrors.length - 1] ?? "";
    const errorTool = lastError.split(":")[0] ?? "";
    const taskType = inferTaskType(ctx, recentTools[recentTools.length - 1] ?? "");
    const query = `${taskType} ${errorTool} solution error`.trim();
    const relevant = retrieveByRUMS(state, query, 1, state.currentSessionId);

    if (relevant.length > 0 && relevant[0].similarity > 0.28) {
      lastRecallTime = now;
      whisperRecall(ctx, `Past solution might apply:`, relevant);
    }
    } catch (err) {
      log.error("[three-mem-turn-end] error:", err);
    }
  });

  // ── Event: agent_end ────────────────────────────────────────────────
  pi.on("agent_end", async (_event: any, ctx: ExtensionContext) => {
    try {
    const state = getState(ctx);
    const uniqueTools = new Set(state.currentSessionTools);
    log.info(`Session ended: ${state.currentSessionTools.length} tool calls, ${uniqueTools.size} unique tools, ${state.episodes.length} episodes, ${state.heuristics.length} heuristics`);

    for (const h of getPrioritizedHeuristics(state).slice(0, 3)) {
      log.info(`  Top heuristic: "${h.condition}" (priority: ${h.priority.toFixed(2)})`);
    }
    } catch (err) {
      // stale ctx expected after session replace/dispose
      const _staleMsg = String(err);
      if (_staleMsg.includes("stale after session replacement")) {
        log.debug("[three-mem-agent-end] stale ctx");
      } else {
        log.warn("[three-mem-agent-end] error:", err);
      }
    }
  });

  // ── Event: session_shutdown ────────────────────────────────────────────
  pi.on("session_shutdown", async (_event: any, _ctx: ExtensionContext) => {
    const state = getState(_ctx);
    if (state.episodes.length > 0) {
      const diskPath = path.join(os.homedir(), ".pi", "agent", "memory", "episodes.jsonl");
      try {
        const dir = path.dirname(diskPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(diskPath, state.episodes.map((e: any) => JSON.stringify(e)).join("\n"), "utf-8");
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
    read: "file_read", write: "file_write", edit: "file_edit",
    bash: "command_execution", grep: "search", find: "search",
    think: "reasoning", memory_recall: "memory_access",
  };
  return toolTypeMap[_toolName] || "general";
}

async function loadPastEpisodes(state: MemoryStoresState): Promise<number> {
  const diskPath = path.join(os.homedir(), ".pi", "memory", "memory.json");
  try {
    const data = await fsReadFilePromise(diskPath, "utf-8");
    const parsed = JSON.parse(data);
    const episodicItems: Array<any> = Array.isArray(parsed.episodic) ? parsed.episodic : Array.isArray(parsed) ? parsed : [];
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
  } catch { return 0; }
}

// ── Exports ──────────────────────────────────────────────────────────────────

export { addEpisode, condenseInsights, retrieveEpisodes, retrieveByRUMS } from "./episodes.js";
export { addHeuristicRule, addPrinciple, evolveHeuristic, getPrioritizedHeuristics, getApplicableHeuristics } from "./heuristics.js";
export { recordToolCall, getToolReliability, selectBestTool } from "./tool-reliability.js";
