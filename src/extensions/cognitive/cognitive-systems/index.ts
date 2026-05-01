import { createLogger } from "../../../lib/logger.js";

const log = createLogger("cognitive-systems");
/**
 * Cognitive Systems Extension
 *
 * Unified cognitive memory with semantic search:
 * - memory_store/recall/list/get: Semantic memory management
 * - explore_paths: Parallel sub-agent exploration of hypotheses
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type CognitiveMemoryEntry,
  type CognitiveMemoryType,
  formatMemoryEntry,
  formatMemoryTimestamp,
  getCognitiveMemory,
} from "../../../lib/cognitive-memory.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { addEvidence } from "../../../lib/evidence-pool.js";
import { textResult } from "../../../lib/extension-utils.js";
import {
  getPendingQAs as getPendingConflictQAs,
  getAllQAs as getAllConflictQAs,
  resolveQA as resolveConflictQA,
  getQAStats as getConflictQAStats,
  getRelevantQA,
} from "../../../lib/conflict-qa.js";

// explore-paths tool — parallel hypothesis investigation
// Searches in pi-braid project root, uses glob for reliable file finding

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// pi-braid project root — resolved from this file's location so searches work from any CWD
import * as path from "node:path";
import * as url from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../../..");

/** Extract candidate file names from a hypothesis string using multiple patterns */
function extractFileCandidates(hypothesis: string): string[] {
  const candidates = new Set<string>();

  // Pattern 1: "in FILE" or "in path/to/file"
  for (const m of hypothesis.matchAll(/\bin\s+([\w./-]+\.\w+)/gi)) {
    candidates.add(m[1]);
  }
  // Pattern 2: "file FILE" or "file: FILE"
  for (const m of hypothesis.matchAll(/\bfile[:\s]+([\w./-]+\.\w+)/gi)) {
    candidates.add(m[1]);
  }
  // Pattern 3: bare filename.ts / filename.js / .json / .mjs
  for (const m of hypothesis.matchAll(/\b([\w-]+\.(?:ts|js|mjs|json))\b/g)) {
    candidates.add(m[1]);
  }
  // Pattern 4: quoted strings that look like paths
  for (const m of hypothesis.matchAll(/[`'"]([\w./-]+\.\w+)[`'"]/g)) {
    candidates.add(m[1]);
  }

  return [...candidates];
}

/** Search for a file starting from PROJECT_ROOT using find */
async function globFind(pattern: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("find", [PROJECT_ROOT, "-name", pattern, "-type", "f"], {
      timeout: 8000,
    });
    const found = stdout.trim().split("\n").filter(Boolean);
    // Prefer .ts over .js over .mjs
    const ts = found.find((f) => f.endsWith(".ts"));
    const js = found.find((f) => f.endsWith(".js"));
    return ts || js || found[0] || "";
  } catch {
    return "";
  }
}

/** Run a grep search and return first few matches */
async function grepSearch(term: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "grep",
      ["-r", "-l", "-m", "3", "--include=*.ts", "--include=*.js", term, PROJECT_ROOT],
      { timeout: 8000 },
    );
    return stdout.trim().split("\n").filter(Boolean).slice(0, 3).join("\n");
  } catch {
    return "";
  }
}

/** Read first N lines of a file */
async function readFileHead(path: string, lines = 30): Promise<string> {
  if (!path) return "";
  try {
    const { stdout } = await execFileAsync("head", [`-${lines}`, path], { timeout: 5000 });
    return stdout;
  } catch {
    return "(could not read)";
  }
}

