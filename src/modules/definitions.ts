/**
 * Module definitions for pi-braid.
 *
 * Each module groups extensions by **actual coupling** (shared events, tools,
 * state, or research paper) rather than just conceptual similarity.
 *
 * See COUPLING.md for the full event/tool/state dependency matrix.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ── Extension imports ────────────────────────────────────────────────────────

import corePolyfillFn from "../extensions/core/polyfill/index.js";
import coreMetacognitionFn from "../extensions/core/metacognition/index.js";
import corePlannerFn from "../extensions/core/planner/index.js";
import coreScratchpadFn from "../extensions/core/scratchpad/index.js";
import corePreprocessorFn from "../extensions/core/user-message-preprocessor/index.js";

import cognitiveSystemsFn from "../extensions/cognitive/cognitive-systems/index.js";
import reasoningFn from "../extensions/cognitive/reasoning/index.js";
import enforcementFn from "../extensions/cognitive/enforcement/index.js";
import verificationFn from "../extensions/cognitive/verification/index.js";
import topicDriftFn from "../extensions/cognitive/topic-drift/index.js";
import sycophancyDetectorFn from "../extensions/cognitive/sycophancy-detector/index.js";

import memoryStoresFn from "../extensions/memory/three-memory-stores/index.js";
import sessionRecallFn from "../extensions/memory/session-recall/index.js";
import contextManagerFn from "../extensions/memory/context-manager/index.js";
import contextLifecycleFn from "../extensions/memory/context-lifecycle/index.js";

import heartbeatSchedulerFn from "../extensions/heartbeat/heartbeat-scheduler/index.js";
import analyticsFn from "../extensions/heartbeat/analytics/index.js";

import retryFn from "../extensions/retry/retry/index.js";
import errorCaptureFn from "../extensions/retry/error-capture/index.js";

import promptBuilderFn from "../extensions/prompt/prompt-builder/index.js";
import promptGuardianFn from "../extensions/prompt/prompt-guardian/index.js";

import codebaseTreeFn from "../extensions/tools/codebase-tree/index.js";
import codebaseGraphFn from "../extensions/tools/codebase-graph/index.js";
import replFn from "../extensions/tools/repl/index.js";
import docsFn from "../extensions/tools/docs/index.js";
import healthcheckFn from "../extensions/tools/healthcheck/index.js";
import timerFn from "../extensions/tools/timer/index.js";
import latentActivatorFn from "../extensions/tools/latent-activator/index.js";

import browserFn from "../extensions/tools/browser/index.js";
import webFetchFn from "../extensions/tools/web-fetch/index.js";
import visionFn from "../extensions/tools/vision/index.js";

import assistantFn from "../extensions/assistant/assistant/index.js";
import feedbackFn from "../extensions/assistant/feedback/index.js";

import evolveFn from "../extensions/evolve/evolve/index.js";
import watchdogFn from "../extensions/watchdog/watchdog/index.js";
import rateLimiterFn from "../extensions/rate-limiter/rate-limiter/index.js";
import agentEnvFn from "../extensions/agent-environment/agent-environment/index.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SubExtension {
	name: string;
	fn: (pi: ExtensionAPI) => Promise<void> | void;
}

export interface ModuleDef {
	/** Unique identifier (used in config, env var, and subagent API) */
	name: string;
	/** Human-readable label */
	label: string;
	/** Short description */
	description: string;
	/** Research paper reference (if any) */
	paper?: string;
	/** Core modules that cannot be disabled */
	alwaysOn?: boolean;
	/** Disabled by default (opt-in only) */
	disabledByDefault?: boolean;
	/** Module names this depends on (loaded first) */
	dependencies?: string[];
	/** Sub-extensions belonging to this module */
	extensions: SubExtension[];
	/** Key events this module listens to (for coupling documentation) */
	listensTo?: string[];
	/** Extensions outside this module that share events or state (documentation) */
	coupledWith?: { module: string; via: string }[];
}

