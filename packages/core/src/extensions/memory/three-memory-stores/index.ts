/**
 * Three Memory Stores Extension
 *
 * Paper: 2604.14475 Evo-MedAgent
 * Key finding: Three complementary stores (Episodes + Heuristics + ToolReliability)
 * outperform single memory. MCQ accuracy 0.68 -> 0.79.
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

// RichEpisode is defined in ./types.ts so sub-modules can import it.

// getSessionFile lives on the canonical SessionManager wrapper
// (lib/state/session-manager.ts); use safeSessionManagerTyped(), which
// returns the typed SessionManager | undefined directly.

import { createLogger } from "../../../lib/core/logger.js";
import {
  registerSessionStartHandler,
  SessionPhase,
} from "../../../lib/state/session-start-queue.js";
import { getExtensionState, safeSessionManagerTyped } from "../../../lib/state/extension-state.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { fenceMemoryContext } from "../../../lib/utils/memory-fence.js";
import { readFile as readFilePromise } from "node:fs/promises";
import { asyncExists } from "../../../lib/utils/async-fs.js";
import {
  EPISODES_FILE,
  LEGACY_MEMORY_FILE,
  METRICS_FILE,
} from "../../../lib/config/braid-paths.js";
import { getCognitiveMemory } from "../../../lib/memory/index.js";
import { deriveProjectIdFromCwd } from "../../../lib/memory/past-insights.js";
import { compactEpisodesFile, flushEpisodeAppends } from "./episodes-disk.js";

// Re-export types
export type { Episode, HeuristicRule, ToolStat, MemoryStoresState } from "./types.js";
import type { MemoryStoresState, Episode } from "./types.js";

// Sub-module imports
import { retrieveByRUMS, sanitizeEpisode } from "./episodes.js";
import { addHeuristicRule, getPrioritizedHeuristics, BUILTIN_HEURISTICS } from "./heuristics.js";
import { recordToolCall, getToolReliability } from "./tool-reliability.js";
import {
  whisperRecall,
  AUTO_RECALL_ENABLED,
  RECALL_COOLDOWN_MS,
} from "./handlers/whisper-recall.js";
import { TURN_END, SESSION_SHUTDOWN, AGENT_END } from "../../../lib/core/event-names.js";

// Project Identifier

/** Derive a short project id from the current working directory. */
function deriveProject(ctx: ExtensionContext): string {
  return typeof ctx.cwd === "string" ? deriveProjectIdFromCwd(ctx.cwd) : "unknown";
}

const log = createLogger("three-memory-stores");

// Helpers

// Factory

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

// Extension

