/**
 * Cognitive Systems Extension
 *
 * Unified cognitive memory with semantic search:
 * - memory_store/recall/list/get: Semantic memory management
 * - explore_paths: Parallel sub-agent exploration of hypotheses
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type CognitiveMemoryEntry,
	type CognitiveMemoryType,
	formatMemoryEntry,
	formatMemoryTimestamp,
	getCognitiveMemory,
} from "../../lib/cognitive-memory.js";
// explore-paths tool - inlined from ../../tools/explore-paths.ts

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function findFile(pattern: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("find", [".", "-name", pattern, "-type", "f"], {
			timeout: 5000,
		});
		return stdout.trim();
	} catch {
		return "";
	}
}

async function readFileHead(path: string, lines = 20): Promise<string> {
	try {
		const { stdout } = await execFileAsync("head", [`-${lines}`, path], {
			timeout: 5000,
		});
		return stdout;
	} catch {
		return "(could not read preview)";
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
				description: "First potential root cause location: 'The bug might be in FILE because REASON'",
			}),
			hypothesis_2: Type.String({
				description: "Second potential root cause location: 'The bug might be in OTHER_FILE because REASON'",
			}),
			hypothesis_3: Type.Optional(
				Type.String({
					description:
						"Third potential root cause location (optional): 'The bug might be in ANOTHER_FILE because REASON'",
				}),
			),
		}),

		execute: async (_toolCallId: string, params: unknown) => {
			const { hypothesis_1, hypothesis_2, hypothesis_3 } = params as {
				hypothesis_1: string;
				hypothesis_2: string;
				hypothesis_3?: string;
			};

			const results: string[] = [];
			const hypotheses = [hypothesis_1, hypothesis_2];
			if (hypothesis_3) hypotheses.push(hypothesis_3);

			const explorations = hypotheses.map(async (hyp, i) => {
				const localResults: string[] = [];
				const fileMatch = hyp.match(/(?:in|file)\s+([^\s]+\.\w+)/i);
				const file = fileMatch ? fileMatch[1] : "unknown";

				localResults.push(`### Hypothesis ${i + 1}: ${hyp.substring(0, 100)}...`);
				localResults.push(`Target file: ${file}`);

				const foundPath = await findFile(file);
				if (foundPath) {
					localResults.push(`✅ Found: ${foundPath}`);
					const preview = await readFileHead(foundPath);
					localResults.push(`Preview:\n${preview.substring(0, 500)}`);
				} else {
					localResults.push("❌ File not found");
				}
				localResults.push("");
				return localResults;
			});

			const allResults = await Promise.all(explorations);
			for (const r of allResults) {
				results.push(...r);
			}

			results.push("**Next steps:**");
			results.push("1. Review the evidence above");
			results.push("2. Identify which hypothesis has supporting evidence");
			results.push("3. Trace the code path for the most likely hypothesis");
			results.push("4. Propose a PROPER fix (no shortcuts, no technical debt)");
			results.push("");
			results.push("**Quality requirement:** All solutions must be well-designed and maintainable.");

			return {
				details: {},
				content: [
					{
						type: "text" as const,
						text: results.join("\n"),
					},
				],
			};
		},
	};
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
			memoryType: StringEnum(
				["insight", "pattern", "preference", "goal", "error", "episodic", "semantic", "procedural"],
			),
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
				StringEnum(
					["insight", "pattern", "preference", "goal", "error", "episodic", "semantic", "procedural", "all"],
				),
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

	// Explore paths tool (inlined)
	const explorePathsTool = createExplorePathsTool();
	pi.registerTool({
		name: explorePathsTool.name,
		label: explorePathsTool.label,
		description: explorePathsTool.description,
		parameters: explorePathsTool.parameters,
		execute: explorePathsTool.execute,
	});

}
