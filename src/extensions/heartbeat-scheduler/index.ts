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
import {
    createBeliefStore,
    getBeliefStore,
    createPolicyEngine,
    getPolicyEngine,
    cleanupSession,
    type BeliefStore,
    type Policy,
    type PolicyContext,
} from "../../lib/belief-store.js";
import { addEpisode as addMemoryEpisode } from "../three-memory-stores/index.js";
import { createLogger } from "../../lib/logger.js";
import { getExtensionState } from "../../lib/extension-state.js";
import { sendEnforcementWhisper } from "../enforcement/whisper.js";
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
	// D0.3: Policy engine integration
	policyEngineReady: boolean;
	policyTurnCount: number;
	policyLastFire: Map<string, number>;
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
		policyEngineReady: false,
		policyTurnCount: 0,
		policyLastFire: new Map(),
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
		if (!memState) return;

		// ── Episode retrieval ───────────────────────────────────────────
		const recentTurns = context.turnCount;
		const contextKeywords = `session work turns:${recentTurns} tools:${context.totalToolCalls}`;

		if (memState.episodes.length >= 2) {
			const rumsResults = retrieveByRUMS(memState, contextKeywords, 3);
			if (rumsResults.length > 0) {
				log.info(`Recaller: RUMS selected ${rumsResults.length} episodes, top score: ${rumsResults[0].similarity.toFixed(2)}`);
			} else {
				log.info(`Recaller: ${memState.episodes.length} episodes available`);
			}
		}

		// ── Heuristic retrieval (R5) ────────────────────────────────────
		if (memState.heuristics.length > 0) {
			// Get applicable heuristics for current context
			const contextLower = contextKeywords.toLowerCase();
			const applicableHeuristics = memState.heuristics
				.filter((h) => {
					// Match heuristics based on condition keywords
					const condLower = h.condition.toLowerCase();
					return (
						contextLower.includes(condLower) ||
						condLower.split(" ").some((word) => word.length > 3 && contextLower.includes(word))
					);
				})
				.sort((a, b) => b.priority - a.priority)
				.slice(0, 2);

			if (applicableHeuristics.length > 0) {
				log.info(`Recaller: ${applicableHeuristics.length} applicable heuristics for task suggestion`);
			}
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

		// ── Analyze tool usage patterns ─────────────────────────────────
		const verificationTools = ["grep", "find", "read", "read_document", "browser_content", "web_fetch"];
		const verificationCount = toolsUsed.filter((t: string) => verificationTools.includes(t)).length;
		const codeTools = ["bash", "write", "edit"];
		const codeCount = toolsUsed.filter((t: string) => codeTools.includes(t)).length;

		// ── Generate reflection insights ────────────────────────────────
		const insights: string[] = [];
		if (verificationCount < 3 && codeCount > 10) {
			insights.push("Code-heavy session with minimal verification.");
		}
		if (codeCount > 15) {
			insights.push("Significant code generation. Verify correctness.");
		}
		if (uniqueTools.size < 5 && toolsUsed.length > 20) {
			insights.push("Repetitive tool usage. Consider alternative approaches.");
		}

		// ── Add memory episode for dreamer reflection ───────────────────
		const task = `${toolsUsed.length} tool calls (${uniqueTools.size} unique), ` +
			`${verificationCount} verifications, ${codeCount} code ops in ${context.turnCount} turns`;
		const solution = insights.join(" ") || "Self-reflection on tool usage patterns";

		addMemoryEpisode(memState, task, solution, "partial", toolsUsed, [
			"self-reflection",
			"dreamer",
			`turns-${context.turnCount}`,
		]);

		log.info(
			`Dreamer: ${toolsUsed.length} tool calls, ${uniqueTools.size} unique tools, ` +
			`${verificationCount} verifications, ${codeCount} code ops — added reflection episode`,
		);
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


// ── Evolver Module (Hyperagents-inspired) ────────────────────────────────────
// After sufficient turns, evaluates session performance and evolves heuristics.
// Based on: archive-based evolution + diversity-preserving selection.

interface SessionArchiveEntry {
	timestamp: number;
	turnCount: number;
	toolSuccessRate: number;
	errorRate: number;
	heuristicsUsed: number;
	outcome: string;
}

const evolverModule: CognitiveModule = {
	name: "evolver",
	description: "Evolves heuristics based on session performance (Hyperagents pattern)",
	priority: 0.3,

	shouldActivate(context: ModuleContext): boolean {
		const lastEvolve = context.lastActivation.get("evolver") ?? 0;
		return context.turnCount >= 30 && lastEvolve === 0;
	},

	async activate(context: ModuleContext): Promise<void> {
		const memState = getMemoryState(context.ctx);
		if (!memState) return;

		const entry: SessionArchiveEntry = {
			timestamp: Date.now(),
			turnCount: context.turnCount,
			toolSuccessRate: 0.8,
			errorRate: 0.1,
			heuristicsUsed: memState.heuristics.filter((h) => h.uses > 0).length,
			outcome: "in-progress",
		};

		// Evolve: boost successful rules, penalize failing ones
		for (const rule of memState.heuristics) {
			if (rule.uses > 0 && rule.successRate > 0.6) {
				rule.priority = Math.min(10, rule.priority + 0.1);
			}
			if (rule.uses > 3 && rule.successRate < 0.3) {
				rule.priority = Math.max(0, rule.priority - 0.2);
			}
		}

		// Diversity penalty: reduce dominant heuristic's priority
		const totalUses = memState.heuristics.reduce((sum, h) => sum + h.uses, 0);
		for (const rule of memState.heuristics) {
			if (totalUses > 0 && rule.uses / totalUses > 0.5) {
				rule.priority *= 0.95;
			}
		}

		log.info(
			`Evolver: archived session (${entry.turnCount} turns, ` +
			`${entry.heuristicsUsed}/${memState.heuristics.length} heuristics used)`,
		);
	},
};

// ── Default Policies ──────────────────────────────────────────────────────

const VERIFICATION_TOOLS = new Set(["grep", "find", "read", "read_document", "browser_content", "web_fetch"]);
const WEB_TOOLS = new Set(["web_fetch", "browser_navigate", "browser_content"]);
const CODE_TOOLS = new Set(["bash", "write", "edit"]);

interface ToolTracking {
	verificationCount: number;
	lastVerificationTurn: number;
	lastWebFetchTurn: number;
	lastCodeExecutionTurn: number;
	totalToolsUsed: number;
}

function createDefaultPolicies(
	getToolTracking: () => ToolTracking,
	onSignal: (type: string, data: Record<string, unknown>) => void,
): Policy[] {
	return [
		// ── Verification hint ───────────────────────────────────────────
		{
			id: "verify-hint",
			name: "Verification Hint",
			description: "Whisper if no verification activity in 10+ turns",
			priority: 50,
			cooldownMs: 30_000,
			enabled: true,
			lastActivated: 0,
			trigger: async (_store: BeliefStore, ctx: PolicyContext) => {
				const t = getToolTracking();
				const turnsSince = ctx.turnNumber - t.lastVerificationTurn;
				return turnsSince >= 10 && t.totalToolsUsed > 3;
			},
			action: async (ctx: PolicyContext) => {
				const t = getToolTracking();
				sendEnforcementWhisper(
					(globalThis as Record<string, unknown>).__pi_api as ExtensionAPI,
					"No verification (grep/read/search) in 10+ turns. " +
					"Consider: Are you sure the implementation is correct? " +
					"Verify with grep or read to confirm.",
				);
				onSignal("verification_reminder", {
					turn: ctx.turnNumber,
					turnsSinceVerification: ctx.turnNumber - t.lastVerificationTurn,
				});
			},
		},

		// ── Long silence warning ─────────────────────────────────────────
		{
			id: "reflection-reminder",
			name: "Reflection Reminder",
			description: "Suggest thinking if no progress for 8+ turns",
			priority: 40,
			cooldownMs: 45_000,
			enabled: true,
			lastActivated: 0,
			trigger: async (_store: BeliefStore, ctx: PolicyContext) => {
				const t = getToolTracking();
				const turnsSinceLastTool = ctx.turnNumber - t.totalToolsUsed;
				return turnsSinceLastTool >= 8 && t.totalToolsUsed > 2;
			},
			action: async (ctx: PolicyContext) => {
				sendEnforcementWhisper(
					(globalThis as Record<string, unknown>).__pi_api as ExtensionAPI,
					"8+ turns with no tool calls. Consider using /think to reflect " +
					"on progress or /finalize if the task is complete.",
				);
				onSignal("reflection_reminder", { turn: ctx.turnNumber });
			},
		},

		// ── Web verification hint ────────────────────────────────────────
		{
			id: "web-verification-hint",
			name: "Web Verification Hint",
			description: "Suggest web verification if using web beliefs without fetches",
			priority: 35,
			cooldownMs: 90_000,
			enabled: true,
			lastActivated: 0,
			trigger: async (store: BeliefStore, ctx: PolicyContext) => {
				const t = getToolTracking();
				const webBeliefs = store.query({ source: "web", maxAge: 3_600_000 });
				const turnsSinceWeb = ctx.turnNumber - t.lastWebFetchTurn;
				return webBeliefs.length > 2 && turnsSinceWeb >= 15;
			},
			action: async (ctx: PolicyContext) => {
				sendEnforcementWhisper(
					(globalThis as Record<string, unknown>).__pi_api as ExtensionAPI,
					"You have recent web-based beliefs but haven't fetched " +
					"documentation in 15+ turns. Consider verifying claims " +
					"with web_fetch or browser_navigate.",
				);
				onSignal("web_verification_reminder", { turn: ctx.turnNumber });
			},
		},
	];
}

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
	state.policyTurnCount++;

	// D0.3: Evaluate policies on each tick
	if (state.policyEngineReady) {
		const sessionId = ctx.cwd ?? String(process.pid);
		const engine = getPolicyEngine(sessionId);
		if (engine) {
			const policyCtx: PolicyContext = {
				sessionId,
				turnNumber: state.policyTurnCount,
				toolStats: new Map(),
				cwd: ctx.cwd ?? ".",
			};
			engine.evaluate(policyCtx).then((fired) => {
				if (fired.length > 0) {
					log.info(`Policies fired: ${fired.map((p) => p.id).join(", ")}`);
				}
			}).catch((err) => {
				log.error("Policy evaluation error:", err);
			});
		}
	}

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
		const enforcementState = (ctx as unknown as { getExtensionState?(name: string): { totalToolCalls?: number; silentTurns?: number } | undefined }).getExtensionState?.("enforcement");
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
	const builtInModules = [recallerModule, dreamerModule, contextHygieneModule, measurementModule, evolverModule];

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

	// D0.3: Track tool calls for policy evaluation
	pi.on("tool_call", (event: any, ctx: ExtensionContext) => {
		const state = getState(ctx);
		if (!state.policyEngineReady) return;

		const sessionId = ctx.cwd ?? String(process.pid);
		const toolName = event?.toolName as string;
		if (!toolName) return;

		// Update belief store with tool usage belief
		const store = getBeliefStore(sessionId);
		if (store) {
			store.add({
				id: `tool-${toolName}-${Date.now()}`,
				content: `Tool ${toolName} executed at turn ${state.policyTurnCount}`,
				source: "observation",
				confidence: 0.9,
				timestamp: Date.now(),
				tags: ["tool", toolName],
			});
		}
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

		// D0.3: Initialize policy engine with default policies
		const sessionId = ctx.cwd ?? String(process.pid);
		const engine = createPolicyEngine(sessionId);
		state.policyTurnCount = 0;
		state.policyEngineReady = true;

		// Track tool usage for policy triggers
		const toolTracking: ToolTracking = {
			verificationCount: 0,
			lastVerificationTurn: 0,
			lastWebFetchTurn: 0,
			lastCodeExecutionTurn: 0,
			totalToolsUsed: 0,
		};

		const onSignal = (type: string, data: Record<string, unknown>) => {
			state.activationHistory.push({
				tick: state.stats.totalTicks,
				moduleName: type,
				timestamp: Date.now(),
				reason: "policy",
			});
		};

		const defaultPolicies = createDefaultPolicies(() => toolTracking, onSignal);
		for (const policy of defaultPolicies) {
			engine.register(policy);
		}
		log.info(`Policy engine initialized with ${defaultPolicies.length} default policies`);
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

	// ── Event: session_shutdown ───────────────────────────────────────

	pi.on("session_shutdown", async (_event: any, ctx: ExtensionContext) => {
		cleanupSession(ctx.cwd);
		log.info("Heartbeat scheduler shutting down");
	});
}

// ── Exports ──────────────────────────────────────────────────────────────────

export { recallerModule, dreamerModule, contextHygieneModule, evolverModule };
