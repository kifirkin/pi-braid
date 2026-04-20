/**
 * Three Memory Stores Extension
 *
 * Paper: 2604.14475 Evo-MedAgent
 * Key finding: Three complementary stores (Episodes + Heuristics + ToolReliability)
 * outperform single memory. MCQ accuracy 0.68 → 0.79.
 *
 * Architecture:
 * 1. Retrospective Episodes — case-based reasoning from past tasks
 * 2. Adaptive Procedural Heuristics — priority-tagged rules that evolve
 * 3. Tool Reliability Controller — per-tool trustworthiness tracking
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { createLogger } from "../../lib/logger.js";
import { getExtensionState } from "../../lib/extension-state.js";

const log = createLogger("three-memory-stores");

// ── Types ────────────────────────────────────────────────────────────────────

export interface Episode {
	id: string;
	task: string;
	solution: string;
	outcome: "success" | "failure" | "partial";
	similarity: number;
	timestamp: number;
	toolSequence: string[];
	tags: string[];
}

export interface HeuristicRule {
	id: string;
	condition: string;
	action: string;
	priority: number;
	successRate: number;
	uses: number;
	successes: number;
	lastUsed: number;
	created: number;
}

export interface ToolStat {
	tool: string;
	taskType: string;
	attempts: number;
	successes: number;
	lastAttempt: number;
	avgDuration: number;
}

interface MemoryStoresState {
	episodes: Episode[];
	heuristics: HeuristicRule[];
	toolStats: Map<string, ToolStat>;
	currentSessionTools: string[];
	sessionStartTime: number;
}

// ── Factory ──────────────────────────────────────────────────────────────────

function createMemoryStoresState(): MemoryStoresState {
	return {
		episodes: [],
		heuristics: [],
		toolStats: new Map(),
		currentSessionTools: [],
		sessionStartTime: Date.now(),
	};
}

function getState(ctx: ExtensionContext): MemoryStoresState {
	return getExtensionState(ctx, "three-memory-stores", createMemoryStoresState);
}

// ── Episode Store ────────────────────────────────────────────────────────────

function addEpisode(
	state: MemoryStoresState,
	task: string,
	solution: string,
	outcome: Episode["outcome"],
	toolSequence: string[],
	tags: string[] = [],
): Episode {
	const episode: Episode = {
		id: `ep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		task,
		solution,
		outcome,
		similarity: 0,
		timestamp: Date.now(),
		toolSequence,
		tags,
	};
	state.episodes.push(episode);

	// Prune if over limit
	if (state.episodes.length > 500) {
		pruneEpisodes(state);
	}

	log.debug(`Added episode: "${task.slice(0, 50)}..." (${outcome})`);
	return episode;
}

function retrieveEpisodes(
	state: MemoryStoresState,
	query: string,
	limit: number = 3,
): Episode[] {
	const queryLower = query.toLowerCase();
	const scored = state.episodes
		.map((ep) => ({
			ep,
			score: computeSimilarity(queryLower, ep),
		}))
		.filter((s) => s.score > 0.1)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);

	return scored.map((s) => ({ ...s.ep, similarity: s.score }));
}

function computeSimilarity(query: string, episode: Episode): number {
	const queryWords = new Set(query.split(/\s+/).filter((w) => w.length > 2));
	if (queryWords.size === 0) return 0;

	const taskWords = new Set(episode.task.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
	const solutionWords = new Set(episode.solution.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
	const tagWords = new Set(episode.tags.flatMap((t) => t.toLowerCase().split(/\s+/)).filter((w) => w.length > 2));

	let matches = 0;
	for (const word of queryWords) {
		if (taskWords.has(word)) matches += 3;
		if (solutionWords.has(word)) matches += 1;
		if (tagWords.has(word)) matches += 2;
	}

	return matches / (queryWords.size * 3);
}

function pruneEpisodes(state: MemoryStoresState): void {
	const outcomeScore = (ep: Episode) =>
		(ep.outcome === "success" ? 2 : ep.outcome === "partial" ? 1 : 0) * 0.5 +
		Math.max(0, 1 - (Date.now() - ep.timestamp) / (30 * 24 * 60 * 60 * 1000)) * 0.5;

	state.episodes
		.map((ep) => ({ ep, score: outcomeScore(ep) }))
		.sort((a, b) => a.score - b.score);

	state.episodes = state.episodes.slice(-500);
}

// ── Heuristics Store ─────────────────────────────────────────────────────────

function addHeuristicRule(
	state: MemoryStoresState,
	condition: string,
	action: string,
	initialPriority: number = 0.5,
): HeuristicRule {
	const rule: HeuristicRule = {
		id: `hr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		condition,
		action,
		priority: initialPriority,
		successRate: 0.5,
		uses: 0,
		successes: 0,
		lastUsed: 0,
		created: Date.now(),
	};
	state.heuristics.push(rule);
	log.debug(`Added heuristic: "${condition.slice(0, 50)}..."`);
	return rule;
}

function evolveHeuristic(
	state: MemoryStoresState,
	ruleId: string,
	success: boolean,
): void {
	const rule = state.heuristics.find((r) => r.id === ruleId);
	if (!rule) return;

	rule.uses++;
	if (success) rule.successes++;
	rule.successRate = rule.successes / rule.uses;
	rule.priority = calculateHeuristicPriority(rule);
	rule.lastUsed = Date.now();
}

function calculateHeuristicPriority(rule: HeuristicRule): number {
	const successComponent = rule.successRate * 0.6;
	const recencyComponent =
		Math.max(0, 1 - (Date.now() - rule.lastUsed) / (7 * 24 * 60 * 60 * 1000)) * 0.2;
	const usageComponent = Math.min(rule.uses / 10, 1) * 0.2;
	return successComponent + recencyComponent + usageComponent;
}

function getPrioritizedHeuristics(state: MemoryStoresState): HeuristicRule[] {
	return [...state.heuristics].sort((a, b) => b.priority - a.priority);
}

function getApplicableHeuristics(
	state: MemoryStoresState,
	context: string,
): HeuristicRule[] {
	const contextLower = context.toLowerCase();
	return state.heuristics
		.filter((r) => contextLower.includes(r.condition.toLowerCase()))
		.sort((a, b) => b.priority - a.priority);
}

// ── Tool Reliability Controller ──────────────────────────────────────────────

function recordToolCall(
	state: MemoryStoresState,
	tool: string,
	taskType: string,
	success: boolean,
	duration: number = 0,
): void {
	const key = `${tool}:${taskType}`;
	let stat = state.toolStats.get(key);

	if (!stat) {
		stat = { tool, taskType, attempts: 0, successes: 0, lastAttempt: 0, avgDuration: 0 };
		state.toolStats.set(key, stat);
	}

	stat.attempts++;
	if (success) stat.successes++;
	stat.lastAttempt = Date.now();
	stat.avgDuration = stat.avgDuration === 0 ? duration : (stat.avgDuration + duration) / 2;
}

function getToolReliability(
	state: MemoryStoresState,
	tool: string,
	taskType: string,
): number {
	const stat = state.toolStats.get(`${tool}:${taskType}`);
	if (!stat || stat.attempts === 0) return 0.5;
	return stat.successes / stat.attempts;
}

function selectBestTool(
	state: MemoryStoresState,
	taskType: string,
	candidates: string[],
): string | null {
	let bestTool: string | null = null;
	let bestReliability = -1;

	for (const tool of candidates) {
		const reliability = getToolReliability(state, tool, taskType);
		if (reliability > bestReliability) {
			bestReliability = reliability;
			bestTool = tool;
		}
	}

	return bestTool;
}

// ── Built-in Heuristic Rules ─────────────────────────────────────────────────

const BUILTIN_HEURISTICS = [
	{
		condition: "think before write",
		action: "Always use think tool before write tool for complex changes",
		priority: 0.8,
	},
	{
		condition: "test after edit",
		action: "Run tests after modifying code files",
		priority: 0.7,
	},
	{
		condition: "read before edit",
		action: "Read file contents before editing to understand context",
		priority: 0.9,
	},
	{
		condition: "small changes first",
		action: "Make incremental changes and verify each step",
		priority: 0.6,
	},
];

// ── Extension ────────────────────────────────────────────────────────────────

export default function threeMemoryStoresExtension(pi: ExtensionAPI) {
	// ── memory_episodes tool ────────────────────────────────────────────

	pi.registerTool({
		name: "memory_episodes",
		label: "Memory Episodes",
		description:
			"Search retrospective episodes for similar past tasks. Returns relevant past solutions and outcomes.",
		parameters: Type.Object({
			action: StringEnum(["search", "add", "list"]),
			query: Type.Optional(
				Type.String({ description: "Task description to search for (search action)" }),
			),
			task: Type.Optional(
				Type.String({ description: "Task description (add action)" }),
			),
			solution: Type.Optional(
				Type.String({ description: "Solution description (add action)" }),
			),
			outcome: Type.Optional(
				StringEnum(["success", "failure", "partial"], {
					description: "Outcome of the task (add action)",
				}),
			),
			limit: Type.Optional(
				Type.Number({ description: "Max results (default: 3)", default: 3 }),
			),
			tags: Type.Optional(
				Type.Array(Type.String(), { description: "Tags for the episode (add action)" }),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const state = getState(ctx);
			const { action, query, task, solution, outcome, limit = 3, tags = [] } = params as any;

			if (action === "search") {
				if (!query) return "Error: query is required for search action";
				const episodes = retrieveEpisodes(state, query, limit);
				if (episodes.length === 0) return "No relevant episodes found.";

				const lines: string[] = [`Found ${episodes.length} relevant episodes:\n`];
				for (const ep of episodes) {
					const outcomeIcon = ep.outcome === "success" ? "✅" : ep.outcome === "failure" ? "❌" : "⚠️";
					lines.push(`${outcomeIcon} [${ep.outcome}] ${ep.task}`);
					lines.push(`   Solution: ${ep.solution.slice(0, 200)}${ep.solution.length > 200 ? "..." : ""}`);
					lines.push(`   Tools: ${ep.toolSequence.join(" → ")}`);
					lines.push(`   Similarity: ${(ep.similarity * 100).toFixed(0)}%`);
					lines.push("");
				}
				return lines.join("\n");
			}

			if (action === "add") {
				if (!task || !solution || !outcome) {
					return "Error: task, solution, and outcome are required for add action";
				}
				const episode = addEpisode(state, task, solution, outcome as any, [], tags);
				return `Episode added: "${task.slice(0, 50)}..." (${outcome}) [${episode.id}]`;
			}

			if (action === "list") {
				if (state.episodes.length === 0) return "No episodes stored.";
				const lines: string[] = [`Episodes (${state.episodes.length} total):\n`];
				const recent = state.episodes.slice(-10).reverse();
				for (const ep of recent) {
					const outcomeIcon = ep.outcome === "success" ? "✅" : ep.outcome === "failure" ? "❌" : "⚠️";
					lines.push(`${outcomeIcon} ${ep.task.slice(0, 60)}...`);
				}
				return lines.join("\n");
			}

			return `Unknown action: ${action}. Use search, add, or list.`;
		},
	});

	// ── memory_heuristics tool ──────────────────────────────────────────

	pi.registerTool({
		name: "memory_heuristics",
		label: "Memory Heuristics",
		description:
			"View and manage adaptive procedural heuristics. Returns prioritized rules for the current context.",
		parameters: Type.Object({
			action: StringEnum(["list", "add", "evolve"]),
			context: Type.Optional(
				Type.String({ description: "Current context to match rules against (list action)" }),
			),
			condition: Type.Optional(
				Type.String({ description: "Rule condition pattern (add action)" }),
			),
			action_text: Type.Optional(
				Type.String({ description: "Rule action description (add action)" }),
			),
			rule_id: Type.Optional(
				Type.String({ description: "Rule ID to evolve (evolve action)" }),
			),
			success: Type.Optional(
				Type.Boolean({ description: "Whether the rule application succeeded (evolve action)" }),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const state = getState(ctx);
			const { action, context, condition, action_text, rule_id, success } = params as any;

			if (action === "list") {
				const rules = context
					? getApplicableHeuristics(state, context)
					: getPrioritizedHeuristics(state);

				if (rules.length === 0) return "No heuristics found.";

				const lines: string[] = [`Heuristics (${rules.length} total):\n`];
				for (const rule of rules) {
					lines.push(`[${rule.priority.toFixed(2)}] ${rule.condition}`);
					lines.push(`   → ${rule.action}`);
					lines.push(`   Success rate: ${(rule.successRate * 100).toFixed(0)}% (${rule.uses} uses)`);
					lines.push("");
				}
				return lines.join("\n");
			}

			if (action === "add") {
				if (!condition || !action_text) {
					return "Error: condition and action_text are required for add action";
				}
				const rule = addHeuristicRule(state, condition, action_text);
				return `Heuristic added: "${condition}" → "${action_text}" [${rule.id}]`;
			}

			if (action === "evolve") {
				if (!rule_id || success === undefined) {
					return "Error: rule_id and success are required for evolve action";
				}
				evolveHeuristic(state, rule_id, success);
				return `Heuristic evolved: ${rule_id} (success: ${success})`;
			}

			return `Unknown action: ${action}. Use list, add, or evolve.`;
		},
	});

	// ── memory_tool_stats tool ──────────────────────────────────────────

	pi.registerTool({
		name: "memory_tool_stats",
		label: "Memory Tool Stats",
		description:
			"View tool reliability statistics. Shows success rates per tool per task type.",
		parameters: Type.Object({
			action: StringEnum(["list", "reliability", "best"]),
			tool: Type.Optional(
				Type.String({ description: "Tool name (reliability action)" }),
			),
			task_type: Type.Optional(
				Type.String({ description: "Task type (reliability/best action)" }),
			),
			candidates: Type.Optional(
				Type.Array(Type.String(), { description: "Candidate tools (best action)" }),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const state = getState(ctx);
			const { action, tool, task_type, candidates } = params as any;

			if (action === "list") {
				if (state.toolStats.size === 0) return "No tool stats recorded.";

				const lines: string[] = ["Tool Reliability Stats:\n"];
				for (const stat of state.toolStats.values()) {
					const rate = stat.attempts > 0 ? ((stat.successes / stat.attempts) * 100).toFixed(0) : "N/A";
					lines.push(`${stat.tool} (${stat.taskType}): ${rate}% success (${stat.attempts} attempts)`);
				}
				return lines.join("\n");
			}

			if (action === "reliability") {
				if (!tool || !task_type) return "Error: tool and task_type are required";
				const reliability = getToolReliability(state, tool, task_type);
				return `${tool} reliability for "${task_type}": ${(reliability * 100).toFixed(0)}%`;
			}

			if (action === "best") {
				if (!task_type || !candidates || candidates.length === 0) {
					return "Error: task_type and candidates are required";
				}
				const best = selectBestTool(state, task_type, candidates);
				if (!best) return "No tool stats available for candidates";
				const reliability = getToolReliability(state, best, task_type);
				return `Best tool for "${task_type}": ${best} (${(reliability * 100).toFixed(0)}% reliability)`;
			}

			return `Unknown action: ${action}. Use list, reliability, or best.`;
		},
	});

	// ── Event: session_start ────────────────────────────────────────────

	pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
		const state = getState(ctx);

		// Seed built-in heuristics if empty
		if (state.heuristics.length === 0) {
			for (const h of BUILTIN_HEURISTICS) {
				addHeuristicRule(state, h.condition, h.action, h.priority);
			}
			log.info(`Seeded ${BUILTIN_HEURISTICS.length} built-in heuristics`);
		}

		state.sessionStartTime = Date.now();
		state.currentSessionTools = [];
	});

	// ── Event: tool_end ─────────────────────────────────────────────────

	pi.on("tool_end", async (event: any, ctx: ExtensionContext) => {
		const state = getState(ctx);
		const toolName = event?.toolName ?? event?.tool ?? "unknown";
		const isError = event?.isError ?? event?.error != null;
		const duration = event?.duration ?? 0;

		// Track tool usage
		state.currentSessionTools.push(toolName);

		// Record in tool reliability
		const taskType = inferTaskType(ctx, toolName);
		recordToolCall(state, toolName, taskType, !isError, duration);

		if (isError) {
			log.debug(`Tool "${toolName}" failed for task "${taskType}"`);
		}
	});

	// ── Event: agent_end ────────────────────────────────────────────────

	pi.on("agent_end", async (_event: any, ctx: ExtensionContext) => {
		const state = getState(ctx);

		// Log session summary
		const uniqueTools = new Set(state.currentSessionTools);
		const duration = Date.now() - state.sessionStartTime;

		log.info(
			`Session ended: ${state.currentSessionTools.length} tool calls, ${uniqueTools.size} unique tools, ${state.episodes.length} episodes, ${state.heuristics.length} heuristics`,
		);

		// Log top heuristics
		const topHeuristics = getPrioritizedHeuristics(state).slice(0, 3);
		for (const h of topHeuristics) {
			log.info(`  Top heuristic: "${h.condition}" (priority: ${h.priority.toFixed(2)})`);
		}
	});
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function inferTaskType(_ctx: ExtensionContext, _toolName: string): string {
	// Simple heuristic: map tool names to task types
	// In a real implementation, this would use more context
	const toolTypeMap: Record<string, string> = {
		read: "file_read",
		write: "file_write",
		edit: "file_edit",
		bash: "command_execution",
		grep: "search",
		find: "search",
		think: "reasoning",
		memory_recall: "memory_access",
	};

	return toolTypeMap[_toolName] || "general";
}

// ── Exports ──────────────────────────────────────────────────────────────────

export {
	Episode,
	HeuristicRule,
	ToolStat,
	addEpisode,
	retrieveEpisodes,
	addHeuristicRule,
	evolveHeuristic,
	getPrioritizedHeuristics,
	getApplicableHeuristics,
	recordToolCall,
	getToolReliability,
	selectBestTool,
};