// ──── Module Definitions (grouped by actual coupling) ──────────────────────

export const MODULE_DEFINITIONS: ModuleDef[] = [
	// ═════════════════════════════════════════════════════════════════════
	// CORE — Foundation layer (always on, no dependencies)
	// Coupling: polyfill patches pi API used by all others; preprocessor
	//   modifies input stream before enforcement sees it;
	//   planner+scratchpad+metacognition form the metacognitive tool stack.
	// ═════════════════════════════════════════════════════════════════════
	{
		name: "core",
		label: "Core",
		description: "Foundation: polyfill, metacognition, planner, scratchpad, preprocessor",
		alwaysOn: true,
		extensions: [
			{ name: "polyfill",              fn: corePolyfillFn },
			{ name: "metacognition",          fn: coreMetacognitionFn },
			{ name: "planner",               fn: corePlannerFn },
			{ name: "scratchpad",            fn: coreScratchpadFn },
			{ name: "user-message-preprocessor", fn: corePreprocessorFn },
		],
		listensTo: ["session_start", "before_agent_start", "agent_end", "input"],
		coupledWith: [
			{ module: "enforcement", via: "input event" },
			{ module: "prompt", via: "before_agent_start event" },
		],
	},

	// ═════════════════════════════════════════════════════════════════════
	// COGNITIVE — Behavioral enforcement + reasoning quality
	// Coupling: enforcement listens to 10+ events (pervasive).
	//   reasoning, verification, topic-drift, cognitive-systems are
	//   tool-only (no event listeners) — coupled by concept, not events.
	// ═════════════════════════════════════════════════════════════════════
	{
		name: "cognitive",
		label: "Cognitive Systems",
		description: "RepE enforcement, structured reasoning, evidence pool, verification, topic-drift, sycophancy detection",
		paper: "RepE Contrast / Evidence-Based Reasoning / Silicon Mirror (2604.19117)",
		dependencies: ["core"],
		extensions: [
			{ name: "cognitive-systems",     fn: cognitiveSystemsFn },
			{ name: "reasoning",             fn: reasoningFn },
			{ name: "enforcement",           fn: enforcementFn },
			{ name: "verification",          fn: verificationFn },
			{ name: "topic-drift",           fn: topicDriftFn },
			{ name: "sycophancy-detector",   fn: sycophancyDetectorFn },
		],
		listensTo: [
			"session_start", "session_shutdown", "input", "agent_end",
			"message_end", "tool_call", "tool_end", "turn_end",
			"session_compact", "auto_retry_end",
		],
		coupledWith: [
			{ module: "memory", via: "tool_end, turn_end" },
			{ module: "retry", via: "auto_retry_end" },
			{ module: "heartbeat", via: "turn_end" },
		],
	},

	// ═════════════════════════════════════════════════════════════════════
	// MEMORY — Three-store memory + session recall + context lifecycle
	// Coupling: all share session custom entries + extension-state.
	//   three-memory-stores listens to session, tool, turn, agent events.
	//   session-recall listens to model_select + turn_end.
	//   context-lifecycle listens to session_start, before_agent_start.
	//   context-manager provides compaction tools (no event listeners).
	// Paper: 2604.14475 (Three Memory Stores)
	// ═════════════════════════════════════════════════════════════════════
	{
		name: "memory",
		label: "Memory Stores",
		description: "Three memory stores, session recall, context compaction + lifecycle",
		paper: "Three Memory Stores (2604.14475)",
		dependencies: ["core"],
		extensions: [
			{ name: "three-memory-stores",   fn: memoryStoresFn },
			{ name: "session-recall",        fn: sessionRecallFn },
			{ name: "context-manager",       fn: contextManagerFn },
			{ name: "context-lifecycle",     fn: contextLifecycleFn },
		],
		listensTo: [
			"session_start", "session_shutdown", "agent_end",
			"tool_end", "turn_end", "model_select", "before_agent_start", "tool_call",
		],
		coupledWith: [
			{ module: "cognitive", via: "turn_end, tool_end" },
			{ module: "heartbeat", via: "session_shutdown" },
		],
	},

	// ═════════════════════════════════════════════════════════════════════
	// HEARTBEAT — Proactive cognitive scheduling
	// Coupling: heartbeat-scheduler provides the timing tick; analytics
	//   provides metrics that inform policy decisions.
	//   Both listen to turn_end + session_start + session_shutdown.
	// Paper: 2604.14178 (Cognitive Heartbeat)
	// ═════════════════════════════════════════════════════════════════════
	{
		name: "heartbeat",
		label: "Heartbeat Scheduler",
		description: "Proactive cognitive scheduling with policy engine + analytics",
		paper: "Cognitive Heartbeat (2604.14178)",
		dependencies: ["core", "memory"],
		extensions: [
			{ name: "heartbeat-scheduler",   fn: heartbeatSchedulerFn },
			{ name: "analytics",            fn: analyticsFn },
		],
		listensTo: [
			"session_start", "session_shutdown", "agent_end",
			"turn_end", "tool_call", "tool_execution_start", "tool_execution_end",
		],
		coupledWith: [
			{ module: "cognitive", via: "turn_end" },
			{ module: "memory", via: "session_shutdown" },
		],
	},

	// ═════════════════════════════════════════════════════════════════════
	// RETRY — Error recovery with backoff
	// Coupling: retry listens to input, agent_end, auto_retry events;
	//   error-capture listens to turn_end + registers error analysis tools.
	//   Both handle failures — one at user level, one at tool level.
	// ═════════════════════════════════════════════════════════════════════
	{
		name: "retry",
		label: "Error Recovery",
		description: "/retry command, auto-retry with backoff, error classification",
		dependencies: ["core"],
		extensions: [
			{ name: "retry",                 fn: retryFn },
			{ name: "error-capture",         fn: errorCaptureFn },
		],
		listensTo: ["session_start", "input", "agent_end", "turn_end", "after_provider_response", "auto_retry_start", "auto_retry_end"],
		coupledWith: [
			{ module: "cognitive", via: "auto_retry_end" },
		],
	},

	// ═════════════════════════════════════════════════════════════════════
	// PROMPT — Prompt builder + injection defence
	// Coupling: both hook into before_agent_start to inject/validate prompts.
	// ═════════════════════════════════════════════════════════════════════
	{
		name: "prompt",
		label: "Prompt Management",
		description: "System prompt builder, prompt injection detection",
		dependencies: ["core"],
		extensions: [
			{ name: "prompt-builder",        fn: promptBuilderFn },
			{ name: "prompt-guardian",       fn: promptGuardianFn },
		],
		listensTo: ["session_start", "phase_start", "session_shutdown", "before_agent_start"],
		coupledWith: [],
	},

	// ═════════════════════════════════════════════════════════════════════
	// TOOLS — Workspace utility tools (no event listeners, pure tool extensions)
	// ═════════════════════════════════════════════════════════════════════
	{
		name: "tools",
		label: "Utility Tools",
		description: "Codebase tree, REPL, docs reader, healthcheck, timer, latent activator",
		dependencies: ["core"],
		extensions: [
			{ name: "codebase-tree",         fn: codebaseTreeFn },
			{ name: "codebase-graph",       fn: codebaseGraphFn },
			{ name: "repl",                 fn: replFn },
			{ name: "docs",                 fn: docsFn },
			{ name: "healthcheck",          fn: healthcheckFn },
			{ name: "timer",                fn: timerFn },
			{ name: "latent-activator",     fn: latentActivatorFn },
		],
		listensTo: ["turn_end"], // timer only
		coupledWith: [],
	},

	// ═════════════════════════════════════════════════════════════════════
	// BROWSER — Web interaction via CDP
	// ═════════════════════════════════════════════════════════════════════
	{
		name: "browser",
		label: "Browser Automation",
		description: "Browser CDP, web fetch, image analysis",
		dependencies: ["core"],
		extensions: [
			{ name: "browser",               fn: browserFn },
			{ name: "web-fetch",            fn: webFetchFn },
			{ name: "vision",               fn: visionFn },
		],
		listensTo: ["session_shutdown"], // browser only
		coupledWith: [],
	},

	// ═════════════════════════════════════════════════════════════════════
	// ASSISTANT — State persistence + UX + feedback whisper
	// Coupling: all three are user-facing. assistant + feedback listen to
	//   session events; ux listens to input/agent_end.
	// ═════════════════════════════════════════════════════════════════════
	{
		name: "assistant",
		label: "Assistant & UX",
		description: "Assistant identity state, feedback whisper, notifications",
		dependencies: ["core"],
		extensions: [
			{ name: "assistant",             fn: assistantFn },
			{ name: "feedback",             fn: feedbackFn },
		],
		listensTo: [
			"session_start", "session_tree", "agent_start", "turn_start",
			"message_end", "tool_call", "turn_end", "before_agent_start",
		],
		coupledWith: [
			{ module: "cognitive", via: "message_end, tool_call" },
		],
	},

	// ═════════════════════════════════════════════════════════════════════
	// WATCHDOG — Error monitoring (opt-in, verbose)
	// Coupling: standalone, listens to session_start + agent_end + message_end
	// ═════════════════════════════════════════════════════════════════════
	{
		name: "watchdog",
		label: "Watchdog",
		description: "Session monitoring and error alerting",
		disabledByDefault: true,
		dependencies: ["core"],
		extensions: [
			{ name: "watchdog",              fn: watchdogFn },
		],
		listensTo: ["session_start", "agent_end", "message_end"],
		coupledWith: [],
	},

	// ═════════════════════════════════════════════════════════════════════
	// EVOLVE — Self-maintenance / checkpointing (opt-in, disruptive)
	// ═════════════════════════════════════════════════════════════════════
	{
		name: "evolve",
		label: "Self-Evolution",
		description: "Health-based checkpointing, degradation detection, rollback",
		disabledByDefault: true,
		dependencies: ["core"],
		extensions: [
			{ name: "evolve",                fn: evolveFn },
		],
		listensTo: ["session_shutdown"],
		coupledWith: [],
	},

	// ═════════════════════════════════════════════════════════════════════
	// RATE-LIMITER — Usage throttling (opt-in, experimental)
	// ═════════════════════════════════════════════════════════════════════
	{
		name: "rate-limiter",
		label: "Rate Limiter",
		description: "API rate limiting and usage management",
		disabledByDefault: true,
		dependencies: ["core"],
		extensions: [
			{ name: "rate-limiter",          fn: rateLimiterFn },
		],
		listensTo: ["session_shutdown", "context"],
		coupledWith: [],
	},

	// ═════════════════════════════════════════════════════════════════════
	// AGENT-ENVIRONMENT — Runtime context for agent execution
	// ═════════════════════════════════════════════════════════════════════
	{
		name: "agent-environment",
		label: "Agent Environment",
		description: "Runtime execution context provider",
		disabledByDefault: true,
		dependencies: ["core"],
		extensions: [
			{ name: "agent-environment",     fn: agentEnvFn },
		],
		listensTo: ["session_start", "message_end"],
		coupledWith: [],
	},
];

// ── Lookup helpers ──────────────────────────────────────────────────────────

const _byName = new Map(MODULE_DEFINITIONS.map((m) => [m.name, m]));

export function getModuleDef(name: string): ModuleDef | undefined {
	return _byName.get(name);
}

export function getAllModuleNames(): string[] {
	return MODULE_DEFINITIONS.map((m) => m.name);
}

export function getDefaultEnabledModules(): string[] {
	return MODULE_DEFINITIONS
		.filter((m) => !m.disabledByDefault)
		.map((m) => m.name);
}
