/**
 * Cognitive Systems Extension
 *
 * Unified cognitive memory with semantic search and knowledge integration:
 * - memory_store/recall/list/get: Semantic memory management
 * - store_documentation/search_documentation: Documentation knowledge base
 * - store_pattern/search_patterns: Learned code patterns
 * - explore_paths: Parallel sub-agent exploration of hypotheses
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type CognitiveMemoryEntry,
	type CognitiveMemoryType,
	formatMemoryEntry,
	formatMemoryTimestamp,
	getCognitiveMemory,
} from "../../lib/cognitive-memory.js";
import { KnowledgeIntegration } from "../../lib/knowledge-integration.js";
import { createExplorePathsTool } from "../../tools/explore-paths.js";
import { createKnowledgeIntegrationTools } from "../../tools/knowledge-integration.js";

// Tool usage pattern tracking — lightweight, backed by cognitive memory
interface ToolPattern {
	toolName: string;
	argKeys: string[];
	successRate: number;
	usageCount: number;
	lastUsed: number;
}

const toolPatterns = new Map<string, ToolPattern>();

function learnToolPattern(toolName: string, args: Record<string, unknown>, success: boolean): void {
	const key = `${toolName}:${Object.keys(args).sort().join(",")}`;
	const existing = toolPatterns.get(key);
	if (existing) {
		existing.usageCount++;
		existing.successRate = (existing.successRate * (existing.usageCount - 1) + (success ? 1 : 0)) / existing.usageCount;
		existing.lastUsed = Date.now();
	} else {
		toolPatterns.set(key, {
			toolName,
			argKeys: Object.keys(args).sort(),
			successRate: success ? 1 : 0,
			usageCount: 1,
			lastUsed: Date.now(),
		});
	}
}

function getBestToolPatterns(limit = 5): ToolPattern[] {
	return Array.from(toolPatterns.values())
		.sort((a, b) => b.successRate - a.successRate || b.usageCount - a.usageCount)
		.slice(0, limit);
}

export default function cognitiveMemoryExtension(pi: ExtensionAPI) {
	const memory = getCognitiveMemory();

	pi.registerTool({
		name: "memory_store",
		label: "Store Memory",
		description:
			"Store information in long-term memory. Supports structured content (files, errors, solutions), memory linking, and TTL-based expiration.",
		parameters: Type.Object({
			content: Type.String({ description: "The information to remember (can be JSON for structured content)" }),
			memoryType: Type.Union([
				Type.Literal("insight", { description: "Key learning or realization" }),
				Type.Literal("pattern", { description: "Successful approach to reuse" }),
				Type.Literal("preference", { description: "User preference or tendency" }),
				Type.Literal("goal", { description: "Current objective" }),
				Type.Literal("error", { description: "Mistake to avoid" }),
				Type.Literal("episodic", { description: "Experience or event" }),
				Type.Literal("semantic", { description: "Factual knowledge" }),
				Type.Literal("procedural", { description: "How-to or process" }),
			]),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
			importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Importance 0-1" })),
			source: Type.Optional(Type.String({ description: "Where this came from" })),
			ttl: Type.Optional(Type.Number({ description: "Time-to-live in milliseconds", minimum: 0 })),
		}),
		execute: async (_toolCallId, params): Promise<AgentToolResult<{ id?: string; stored: boolean }>> => {
			try {
				const m = memory.store(params.content, params.memoryType as CognitiveMemoryType, {
					tags: params.tags,
					importance: params.importance,
					source: params.source,
					ttl: params.ttl,
				});
				return {
					content: [{ type: "text", text: `Stored memory ${m.id.slice(0, 12)} (${params.memoryType})` }],
					details: { id: m.id, stored: true },
				};
			} catch (e) {
				return {
					content: [{ type: "text", text: `Skipped: ${e instanceof Error ? e.message : "Unknown error"}` }],
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
				Type.Union([
					Type.Literal("insight"),
					Type.Literal("pattern"),
					Type.Literal("preference"),
					Type.Literal("goal"),
					Type.Literal("error"),
					Type.Literal("episodic"),
					Type.Literal("semantic"),
					Type.Literal("procedural"),
					Type.Literal("all"),
				]),
			),
			limit: Type.Optional(Type.Number({ default: 5 })),
			tags: Type.Optional(Type.Array(Type.String())),
		}),
		execute: async (_toolCallId, params): Promise<AgentToolResult<{ count: number }>> => {
			const type = params.memoryType === "all" ? undefined : (params.memoryType as CognitiveMemoryType);
			const results = memory.recall(params.query, { type, limit: params.limit, tags: params.tags });
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
			full: Type.Optional(Type.Boolean({ description: "Show full details including timestamps", default: false })),
		}),
		execute: async (_toolCallId, params): Promise<AgentToolResult<{ memories: CognitiveMemoryEntry[] }>> => {
			const memories = memory.getAll(params.limit ?? 20);
			const showFull = params.full ?? false;
			const text =
				memories.length > 0
					? memories.map((m) => `- ${formatMemoryEntry(m, showFull)}`).join("\n")
					: "No memories stored yet.";
			return { content: [{ type: "text", text }], details: { memories: memories as CognitiveMemoryEntry[] } };
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
			_toolCallId,
			params,
		): Promise<AgentToolResult<{ found: boolean; memory?: CognitiveMemoryEntry }>> => {
			const m = memory.getById(params.id);
			if (!m) {
				return { content: [{ type: "text", text: `Memory ${params.id} not found` }], details: { found: false } };
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

	// Knowledge integration tools
	const knowledge = new KnowledgeIntegration();
	const knowledgeTools = createKnowledgeIntegrationTools(knowledge);
	for (const tool of knowledgeTools) {
		pi.registerTool({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			execute: tool.execute,
		});
	}

	// Explore paths tool
	const explorePathsTool = createExplorePathsTool();
	pi.registerTool({
		name: explorePathsTool.name,
		label: explorePathsTool.label,
		description: explorePathsTool.description,
		parameters: explorePathsTool.parameters,
		execute: explorePathsTool.execute,
	});

	// Tool usage pattern tracking
	pi.registerTool({
		name: "tool_usage_patterns",
		label: "Tool Usage Patterns",
		description: "Get learned tool usage patterns — which tool+arg combinations work best. Tracked automatically from tool calls.",
		parameters: Type.Object({
			toolName: Type.Optional(Type.String({ description: "Filter by tool name" })),
			limit: Type.Optional(Type.Number({ description: "Max results (default 5)", default: 5 })),
		}),
		execute: async (_toolCallId, params) => {
			let patterns = params.toolName
				? Array.from(toolPatterns.values()).filter((p) => p.toolName === params.toolName)
				: getBestToolPatterns(params.limit ?? 5);

			if (patterns.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No tool usage patterns recorded yet." }],
					details: { count: 0, patterns: [] },
				};
			}

			const lines = patterns.map(
				(p) =>
					`- ${p.toolName}(${p.argKeys.join(", ")}): ${(p.successRate * 100).toFixed(0)}% success over ${p.usageCount} uses`,
			);

			return {
				content: [{ type: "text" as const, text: `Tool patterns:\n${lines.join("\n")}` }],
				details: { count: patterns.length, patterns },
			};
		},
	});
}
