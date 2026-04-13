/**
 * Tool Discovery & Learning System
 *
 * Based on: docs/analysis/SUPER_AGENT_GAP_ANALYSIS.md (Gap 5 - HIGH)
 * Provides tool pattern learning, composition, and external API discovery.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ToolPattern {
	toolName: string;
	commonArgs: Record<string, unknown>;
	typicalContext: string;
	successRate: number;
	usageCount: number;
	lastUsed: number;
}

export interface ComposedTool {
	id: string;
	name: string;
	description: string;
	steps: ComposedStep[];
	createdAt: number;
	usageCount: number;
}

export interface ComposedStep {
	tool: string;
	args: Record<string, unknown>;
	condition?: string; // Optional condition for conditional execution
}

export interface DiscoveredAPI {
	id: string;
	name: string;
	url: string;
	tools: DiscoveredAPITool[];
	discoveredAt: number;
}

export interface DiscoveredAPITool {
	name: string;
	path: string;
	method: string;
	parameters: Array<{
		name: string;
		type: string;
		required: boolean;
		description?: string;
	}>;
}

export interface ToolLearnerState {
	patterns: ToolPattern[];
	composedTools: ComposedTool[];
	discoveredAPIs: DiscoveredAPI[];
	version: number;
}

export class ToolLearner {
	private patterns = new Map<string, ToolPattern>();
	private composedTools = new Map<string, ComposedTool>();
	private discoveredAPIs = new Map<string, DiscoveredAPI>();
	private storagePath: string | null = null;

	/**
	 * Initialize tool learner with optional persistence
	 */
	initialize(storageDir?: string): void {
		if (storageDir) {
			this.storagePath = join(storageDir, "tool-learner.json");
			this.load();
		}
	}

	/**
	 * Learn from successful tool execution
	 */
	learnPattern(toolName: string, args: Record<string, unknown>, context: string): void {
		const key = `${toolName}:${JSON.stringify(Object.keys(args).sort())}`;
		const existing = this.patterns.get(key);

		if (existing) {
			// Update existing pattern
			existing.usageCount++;
			existing.successRate = (existing.successRate * (existing.usageCount - 1) + 1) / existing.usageCount;
			existing.lastUsed = Date.now();
			// Merge common args (keep most common values)
			for (const [k, v] of Object.entries(args)) {
				if (existing.commonArgs[k] === undefined) {
					existing.commonArgs[k] = v;
				}
			}
		} else {
			// Create new pattern
			const pattern: ToolPattern = {
				toolName,
				commonArgs: { ...args },
				typicalContext: context.slice(0, 200), // Limit context size
				successRate: 1.0,
				usageCount: 1,
				lastUsed: Date.now(),
			};
			this.patterns.set(key, pattern);
		}

		this.save();
	}

	/**
	 * Get learned patterns for a tool
	 */
	getPatterns(toolName?: string): ToolPattern[] {
		const patterns = Array.from(this.patterns.values());
		if (toolName) {
			return patterns.filter((p) => p.toolName === toolName);
		}
		return patterns;
	}

	/**
	 * Get most successful patterns
	 */
	getBestPatterns(limit = 5): ToolPattern[] {
		return Array.from(this.patterns.values())
			.sort((a, b) => b.successRate - a.successRate)
			.slice(0, limit);
	}

	/**
	 * Create a composed tool from multiple steps
	 */
	composeTool(name: string, description: string, steps: ComposedStep[]): ComposedTool {
		const id = `composed-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
		const tool: ComposedTool = {
			id,
			name,
			description,
			steps,
			createdAt: Date.now(),
			usageCount: 0,
		};
		this.composedTools.set(id, tool);
		this.save();
		return tool;
	}

	/**
	 * Get a composed tool by ID
	 */
	getComposedTool(id: string): ComposedTool | undefined {
		return this.composedTools.get(id);
	}

	/**
	 * List all composed tools
	 */
	listComposedTools(): ComposedTool[] {
		return Array.from(this.composedTools.values()).sort((a, b) => b.usageCount - a.usageCount);
	}

	/**
	 * Record usage of a composed tool
	 */
	recordComposedToolUsage(id: string): void {
		const tool = this.composedTools.get(id);
		if (tool) {
			tool.usageCount++;
			this.save();
		}
	}

	/**
	 * Delete a composed tool
	 */
	deleteComposedTool(id: string): boolean {
		const deleted = this.composedTools.delete(id);
		if (deleted) this.save();
		return deleted;
	}

	/**
	 * Discover tools from an OpenAPI spec
	 */
	discoverFromOpenAPI(url: string, name: string, spec: unknown): DiscoveredAPI {
		const id = `api-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

		// Parse OpenAPI spec and extract tools
		const tools = this.parseOpenAPISpec(spec);

		const api: DiscoveredAPI = {
			id,
			name,
			url,
			tools,
			discoveredAt: Date.now(),
		};

		this.discoveredAPIs.set(id, api);
		this.save();
		return api;
	}

	/**
	 * Parse OpenAPI spec and extract tool definitions
	 */
	private parseOpenAPISpec(spec: unknown): DiscoveredAPITool[] {
		const tools: DiscoveredAPITool[] = [];

		try {
			const s = spec as {
				paths?: Record<
					string,
					Record<
						string,
						{
							summary?: string;
							parameters?: Array<{
								name: string;
								in: string;
								schema?: { type?: string };
								required?: boolean;
								description?: string;
							}>;
						}
					>
				>;
			};

			for (const [path, methods] of Object.entries(s.paths || {})) {
				for (const [method, operation] of Object.entries(methods)) {
					if (typeof operation !== "object" || operation === null) continue;

					const parameters =
						operation.parameters
							?.filter((p) => p.in === "query" || p.in === "path")
							.map((p) => ({
								name: p.name,
								type: p.schema?.type || "string",
								required: p.required ?? false,
								description: p.description,
							})) || [];

					tools.push({
						name: operation.summary || `${method} ${path}`,
						path,
						method: method.toUpperCase(),
						parameters,
					});
				}
			}
		} catch {
			// Return empty if parsing fails
		}

		return tools;
	}

	/**
	 * Get discovered APIs
	 */
	getDiscoveredAPIs(): DiscoveredAPI[] {
		return Array.from(this.discoveredAPIs.values()).sort((a, b) => b.discoveredAt - a.discoveredAt);
	}

	/**
	 * Get a discovered API by ID
	 */
	getDiscoveredAPI(id: string): DiscoveredAPI | undefined {
		return this.discoveredAPIs.get(id);
	}

	/**
	 * Get state summary
	 */
	getSummary(): {
		patternCount: number;
		composedToolCount: number;
		discoveredAPICount: number;
		topPatterns: ToolPattern[];
	} {
		return {
			patternCount: this.patterns.size,
			composedToolCount: this.composedTools.size,
			discoveredAPICount: this.discoveredAPIs.size,
			topPatterns: this.getBestPatterns(3),
		};
	}

	/**
	 * Get full state
	 */
	getState(): ToolLearnerState {
		return {
			patterns: Array.from(this.patterns.values()),
			composedTools: Array.from(this.composedTools.values()),
			discoveredAPIs: Array.from(this.discoveredAPIs.values()),
			version: 1,
		};
	}

	private save(): void {
		if (!this.storagePath) return;

		try {
			const dir = dirname(this.storagePath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}

			const state: ToolLearnerState = {
				patterns: Array.from(this.patterns.values()),
				composedTools: Array.from(this.composedTools.values()),
				discoveredAPIs: Array.from(this.discoveredAPIs.values()),
				version: 1,
			};

			writeFileSync(this.storagePath, JSON.stringify(state, null, 2));
		} catch {
			// Silent fail
		}
	}

	private load(): void {
		if (!this.storagePath) return;
		if (!existsSync(this.storagePath)) return;

		try {
			const data = readFileSync(this.storagePath, "utf-8");
			const loaded = JSON.parse(data) as ToolLearnerState;

			// Restore patterns
			this.patterns.clear();
			for (const pattern of loaded.patterns || []) {
				const key = `${pattern.toolName}:${JSON.stringify(Object.keys(pattern.commonArgs).sort())}`;
				this.patterns.set(key, pattern);
			}

			// Restore composed tools
			this.composedTools.clear();
			for (const tool of loaded.composedTools || []) {
				this.composedTools.set(tool.id, tool);
			}

			// Restore discovered APIs
			this.discoveredAPIs.clear();
			for (const api of loaded.discoveredAPIs || []) {
				this.discoveredAPIs.set(api.id, api);
			}
		} catch {
			// Silent fail - use defaults
		}
	}
}
