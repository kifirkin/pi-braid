/**
 * Knowledge Integration Tools
 *
 * Provides tools for learning from documentation and code patterns.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { KnowledgeIntegration } from "../lib/knowledge-integration.js";

export function createKnowledgeIntegrationTools(knowledge: KnowledgeIntegration): AgentTool<any>[] {
	return [
		{
			name: "store_documentation",
			label: "Store Documentation",
			description: "Store documentation knowledge for future recall",
			parameters: Type.Object({
				url: Type.String({ description: "URL of the documentation" }),
				topic: Type.String({ description: "Topic or category of the documentation" }),
				content: Type.String({ description: "Content of the documentation" }),
				summary: Type.Optional(Type.String({ description: "Optional summary of the documentation" })),
			}),
			execute: async (_toolCallId, { url, topic, content, summary }) => {
				const doc = knowledge.storeDoc(
					url as string,
					topic as string,
					content as string,
					summary as string | undefined,
				);
				return {
					content: [{ type: "text", text: `Stored documentation: ${doc.topic}` }],
					details: { id: doc.id },
				};
			},
		},
		{
			name: "search_documentation",
			label: "Search Documentation",
			description: "Search documentation knowledge base",
			parameters: Type.Object({
				query: Type.String({ description: "What to search for" }),
				limit: Type.Optional(Type.Number({ description: "Maximum results to return", default: 5 })),
			}),
			execute: async (_toolCallId, { query, limit }) => {
				const results = knowledge.searchDocs(query as string);
				const truncated = limit ? results.slice(0, limit as number) : results;
				return {
					content: [{ type: "text", text: `Found ${results.length} results (${truncated.length} shown)` }],
					details: { results: truncated, total: results.length },
				};
			},
		},
		{
			name: "get_by_topic",
			label: "Get by Topic",
			description: "Get all documentation for a specific topic",
			parameters: Type.Object({
				topic: Type.String({ description: "Topic to search for" }),
			}),
			execute: async (_toolCallId, { topic }) => {
				const docs = knowledge.getByTopic(topic as string);
				return {
					content: [{ type: "text", text: `Found ${docs.length} docs for ${topic}` }],
					details: { docs },
				};
			},
		},
		{
			name: "store_pattern",
			label: "Store Pattern",
			description: "Store a learned code pattern",
			parameters: Type.Object({
				repoUrl: Type.String({ description: "URL of the repository" }),
				pattern: Type.String({ description: "Pattern description" }),
				description: Type.String({ description: "Detailed description of the pattern" }),
				examples: Type.Array(Type.String(), { description: "Example code snippets" }),
				filePaths: Type.Array(Type.String(), { description: "File paths where pattern was found" }),
			}),
			execute: async (_toolCallId, { repoUrl, pattern, description, examples, filePaths }) => {
				const p = knowledge.storePattern(
					repoUrl as string,
					pattern as string,
					description as string,
					examples as string[],
					filePaths as string[],
				);
				return {
					content: [{ type: "text", text: `Stored pattern: ${p.pattern}` }],
					details: { id: p.id },
				};
			},
		},
		{
			name: "search_patterns",
			label: "Search Patterns",
			description: "Search learned patterns",
			parameters: Type.Object({
				query: Type.String({ description: "What to search for" }),
			}),
			execute: async (_toolCallId, { query }) => {
				const patterns = knowledge.searchPatterns(query as string);
				return {
					content: [{ type: "text", text: `Found ${patterns.length} patterns` }],
					details: { patterns },
				};
			},
		},
		{
			name: "get_patterns_by_repo",
			label: "Get Patterns by Repo",
			description: "Get all patterns for a repository",
			parameters: Type.Object({
				repoUrl: Type.String({ description: "Repository URL" }),
			}),
			execute: async (_toolCallId, { repoUrl }) => {
				const patterns = knowledge.getPatternsByRepo(repoUrl as string);
				return {
					content: [{ type: "text", text: `Found ${patterns.length} patterns` }],
					details: { patterns },
				};
			},
		},
		{
			name: "get_all_docs",
			label: "Get All Docs",
			description: "Get all stored documentation",
			parameters: Type.Object({}),
			execute: async (_toolCallId) => {
				const docs = knowledge.getAllDocs();
				return {
					content: [{ type: "text", text: `Found ${docs.length} documentation entries` }],
					details: { docs },
				};
			},
		},
		{
			name: "get_all_patterns",
			label: "Get All Patterns",
			description: "Get all learned patterns",
			parameters: Type.Object({}),
			execute: async (_toolCallId) => {
				const patterns = knowledge.getAllPatterns();
				return {
					content: [{ type: "text", text: `Found ${patterns.length} patterns` }],
					details: { patterns },
				};
			},
		},
		{
			name: "export_to_markdown",
			label: "Export to Markdown",
			description: "Export all knowledge to markdown format",
			parameters: Type.Object({}),
			execute: async (_toolCallId) => {
				const md = knowledge.exportToMarkdown();
				return {
					content: [{ type: "text", text: `Exported knowledge (length: ${md.length} chars)` }],
					details: { content: md },
				};
			},
		},
		{
			name: "get_knowledge_summary",
			label: "Get Knowledge Summary",
			description: "Get summary of knowledge integration state",
			parameters: Type.Object({}),
			execute: async (_toolCallId) => {
				const summary = knowledge.getSummary();
				return {
					content: [
						{
							type: "text",
							text: `Doc count: ${summary.docCount}, pattern count: ${summary.patternCount}, topics: ${summary.topics.join(", ")}`,
						},
					],
					details: summary,
				};
			},
		},
	];
}
