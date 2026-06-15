/**
 * Three Memory Stores Extension
 *
 * Paper: 2604.14475 Evo-MedAgent
 * Key finding: Three complementary stores (Episodes + Heuristics + ToolReliability)
 * outperform single memory. MCQ accuracy 0.68 → 0.79.
 *
 * Architecture:
 * 1. Retrospective Episodes - case-based reasoning from past tasks (episodes.ts)
 * 2. Adaptive Procedural Heuristics - priority-tagged rules that evolve (heuristics.ts)
 * 3. Tool Reliability Controller - per-tool trustworthiness tracking (tool-reliability.ts)
 *
 * Two surfaces:
 * - **Internal API** (episodes.ts / heuristics.ts / tool-reliability.ts):
 *   data-layer functions like `addEpisode`, `addPrinciple`, `recordToolCall`.
 *   Many extensions import these directly (e.g. finalize.ts adds episodes
 *   on task completion, recaller.ts retrieves them for cross-task context).
 *   Treat as infrastructure - do not move.
 * - **Agent-facing tools** live in `memory-agent-bridge/` as the unified
 *   `memory` tool (actions: recall_search|recall_list|recall_get,
 *   episodes_search|episodes_list|episodes_add,
 *   heuristics_list|heuristics_add|heuristics_evolve).
 *   The separate `memory_store` tool covers the unified semantic-memory write side.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";


import type { SessionManager } from "../../../lib/state/session-manager.js";

// Extended episode with dynamic metadata fields not in the base type
interface RichEpisode extends Episode {
  memoryConfidence?: number;
  _crossSession?: boolean;
}

// Extended session manager with getSessionFile (pi-native, not in our wrapper)
interface CtxSessionManager extends SessionManager {
  getSessionFile(): string;
}

import { createLogger } from "../../../lib/core/logger.js";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/state/session-start-queue.js";
import { getExtensionState, safeSessionManager } from "../../../lib/state/extension-state.js";
import { emitSignal } from "../../../lib/reasoning/belief-policy-engine.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { readFile as readFilePromise, writeFile, mkdir } from "node:fs/promises";
import { asyncExists } from "../../../lib/utils/async-fs.js";
import * as path from "node:path";
import { EPISODES_FILE, LEGACY_MEMORY_FILE, METRICS_FILE } from "../../../lib/config/braid-paths.js";
import { getCognitiveMemory } from "../../../lib/memory/index.js";

// ── Re-export types ─────────────────────────────────────────────────────────
export type { Episode, HeuristicRule, ToolStat, MemoryStoresState } from "./types.js";
import type { MemoryStoresState, Episode } from "./types.js";

// ── Sub-module imports ──────────────────────────────────────────────────────
import { retrieveByRUMS } from "./episodes.js";
import {
  addHeuristicRule,
  getPrioritizedHeuristics,
  BUILTIN_HEURISTICS,
} from "./heuristics.js";
import { recordToolCall, getToolReliability } from "./tool-reliability.js";
import { TURN_END, SESSION_SHUTDOWN } from "../../../lib/core/event-names.js";

// ── Project Identifier ───────────────────────────────────────────────────────






const log = createLogger("three-memory-stores");

// ── Helpers ──────────────────────────────────────────────────────────────────





// ── Factory ──────────────────────────────────────────────────────────────────

export function createMemoryStoresState(): MemoryStoresState {
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
    lastRecallTime: 0,
    lastSemanticRecallHashes: [],
    lastEpisodeRecallSignature: "",
    lastSemanticRecallTime: 0,
  };
}

export function getState(ctx: ExtensionContext): MemoryStoresState {
  return getExtensionState(ctx, "three-memory-stores", createMemoryStoresState);
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function threeMemoryStoresExtension(pi: ExtensionAPI) {
  // Agent-facing tool surface is owned by `memory-agent-bridge/` (the unified `memory` tool
  // exposes episodes_* and heuristics_* actions). This extension owns the data layer
  // (episodes, heuristics, tool-reliability) and the event-driven auto-recall loop.

  // ── Event: session_start ────────────────────────────────────────────
  registerSessionStartHandler(
    pi,
    SessionPhase.MemoryState,
    async (_event: any, ctx: ExtensionContext) => {
      const state = getState(ctx);
      const sm = safeSessionManager(ctx) as CtxSessionManager | undefined;
      state.currentSessionId = sm?.getSessionFile?.() ?? `session-${Date.now()}`;

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
      const analyticsPath = METRICS_FILE;
      try {
        if (await asyncExists(analyticsPath)) {
          const raw = await readFilePromise(analyticsPath, "utf-8");
          for (const line of raw.trim().split("\n").filter(Boolean).slice(-20)) {
            try {
              const entry = JSON.parse(line);
              if (entry.toolMetrics) {
                for (const [toolName, metrics] of Object.entries(entry.toolMetrics)) {
                  const m = metrics as { successCount?: number; totalCalls?: number };
                  if (m.successCount !== undefined && m.totalCalls !== undefined) {
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
              /* skip malformed */
            }
          }
          log.debug(`Loaded analytics entries for tool reliability pre-population`);
        }
      } catch {
        /* non-fatal */
      }

      state.sessionStartTime = Date.now();
      state.currentSessionTools = [];
      state.lastSkillType = "";
      state.skillTransitionCount = 0;
      state.recentErrors = [];
    },
  );

  // ── Auto-Recall Cooldown (raised from 30s to 120s to reduce flooding) ───
  const RECALL_COOLDOWN_MS = 120_000;
  const AUTO_RECALL_ENABLED = true;

  function whisperRecall(
    state: MemoryStoresState,
    ctx: ExtensionContext,
    title: string,
    episodes: Episode[],
  ): void {
    if (!AUTO_RECALL_ENABLED || episodes.length === 0) return;

    // Filter out cross-session episodes from auto-whisper unless highly relevant (>0.6)
    const filtered = episodes.filter((ep: any) => {
      if (!ep._crossSession) return true;
      return (ep! as unknown as RichEpisode).similarity > 0.6;
    });
    if (filtered.length === 0) return;

    const now = Date.now();
    if (now - state.lastRecallTime < RECALL_COOLDOWN_MS) return;
    state.lastRecallTime = now;

    // Deduplicate: skip if same title + episodes as last emission
    const signature = `${title}|${filtered
      .slice(0, 2)
      .map((ep: Episode) => ep.id)
      .join("|")}`;
    if (signature === state.lastEpisodeRecallSignature) return;
    state.lastEpisodeRecallSignature = signature;

    const crossSession = filtered.filter((ep: any) => ep._crossSession);
    // Only emit contamination signal for repeated cross-session - batch per session
    if (crossSession.length > 0 && state.recentErrors.length < 10) {
      emitSignal(ctx, "memory", "contamination", "warn", false, {
        count: crossSession.length,
        sessionIds: crossSession.map((ep: any) => ep.sessionId).slice(0, 3),
      });
    }

    const lines: string[] = [`[recall] ${title}`];
    for (const ep of filtered.slice(0, 2) as Episode[]) {
      const icon = ep.outcome === "success" ? "✅" : ep.outcome === "failure" ? "❌" : "⚠️";
      const _richEp = ep! as unknown as RichEpisode;
      const crossMark = _richEp._crossSession ? " [CROSS-SESSION]" : "";
      const conf =
        _richEp.memoryConfidence != null
          ? ` (conf ${(_richEp.memoryConfidence * 100).toFixed(0)}%)`
          : "";
      lines.push(`  ${icon}${crossMark}${conf} ${ep.task.slice(0, 80)}`);
      lines.push(`    Solution: ${ep.solution.slice(0, 300)}`);
    }

    sendTrackedMessage(
      pi,
      {
        customType: "memory",
        display: true,
        content: [{ type: "text", text: lines.join("\n") }],
      },
      { deliverAs: "steer", triggerTurn: false },
      { type: "memory", source: "three-memory-stores/recall" },
    );
  }

  // ── Event: tool_result ────────────────────────────────────────────────
  pi.on("tool_result", async (event: any, ctx: ExtensionContext) => {
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
          const relevant = retrieveByRUMS(
            state,
            `${taskType} solution approach`,
            1,
            state.currentSessionId,
          );
          if (relevant.length > 0 && relevant[0].similarity > 0.4) {
            whisperRecall(state, ctx, `Approach hint for ${taskType} tasks:`, relevant);
          }
        }
      }
      state.lastSkillType = taskType;

      if (isError) {
        state.recentErrors.push(`${toolName}:${taskType}`);
        if (state.recentErrors.length > 5) state.recentErrors.shift();

        const errorQuery = `${toolName} ${taskType} failure error`;
        const similarFailures = retrieveByRUMS(state, errorQuery, 2, state.currentSessionId);
        if (similarFailures.length > 0 && similarFailures[0].similarity > 0.35) {
          whisperRecall(state, ctx, `Similar past issue with ${toolName}:`, similarFailures);
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
                // triggerTurn: true - significant reliability gap (>0.2)
                // means the current tool is consistently failing for this
                // task type. Wakes the agent so it can switch tools.
                { deliverAs: "steer", triggerTurn: true },
                { type: "memory", source: "three-memory-stores/reliability" },
              );
            }
          }
        }
      }
    } catch (err) {
      log.error("[three-mem-tool-end] error:", err);
    }
  });

  // ── Event: turn_end ────────────────────────────────────────────────
  pi.on(TURN_END, async (_event: unknown, ctx: ExtensionContext) => {
    try {
      const state = getState(ctx);
      if (!AUTO_RECALL_ENABLED || state.currentSessionTools.length < 3) return;

      const now = Date.now();
      if (now - state.lastRecallTime < RECALL_COOLDOWN_MS) return;

      // Use a stable aggregated query: the most frequent task type across recent tools
      // (not the last tool alone, which changes every turn and causes query instability)
      const recentTools = state.currentSessionTools.slice(-5);
      const toolTypes = recentTools.map((t: string) => inferTaskType(ctx, t));
      const dominantType =
        toolTypes.filter((t: string) => t === toolTypes[0]).length >= 3 ? toolTypes[0] : "general";
      const lastError = state.recentErrors[state.recentErrors.length - 1] ?? "";
      const errorTool = lastError.split(":")[0] ?? "";
      const stableQuery = `${dominantType} ${errorTool} solution error`.trim();
      const relevant = retrieveByRUMS(state, stableQuery, 1, state.currentSessionId);

      if (relevant.length > 0 && relevant[0].similarity > 0.4) {
        whisperRecall(state, ctx, `Past solution might apply:`, relevant);
      }

      // Cross-search semantic memory for relevant insights
      // Uses a separate cooldown so it doesn't interfere with episode recall's timer.
      if (now - state.lastSemanticRecallTime < RECALL_COOLDOWN_MS) return;
      state.lastSemanticRecallTime = now;
      try {
        const cm = getCognitiveMemory();
        const semanticResults = await cm.recall(stableQuery, { type: undefined, limit: 2 });

        // Filter: only surface highly relevant results (adjusted relevance > 1.5)
        // and skip ephemeral types (episodic, procedural) - only goal/pattern,semantic,insight
        const relevantTypes = new Set(["goal", "pattern", "semantic", "insight"]);
        const filtered = semanticResults.filter(
          (r: any) => r.relevance > 1.5 && relevantTypes.has(r.memory.type),
        );
        if (filtered.length === 0) return;

        // Deduplicate: skip if same hashes as last emission
        const resultHashes = filtered.map(
          (r: any) => `${r.memory.id}:${r.memory.content.slice(0, 40)}`,
        );
        const prevHashes = state.lastSemanticRecallHashes;
        if (
          resultHashes.length > 0 &&
          (resultHashes.length !== prevHashes.length ||
            !resultHashes.every((h: string, i: number) => h === prevHashes[i]))
        ) {
          state.lastSemanticRecallHashes = resultHashes;

          const lines: string[] = [`[recall] Related memory:`];
          for (const r of filtered.slice(0, 1)) {
            lines.push(`  [${r.memory.type}] ${r.memory.content.slice(0, 80).replace(/\n/g, " ")}`);
          }
          sendTrackedMessage(
            pi,
            {
              customType: "memory",
              display: true,
              content: [{ type: "text", text: lines.join("\n") }],
            },
            { deliverAs: "steer", triggerTurn: false },
            { type: "memory", source: "three-memory-stores/cross-recall" },
          );
        }
      } catch {
        /* semantic memory unavailable */
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
      log.info(
        `Session ended: ${state.currentSessionTools.length} tool calls, ${uniqueTools.size} unique tools, ${state.episodes.length} episodes, ${state.heuristics.length} heuristics`,
      );

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
  pi.on(SESSION_SHUTDOWN, async (_event: any, _ctx: ExtensionContext) => {
    const state = getState(_ctx);
    if (state.episodes.length > 0) {
      try {
        const dir = path.dirname(EPISODES_FILE);
        if (!(await asyncExists(dir))) await mkdir(dir, { recursive: true });
        await writeFile(
          EPISODES_FILE,
          state.episodes.map((e: any) => JSON.stringify(e)).join("\n"),
          "utf-8",
        );
        log.debug(`Persisted ${state.episodes.length} episodes to ${EPISODES_FILE}`);
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
    memory: "memory_access",
  };
  return toolTypeMap[_toolName] || "general";
}

async function loadPastEpisodes(state: MemoryStoresState): Promise<number> {
  let loaded = 0;

  // Load from current path first
  const newPath = EPISODES_FILE;
  try {
    if (await asyncExists(newPath)) {
      const content = await readFilePromise(newPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const ep: Episode = JSON.parse(line);
          if (!state.episodes.some((e) => e.id === ep.id)) {
            state.episodes.push(ep);
            loaded++;
          }
        } catch {
          /* skip malformed lines */
        }
      }
    }
  } catch {
    /* non-fatal */
  }

  // Backward compat: load episodic items from the legacy memory file path
  const legacyMemPath = LEGACY_MEMORY_FILE;
  try {
    if (await asyncExists(legacyMemPath)) {
      const parsed = JSON.parse(await readFilePromise(legacyMemPath, "utf-8"));
      const episodicItems: Array<any> = Array.isArray(parsed.memories)
        ? parsed.memories.filter((m: any) => m.type === "episodic")
        : [];
      for (const item of episodicItems) {
        if (state.episodes.some((e) => e.id === item.id)) continue;
        state.episodes.push({
          id: item.id || `mig-${Date.now()}-${loaded}`,
          task: item.content?.substring(0, 200) || "",
          solution: item.content || "",
          outcome: "partial",
          similarity: 0.5,
          timestamp: item.timestamp || Date.now() - 86400000,
          toolSequence: [],
          tags: ["loaded-from-disk"],
          project: item.project ?? "unknown",
          sessionId: item.sessionId ?? "migrated",
        });
        loaded++;
      }
    }
  } catch {
    /* non-fatal */
  }

  return loaded;
}

// ── Exports ──────────────────────────────────────────────────────────────────

export { addEpisode, condenseInsights, retrieveEpisodes, retrieveByRUMS } from "./episodes.js";
export {
  addHeuristicRule,
  addPrinciple,
  evolveHeuristic,
  getPrioritizedHeuristics,
  getApplicableHeuristics,
} from "./heuristics.js";
export { recordToolCall, getToolReliability, selectBestTool } from "./tool-reliability.js";
