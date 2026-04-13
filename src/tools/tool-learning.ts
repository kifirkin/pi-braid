/**
 * Tool Learning Tools
 *
 * Provides tools for dynamic tool loading and usage pattern analysis.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ToolLearner } from "../lib/tool-learner.js";

export function createToolLearningTools(learner: ToolLearner): AgentTool<any>[] {
	return [
		{
			name: "learn_pattern",
			label: "Learn Pattern",
			description: "Learn from a successful tool execution",
			parameters: Type.Object({
				toolName: Type.String({ description: "Name of the tool that was executed" }),
				args: Type.Record(Type.String(), Type.Any(), { description: "Arguments passed to the tool" }),
				context: Type.String({ description: "Context of how this tool was used" }),
			}),
			execute: async (_toolCallId, { toolName, args, context }) => {
				learner.learnPattern(toolName as string, args as Record<string, unknown>, context as string);
				return {
					content: [{ type: "text", text: `Learned pattern for ${toolName}` }],
					details: { success: true },
				};
			},
		},
		{
			name: "get_patterns",
			label: "Get Patterns",
			description: "Get learned patterns",
			parameters: Type.Object({
				toolName: Type.Optional(Type.String({ description: "Optional: filter by tool name" })),
			}),
			execute: async (_toolCallId, { toolName }) => {
				const patterns = learner.getPatterns(toolName as string | undefined);
				return {
					content: [{ type: "text", text: `Found ${patterns.length} patterns` }],
					details: { patterns },
				};
			},
		},
		{
			name: "get_best_patterns",
			label: "Get Best Patterns",
			description: "Get the most successful patterns",
			parameters: Type.Object({
				limit: Type.Optional(Type.Number({ description: "Maximum number to return", default: 5 })),
			}),
			execute: async (_toolCallId, { limit }) => {
				const patterns = learner.getBestPatterns(limit as number);
				return {
					content: [{ type: "text", text: `Found ${patterns.length} best patterns` }],
					details: { patterns },
				};
			},
		},
		{
			name: "compose_tool",
			label: "Compose Tool",
			description: "Create a composed tool from multiple steps",
			parameters: Type.Object({
				name: Type.String({ description: "Name for the composed tool" }),
				description: Type.String({ description: "Description of what the composed tool does" }),
				steps: Type.Array(
					Type.Object({
						tool: Type.String(),
						args: Type.Record(Type.String(), Type.Any()),
						condition: Type.Optional(Type.String()),
					}),
					{ description: "Steps to compose" },
				),
			}),
			execute: async (_toolCallId, { name, description, steps }) => {
				const tool = learner.composeTool(name as string, description as string, steps as any[]);
				return {
					content: [{ type: "text", text: `Composed tool created: ${tool.name}` }],
					details: { id: tool.id },
				};
			},
		},
		{
			name: "get_composed_tools",
			label: "Get Composed Tools",
			description: "Get list of all composed tools",
			parameters: Type.Object({}),
			execute: async (_toolCallId) => {
				const tools = learner.listComposedTools();
				return {
					content: [{ type: "text", text: `Found ${tools.length} composed tools` }],
					details: { tools },
				};
			},
		},
		{
			name: "discover_api",
			label: "Discover API",
			description: "Discover tools from an OpenAPI spec",
			parameters: Type.Object({
				url: Type.String({ description: "URL to OpenAPI spec" }),
				name: Type.String({ description: "Name for the discovered API" }),
				spec: Type.Object({
					paths: Type.Optional(Type.Record(Type.String(), Type.Any())),
				}),
			}),
			execute: async (_toolCallId, { url, name, spec }) => {
				const api = learner.discoverFromOpenAPI(url as string, name as string, spec as unknown);
				return {
					content: [{ type: "text", text: `Discovered API with ${api.tools.length} tools` }],
					details: { id: api.id },
				};
			},
		},
		{
			name: "get_discovered_apis",
			label: "Get Discovered APIs",
			description: "Get list of all discovered APIs",
			parameters: Type.Object({}),
			execute: async (_toolCallId) => {
				const apis = learner.getDiscoveredAPIs();
				return {
					content: [{ type: "text", text: `Found ${apis.length} discovered APIs` }],
					details: { apis },
				};
			},
		},
		{
			name: "get_learner_summary",
			label: "Get Learner Summary",
			description: "Get summary of tool learning state",
			parameters: Type.Object({}),
			execute: async (_toolCallId) => {
				const summary = learner.getSummary();
				return {
					content: [
						{
							type: "text",
							text: `Pattern count: ${summary.patternCount}, composed tools: ${summary.composedToolCount}, discovered APIs: ${summary.discoveredAPICount}`,
						},
					],
					details: summary,
				};
			},
		},
	];
}
