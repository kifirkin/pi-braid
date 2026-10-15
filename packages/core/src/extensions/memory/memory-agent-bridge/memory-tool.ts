/**
 * memory tool - Unified memory access across three domains
 *
 * Factory pattern: createMemoryTool(memory, initPromise, recordMemoryToolCall)
 * returns a tool descriptor object with 9 action handlers:
 *   recall_search|recall_list|recall_get|episodes_search|episodes_list|
 *   episodes_add|heuristics_list|heuristics_add|heuristics_evolve
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  CognitiveMemory,
  CognitiveMemoryEntry,
  CognitiveMemoryType,
} from "../../../lib/memory/index.js";
import { formatMemoryEntry, formatMemoryTimestamp } from "../../../lib/memory/index.js";
import { deriveProjectIdFromCwd } from "../../../lib/memory/past-insights.js";
import { getMemoryWriteGateConfig } from "../../../lib/config/braid-settings.js";
import { applyWriteGateLogged } from "../../../lib/memory/write-log.js";
import { selectRecentEpisodes } from "../../../lib/memory/write-quality.js";
import { addEvidence } from "../../../lib/store/evidence-pool.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { createLogger } from "../../../lib/core/logger.js";
import { textResult } from "../../../lib/utils/extension-utils.js";
import type { Episode, MemoryStoresState } from "../three-memory-stores/index.js";
import {
  addEpisode,
  addHeuristicRule,
  createMemoryStoresState,
  evolveHeuristic,
  getApplicableHeuristics,
  getPrioritizedHeuristics,
  retrieveByRUMS,
  retrieveEpisodes,
} from "../three-memory-stores/index.js";
import { flushEpisodeAppends } from "../three-memory-stores/episodes-disk.js";

const log = createLogger("memory-agent-bridge/memory-tool");

// Recency filtering helpers

/** Parse a since/until value into a Unix timestamp (ms), or undefined if invalid. */
function parseTimeFilter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const iso = Date.parse(value);
  if (!isNaN(iso)) return iso;
  const relMatch = value.match(/^(\d+)([hdm])$/);
  if (relMatch) {
    const num = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const multipliers: Record<string, number> = { h: 3_600_000, d: 86_400_000, m: 60_000 };
    return Date.now() - num * (multipliers[unit] ?? 0);
  }
  return undefined;
}

/** Build a human-readable relevance_reason string with boost factors. */
function relevanceReason(r: {
  memory: { type: string; tags: string[]; utility: number; timestamp: number; accessCount: number };
  relevance: number;
  currentProject?: string;
}): string {
  const parts: string[] = [];
  const ageMs = Date.now() - r.memory.timestamp;
  if (ageMs < 86_400_000) parts.push("fresh");
  if (r.relevance > 0.8) parts.push("high-match");
  else if (r.relevance > 0.4) parts.push("moderate-match");
  else parts.push("low-match");
  if (r.memory.utility > 0.7) parts.push("high-utility");
  if (
    r.currentProject &&
    r.memory.tags.some((t) => t.includes(deriveProjectId(r.currentProject!)))
  ) {
    parts.push("same-project");
  }
  if (r.memory.accessCount > 5) parts.push("frequent");
  if (r.memory.type === "error" || r.memory.type === "goal") {
    parts.push("operational");
  }
  if (r.memory.tags.length > 0) parts.push(`tagged:${r.memory.tags.slice(0, 2).join(",")}`);
  return parts.join(", ");
}

/**
 * Project identifier from cwd, e.g. /foo/bar/baz -> "bar/baz".
 * Delegates to shared deriveProjectIdFromCwd in past-insights.ts.
 */
function deriveProjectId(cwd: string): string {
  return deriveProjectIdFromCwd(cwd);
}

/** Returns the three-memory-stores state, or null if unavailable. */
function getThreeMem(ctx: ExtensionContext | undefined): MemoryStoresState | null {
  if (!ctx) return null;
  try {
    return getExtensionState<MemoryStoresState>(
      ctx,
      "three-memory-stores",
      createMemoryStoresState,
    );
  } catch {
    return null;
  }
}

