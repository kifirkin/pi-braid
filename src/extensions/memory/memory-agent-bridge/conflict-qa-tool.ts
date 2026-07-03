/**
 * conflict_qa tool - View and resolve knowledge conflicts from evidence pool
 *
 * Extracted from memory-agent-bridge/index.ts for cleaner separation of concerns.
 * Self-contained: createConflictQATool() returns a tool descriptor with
 * 4 actions: list, stats, resolve, search.
 */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { textResult } from "../../../lib/utils/extension-utils.js";
import {
  getPendingQAs as getPendingConflictQAs,
  resolveQA as resolveConflictQA,
  getQAStats as getConflictQAStats,
  getRelevantQA,
} from "../../../lib/store/conflict-qa.js";

interface ConflictQAToolDesc {
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
    ctx: ExtensionContext,
  ) => Promise<AgentToolResult<unknown>>;
}

export function createConflictQATool(): ConflictQAToolDesc {
  return {
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
    execute: async (
      _toolCallId: string,
      params: { action: string; qa_id?: string; verdict?: string; topic?: string },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> => {
      const { action, qa_id, verdict, topic } = params;

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
        return textResult(`Conflict QA resolved: ${qa_id} -> "${verdict}"`);
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
  };
}