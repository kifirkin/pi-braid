


/**
 * Cognitive Systems Extension
 *
 * Unified cognitive memory with semantic search:
 * - memory_store/recall/list/get: Semantic memory management
 * - explore_paths: Parallel sub-agent exploration of hypotheses
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type CognitiveMemoryEntry,
  type CognitiveMemoryType,
  formatMemoryEntry,
  formatMemoryTimestamp,
  getCognitiveMemory,
} from "../../../lib/memory/index.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addEvidence } from "../../../lib/store/evidence-pool.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";
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
import {
  getPendingQAs as getPendingConflictQAs,
  // NOTE: getAllQAs aliased as getAllConflictQAs - verify if alias is needed
  resolveQA as resolveConflictQA,
  getQAStats as getConflictQAStats,
  getRelevantQA,
} from "../../../lib/store/conflict-qa.js";

// explore-paths tool - parallel hypothesis investigation
// Extracted to ./explore-paths.ts for cleaner separation
import { createExplorePathsTool } from "./explore-paths.js";

// explore-paths tool registered later in this file

export default function cognitiveMemoryExtension(pi: ExtensionAPI) {
  const memory = getCognitiveMemory();
  // Initialize async - tools will await before first use
  const initPromise: Promise<void> | null = memory.init();

  pi.registerTool({
    name: "memory_store",
    label: "Store Memory",
    promptSnippet: "Store information in long-term memory",
    description:
      "Persist insights, patterns, and errors to long-term memory - use when saving findings for cross-session recall. Supports structured content, memory linking, and TTL-based expiration.",
    parameters: Type.Object({
      content: Type.String({
        description: "The information to remember (can be JSON for structured content)",
      }),
      memoryType: StringEnum([
        "insight",
        "pattern",
        "preference",
        "goal",
        "error",
        "episodic",
        "semantic",
        "procedural",
      ]),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
      importance: Type.Optional(
        Type.Number({ minimum: 0, maximum: 1, description: "Importance 0-1" }),
      ),
      source: Type.Optional(Type.String({ description: "Where this came from" })),
      ttl: Type.Optional(Type.Number({ description: "Time-to-live in milliseconds", minimum: 0 })),
      consolidateWith: Type.Optional(
        Type.Array(Type.String(), {
          description: "IDs of existing memories to merge into this one (consolidation/merge)",
        }),
      ),
      linkedMemories: Type.Optional(
        Type.Array(Type.String(), {
          description: "IDs of related memories to create bidirectional links with",
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<{ id?: string; stored: boolean }>> => {
      await initPromise;
      try {
        // Build linked-memory relations from consolidate_with + linkedMemories
        const related: Array<{ id: string; type: "related" | "fixes" | "supersedes" | "example"; auto: boolean }> = [];
        if (params.linkedMemories) {
          for (const id of params.linkedMemories) {
            related.push({ id, type: "related", auto: false });
          }
        }

        // Consolidation: merge consolidateWith memories into new content, then delete originals
        let consolidatedContent = params.content;
        if (params.consolidateWith) {
          for (const id of params.consolidateWith) {
            const existing = memory.getByIdSync(id);
            if (existing) {
              const sep = consolidatedContent.endsWith(".") ? " " : ". ";
              consolidatedContent += `${sep}[merged from: ${existing.content.slice(0, 500)}]`;
              memory.deleteById(id);
            }
          }
        }

        const m = await memory.store(consolidatedContent, params.memoryType as CognitiveMemoryType, {
          tags: params.tags,
          importance: params.importance,
          source: params.source,
          ttl: params.ttl,
          related: related.length > 0 ? related : undefined,
        });

        // When storing episodic type, also add to three-memory-stores
        if (params.memoryType === "episodic" && ctx) {
          try {
            const threeMem = getExtensionState<MemoryStoresState>(
              ctx,
              "three-memory-stores",
              createMemoryStoresState,
            );
            addEpisode(
              threeMem,
              consolidatedContent.slice(0, 300),
              consolidatedContent,
              "partial",
              [],
              params.tags ?? [],
              undefined,
            );
          } catch {
            /* three-memory-stores not available */
          }
        }

        return {
          content: [{ type: "text", text: `Stored memory ${m.id} (${params.memoryType})` }],
          details: { id: m.id, stored: true },
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Skipped: ${e instanceof Error ? e.message : "Unknown error"}`,
            },
          ],
          details: { stored: false },
        };
      }
    },
  });

  // ── Recency filtering helpers ────────────────────────────────────────────

  /** Parse a since/until value into a Unix timestamp (ms), or undefined if invalid. */
  function parseTimeFilter(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const iso = Date.parse(value);
    if (!isNaN(iso)) return iso;
    const relMatch = value.match(/^(\d+)([hdm])$/);
    if (relMatch) {
      const num = parseInt(relMatch[1], 10);
      const unit = relMatch[2];
      const multipliers = { h: 3_600_000, d: 86_400_000, m: 60_000 };
      return Date.now() - num * (multipliers[unit as keyof typeof multipliers]);
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
    if (r.currentProject && r.memory.tags.some((t) => t.includes(r.currentProject!))) {
      parts.push("same-project");
    }
    if (r.memory.accessCount > 5) parts.push("frequent");
    if (r.memory.type === "error" || r.memory.type === "goal") {
      parts.push("operational");
    }
    if (r.memory.tags.length > 0) parts.push(`tagged:${r.memory.tags.slice(0, 2).join(",")}`);
    return parts.join(", ");
  }

  /** Project identifier from cwd, e.g. /foo/bar/baz → "bar/baz". */
  function deriveProjectId(cwd: string): string {
    const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length < 2) return cwd || "unknown";
    return parts.slice(-2).join("/");
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

  // Unified memory tool (consolidates memory_recall + memory_episodes + memory_heuristics).
  // Flat action namespace with prefix-by-domain (recall_*, episodes_*, heuristics_*).
  // Pattern mirrors the scratchpad tool: one tool, multiple discriminated actions.
  pi.registerTool({
    name: "memory",
    label: "Memory",
    promptSnippet: "Unified memory: recall, episodes, heuristics",
    description:
      "Unified memory access across three domains: " +
      "(1) recall_* - semantic search over the unified cognitive memory (also cross-searches episodes); " +
      "(2) episodes_* - case-based reasoning from past task episodes; " +
      "(3) heuristics_* - view and evolve the procedural behavior rules. " +
      "Common actions: recall_search (semantic query, cross-searches episodes), " +
      "episodes_search (case-based reasoning from past tasks), " +
      "episodes_add (record what you just learned), " +
      "heuristics_list (view active behavior rules), " +
      "heuristics_evolve (mark a rule as success/failure). " +
      "Use the separate `memory_store` tool to write to the unified memory.",
    parameters: Type.Object({
      action: StringEnum([
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
      ], { description: "Action: recall_search|recall_list|recall_get|episodes_search|episodes_list|episodes_add|heuristics_list|heuristics_add|heuristics_evolve" }),

      // ── recall_search params ──
      query: Type.Optional(
        Type.String({ description: "What to search for (recall_search, episodes_search)" }),
      ),
      memoryType: Type.Optional(
        StringEnum([
          "insight",
          "pattern",
          "preference",
          "goal",
          "error",
          "episodic",
          "semantic",
          "procedural",
          "all",
        ], { description: "Memory type filter (recall_search)" }),
      ),
      tags: Type.Optional(
        Type.Array(Type.String(), { description: "Tag filter (recall_search)" }),
      ),
      since: Type.Optional(
        Type.String({
          description:
            "ISO-8601 or relative (e.g. '7d'). Only memories stored after this time (recall_search).",
        }),
      ),
      until: Type.Optional(
        Type.String({
          description:
            "ISO-8601 or relative (e.g. '7d'). Only memories stored before this time (recall_search).",
        }),
      ),

      // ── recall_list params ──
      full: Type.Optional(
        Type.Boolean({ description: "Show full details including timestamps (recall_list)" }),
      ),

      // ── recall_get params ──
      id: Type.Optional(
        Type.String({ description: "Memory ID to retrieve (recall_get)" }),
      ),

      // ── common limit ──
      limit: Type.Optional(
        Type.Number({
          default: 5,
          description:
            "Max results to return (recall_search default 5, recall_list default 20, episodes_search default 3)",
        }),
      ),

      // ── episodes_add params ──
      task: Type.Optional(Type.String({ description: "Task description (episodes_add)" })),
      solution: Type.Optional(
        Type.String({ description: "Solution description (episodes_add)" }),
      ),
      outcome: Type.Optional(
        StringEnum(["success", "failure", "partial"], {
          description: "Outcome of the task (episodes_add)",
        }),
      ),

      // ── heuristics_list params ──
      context: Type.Optional(
        Type.String({
          description:
            "Context to match applicable rules against; if omitted, returns all prioritized rules (heuristics_list)",
        }),
      ),

      // ── heuristics_add params ──
      condition: Type.Optional(
        Type.String({ description: "Rule condition pattern (heuristics_add)" }),
      ),
      action_text: Type.Optional(
        Type.String({ description: "Rule action description (heuristics_add)" }),
      ),

      // ── heuristics_evolve params ──
      rule_id: Type.Optional(
        Type.String({ description: "Rule ID to evolve (heuristics_evolve)" }),
      ),
      success: Type.Optional(
        Type.Boolean({
          description: "Whether the rule application succeeded (heuristics_evolve)",
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<unknown>> => {
      try {
        switch (params?.action) {
          // ── recall_* ──────────────────────────────────────────────────
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
              params.memoryType === "all"
                ? undefined
                : (params.memoryType as CognitiveMemoryType);
            const currentProject = typeof ctx?.cwd === "string" ? ctx.cwd : undefined;
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
              currentSessionId: sessionId,
              accessBoost: 5,
            });
            const since = parseTimeFilter(params.since);
            const until = parseTimeFilter(params.until);
            const filteredResults = results.filter((r) => {
              if (since && r.memory.timestamp < since) return false;
              if (until && r.memory.timestamp > until) return false;
              return true;
            });
            const annotatedResults = filteredResults.map((r) => ({
              ...r,
              relevanceReason: relevanceReason({ ...r, currentProject }),
            }));
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
                  const episodes = retrieveByRUMS(
                    threeMem,
                    params.query,
                    params.limit ?? 3,
                    threeMem.currentSessionId,
                  );
                  episodeResults = episodes.map((ep) => ({
                    task: ep.task,
                    solution: ep.solution.slice(0, 500),
                    outcome: ep.outcome,
                    similarity: ep.similarity ?? 0,
                  }));
                }
              } catch {
                /* three-memory-stores not available */
              }
            }
            if (filteredResults.length > 0 && ctx) {
              for (const r of filteredResults.slice(0, 3)) {
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
                  ep.outcome === "success" ? "✅" : ep.outcome === "failure" ? "❌" : "⚠️";
                const sol = ep.solution ? ` Solution: ${ep.solution}` : "";
                lines.push(
                  `  ${icon} [episodic] ${ep.task}${sol} (similarity: ${ep.similarity.toFixed(2)})`,
                );
              }
            }
            if (lines.length === 0) {
              lines.push("No matching memories found.");
            }
            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: {
                count: annotatedResults.length + episodeResults.length,
                relevanceReasons: annotatedResults.slice(0, params.limit ?? 5).map((r) => ({
                  id: r.memory.id,
                  reason: r.relevanceReason,
                  relevance: Math.round(r.relevance * 100) / 100,
                })),
              },
            };
          }
          case "recall_list": {
            const limit = params.limit ?? 20;
            const memories = memory.getAll(limit);
            const showFull = params.full ?? false;
            const lines: string[] = [];
            if (memories.length > 0) {
              lines.push("Semantic memories:");
              lines.push(memories.map((m) => `- ${formatMemoryEntry(m, showFull)}`).join("\n"));
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
                  .sort((a, b) => b.timestamp - a.timestamp)
                  .slice(0, Math.min(limit, 5));
                if (recent.length > 0) {
                  if (lines.length > 0) lines.push("");
                  lines.push(`Recent episodes (${threeMem.episodes.length} total):`);
                  for (const ep of recent) {
                    const icon =
                      ep.outcome === "success" ? "✅" : ep.outcome === "failure" ? "❌" : "⚠️";
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
                const ep = threeMem.episodes.find((e) => e.id === params.id);
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
                      memory: {
                        id: ep.id,
                        content: `${ep.task}: ${ep.solution}`,
                        type: "episodic",
                        tags: ep.tags ?? [],
                        timestamp: ep.timestamp,
                        accessCount: 0,
                        lastAccessed: 0,
                        importance: 0.5,
                        utility: 0.5,
                      },
                    },
                  };
                }
              } catch {
                /* three-memory-stores not available */
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

          // ── episodes_* ───────────────────────────────────────────────
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
            if (episodes.length === 0) return textResult("No relevant episodes found.");

            const lines: string[] = [`Found ${episodes.length} relevant episodes:\n`];
            for (const ep of episodes) {
              const outcomeIcon =
                ep.outcome === "success" ? "✅" : ep.outcome === "failure" ? "❌" : "⚠️";
              const ageMinutes = Math.round((Date.now() - ep.timestamp) / 60000);
              const provenance = `[MEMORY project=${ep.project || "unknown"} ttl=${ageMinutes}m ago]`;
              const _rich = ep! as unknown as { memoryConfidence?: number; _crossSession?: boolean };
              const confTag =
                _rich.memoryConfidence != null
                  ? ` conf=${(_rich.memoryConfidence * 100).toFixed(0)}%`
                  : "";
              const crossTag = _rich._crossSession ? " [CROSS-SESSION]" : "";
              const qualityTag =
                ep.quality != null ? ` quality=${(ep.quality * 100).toFixed(0)}%` : "";
              lines.push(
                `${provenance}${confTag}${qualityTag}${crossTag} ${outcomeIcon} [${ep.outcome}] ${ep.task}`,
              );
              lines.push(
                `   Solution: ${ep.solution.slice(0, 500)}${ep.solution.length > 500 ? "..." : ""}`,
              );
              lines.push(`   Tools: ${ep.toolSequence.join(" → ")}`);
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
                ep.outcome === "success" ? "✅" : ep.outcome === "failure" ? "❌" : "⚠️";
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
            const episode = addEpisode(
              state,
              params.task,
              params.solution,
              params.outcome as Episode["outcome"],
              [],
              params.tags ?? [],
              deriveProjectId(ctx?.cwd ?? ""),
            );
            return textResult(
              `Episode added: "${params.task.slice(0, 50)}..." (${params.outcome}) [${episode.id}]`,
            );
          }

          // ── heuristics_* ─────────────────────────────────────────────
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
              lines.push(`   → ${rule.action}`);
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
              `Heuristic added: "${params.condition}" → "${params.action_text}" [${rule.id}]`,
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
            return textResult(
              `Heuristic evolved: ${params.rule_id} (success: ${params.success})`,
            );
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
  });



  // Explore paths tool (inlined)
  const explorePathsTool = createExplorePathsTool();
  pi.registerTool({
    name: explorePathsTool.name,
    label: explorePathsTool.label,
    promptSnippet: explorePathsTool.promptSnippet,
    description: explorePathsTool.description,
    parameters: explorePathsTool.parameters,
    execute: explorePathsTool.execute,
  });

  // ── conflict_qa tool ──────────────────────────────────────────────────

  pi.registerTool({
    name: "conflict_qa",
    label: "Conflict QA",
    promptSnippet: "View and resolve knowledge conflicts from evidence pool",
    description:
      "Resolve contradictions between sources or beliefs using the evidence pool - use when sources disagree. Shows contradiction classification, resolution strategy, and source confidence.",
    parameters: Type.Object({
      action: StringEnum(["list", "stats", "resolve", "search"]),
      qa_id: Type.Optional(Type.String({ description: "QA ID to resolve (resolve action)" })),
      verdict: Type.Optional(Type.String({ description: "Resolution verdict (resolve action)" })),
      topic: Type.Optional(
        Type.String({ description: "Topic to search for relevant conflicts (search action)" }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const p = params as { action: string; qa_id?: string; verdict?: string; topic?: string };
      const { action, qa_id, verdict, topic } = p;

      if (action === "list") {
        const qas = getPendingConflictQAs(ctx);
        if (qas.length === 0) return textResult("No pending conflict QAs.");
        const lines = [
          `Pending Conflict QAs (${qas.length}):
`,
        ];
        for (const qa of qas) {
          lines.push(`[${qa.type}] ${qa.question.slice(0, 120)}...`);
          lines.push(`  Strategy: ${qa.resolutionStrategy} | Sources: ${qa.sources.length}`);
          lines.push("");
        }
        return textResult(lines.join("\n"));
      }

      if (action === "stats") {
        const stats = getConflictQAStats(ctx);
        const lines = [
          "Conflict QA Statistics:",
          `  Generated: ${stats.totalGenerated}`,
          `  Resolved: ${stats.totalResolved}`,
          `  Pending: ${stats.pendingCount}`,
        ];
        for (const [strat, count] of Object.entries(stats.resolutionsByStrategy)) {
          lines.push(`  ${strat}: ${count} resolutions`);
        }
        return textResult(lines.join("\n"));
      }

      if (action === "resolve") {
        if (!qa_id || !verdict) return textResult("Error: qa_id and verdict required");
        resolveConflictQA(ctx, qa_id, verdict);
        return textResult(`Conflict QA resolved: ${qa_id} → "${verdict}"`);
      }

      if (action === "search") {
        if (!topic) return textResult("Error: topic required for search");
        const qa = getRelevantQA(ctx, topic);
        if (!qa) return textResult("No relevant conflicts found for topic.");
        return textResult(
          `[${qa.type}] ${qa.question}\nStrategy: ${qa.resolutionStrategy}\nSources: ${qa.sources.length}`,
        );
      }

      return textResult(`Unknown action: ${action}. Use list, stats, resolve, or search.`);
    },
  });
}