interface MemoryToolDesc {
  name: string;
  label: string;
  promptSnippet: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute: (
    toolCallId: string,
    params: any,
    signal: unknown,
    onUpdate: unknown,
    ctx: ExtensionContext | undefined,
  ) => Promise<AgentToolResult<unknown>>;
}

export function createMemoryTool(
  memory: CognitiveMemory,
  initPromise: Promise<void> | null,
  recordMemoryToolCall: (ctx: ExtensionContext | undefined, tool: string) => void,
): MemoryToolDesc {
  return {
    name: "memory",
    label: "Memory",
    promptSnippet: "Unified memory: recall, episodes, heuristics",
    description:
      "Unified memory: recall_* semantic search, episodes_* case-based history, heuristics_* procedural rules.",
    parameters: Type.Object({
      action: StringEnum(
        [
          // recall (semantic memory)
          "recall_search",
          "recall_list",
          "recall_get",
          // episodes (episodic case-based memory)
          "episodes_search",
          "episodes_list",
          "episodes_add",
          // heuristics (procedural rules)
          "heuristics_list",
          "heuristics_add",
          "heuristics_evolve",
        ],
        {
          description:
            "Action: recall_search/list/get, episodes_search/list/add, heuristics_list/add/evolve",
        },
      ),

      // recall_search params
      query: Type.Optional(
        Type.String({ description: "What to search for (recall_search, episodes_search)" }),
      ),
      memoryType: Type.Optional(
        StringEnum(
          [
            "insight",
            "pattern",
            "preference",
            "goal",
            "error",
            "episodic",
            "semantic",
            "procedural",
            "all",
          ],
          { description: "Memory type filter (recall_search)" },
        ),
      ),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tag filter (recall_search)" })),
      projectScope: Type.Optional(
        StringEnum(["current", "all"], {
          description:
            "Project scope: 'current' (default) = this project only, 'all' = all projects.",
        }),
      ),
      since: Type.Optional(
        Type.String({
          description: "ISO-8601 or relative (e.g. '7d'); only memories stored after this time.",
        }),
      ),
      until: Type.Optional(
        Type.String({
          description: "ISO-8601 or relative (e.g. '7d'); only memories stored before this time.",
        }),
      ),

      // recall_list params
      full: Type.Optional(
        Type.Boolean({ description: "Show full details including timestamps (recall_list)" }),
      ),

      // recall_get params
      id: Type.Optional(Type.String({ description: "Memory ID to retrieve (recall_get)" })),

      // common limit
      limit: Type.Optional(
        Type.Number({
          default: 5,
          description: "Max results (recall_search default 5; recall_list 20; episodes_search 3)",
        }),
      ),

      // episodes_add params
      task: Type.Optional(Type.String({ description: "Task description (episodes_add)" })),
      solution: Type.Optional(Type.String({ description: "Solution description (episodes_add)" })),
      outcome: Type.Optional(
        StringEnum(["success", "failure", "partial"], {
          description: "Outcome of the task (episodes_add)",
        }),
      ),

      // heuristics_list params
      context: Type.Optional(
        Type.String({
          description:
            "Rule-matching context; if omitted, all prioritized rules return (heuristics_list)",
        }),
      ),

      // heuristics_add params
      condition: Type.Optional(
        Type.String({ description: "Rule condition pattern (heuristics_add)" }),
      ),
      action_text: Type.Optional(
        Type.String({ description: "Rule action description (heuristics_add)" }),
      ),

      // heuristics_evolve params
      rule_id: Type.Optional(Type.String({ description: "Rule ID to evolve (heuristics_evolve)" })),
      success: Type.Optional(
        Type.Boolean({
          description: "Whether the rule application succeeded (heuristics_evolve)",
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        action?: string;
        query?: string;
        memoryType?: string;
        tags?: string[];
        projectScope?: string;
        since?: string;
        until?: string;
        full?: boolean;
        id?: string;
        limit?: number;
        task?: string;
        solution?: string;
        outcome?: string;
        context?: string;
        condition?: string;
        action_text?: string;
        rule_id?: string;
        success?: boolean;
      },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ExtensionContext | undefined,
    ): Promise<AgentToolResult<unknown>> => {
      // Record per-action: e.g. "memory:recall_search", "memory:episodes_add".
      // The action may be undefined if the caller sent a malformed request;
      // record as "memory:unknown" in that case so it's still counted.
      recordMemoryToolCall(ctx, `memory:${params?.action ?? "unknown"}`);
      try {
        switch (params?.action) {
          // recall_*
          case "recall_search": {
            if (!params.query) {
              return {
                content: [
                  { type: "text", text: "action=recall_search requires 'query' parameter" },
                ],
                details: { error: true, action: "recall_search" },
              };
            }
            await initPromise;
            const type =
              params.memoryType === "all" ? undefined : (params.memoryType as CognitiveMemoryType);
            const currentProject =
              typeof ctx?.cwd === "string" ? deriveProjectId(ctx.cwd) : undefined;
            let sessionId: string | undefined;
            try {
              sessionId = ctx?.sessionManager?.getSessionId?.();
            } catch {
              /* stale ctx */
            }
            const results = await memory.recall(params.query, {
              type,
              limit: params.limit,
              tags: params.tags,
              currentProject,
              projectScope: params.projectScope as "current" | "all" | undefined,
              currentSessionId: sessionId,
              accessBoost: 5,
            });
            const since = parseTimeFilter(params.since);
            const until = parseTimeFilter(params.until);
            const filteredResults = results.filter((r: { memory: { timestamp: number } }) => {
              if (since && r.memory.timestamp < since) return false;
              if (until && r.memory.timestamp > until) return false;
              return true;
            });
            const annotatedResults = filteredResults.map(
              (r: {
                memory: {
                  type: string;
                  tags: string[];
                  utility: number;
                  timestamp: number;
                  accessCount: number;
                  id: string;
                  content: string;
                };
                relevance: number;
              }) => ({
                ...r,
                relevanceReason: relevanceReason({ ...r, currentProject }),
              }),
            );
            let episodeResults: Array<{
              task: string;
              solution: string;
              outcome: string;
              similarity: number;
            }> = [];
            if (ctx) {
              try {
                const threeMem = getExtensionState<MemoryStoresState>(
                  ctx,
                  "three-memory-stores",
                  createMemoryStoresState,
                );
                if (threeMem.episodes.length > 0) {
                  // Apply the same since/until filter to episodes that
                  // we apply to semantic memories above. Without this,
                  // a recall_search with since=,
                  // until= returned episodes from 2026 (the
                  // filter only applied to the semantic path).
                  const projectId = deriveProjectId(ctx?.cwd ?? "");
                  const userProjectScope = params.projectScope as "current" | "all" | undefined;
                  // The tool contract says projectScope defaults to
                  // "current": pass the project into retrieveByRUMS unless the
                  // caller explicitly set projectScope="all" — otherwise a
                  // plain recall_search runs the RUMS retrieval with no
                  // project filtering and cross-project episodes rank into
                  // results as if they were current-project memory.
                  const effectiveScope = userProjectScope ?? "current";
                  const episodes = retrieveByRUMS(
                    threeMem,
                    params.query!,
                    params.limit ?? 3,
                    threeMem.currentSessionId,
                    effectiveScope === "current" ? projectId : undefined,
                    effectiveScope,
                  ).filter((ep: { timestamp: number }) => {
                    if (since && ep.timestamp < since) return false;
                    if (until && ep.timestamp > until) return false;
                    return true;
                  });
                  episodeResults = episodes.map(
                    (ep: {
                      task: string;
                      solution: string;
                      outcome: string;
                      similarity?: number;
                      _crossProject?: boolean;
                    }) => ({
                      task: ep.task,
                      solution: ep.solution.slice(0, 500),
                      outcome: ep.outcome,
                      similarity: ep.similarity ?? 0,
                      _crossProject: ep._crossProject ?? false,
                    }),
                  );
                }
              } catch {
                /* three-memory-stores not available */
              }
            }
            if (filteredResults.length > 0 && ctx) {
              // Dedupe addEvidence by memory id+type: re-adding the same
              // evidence on every appearance of the same content biases the
              // relevance pool toward frequently-searched memories.
              const seen = new Set<string>();
              for (const r of filteredResults.slice(0, 3)) {
                const key = `${r.memory.type}:${r.memory.id}`;
                if (seen.has(key)) continue;
                seen.add(key);
                addEvidence(ctx, r.memory.content, "memory", r.memory.content, r.relevance);
              }
            }
            const lines: string[] = [];
            if (annotatedResults.length > 0) {
              lines.push(`Found ${annotatedResults.length} semantic memories:`);
              for (const r of annotatedResults.slice(0, params.limit ?? 5)) {
                lines.push(
                  `  [${r.memory.type}] ${r.memory.content.slice(0, 300)}... (${r.relevanceReason}, id: ${r.memory.id})`,
                );
              }
            }
            if (episodeResults.length > 0) {
              if (lines.length > 0 && filteredResults.length > 0) lines.push("");
              lines.push(`Found ${episodeResults.length} related episodes:`);
              for (const ep of episodeResults) {
                const icon =
                  ep.outcome === "success"
                    ? "[ok]"
                    : ep.outcome === "failure"
                      ? "[fail]"
                      : "[warn]";
                const sol = ep.solution ? ` Solution: ${ep.solution}` : "";
                const crossProjectMark = (ep as { _crossProject?: boolean })._crossProject
                  ? " [CROSS-PROJECT]"
                  : "";
                lines.push(
                  `  ${icon} [episodic] ${ep.task}${sol} (similarity: ${ep.similarity.toFixed(2)})${crossProjectMark}`,
                );
              }
            }
            if (lines.length === 0) {
              lines.push("No matching memories found. Consider broader trying search.");
            }
            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: {
                count: annotatedResults.length + episodeResults.length,
                relevanceReasons: annotatedResults
                  .slice(0, params.limit ?? 5)
                  .map(
                    (r: {
                      memory: { id: string };
                      relevanceReason: string;
                      relevance: number;
                    }) => ({
                      id: r.memory.id,
                      reason: r.relevanceReason,
                      relevance: Math.round(r.relevance * 100) / 100,
                    }),
                  ),
              },
            };
          }
          case "recall_list": {
            const limit = params.limit ?? 20;
            const currentProject =
              ctx && typeof ctx.cwd === "string" ? deriveProjectIdFromCwd(ctx.cwd) : undefined;
            const allMemories = memory.getAll(limit);
            // Filter to current-project entries (or legacy entries without a projectId).
            const memories = currentProject
              ? allMemories.filter(
                  (m: CognitiveMemoryEntry) => !m.projectId || m.projectId === currentProject,
                )
              : allMemories;
            const showFull = params.full ?? false;
            const lines: string[] = [];
            if (memories.length > 0) {
              lines.push("Semantic memories:");
              lines.push(
                memories
                  .map((m: CognitiveMemoryEntry) => `- ${formatMemoryEntry(m, showFull)}`)
                  .join("\n"),
              );
            }
            if (ctx) {
              try {
                const threeMem = getExtensionState<MemoryStoresState>(
                  ctx,
                  "three-memory-stores",
                  createMemoryStoresState,
                );
                const recent = threeMem.episodes
                  .slice()
                  .sort(
                    (a: { timestamp: number }, b: { timestamp: number }) =>
                      b.timestamp - a.timestamp,
                  )
                  .slice(0, Math.min(limit, 5));
                if (recent.length > 0) {
                  if (lines.length > 0) lines.push("");
                  lines.push(`Recent episodes (${threeMem.episodes.length} total):`);
                  for (const ep of recent) {
                    const icon =
                      ep.outcome === "success"
                        ? "[ok]"
                        : ep.outcome === "failure"
                          ? "[fail]"
                          : "[warn]";
                    const time = new Date(ep.timestamp).toLocaleDateString();
                    lines.push(`  ${icon} [id:${ep.id}] ${time} - ${ep.task.slice(0, 60)}`);
                  }
                }
              } catch {
                /* three-memory-stores not available */
              }
            }
            if (lines.length === 0) {
              lines.push("No memories stored yet.");
            }
            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: { memories: memories as CognitiveMemoryEntry[] },
            };
          }
          case "recall_get": {
            if (!params.id) {
              return {
                content: [{ type: "text", text: "action=recall_get requires 'id' parameter" }],
                details: { error: true, action: "recall_get" },
              };
            }
            await initPromise;
            const m = await memory.getById(params.id);
            if (!m && ctx) {
              try {
                const threeMem = getExtensionState<MemoryStoresState>(
                  ctx,
                  "three-memory-stores",
                  createMemoryStoresState,
                );
                const ep = threeMem.episodes.find((e: { id: string }) => e.id === params.id);
                if (ep) {
                  const time = formatMemoryTimestamp(ep.timestamp);
                  const tags = ep.tags?.length ? ` [${ep.tags.join(", ")}]` : "";
                  return {
                    content: [
                      {
                        type: "text",
                        text: `[episodic] ${time}${tags}\n  Task: ${ep.task}\n  Solution: ${ep.solution}\n  Outcome: ${ep.outcome}`,
                      },
                    ],
                    details: {
                      found: true,
                      entryType: "episode", // explicit discriminator, not a synthesized CognitiveMemoryEntry
                      memory: {
                        id: ep.id,
                        content: `${ep.task}: ${ep.solution}`,
                        type: "episodic",
                        tags: ep.tags ?? [],
                        timestamp: ep.timestamp,
                      },
                    },
                  };
                }
              } catch (err) {
                // Surface the failure instead of swallowing it.
                log.warn(`[memory-agent-bridge] three-memory-stores lookup failed: ${err}`);
              }
            }
            if (!m) {
              return {
                content: [{ type: "text", text: `Memory ${params.id} not found` }],
                details: { found: false },
              };
            }
            const time = formatMemoryTimestamp(m.timestamp);
            const tags = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
            const source = m.source ? `\n  Source: ${m.source}` : "";
            return {
              content: [
                { type: "text", text: `[${m.type}] ${time}${tags}\n  ${m.content}${source}` },
              ],
              details: { found: true, memory: m },
            };
          }

          // episodes_*
          case "episodes_search": {
            if (!params.query) {
              return {
                content: [
                  { type: "text", text: "action=episodes_search requires 'query' parameter" },
                ],
                details: { error: true, action: "episodes_search" },
              };
            }
            const state = getThreeMem(ctx);
            if (!state) return textResult("No episodes stored yet.");
            const limit = params.limit ?? 3;
            const episodes = retrieveEpisodes(
              state,
              params.query,
              limit,
              deriveProjectId(ctx?.cwd ?? ""),
            );
            if (episodes.length === 0)
              return textResult("No relevant episodes found. Consider trying broader search.");

            const lines: string[] = [`Found ${episodes.length} relevant episodes:\n`];
            for (const ep of episodes) {
              const outcomeIcon =
                ep.outcome === "success" ? "[ok]" : ep.outcome === "failure" ? "[fail]" : "[warn]";
              const ageMinutes = Math.round((Date.now() - ep.timestamp) / 60000);
              const provenance = `[MEMORY project=${ep.project || "unknown"} age=${ageMinutes}m ago]`;
              const confTag =
                (ep as { memoryConfidence?: number }).memoryConfidence != null
                  ? ` conf=${((ep as { memoryConfidence?: number }).memoryConfidence! * 100).toFixed(0)}%`
                  : "";
              const crossTag = (ep as { _crossSession?: boolean })._crossSession
                ? " [CROSS-SESSION]"
                : "";
              const qualityTag =
                ep.quality != null ? ` quality=${(ep.quality * 100).toFixed(0)}%` : "";
              lines.push(
                `${provenance}${confTag}${qualityTag}${crossTag} ${outcomeIcon} [${ep.outcome}] ${ep.task}`,
              );
              lines.push(
                `   Solution: ${ep.solution.slice(0, 500)}${ep.solution.length > 500 ? "..." : ""}`,
              );
              lines.push(`   Tools: ${ep.toolSequence.join(" -> ")}`);
              lines.push(`   Similarity: ${(ep.similarity * 100).toFixed(0)}%`);
              lines.push("");
            }
            return textResult(lines.join("\n"));
          }
          case "episodes_list": {
            const state = getThreeMem(ctx);
            if (!state || state.episodes.length === 0) return textResult("No episodes stored.");
            const lines: string[] = [`Episodes (${state.episodes.length} total):\n`];
            for (const ep of state.episodes.slice(-10).reverse()) {
              const outcomeIcon =
                ep.outcome === "success" ? "[ok]" : ep.outcome === "failure" ? "[fail]" : "[warn]";
              lines.push(`${outcomeIcon} ${ep.task.slice(0, 60)}...`);
            }
            return textResult(lines.join("\n"));
          }
          case "episodes_add": {
            if (!params.task || !params.solution || !params.outcome) {
              return textResult(
                "Error: task, solution, and outcome are required for action=episodes_add",
              );
            }
            const state = getThreeMem(ctx);
            if (!state) return textResult("Error: three-memory-stores not available");
            const project = deriveProjectId(ctx?.cwd ?? "");
            // Agent-explicit write: a suppressed candidate is reported with
            // its reason or the id of the episode it duplicates — never a
            // silent drop.
            const gate = applyWriteGateLogged(getMemoryWriteGateConfig(), {
              site: "episodesAdd",
              task: params.task,
              solution: params.solution,
              recent: selectRecentEpisodes(state.episodes, project),
            });
            if (!gate.write) {
              const decision = gate.decision;
              if (decision.action === "skip-dup") {
                return textResult(
                  `Episode already stored: [${decision.existingId}] ` +
                    `(${decision.match} match). Not written again.`,
                );
              }
              return textResult(
                `Episode not stored: ` +
                  (decision.action === "reject" ? decision.reason : "suppressed by the write gate"),
              );
            }
            const episode = addEpisode(
              state,
              params.task,
              gate.solution,
              params.outcome as Episode["outcome"],
              [],
              params.tags ?? [],
              project,
            );
            // The result text says "Episode added" — make it disk-true: the
            // append lands before the agent is told the episode exists. A
            // failed append degrades to a note (the episode is in the
            // in-memory store; the shutdown compaction retries it).
            try {
              await flushEpisodeAppends();
            } catch (flushErr) {
              log.warn(`episodes_add append flush failed: ${flushErr}`);
            }
            return textResult(
              `Episode added: "${params.task.slice(0, 50)}..." (${params.outcome}) [${episode.id}]`,
            );
          }

          // heuristics_*
          case "heuristics_list": {
            const state = getThreeMem(ctx);
            if (!state) return textResult("No heuristics found.");
            const rules = params.context
              ? getApplicableHeuristics(state, params.context)
              : getPrioritizedHeuristics(state);
            if (rules.length === 0) return textResult("No heuristics found.");
            const lines: string[] = [`Heuristics (${rules.length} total):\n`];
            for (const rule of rules) {
              lines.push(`[${rule.priority.toFixed(2)}] ${rule.condition}`);
              lines.push(`   -> ${rule.action}`);
              lines.push(
                `   Success rate: ${(rule.successRate * 100).toFixed(0)}% (${rule.uses} uses)`,
              );
              lines.push("");
            }
            return textResult(lines.join("\n"));
          }
          case "heuristics_add": {
            if (!params.condition || !params.action_text) {
              return textResult(
                "Error: condition and action_text are required for action=heuristics_add",
              );
            }
            const state = getThreeMem(ctx);
            if (!state) return textResult("Error: three-memory-stores not available");
            const rule = addHeuristicRule(state, params.condition, params.action_text);
            return textResult(
              `Heuristic added: "${params.condition}" -> "${params.action_text}" [${rule.id}]`,
            );
          }
          case "heuristics_evolve": {
            if (!params.rule_id || params.success === undefined) {
              return textResult(
                "Error: rule_id and success are required for action=heuristics_evolve",
              );
            }
            const state = getThreeMem(ctx);
            if (!state) return textResult("Error: three-memory-stores not available");
            evolveHeuristic(state, params.rule_id, params.success);
            return textResult(`Heuristic evolved: ${params.rule_id} (success: ${params.success})`);
          }

          default:
            throw new Error(
              `Unknown memory action: ${params?.action}. Use: recall_search|recall_list|recall_get|episodes_search|episodes_list|episodes_add|heuristics_list|heuristics_add|heuristics_evolve.`,
            );
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err}` }],
          details: { error: true, action: params?.action },
        };
      }
    },
  };
}
