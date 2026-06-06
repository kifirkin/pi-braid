import { createLogger } from "../../../lib/core/logger.js";

const log = createLogger("cognitive-systems");
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
} from "../../../lib/cognitive-memory/index.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addEvidence } from "../../../lib/store/evidence-pool.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { textResult } from "../../../lib/utils/extension-utils.js";
import type { MemoryStoresState } from "../three-memory-stores/index.js";
import {
  createMemoryStoresState,
  retrieveByRUMS,
  addEpisode,
} from "../three-memory-stores/index.js";
import {
  getPendingQAs as getPendingConflictQAs,
  // NOTE: getAllQAs aliased as getAllConflictQAs — verify if alias is needed
  resolveQA as resolveConflictQA,
  getQAStats as getConflictQAStats,
  getRelevantQA,
} from "../../../lib/store/conflict-qa.js";

// explore-paths tool — parallel hypothesis investigation
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
      "Persist insights, patterns, and errors to long-term memory — use when saving findings for cross-session recall. Supports structured content, memory linking, and TTL-based expiration.",
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

  pi.registerTool({
    name: "memory_recall",
    label: "Recall Memory",
    promptSnippet: "Search memory for relevant information",
    description:
      "Search memory for past learnings and patterns — use when you need to recall before answering. Uses semantic text search to find relevant stored information.",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for (natural language)" }),
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
        ]),
      ),
      limit: Type.Optional(Type.Number({ default: 5 })),
      tags: Type.Optional(Type.Array(Type.String())),
      since: Type.Optional(
        Type.String({ description: "ISO-8601 timestamp or relative string like '7d' or '24h' — only return memories stored after this time" }),
      ),
      until: Type.Optional(
        Type.String({ description: "ISO-8601 timestamp or relative string like '7d' or '24h' — only return memories stored before this time" }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<{ count: number; relevanceReasons?: Array<{ id: string; reason: string; relevance: number }> }>> => {
      await initPromise;
      const type =
        params.memoryType === "all" ? undefined : (params.memoryType as CognitiveMemoryType);
      const currentProject = typeof ctx?.cwd === "string" ? ctx.cwd : undefined;
      let sessionId: string | undefined;
      try { sessionId = ctx?.sessionManager?.getSessionId?.(); } catch { /* stale ctx */ }
      const results = await memory.recall(params.query, {
        type,
        limit: params.limit,
        tags: params.tags,
        currentProject,
        currentSessionId: sessionId,
        accessBoost: 5,
      });

      // Apply since/until time filters post-recall
      const since = parseTimeFilter(params.since);
      const until = parseTimeFilter(params.until);
      const filteredResults = results.filter((r) => {
        if (since && r.memory.timestamp < since) return false;
        if (until && r.memory.timestamp > until) return false;
        return true;
      });

      // Add relevance_reason to each result
      const annotatedResults = filteredResults.map((r) => ({
        ...r,
        relevanceReason: relevanceReason({ ...r, currentProject }),
      }));

      // Cross-search three-memory-stores episodes
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

      // Add evidence to pool (Task 3b)
      if (filteredResults.length > 0 && ctx) {
        for (const r of filteredResults.slice(0, 3)) {
          addEvidence(ctx, r.memory.content, "memory", r.memory.content, r.relevance);
        }
      }

      // Build merged output
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
          const icon = ep.outcome === "success" ? "✅" : ep.outcome === "failure" ? "❌" : "⚠️";
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
    },
  });

  pi.registerTool({
    name: "memory_list",
    label: "List Memories",
    promptSnippet: "List all stored memories sorted by recency",
    description:
      "List stored memories sorted by recency — use before searching or recalling to see what's available.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ default: 20 })),
      full: Type.Optional(
        Type.Boolean({
          description: "Show full details including timestamps",
          default: false,
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<{ memories: CognitiveMemoryEntry[] }>> => {
      const memories = memory.getAll(params.limit ?? 20);
      const showFull = params.full ?? false;
      const lines: string[] = [];
      if (memories.length > 0) {
        lines.push("Semantic memories:");
        lines.push(memories.map((m) => `- ${formatMemoryEntry(m, showFull)}`).join("\n"));
      }

      // Cross-list three-memory-stores episodes
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
            .slice(0, Math.min(params.limit ?? 5, 5));
          if (recent.length > 0) {
            if (lines.length > 0) lines.push("");
            lines.push(`Recent episodes (${threeMem.episodes.length} total):`);
            for (const ep of recent) {
              const icon = ep.outcome === "success" ? "✅" : ep.outcome === "failure" ? "❌" : "⚠️";
              const time = new Date(ep.timestamp).toLocaleDateString();
              lines.push(`  ${icon} [id:${ep.id}] ${time} — ${ep.task.slice(0, 60)}`);
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
    },
  });

  pi.registerTool({
    name: "memory_get",
    label: "Get Memory",
    promptSnippet: "Get a specific memory by ID",
    description:
      "Retrieve a specific memory by its full ID — use after listing or searching to inspect complete details.",
    parameters: Type.Object({
      id: Type.String({ description: "Memory ID to retrieve" }),
    }),
    execute: async (
      _toolCallId: string,
      params,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<{ found: boolean; memory?: CognitiveMemoryEntry }>> => {
      await initPromise;
      const m = await memory.getById(params.id);

      // Also search three-memory-stores episodes by ID
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
        content: [{ type: "text", text: `[${m.type}] ${time}${tags}\n  ${m.content}${source}` }],
        details: { found: true, memory: m },
      };
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
      "Resolve contradictions between sources or beliefs using the evidence pool — use when sources disagree. Shows contradiction classification, resolution strategy, and source confidence.",
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