function createExplorePathsTool() {
  return {
    name: "explore_paths",
    label: "Explore Paths",
    description:
      "Spawn parallel sub-agents to explore MULTIPLE potential root causes. Use BEFORE fixing bugs to gather evidence. All hypotheses must lead to proper, well-designed solutions - never use monkey patching or workarounds.",
    parameters: Type.Object({
      hypothesis_1: Type.String({
        description:
          "First potential root cause location: 'The bug might be in FILE because REASON'",
      }),
      hypothesis_2: Type.String({
        description:
          "Second potential root cause location: 'The bug might be in OTHER_FILE because REASON'",
      }),
      hypothesis_3: Type.Optional(
        Type.String({
          description:
            "Third potential root cause location (optional): 'The bug might be in ANOTHER_FILE because REASON'",
        }),
      ),
    }),

    execute: async (
      _toolCallId: string,
      params: unknown,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) => {
      const { hypothesis_1, hypothesis_2, hypothesis_3 } = params as {
        hypothesis_1: string;
        hypothesis_2: string;
        hypothesis_3?: string;
      };

      const results: string[] = [];
      const hypotheses = [hypothesis_1, hypothesis_2];
      if (hypothesis_3) hypotheses.push(hypothesis_3);

      // Run all hypothesis investigations in parallel
      const explorations = hypotheses.map(async (hyp, i) => {
        const localResults: string[] = [];
        localResults.push(`### Hypothesis ${i + 1}: ${hyp.substring(0, 120)}`);

        const candidates = extractFileCandidates(hyp);
        if (candidates.length === 0) {
          // No files found — try keyword search
          localResults.push("No file candidates extracted — trying keyword search...");
          const words = hyp
            .split(/\W+/)
            .filter(
              (w) =>
                w.length > 3 &&
                !/^(the|and|for|because|when|that|this|with|from|have|will|been|also|than|then|more|into|use|using|need|want|make|just|only|not|but|all|any|some|their|there|here|where|what|which|while|would|could|should|might|must|such|same|very)$/i.test(
                  w,
                ),
            );
          const keyTerm = words.slice(0, 3).join(" ");
          if (keyTerm.length > 3) {
            const grepResult = await grepSearch(keyTerm);
            if (grepResult) {
              localResults.push(`Keyword search for "${keyTerm}":`);
              localResults.push(
                grepResult
                  .split("\n")
                  .map((f) => `  📄 ${f}`)
                  .join("\n"),
              );
              localResults.push("(first 3 matches shown)");
            } else {
              localResults.push(`No results for keyword search "${keyTerm}"`);
            }
          } else {
            localResults.push("No useful keywords found for search.");
          }
        } else {
          // Try each candidate file in parallel
          const searchResults = await Promise.all(
            candidates.map(async (candidate) => {
              const foundPath = await globFind(candidate);
              return { candidate, foundPath };
            }),
          );

          const found = searchResults.filter((r) => r.foundPath);
          const notFound = searchResults.filter((r) => !r.foundPath);

          if (found.length > 0) {
            for (const { candidate, foundPath } of found) {
              const relPath = foundPath.replace(PROJECT_ROOT + "/", "");
              localResults.push(`✅ "${candidate}" → ${relPath}`);
              const preview = await readFileHead(foundPath);
              const previewLines = preview.split("\n").slice(0, 15);
              localResults.push("```");
              localResults.push(...previewLines);
              localResults.push("```");
            }
          }
          if (notFound.length > 0) {
            for (const { candidate } of notFound) {
              localResults.push(`❌ "${candidate}" not found in project`);
            }
          }
        }

        localResults.push("");
        return localResults;
      });

      const allResults = await Promise.all(explorations);
      for (const r of allResults) {
        results.push(...r);
      }

      results.push("---");
      results.push("**Next steps:**");
      results.push("1. Review the evidence above — files found show the actual code path");
      results.push("2. Identify which hypothesis has supporting evidence");
      results.push("3. Trace the code path for the most likely hypothesis");
      results.push("4. Propose a PROPER fix (no shortcuts, no technical debt)");
      results.push("");
      results.push(
        "**Quality requirement:** All solutions must be well-designed and maintainable.",
      );

      // Add evidence to pool
      if (ctx) {
        for (const hyp of hypotheses) {
          addEvidence(ctx, hyp, "session", hyp, 0.5);
        }
      }

      return {
        details: { hypotheses: hypotheses.length, projectRoot: PROJECT_ROOT },
        content: [{ type: "text" as const, text: results.join("\n") }],
      };
    },
  };
}

export default function cognitiveMemoryExtension(pi: ExtensionAPI) {
  const memory = getCognitiveMemory();
  // Initialize async - tools will await before first use
  const initPromise: Promise<void> | null = memory.init();

  pi.registerTool({
    name: "memory_store",
    label: "Store Memory",
    description:
      "Store information in long-term memory. Supports structured content (files, errors, solutions), memory linking, and TTL-based expiration.",
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
        const m = await memory.store(params.content, params.memoryType as CognitiveMemoryType, {
          tags: params.tags,
          importance: params.importance,
          source: params.source,
          ttl: params.ttl,
        });
        return {
          content: [
            { type: "text", text: `Stored memory ${m.id.slice(0, 12)} (${params.memoryType})` },
          ],
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

  pi.registerTool({
    name: "memory_recall",
    label: "Recall Memory",
    description: "Search memory for relevant information using semantic text search",
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
    }),
    execute: async (
      _toolCallId: string,
      params,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<{ count: number }>> => {
      await initPromise;
      const type =
        params.memoryType === "all" ? undefined : (params.memoryType as CognitiveMemoryType);
      const results = await memory.recall(params.query, {
        type,
        limit: params.limit,
        tags: params.tags,
      });

      // Add evidence to pool (Task 3b)
      if (results.length > 0 && ctx) {
        for (const r of results.slice(0, 3)) {
          addEvidence(ctx, r.memory.content, "memory", r.memory.content, r.relevance);
        }
      }

      const text =
        results.length > 0
          ? `Found ${results.length} memories:\n` +
            results
              .map(
                (r) =>
                  `[${r.memory.type}] ${r.memory.content.slice(0, 80)}... (relevance: ${r.relevance.toFixed(1)}, id: ${r.memory.id})`,
              )
              .join("\n")
          : "No matching memories found.";
      return { content: [{ type: "text", text }], details: { count: results.length } };
    },
  });

  pi.registerTool({
    name: "memory_list",
    label: "List Memories",
    description: "List all stored memories (sorted by recency)",
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
      _ctx,
    ): Promise<AgentToolResult<{ memories: CognitiveMemoryEntry[] }>> => {
      const memories = memory.getAll(params.limit ?? 20);
      const showFull = params.full ?? false;
      const text =
        memories.length > 0
          ? memories.map((m) => `- ${formatMemoryEntry(m, showFull)}`).join("\n")
          : "No memories stored yet.";
      return {
        content: [{ type: "text", text }],
        details: { memories: memories as CognitiveMemoryEntry[] },
      };
    },
  });

  pi.registerTool({
    name: "memory_get",
    label: "Get Memory",
    description: "Get a specific memory by ID",
    parameters: Type.Object({
      id: Type.String({ description: "Memory ID to retrieve" }),
    }),
    execute: async (
      _toolCallId: string,
      params,
      _signal,
      _onUpdate,
      _ctx,
    ): Promise<AgentToolResult<{ found: boolean; memory?: CognitiveMemoryEntry }>> => {
      await initPromise;
      const m = await memory.getById(params.id);
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
    description: explorePathsTool.description,
    parameters: explorePathsTool.parameters,
    execute: explorePathsTool.execute,
  });

  // ── conflict_qa tool ──────────────────────────────────────────────────

  pi.registerTool({
    name: "conflict_qa",
    label: "Conflict QA",
    description:
      "View and resolve knowledge conflicts detected by the evidence pool. " +
      "Shows contradiction classification, resolution strategy, and source confidence.",
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
