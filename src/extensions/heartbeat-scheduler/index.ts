/**
 * Heartbeat Scheduler Extension
 *
 * Proactive cognitive scheduling based on turn patterns.
 * Paper: 2604.14178 Heartbeat Scheduling
 *
 * Key insight: Reactive control (post-hoc correction) causes impulsivity.
 * Proactive heartbeat-driven scheduling activates cognitive modules based on
 * temporal patterns and historical context.
 *
 * Architecture:
 * - tick() fires every N turns (configurable)
 * - Evaluates registered CognitiveModules via shouldActivate()
 * - Activates top-priority modules (max per tick configurable)
 * - HistoryAnalyzer optimizes intervals based on effectiveness
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { createLogger } from "../../lib/logger.js";
import { getExtensionState } from "../../lib/extension-state.js";
import type { Episode, HeuristicRule } from "../three-memory-stores/index.js";
import { retrieveByRUMS } from "../three-memory-stores/index.js";
import { isDegraded, getDegradationReasons, getMetricsSummary } from "../../lib/degradation-detector.js";
import { measureBigramEntropy, countSelfContradictions } from "../../lib/reasoning-metrics.js";

const log = createLogger("heartbeat");

// ── Cross-extension state access ─────────────────────────────────────────────

interface MemoryStoresState {
	episodes: Episode[];
	heuristics: HeuristicRule[];
	toolStats: Map<string, any>;
	currentSessionTools: string[];
	sessionStartTime: number;
}

function getMemoryState(ctx: ExtensionContext): MemoryStoresState | null {
	try {
		return getExtensionState<MemoryStoresState>(ctx, "three-memory-stores", () => ({
			episodes: [],
			heuristics: [],
			toolStats: new Map(),
			currentSessionTools: [],
			sessionStartTime: Date.now(),
		}));
	} catch {
		return null;
	}
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface CognitiveModule {
	name: string;
	description: string;
	priority: number;
	shouldActivate(context: ModuleContext): boolean;
	activate(context: ModuleContext): Promise<void>;
}

export interface ModuleContext {
	ctx: ExtensionContext;
	turnCount: number;
	lastActivation: Map<string, number>;
	sessionAge: number;
	toolCallsSinceLastTick: string[];
	totalToolCalls: number;
	silentTurns: number;
	metadata: Record<string, unknown>;
}

interface HeartbeatConfig {
	interval: number;            // Turns between ticks
	historyWindow: number;       // Turns to analyze
	maxActivationsPerTick: number;
	enabled: boolean;
}

interface HeartbeatState {
	enabled: boolean;
	turnCount: number;
	modules: Map<string, RegisteredModule>;
	lastActivation: Map<string, number>;
	activationHistory: ActivationRecord[];
	stats: {
		totalTicks: number;
		totalActivations: number;
		activationsByModule: Record<string, number>;
	};
}

interface RegisteredModule {
	module: CognitiveModule;
	enabled: boolean;
	activations: number;
	lastActivated: number;
	effectiveness: number; // 0-1 rolling average of activation value
}

interface ActivationRecord {
	tick: number;
	moduleName: string;
	timestamp: number;
	reason: string;
}

// ── Factory ──────────────────────────────────────────────────────────────────

function createHeartbeatState(): HeartbeatState {
	return {
		enabled: true,
		turnCount: 0,
		modules: new Map(),
		lastActivation: new Map(),
		activationHistory: [],
		stats: {
			totalTicks: 0,
			totalActivations: 0,
			activationsByModule: {},
		},
	};
}

function getState(ctx: ExtensionContext): HeartbeatState {
	return getExtensionState(ctx, "heartbeat", createHeartbeatState);
}

// ── Built-in Modules ─────────────────────────────────────────────────────────

const recallerModule: CognitiveModule = {
	name: "recaller",
	description: "Proactive memory retrieval using RUMS (mutual information)",
	priority: 0.6,

	shouldActivate(context: ModuleContext): boolean {
		const lastRecall = context.lastActivation.get("recaller") ?? 0;
		const turnsSinceRecall = context.turnCount - lastRecall;
		if (turnsSinceRecall < 15 || context.totalToolCalls < 5) return false;
		const memState = getMemoryState(context.ctx);
		return memState !== null && memState.episodes.length >= 2;
	},

	async activate(context: ModuleContext): Promise<void> {
		const memState = getMemoryState(context.ctx);
		if (!memState || memState.episodes.length < 2) return;

		// RUMS retrieval: use mutual information instead of simple similarity
		const recentTurns = context.turnCount;
		const contextKeywords = `session work turns:${recentTurns} tools:${context.totalToolCalls}`;
		const rumsResults = retrieveByRUMS(memState, contextKeywords, 3);

		if (rumsResults.length > 0) {
			log.info(`Recaller: RUMS selected ${rumsResults.length} episodes, top score: ${rumsResults[0].similarity.toFixed(2)}`);
		} else {
			log.info(`Recaller: ${memState.episodes.length} episodes available`);
		}
	},
};

const dreamerModule: CognitiveModule = {
	name: "dreamer",
	description: "Reflection and knowledge consolidation after sustained work",
	priority: 0.4,

	shouldActivate(context: ModuleContext): boolean {
		const lastDream = context.lastActivation.get("dreamer") ?? 0;
		const turnsSinceDream = context.turnCount - lastDream;
		if (turnsSinceDream < 25 || context.totalToolCalls < 15) return false;

		// Check if there's enough activity to reflect on
		const memState = getMemoryState(context.ctx);
		if (!memState) return context.totalToolCalls > 20;

		// Activate if there are tools used that could generate episodes
		return memState.currentSessionTools.length >= 5;
	},

	async activate(context: ModuleContext): Promise<void> {
		const memState = getMemoryState(context.ctx);
		if (!memState) return;

		const toolsUsed = memState.currentSessionTools;
		const uniqueTools = new Set(toolsUsed);

		log.info(`Dreamer: ${toolsUsed.length} tool calls, ${uniqueTools.size} unique tools — suggesting reflection`);
	},
};

const contextHygieneModule: CognitiveModule = {
	name: "context-hygiene",
	description: "Proactive context management before overflow",
	priority: 0.8,

	shouldActivate(context: ModuleContext): boolean {
		// Activate if: context is getting large and hasn't been checked
		const lastCheck = context.lastActivation.get("context-hygiene") ?? 0;
		const turnsSinceCheck = context.turnCount - lastCheck;
		// Check every ~20 turns
		return turnsSinceCheck >= 20;
	},

	async activate(context: ModuleContext): Promise<void> {
		log.debug("Context hygiene module activated — suggesting context_audit");
	},
};

const measurementModule: CognitiveModule = {
	name: "measurement",
	description: "Proactive degradation detection and reasoning quality measurement",
	priority: 0.7,

	shouldActivate(context: ModuleContext): boolean {
		const lastCheck = context.lastActivation.get("measurement") ?? 0;
		const turnsSinceCheck = context.turnCount - lastCheck;
		return turnsSinceCheck >= 10;
	},

	async activate(context: ModuleContext): Promise<void> {
		// Check degradation status
		const degraded = isDegraded(context.ctx);
		if (degraded) {
			const reasons = getDegradationReasons(context.ctx);
			log.warn(`Degradation detected: ${reasons.join(", ")}`);
		}

		// Get metrics summary
		const summary = getMetricsSummary(context.ctx);
		if (summary.totalTurns > 0) {
			log.info(
				`Metrics: ${summary.totalTurns} turns, error rate: ${(summary.avgErrorRate * 100).toFixed(0)}%, ` +
				`tool success: ${(summary.avgToolSuccess * 100).toFixed(0)}%, degraded: ${summary.degraded}`,
			);
		}
	},
};

// ── Heartbeat Engine ─────────────────────────────────────────────────────────

const DEFAULT_CONFIG: HeartbeatConfig = {
	interval: 5,
	historyWindow: 20,
	maxActivationsPerTick: 2,
	enabled: true,
};

function tick(
	pi: ExtensionAPI,
	state: HeartbeatState,
	config: HeartbeatConfig,
	ctx: ExtensionContext,
): void {
	state.stats.totalTicks++;

	// Build module context
	const moduleContext: ModuleContext = {
		ctx,
		turnCount: state.turnCount,
		lastActivation: state.lastActivation,
		sessionAge: state.turnCount,
		toolCallsSinceLastTick: [],
		totalToolCalls: 0,  // Filled by enforcement state if available
		silentTurns: 0,
		metadata: {},
	};

	// Try to get tool call info from enforcement state
	try {
		const enforcementState = ((ctx as any)?.getExtensionState ?? (() => null))("enforcement");
		if (enforcementState) {
			moduleContext.totalToolCalls = enforcementState.totalToolCalls ?? 0;
			moduleContext.silentTurns = enforcementState.silentTurns ?? 0;
		}
	} catch { /* non-fatal: enforcement state not available */ }

	// Evaluate which modules should activate
	const candidates: Array<{ module: CognitiveModule; priority: number; reg: RegisteredModule }> = [];

	for (const [name, reg] of state.modules) {
		if (!reg.enabled) continue;

		try {
			const shouldActivate = reg.module.shouldActivate(moduleContext);
			if (shouldActivate) {
				candidates.push({ module: reg.module, priority: reg.module.priority, reg });
			}
		} catch (err) {
			log.error(`Module "${name}" shouldActivate error:`, err);
		}
	}

	// Sort by priority, take top N
	candidates
		.sort((a, b) => b.priority - a.priority)
		.slice(0, config.maxActivationsPerTick)
		.forEach(async ({ module, reg }) => {
			try {
				await module.activate(moduleContext);

				// Update tracking
				reg.activations++;
				reg.lastActivated = state.turnCount;
				state.lastActivation.set(module.name, state.turnCount);
				state.stats.totalActivations++;
				state.stats.activationsByModule[module.name] =
					(state.stats.activationsByModule[module.name] ?? 0) + 1;

				state.activationHistory.push({
					tick: state.stats.totalTicks,
					moduleName: module.name,
					timestamp: Date.now(),
					reason: "heartbeat",
				});

				// Keep history bounded
				if (state.activationHistory.length > 100) {
					state.activationHistory.shift();
				}

				log.info(`Activated module "${module.name}" (priority ${module.priority.toFixed(1)})`);
			} catch (err) {
				log.error(`Module "${module.name}" activate error:`, err);
			}
		});
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function heartbeatExtension(pi: ExtensionAPI) {
	const config = { ...DEFAULT_CONFIG };

	// Register built-in modules
	const builtInModules = [recallerModule, dreamerModule, contextHygieneModule, measurementModule];

	// ── heartbeat_status tool ─────────────────────────────────────────

	pi.registerTool({
		name: "heartbeat_status",
		label: "Heartbeat Status",
		description: "View heartbeat scheduler status, registered modules, and activation history.",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			const state = getState(ctx);
			const lines: string[] = [];

			lines.push(`Heartbeat: ${state.enabled ? "🟢 Active" : "🔴 Stopped"}`);
			lines.push(`Interval: every ${config.interval} turns`);
			lines.push(`Turns: ${state.turnCount}`);
			lines.push(`Ticks: ${state.stats.totalTicks}`);
			lines.push(`Activations: ${state.stats.totalActivations}`);
			lines.push("");

			lines.push("Modules:");
			for (const [name, reg] of state.modules) {
				const status = reg.enabled ? "✅" : "⏸️";
				const last = reg.lastActivated > 0 ? `${reg.lastActivated} turns ago` : "never";
				lines.push(`  ${status} ${name} (priority: ${reg.module.priority.toFixed(1)}, activated: ${reg.activations}x, last: ${last})`);
			}

			if (state.activationHistory.length > 0) {
				lines.push("");
				lines.push("Recent activations:");
				const recent = state.activationHistory.slice(-5);
				for (const record of recent) {
					lines.push(`  Tick ${record.tick}: ${record.moduleName} (${record.reason})`);
				}
			}

			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
		},
	});

	// ── Event: turn_end ───────────────────────────────────────────────

	pi.on("turn_end", async (_event: any, ctx: ExtensionContext) => {
		const state = getState(ctx);
		if (!state.enabled || !config.enabled) return;

		state.turnCount++;

		if (state.turnCount % config.interval !== 0) return;

		tick(pi, state, config, ctx);
	});

	// ── Event: session_start ──────────────────────────────────────────

	pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
		const state = getState(ctx);

		// Register built-in modules if not already registered
		for (const module of builtInModules) {
			if (!state.modules.has(module.name)) {
				state.modules.set(module.name, {
					module,
					enabled: true,
					activations: 0,
					lastActivated: 0,
					effectiveness: 0.5,
				});
				log.info(`Registered module "${module.name}"`);
			}
		}
	});

	// ── Event: agent_end ──────────────────────────────────────────────

	pi.on("agent_end", async (_event: any, ctx: ExtensionContext) => {
		const state = getState(ctx);
		// Log final stats
		log.info(`Session ended. Ticks: ${state.stats.totalTicks}, Activations: ${state.stats.totalActivations}`);
		for (const [name, count] of Object.entries(state.stats.activationsByModule)) {
			log.info(`  ${name}: ${count} activations`);
		}
	});
}

// ── Exports ──────────────────────────────────────────────────────────────────

export { recallerModule, dreamerModule, contextHygieneModule };
