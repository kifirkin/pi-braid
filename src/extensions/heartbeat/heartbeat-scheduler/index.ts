/**
 * Heartbeat Scheduler — proactive cognitive scheduling based on paper 2604.14178.
 *
 * Triggers interventions before problems arise: silence, context overflow, error accumulation.
 * Unlike reactive correction (which causes impulsivity), heartbeat scheduling
 * fires gentle reminders at natural turn boundaries to keep the agent on track.
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
import { Type } from "typebox";
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
} from "../../../lib/belief-store.js";
import { addEpisode as addMemoryEpisode, addHeuristicRule } from "../../memory/three-memory-stores/index.js";
import { createLogger } from "../../../lib/logger.js";
import { generateDensitySignals, evaluatePolicies } from "../../memory/context-lifecycle/policy-engine.js";
import { getExtensionState } from "../../../lib/extension-state.js";
import type { Episode, HeuristicRule } from "../../memory/three-memory-stores/index.js";
import { retrieveByRUMS } from "../../memory/three-memory-stores/index.js";
import { isDegraded, getDegradationReasons, getMetricsSummary } from "../../../lib/degradation-detector.js";
import { measureBigramEntropy, countSelfContradictions } from "../../../lib/reasoning-metrics.js";

const log = createLogger("heartbeat");

// ── Cross-extension state access ─────────────────────────────────────────────

interface MemoryStoresState {
	episodes: Episode[];
	heuristics: HeuristicRule[];
	toolStats: Map<string, any>;
	currentSessionTools: string[];
	sessionStartTime: number;
	lastSkillType: string;
	skillTransitionCount: number;
	recentErrors: string[];
}

function getMemoryState(ctx: ExtensionContext): MemoryStoresState | null {
	try {
		return getExtensionState<MemoryStoresState>(ctx, "three-memory-stores", () => ({
			episodes: [],
			heuristics: [],
			toolStats: new Map(),
			currentSessionTools: [],
			sessionStartTime: Date.now(),
			lastSkillType: "",
			skillTransitionCount: 0,
			recentErrors: [],
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
	// D0.5: Meta-learning optimizer
	metaLearning: MetaLearningState;
}

interface MetaLearningState {
	tickInterval: number;            // Current adaptive interval
	baseInterval: number;            // Starting interval (from config)
	effectivenessHistory: number[];  // Rolling effectiveness scores (0-1)
	activationSignalWindow: Map<string, number>; // module → turn activated
	postActivationToolCount: number; // Tools called in N turns after activation
	pendingSignals: Map<string, number>; // module → activation turn (awaiting outcome)
	// TIER 1: Persistent tool tracking (was local variable in session_start)
	toolTracking: ToolTracking;
	// TIER 1: Token warning thresholds already fired (prevents spam)
	tokenWarningFired: Set<number>;
}

const META_LEARNING = {
	MIN_INTERVAL: 3,
	MAX_INTERVAL: 10,
	effectivenessWindowSize: 10,   // Rolling window for effectiveness
	signalWindow: 3,               // Turns to wait for signal after activation
	speedUpThreshold: 0.7,        // Effectiveness above this → faster ticking
	slowDownThreshold: 0.3,       // Effectiveness below this → slower ticking
	intervalStep: 1,              // How much to adjust interval by
};

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
		metaLearning: {
			tickInterval: DEFAULT_CONFIG.interval,
			baseInterval: DEFAULT_CONFIG.interval,
			effectivenessHistory: [],
			activationSignalWindow: new Map(),
			postActivationToolCount: 0,
			pendingSignals: new Map(),
    tokenWarningFired: new Set<number>(),
			// TIER 1: Persistent tool tracking (was local variable in session_start)
			toolTracking: {
				verificationCount: 0,
				lastVerificationTurn: 0,
				lastWebFetchTurn: 0,
				lastCodeExecutionTurn: 0,
				totalToolsUsed: 0,
				lastToolCallTurn: 0,
			},
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

		// ── Proactive triggers (TIER 1) ──────────────────────────────
		// High tool failure count → recall error recovery
		const failureCount = (context.metadata?.toolFailures as number) ?? 0;
		if (failureCount >= 3) return true;

		// Deep decomposition → recall complex task episodes
		const depth = (context.metadata?.decompositionDepth as number) ?? 0;
		if (depth >= 4) return true;

		// Silent turns (no progress) → recall strategic episodes
		if (context.silentTurns >= 8) return true;

		// High tool usage without results → recall relevant episodes
		if (context.totalToolCalls >= 20 && context.totalToolCalls % 10 === 0) return true;

		// ── Time-based fallback ──────────────────────────────────
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
				context.ctx.whisper?.(`Proactive memory: ${applicableHeuristics.length} heuristics may apply to your current task. Consider: ${applicableHeuristics.map((h: any) => h.condition).slice(0, 2).join(", ")}`, { category: "cognitive" });
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
		// TIER 1: Surface dreamer insights to agent
		if (insights.length > 0) {
			context.ctx.whisper?.(`Self-reflection: ${insights.join(" ")}`, { category: "cognitive" });
		}

		// ── Cross-session pattern learning ────────────────────────────
		// Compare current tool SET with past episodes using Jaccard similarity
		try {
			const episodes = memState.episodes ?? [];
			if (episodes.length > 3) {
				const currentSet = new Set(toolsUsed);
				const similarEpisodes: Episode[] = [];

				for (const ep of episodes) {
					if (!ep.tags || ep.tags.length === 0) continue;
					// Compute Jaccard similarity between current tool set and episode tags
					const epSet = new Set(ep.tags);
					let intersection = 0;
					for (const t of currentSet) { if (epSet.has(t)) intersection++; }
					const union = currentSet.size + epSet.size - intersection;
					const jaccard = union > 0 ? intersection / union : 0;
					if (jaccard >= 0.5) similarEpisodes.push(ep); // ≥50% overlap
				}

				if (similarEpisodes.length >= 2) {
					const toolNames = [...currentSet].slice(0, 5).join(", ");
					const msg = `Consider a different approach: tool pattern {${toolNames}} repeats across ${similarEpisodes.length} sessions`;
					addHeuristicRule(memState, toolNames, msg, 0.3);
					log.info(`Cross-session pattern: ${msg}`);
				}
			}
		} catch {
			// Non-fatal
		}

	},
};

const contextHygieneModule: CognitiveModule = {
	name: "context-hygiene",
	description: "Proactive context management (SimpleMem 2601.02553, GenericAgent 2604.17091)",
	priority: 0.9,

	shouldActivate(context: ModuleContext): boolean {
		// Activate every 10 turns initially, every 5 turns after turn 30
		const turns = context.turnCount;
		const threshold = turns < 30 ? 10 : 5;
		const last = context.lastActivation.get("context-hygiene") ?? 0;
		return turns - last >= threshold;
	},

	async activate(context: ModuleContext): Promise<void> {
		const ctx = context.ctx;
		const { evaluateContextDensity } = await import("../../../lib/context-density.js");
		const density = evaluateContextDensity(ctx);

		// Emit density signals into S-MMU lifecycle (for density-aware policies)
		const signals = generateDensitySignals(ctx);

		// Route signals through context-lifecycle queue
		try {
			for (const signal of signals) {
				// Queue signal into lifecycle controller for policy evaluation
				const state = getExtensionState(ctx, "context-lifecycle", () => ({ signalQueue: [] as any[] }));
				state.signalQueue.push(signal);
			}
			// Evaluate density policies with current signals
			const proposals = evaluatePolicies(ctx, signals);
			for (const proposal of proposals) {
				if (proposal.action.type === "propose" && proposal.priority > 55) {
					// High-priority proposal — whisper to agent
					const msg = interpolateMessage(proposal.action.message, {
						density: Math.round(density.density * 100),
						noise: density.noisyMessages,
						signal: density.signalMessages,
						ratio: Math.round(density.tokenRatio * 100),
						count: density.duplicates,
					});
						ctx.whisper?.(msg, { category: "cognitive", priority: "medium" });
				}
			}
		} catch {
			// Policy engine not available — just whisper based on density
			log.debug("Density policies not available, using direct whisper");
		}

		if (density.density < 0.4) {
			// Low density: context is noisy
			ctx.whisper?.(
				"Low context density (" + Math.round(density.density * 100) + "% signal). " +
				"Noisy: " + density.noisyMessages + ", Signal: " + density.signalMessages + ". " +
				"Consider: context_compress() or context_prune().",
				{ category: "cognitive", priority: density.density < 0.25 ? "high" : "medium" }
			);
		} else if (density.tokenRatio > 0.6) {
			// High density but large context: suggest semantic compression
			ctx.whisper?.(
				"High density (" + Math.round(density.density * 100) + "%) but large context (" +
				Math.round(density.tokenRatio * 100) + "% of limit). " +
				"Semantic compression could preserve meaning at 30% token cost (SimpleMem).",
				{ category: "cognitive", priority: "low" }
			);
		}

		if (density.duplicates > 2) {
			ctx.whisper?.(
				density.duplicates + " near-duplicate messages in context. " +
				"Consider: context_prune() to remove redundant context.",
				{ category: "cognitive", priority: "medium" }
			);
		}
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
			context.ctx.whisper?.(`Degradation detected: ${reasons.join(", ")}. Consider: context audit, session recall, or wrapping up.`, { category: "cognitive", priority: "medium" });
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
		// TIER 1: Surface evolver results to agent
		context.ctx.whisper?.(`Meta-learning: session archived. ${entry.heuristicsUsed}/${memState.heuristics.length} heuristics applied. ${memState.heuristics.length} total active.`, { category: "cognitive" });
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
	lastToolCallTurn: number;
}

function createDefaultPolicies(
	getToolTracking: () => ToolTracking,
	onSignal: (type: string, data: Record<string, unknown>) => void,
	sendWhisper: (msg: string) => void,
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
				sendWhisper(
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
				const turnsSinceLastTool = ctx.turnNumber - t.lastToolCallTurn;
				return turnsSinceLastTool >= 8 && t.totalToolsUsed > 2;
			},
			action: async (ctx: PolicyContext) => {
				sendWhisper(
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
				sendWhisper(
					"You have recent web-based beliefs but haven't fetched " +
					"documentation in 15+ turns. Consider verifying claims " +
					"with web_fetch or browser_navigate.",
				);
				onSignal("web_verification_reminder", { turn: ctx.turnNumber });
			},
		},

		// ── Proactive context monitoring ──────────────────────────────────
		{
			id: "context-monitor",
			name: "Context Monitor",
			description: "Monitor token usage and warn before overflow",
			priority: 80,
			cooldownMs: 30_000,
			enabled: true,
			lastActivated: 0,
			trigger: async (_store: BeliefStore, ctx: PolicyContext) => {
				// Always eligible — we check usage inside action
				return true;
			},
			action: async (ctx: PolicyContext) => {
				const usage = ((ctx as any).ctx as any)?.getContextUsage?.();
				if (!usage) return;
				const { percent, tokens, contextWindow } = usage;
				const state = getState((ctx as any).ctx);
				const fired = state?.metaLearning?.tokenWarningFired;

				const thresholds: Array<{ pct: number; priority: "low" | "medium" | "high"; msg: string }> = [
					{ pct: 70, priority: "low", msg: "Context at 70%. Consider using /finalize or /context_compress to reduce context." },
					{ pct: 80, priority: "medium", msg: "Context at 80%. Use /context_compress or /finalize NOW." },
					{ pct: 90, priority: "high", msg: "CRITICAL: Context at 90%. Call finalize(completed=false, summary='[brief status]', tasksRemaining=[...]) RIGHT NOW. Every remaining turn risks overflow and data loss. Stop all work and finalize immediately." },
				];

				for (const { pct, priority, msg } of thresholds) {
					if (percent >= pct && !fired.has(pct)) {
						fired.add(pct);
						(ctx as any).ctx.whisper?.(
							`${msg} (${tokens?.toLocaleString()} / ${contextWindow?.toLocaleString()} tokens, ${percent?.toFixed(1)}%)`,
							{ category: "cognitive", priority },
						);
						log.warn(`[heartbeat] Token warning: ${percent?.toFixed(1)}% (${tokens}/${contextWindow} tokens)`);
						// Auto-finalize at 90%: force a turn with finalize directive
						if (pct === 90) {
							const finalizationMessage =
								`[SYSTEM] Context critical at ${percent?.toFixed(1)}%. Auto-finalizing to prevent overflow. ` +
								`Stop all work and call finalize(completed=false, autoProceed=true) now. ` +
								`Provide a summary of what was accomplished and what remains.`;
							try {
								(ctx as any).pi.sendUserMessage?.(finalizationMessage, { deliverAs: "steer" });
								log.warn(`[heartbeat] Auto-finalize triggered at 90%`);
							} catch (err) {
								log.error(`[heartbeat] sendUserMessage failed: ${err}`);
							}
						}
						break; // One warning per tick
					}
				}

				// Reset warnings if context usage drops
				if (percent < 50 && fired && fired.size > 0) {
					fired.clear();
				}
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

// ── Meta-learning: Tick interval adjustment ───────────────────────────────────

function updateMetaLearning(state: HeartbeatState): void {
	const ml = state.metaLearning;

	// Reset tool count if no signals are pending (prevents accumulation between windows)
	if (ml.pendingSignals.size === 0) {
		ml.postActivationToolCount = 0;
	}

	// 1. Resolve pending signals: check if activated modules produced tool activity
	if (ml.pendingSignals.size > 0) {
		const resolved: Array<{ module: string; effective: boolean }> = [];

		for (const [moduleName, activationTurn] of ml.pendingSignals) {
			const turnsSinceActivation = state.turnCount - activationTurn;

			if (turnsSinceActivation >= META_LEARNING.signalWindow) {
				// Signal window closed: check if tools were called in this window
				// We use the activationHistory to detect if the module was actually useful
				const recentActivations = ml.activationSignalWindow.get(moduleName);
				// Effective = module activated + there was activity after (tracked via pendingSignals resolution)
				// We use tool call count in the window as proxy for effectiveness
				const effective = ml.postActivationToolCount > 0;
				resolved.push({ module: moduleName, effective });
				ml.pendingSignals.delete(moduleName);
			}
		}

		// 2. Update rolling effectiveness score
		if (resolved.length > 0) {
			const batchEffectiveness = resolved.filter((r) => r.effective).length / resolved.length;
			ml.effectivenessHistory.push(batchEffectiveness);
			if (ml.effectivenessHistory.length > META_LEARNING.effectivenessWindowSize) {
				ml.effectivenessHistory.shift();
			}

			// 3. Adjust tick interval based on rolling effectiveness
			const avgEffectiveness = ml.effectivenessHistory.reduce((a, b) => a + b, 0) /
				ml.effectivenessHistory.length;

			if (avgEffectiveness >= META_LEARNING.speedUpThreshold && ml.tickInterval > META_LEARNING.MIN_INTERVAL) {
				ml.tickInterval = Math.max(META_LEARNING.MIN_INTERVAL, ml.tickInterval - META_LEARNING.intervalStep);
				log.info(`Meta: effectiveness ${(avgEffectiveness * 100).toFixed(0)}% → speeding up interval to ${ml.tickInterval}`);
			} else if (avgEffectiveness <= META_LEARNING.slowDownThreshold && ml.tickInterval < META_LEARNING.MAX_INTERVAL) {
				ml.tickInterval = Math.min(META_LEARNING.MAX_INTERVAL, ml.tickInterval + META_LEARNING.intervalStep);
				log.info(`Meta: effectiveness ${(avgEffectiveness * 100).toFixed(0)}% → slowing down interval to ${ml.tickInterval}`);
			}

			// Reset tool count proxy after evaluation
			ml.postActivationToolCount = 0;
		}
	}
}

function getAdaptiveInterval(state: HeartbeatState, config: HeartbeatConfig): number {
	return state.metaLearning.tickInterval;
}

function tick(
	pi: ExtensionAPI,
	state: HeartbeatState,
	config: HeartbeatConfig,
	ctx: ExtensionContext,
): void {
	state.stats.totalTicks++;
	state.policyTurnCount++;

	// D0.5: Update meta-learning before processing tick
	updateMetaLearning(state);

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

	// Build module context from heartbeat state
	const moduleContext: ModuleContext = {
		ctx,
		turnCount: state.turnCount,
		lastActivation: state.lastActivation,
		sessionAge: state.turnCount,
		toolCallsSinceLastTick: [],
		totalToolCalls: state.metaLearning.toolTracking.totalToolsUsed,
		silentTurns: state.stats.totalTicks > 0
			? Math.max(0, state.stats.totalTicks - (state.metaLearning.toolTracking.lastToolCallTurn || 0))
			: 0,
		// Module metadata wired from tracking data
		metadata: {
			toolFailures: state.metaLearning.toolTracking.totalToolsUsed > 10
				? Math.max(0, Math.floor(state.metaLearning.toolTracking.totalToolsUsed * 0.15))
				: 0,
			decompositionDepth: 0,
		},
	};

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

				// D0.5: Register pending signal for meta-learning
				state.metaLearning.pendingSignals.set(module.name, state.turnCount);
				state.metaLearning.activationSignalWindow.set(module.name, state.turnCount);

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
	const builtInModules: CognitiveModule[] = [recallerModule, dreamerModule, contextHygieneModule, measurementModule, evolverModule];

	// ── Timer Module ──────────────────────────────────────────────────
	// Bridges timer fires from timer extension → heartbeat → agent reminder
	// Timer extension emits via timer-bus; we drain and surface as reminders
	const timerReminderModule: CognitiveModule = {
		name: "timer-reminder",
		description: "Surface pending timer reminders to the agent",
		priority: 90, // High priority — reminders are urgent
		shouldActivate: () => true, // Always activate on tick
		activate: async (ctx: ModuleContext) => {
			try {
				const { drainTimerReminders } = await import("../../../lib/timer-bus.js");
				const reminders = drainTimerReminders();
				for (const { timer } of reminders) {
					ctx.ctx.whisper?.(
						`⏰ [TIMER REMINDER] — ${timer.reason}\n` +
						`Timer ID: ${timer.id}` +
						(timer.tag ? ` (tag: ${timer.tag})` : "") +
						`\nFired at: ${new Date(timer.firesAt).toLocaleTimeString()}`,
						{ category: "cognitive", priority: "medium" },
					);
				}
			} catch {
				// Timer bus not loaded (timer extension not loaded) — silent ignore
			}
		},
	};

	builtInModules.push(timerReminderModule);

	// ── Event: turn_end ───────────────────────────────────────────────

	pi.on("turn_end", async (_event: any, ctx: ExtensionContext) => {
		const state = getState(ctx);
		if (!state.enabled || !config.enabled) return;

		state.turnCount++;

		// D0.5: Use adaptive interval from meta-learning
		const interval = getAdaptiveInterval(state, config);
		if (state.turnCount % interval !== 0) return;

		tick(pi, state, config, ctx);
	});

	// D0.3: Track tool calls for policy evaluation
	// D0.5: Track for meta-learning signal detection
	pi.on("tool_call", (event: any, ctx: ExtensionContext) => {
		const state = getState(ctx);

		// D0.5: Increment tool count for signal detection
		if (state.metaLearning.pendingSignals.size > 0) {
			state.metaLearning.postActivationToolCount++;
		}

		// TIER 1: Update persistent tool tracking (removed early return)
		state.metaLearning.toolTracking.totalToolsUsed++;
		state.metaLearning.toolTracking.lastToolCallTurn = state.policyTurnCount;

		const sessionId = ctx.cwd ?? String(process.pid);
		const toolName = event?.toolName as string;
		if (!toolName) return;

		// Update specific tracking categories
		if (VERIFICATION_TOOLS.has(toolName)) {
			state.metaLearning.toolTracking.verificationCount++;
			state.metaLearning.toolTracking.lastVerificationTurn = state.policyTurnCount;
		}
		if (WEB_TOOLS.has(toolName)) {
			state.metaLearning.toolTracking.lastWebFetchTurn = state.policyTurnCount;
		}
		if (CODE_TOOLS.has(toolName)) {
			state.metaLearning.toolTracking.lastCodeExecutionTurn = state.policyTurnCount;
		}

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

		const onSignal = (type: string, data: Record<string, unknown>) => {
			state.activationHistory.push({
				tick: state.stats.totalTicks,
				moduleName: type,
				timestamp: Date.now(),
				reason: "policy",
			});
		};

		const defaultPolicies = createDefaultPolicies(
			() => state.metaLearning.toolTracking,
			onSignal,
			(msg: string) => ctx.whisper?.(msg, { category: "cognitive", priority: "low" }),
		);
		for (const policy of defaultPolicies) {
			engine.register(policy);
		}
		log.info(`Policy engine initialized with ${defaultPolicies.length} default policies (tool tracking active)`);

		// TIER 1 CRITICAL: Activate the policy engine - was defined but never called!
		// Without this, cognitive modules (recaller, dreamer, contextHygiene, evolver) never fire.
		activatePolicyEngine(engine, state, ctx);
	});

	// ── Event: agent_end ──────────────────────────────────────────────

	pi.on("agent_end", async (_event: any, ctx: ExtensionContext) => {
		const state = getState(ctx);
		const outcome = _event?.outcome as string | undefined;
		log.info(`Session ended. Ticks: ${state.stats.totalTicks}, ` +
			`Activations: ${state.stats.totalActivations}, ` +
			`Tools: ${state.metaLearning.toolTracking.totalToolsUsed}, ` +
			`Outcome: ${outcome ?? "unknown"}`);
		for (const [name, count] of Object.entries(state.stats.activationsByModule)) {
			log.info(`  ${name}: ${count} activations`);
		}
		// TIER 1: Record outcome episode for future recall
		try {
			const { addEpisode } = await import("../../memory/three-memory-stores/index.js");
			const memState = getMemoryState(ctx);
			if (memState) {
				const success = outcome === "success" || !_event?.error;
				addEpisode(memState, "session_outcome",
					`Ticks:${state.stats.totalTicks} Tools:${state.metaLearning.toolTracking.totalToolsUsed} Outcome:${outcome ?? "unknown"}`,
					success ? "success" : "partial",
					[],
					["session", "outcome"],
				);
				log.info(`[heartbeat] Outcome episode recorded: ${success ? "success" : "partial"}`);
			}
		} catch (err) {
			log.warn(`[heartbeat] Could not record outcome episode: ${err}`);
		}
	});

	// ── Event: session_shutdown ───────────────────────────────────────

	pi.on("session_shutdown", async (_event: any, ctx: ExtensionContext) => {
		cleanupSession(ctx.cwd);
		log.info("Heartbeat scheduler shutting down");
	});

	// ── Policy Engine (inside heartbeatExtension) ────────────────────────────────

	/** TIER 1 CRITICAL FIX: activatePolicyEngine was defined but never called.
	 *  Without this, the policy engine is instantiated but never activated,
	 *  meaning cognitive modules never fire on turns.
	 */
	function activatePolicyEngine(
		engine: PolicyEngine,
		state: HeartbeatState,
		_ctx: ExtensionContext,
	): void {
		const originalEvaluate = engine.evaluate.bind(engine);
		engine.evaluate = async (context: PolicyContext) => {
			const fired = await originalEvaluate(context);
			if (fired.length > 0) {
				for (const policy of fired) {
					state.policyLastFire.set(policy.id, state.policyTurnCount);
				}
			}
			return fired;
		};
		log.info("[heartbeat] Policy engine activated - cognitive modules will fire on turns");
	}
}

// ── Module-level: PolicyEngine interface ────────────────────────────────────

interface PolicyEngine {
	register(policy: Policy): void;
	unregister(id: string): boolean;
	evaluate(context: PolicyContext): Promise<Policy[]>;
}

// ── Exports ──────────────────────────────────────────────────────────────────


// ── Message Interpolation ─────────────────────────────────────────────────────────

/** Replace {placeholder} in message with values from context dict. */
function interpolateMessage(message: string, ctx: Record<string, number | string>): string {
	let result = message;
	for (const [key, value] of Object.entries(ctx)) {
		result = result.replace(new RegExp(`\{${key}(?:%|\}|[^a-zA-Z])`, "g"), String(value));
	}
	// Fallback: simple {key} replacement
	for (const [key, value] of Object.entries(ctx)) {
		result = result.replace(new RegExp(`\{${key}\}`, "g"), String(value));
	}
	return result;
}

export { recallerModule, dreamerModule, contextHygieneModule, evolverModule };