export default function threeMemoryStoresExtension(pi: ExtensionAPI) {
  // Agent-facing tool surface is owned by `memory-agent-bridge/` (the unified `memory` tool
  // exposes episodes_* and heuristics_* actions). This extension owns the data layer
  // (episodes, heuristics, tool-reliability) and the event-driven auto-recall loop.

  // Event: session_start
  registerSessionStartHandler(
    pi,
    SessionPhase.MemoryState,
    async (_event: any, ctx: ExtensionContext) => {
      const state = getState(ctx);
      const sm = safeSessionManagerTyped(ctx);
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
        // Analytics file absent/unreadable — reliability stats simply start
        // empty; nothing downstream requires the pre-population.
      }

      state.sessionStartTime = Date.now();
      state.currentSessionTools = [];
      state.lastSkillType = "";
      state.skillTransitionCount = 0;
      state.recentErrors = [];
    },
  );

  // (whisperRecall and its constants are in ./handlers/whisper-recall.ts)

  // Event: tool_result
  pi.on("tool_result", async (event: any, ctx: ExtensionContext) => {
    try {
      const state = getState(ctx);
      const toolName = event?.toolName ?? "unknown";
      const isError = Boolean(event?.isError);

      state.currentSessionTools.push(toolName);
      // One string per tool_result, never trimmed; consumers read
      // only slice(-5) (task-type inference). Cap 50 = 10x the lookback.
      if (state.currentSessionTools.length > 50) {
        state.currentSessionTools = state.currentSessionTools.slice(-50);
      }
      const taskType = inferTaskType(ctx, toolName);
      // pi tool_result carries no duration (ToolResultEvent); the stat keeps
      // recordToolCall's default instead of a fabricated sample.
      recordToolCall(state, toolName, taskType, !isError);
      const project = deriveProject(ctx);

      if (state.lastSkillType && state.lastSkillType !== taskType) {
        state.skillTransitionCount++;
        if (state.skillTransitionCount === 3 && state.episodes.length > 0) {
          const relevant = retrieveByRUMS(
            state,
            `${taskType} solution approach`,
            1,
            state.currentSessionId,
            project,
            "current",
          );
          if (relevant.length > 0 && relevant[0].similarity > 0.4) {
            whisperRecall(
              state,
              ctx,
              pi,
              `Approach hint for ${taskType} tasks:`,
              relevant,
              project,
            );
          }
        }
      }
      state.lastSkillType = taskType;

      if (isError) {
        state.recentErrors.push(`${toolName}:${taskType}`);
        if (state.recentErrors.length > 5) state.recentErrors.shift();

        const errorQuery = `${toolName} ${taskType} failure error`;
        const similarFailures = retrieveByRUMS(
          state,
          errorQuery,
          2,
          state.currentSessionId,
          deriveProject(ctx),
          "current",
        );
        if (similarFailures.length > 0 && similarFailures[0].similarity > 0.35) {
          whisperRecall(
            state,
            ctx,
            pi,
            `Similar past issue with ${toolName}:`,
            similarFailures,
            project,
          );
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
                  // This body is TOOL-RELIABILITY ANALYTICS
                  // (a stats-driven recommendation), not memory recall. It was
                  // labeled customType "memory", which misattributed it to the
                  // memory family. True family is analytics; the envelope
                  // derives from the source below, so both now say analytics.
                  customType: "analytics",
                  display: true,
                  content: [
                    {
                      type: "text",
                      text: `${bestAlt} has better reliability (${(bestRel * 100).toFixed(0)}%) for "${taskType}" than ${toolName} (${(currentReliability * 100).toFixed(0)}%)`,
                    },
                  ],
                },
                // triggerTurn: true - significant reliability gap (>0.2)
                // means the current tool is consistently failing for this
                // task type. Wakes the agent so it can switch tools.
                { deliverAs: "steer", triggerTurn: true },
                // type "heartbeat" (not "other") keeps the _braidInjected /
                // _braidSource decoration; heartbeat is the analytics-alert
                // type (see heartbeat/analytics). Source root "analytics" so
                // envelope family == body family ().
                { type: "heartbeat", source: "analytics/reliability" },
              );
            }
          }
        }
      }
    } catch (err) {
      log.error("[three-mem-tool-end] error:", err);
    }
  });

  // Event: turn_end
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
      // Only add "solution"/"error" terms when there's actually an error to reference;
      // otherwise the query is just "general" + generic terms which matches every episode.
      const stableQuery = errorTool
        ? `${dominantType} ${errorTool} solution error`.trim()
        : `${dominantType} task pattern`.trim();
      const project = deriveProject(ctx);
      const relevant = retrieveByRUMS(
        state,
        stableQuery,
        1,
        state.currentSessionId,
        project,
        "current",
      );

      if (relevant.length > 0 && relevant[0].similarity > 0.4) {
        whisperRecall(state, ctx, pi, `Past solution might apply:`, relevant, project);
      }

      // Cross-search semantic memory for relevant insights
      // Uses a separate cooldown so it doesn't interfere with episode recall's timer.
      if (now - state.lastSemanticRecallTime < RECALL_COOLDOWN_MS) return;
      state.lastSemanticRecallTime = now;
      try {
        const cm = getCognitiveMemory();
        const semanticResults = await cm.recall(stableQuery, {
          type: undefined,
          limit: 2,
          currentProject: project,
          projectScope: "current",
        });

        // Filter: only surface highly relevant results (adjusted relevance > 1.5)
        // and skip ephemeral types (episodic, procedural) - only goal/pattern,semantic,insight
        const relevantTypes = new Set(["goal", "pattern", "semantic", "insight"]);
        const filtered = semanticResults.filter(
          (r: any) => r.relevance > 1.5 && relevantTypes.has(r.memory.type),
        );
        if (filtered.length === 0) return;

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

          const lines: string[] = [`Related memory:`];
          for (const r of filtered.slice(0, 1)) {
            // Whisper truncation fix: semantic entries are
            // paragraph-length; 80 chars made the whisper useless AND left
            // no retrieval handle. Render 300 chars with explicit ellipsis
            // plus the entry id (mirrors memory-tool.ts's bounded pattern)
            // so the agent can fetch the full text via memory recall_get.
            lines.push(
              `  [${r.memory.type}] ${r.memory.content.slice(0, 300).replace(/\n/g, " ")}${r.memory.content.length > 300 ? "…" : ""} (id: ${r.memory.id})`,
            );
          }
          sendTrackedMessage(
            pi,
            {
              customType: "memory",
              display: true,
              // Recalled semantic entries are fenced non-user context.
              content: [{ type: "text", text: fenceMemoryContext(lines.join("\n")) }],
            },
            { delivery: "park", deliverAs: "steer" },
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

  // Event: agent_end
  pi.on(AGENT_END, async (_event: any, ctx: ExtensionContext) => {
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

  // Event: session_shutdown
  // Compaction, not a blind rewrite: the file is union-merged with the local
  // snapshot by episode id under the store lock, so episodes other live
  // processes appended during this session survive (a snapshot rewrite would
  // have erased them). Pending appends are flushed first; compaction is also
  // the fallback for any episode whose append failed.
  pi.on(SESSION_SHUTDOWN, async (_event: any, _ctx: ExtensionContext) => {
    const state = getState(_ctx);
    if (state.episodes.length > 0) {
      try {
        await flushEpisodeAppends();
        const persisted = await compactEpisodesFile(state.episodes);
        log.debug(`Compacted episode store: ${persisted} episodes at ${EPISODES_FILE}`);
      } catch (err) {
        log.warn(`Failed to persist episodes: ${err}`);
      }
    }
  });
}

// Helpers

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

/**
 * Sanitize an episode's string fields by decoding literal `\uXXXX` escape
 * sequences that may have been written by a previous code path that
 * double-encoded unicode. The agent-facing `recall_search` and
 * `episodes_search` displays otherwise show literal `\u2192` instead of
 * the real character `->`. We apply this at load time so existing data
 * files are healed without requiring a destructive migration.
 *
 * Both the load-time sanitizer (index.ts:loadPastEpisodes) and the write-time
 * sanitizer (in addEpisode) call this; episodes.ts is the canonical home for
 * Episode-related helpers, and index.ts re-exports sanitizeEpisode for
 * callers that prefer the index module.
 */

async function loadPastEpisodes(state: MemoryStoresState): Promise<number> {
  let loaded = 0;

  // Current path wins; the legacy file below is the fallback.
  const newPath = EPISODES_FILE;
  try {
    if (await asyncExists(newPath)) {
      const content = await readFilePromise(newPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const ep: Episode = JSON.parse(line);
          const sanitized = sanitizeEpisode(ep);
          if (!state.episodes.some((e) => e.id === sanitized.id)) {
            state.episodes.push(sanitized);
            loaded++;
          }
        } catch {
          /* skip malformed lines */
        }
      }
    }
  } catch {
    // Legacy episodic file unreadable — stores start empty; the canonical
    // three-store files remain authoritative.
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
    // Migration source unreadable — migration is opportunistic; fresh
    // writes to the new store are unaffected.
  }

  return loaded;
}

// Exports

export {
  addEpisode,
  condenseInsights,
  retrieveEpisodes,
  retrieveByRUMS,
  sanitizeEpisode,
} from "./episodes.js";
export {
  addHeuristicRule,
  addPrinciple,
  evolveHeuristic,
  getPrioritizedHeuristics,
  getApplicableHeuristics,
} from "./heuristics.js";
export { recordToolCall, getToolReliability, selectBestTool } from "./tool-reliability.js";
