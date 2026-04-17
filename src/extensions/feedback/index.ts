/**
 * Feedback & Tuning Extension - Phase 4
 *
 * Uses the whisper pattern (before_agent_start event) to inject
 * feedback and nudges as visible messages with purple background.
 *
 * Integrates all enforcement framework components:
 * 1. Smart nudge generator - Context-aware, rate-limited nudges
 * 2. A/B testing framework - Test different enforcement rules
 * 3. Per-model preferences - Model-specific configurations
 * 4. Integration hub - Connects analytics, enforcement, adaptive
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult, ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Whisper System - Send feedback messages immediately

let pendingWhisper: string | null = null;

/**
 * Send a feedback whisper immediately using pi.sendMessage().
 * This injects the whisper right away instead of waiting for before_agent_start,
 * which only fires when user sends a message (causing whisper accumulation).
 */
function sendFeedbackWhisper(pi: ExtensionAPI, message: string): void {
	pi.sendMessage(
		{
			customType: "feedback",
			content: [{ type: "text" as const, text: message }],
			display: true,
		},
		{ deliverAs: "steer" },
	);
}

/**
 * Queue a feedback whisper to be injected on the next agent turn.
 * DEPRECATED: Now sends immediately via sendFeedbackWhisper.
 * Kept for backward compatibility.
 */
function _queueFeedbackWhisper(message: string): void {
	// Just store for potential debugging/audit purposes
	if (pendingWhisper) {
		pendingWhisper = `${pendingWhisper}\n\n${message}`;
	} else {
		pendingWhisper = message;
	}
}

// Types

interface Nudge {
	id: string;
	timestamp: number;
	type: NudgeType;
	severity: "info" | "warning" | "critical";
	message: string;
	triggeredBy: string;
	action?: string;
	acknowledged: boolean;
}

type NudgeType =
	| "silent_turn"
	| "sequence_repetition"
	| "tool_ineffective"
	| "scratchpad_missing"
	| "hallucination_detected"
	| "phase_mismatch"
	| "success_tip"
	| "think_tool_missing";

interface ABTest {
	id: string;
	name: string;
	variantA: Record<string, unknown>;
	variantB: Record<string, unknown>;
	active: boolean;
	results: {
		variantA: { impressions: number; success: number };
		variantB: { impressions: number; success: number };
	};
}

interface ModelPreferences {
	modelId: string;
	preferences: {
		requireReasoning: boolean;
		requirePlan: boolean;
		enforceScratchpad: boolean;
		maxSilentTurns: number;
		nudgeFrequency: "low" | "medium" | "high";
		preferredTools: string[];
		avoidTools: string[];
	};
}

interface FeedbackConfig {
	nudgeCooldownMs: number;
	maxNudgesPerTurn: number;
	enableABTesting: boolean;
	enableModelPreferences: boolean;
	smartNudgeThreshold: number; // 0-1, only nudge if confidence > threshold
	// Think tool enforcement - nudge every N turns without think tool call
	thinkToolEnforcementTurns: number; // 0 to disable, N turns without think tool to nudge
}

// Configuration

const DEFAULT_CONFIG: FeedbackConfig = {
	nudgeCooldownMs: 3000,
	maxNudgesPerTurn: 2,
	enableABTesting: false,
	enableModelPreferences: true,
	smartNudgeThreshold: 0.6,
	// Modern models use think() tool - enforce every N turns
	thinkToolEnforcementTurns: 5, // 0 to disable, 5 turns without think tool to nudge
};

const STORAGE_DIR = join(homedir(), ".pi/agent/feedback");
const NUDGE_HISTORY_FILE = join(STORAGE_DIR, "nudge-history.jsonl");
const AB_TESTS_FILE = join(STORAGE_DIR, "ab-tests.json");
const MODEL_PREFS_FILE = join(STORAGE_DIR, "model-preferences.json");
const CONFIG_FILE = join(STORAGE_DIR, "config.json");

// State

const state = {
	config: loadConfig(),
	nudgeHistory: [] as Nudge[],
	activeNudges: [] as Nudge[],
	recentNudges: [] as string[], // Recent nudge message hashes
	abTests: loadABTests(),
	modelPreferences: loadModelPreferences(),
	lastNudgeTime: 0,
	nudgeCountThisTurn: 0,
	currentTurn: 0,
	// Analytics integration
	analyticsPath: join(homedir(), ".pi/agent/analytics/tool-analytics.jsonl"),
	// Track think tool usage for enforcement
	lastThinkToolTurn: -1, // Turn index when think tool was last called
	thinkToolNudgeActive: false, // Prevent spam for think tool enforcement
};

// Persistence

function ensureStorageDir(): void {
	if (!existsSync(STORAGE_DIR)) {
		mkdirSync(STORAGE_DIR, { recursive: true });
	}
}

function loadConfig(): FeedbackConfig {
	ensureStorageDir();
	const path = CONFIG_FILE;
	if (!existsSync(path)) {
		return { ...DEFAULT_CONFIG };
	}
	try {
		return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(path, "utf-8")) };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function _saveConfig(): void {
	ensureStorageDir();
	writeFileSync(CONFIG_FILE, JSON.stringify(state.config, null, 2));
}

function loadNudgeHistory(): Nudge[] {
	ensureStorageDir();
	const path = NUDGE_HISTORY_FILE;
	if (!existsSync(path)) {
		return [];
	}
	try {
		const content = readFileSync(path, "utf-8");
		const lines = content.trim().split("\n");
		return lines.map((l) => JSON.parse(l)).slice(-100); // Keep last 100
	} catch {
		return [];
	}
}

function loadABTests(): ABTest[] {
	ensureStorageDir();
	const path = AB_TESTS_FILE;
	if (!existsSync(path)) {
		return getDefaultABTests();
	}
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return getDefaultABTests();
	}
}

function getDefaultABTests(): ABTest[] {
	return [
		{
			id: "nudge-frequency",
			name: "Nudge Frequency Test",
			variantA: { nudgeCooldownMs: 5000, maxNudgesPerTurn: 1 },
			variantB: { nudgeCooldownMs: 2000, maxNudgesPerTurn: 3 },
			active: false,
			results: {
				variantA: { impressions: 0, success: 0 },
				variantB: { impressions: 0, success: 0 },
			},
		},
		{
			id: "reasoning-required",
			name: "Require Reasoning Block Test",
			variantA: { requireReasoning: false },
			variantB: { requireReasoning: true },
			active: false,
			results: {
				variantA: { impressions: 0, success: 0 },
				variantB: { impressions: 0, success: 0 },
			},
		},
	];
}

function saveABTests(): void {
	ensureStorageDir();
	writeFileSync(AB_TESTS_FILE, JSON.stringify(state.abTests, null, 2));
}

function loadModelPreferences(): Record<string, ModelPreferences["preferences"]> {
	ensureStorageDir();
	const path = MODEL_PREFS_FILE;
	if (!existsSync(path)) {
		return {};
	}
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}

function _saveModelPreferences(): void {
	ensureStorageDir();
	writeFileSync(MODEL_PREFS_FILE, JSON.stringify(state.modelPreferences, null, 2));
}

// Smart Nudge Generator

/**
 * Generate a smart nudge based on context
 */
function generateNudge(
	type: NudgeType,
	context: Record<string, unknown>,
): { message: string; severity: "info" | "warning" | "critical"; action?: string } {
	switch (type) {
		case "think_tool_missing": {
			const turnsSince = context.turnsSince as number;
			return {
				severity: "info",
				message: `Consider using think() tool to record structured reasoning.\n\n${turnsSince} turn(s) since think() was called. Use think() to track:\n- Observation: what you discovered\n- Decision: what you decided\n- Reason: why you made that choice`,
				action: "Call think() tool to record your reasoning.",
			};
		}

		case "silent_turn": {
			const silentCount = context.silentTurns as number;
			return {
				severity: "critical",
				message: `You have ${silentCount} turn(s) without calling any tools. You work through tools - reach for: read, grep, find, bash, edit, write, think, scratchpad.\n\nYou don't describe what you would do - you do it with tools.`,
				action: "Call at least one tool in your next response.",
			};
		}

		case "sequence_repetition": {
			const tool = context.toolName as string;
			const count = context.count as number;
			return {
				severity: "warning",
				message: `You're repeating the same tool (${tool}) ${count} times in a row. Consider:\n- Is this the right approach?\n- Are you stuck in a loop?\n- Should you try a different approach?`,
					};
		}

		case "tool_ineffective": {
			const ineffectiveTool = context.toolName as string;
			const tip = context.tip as string;
			return {
				severity: "info",
				message: `Note: ${ineffectiveTool} has low effectiveness. ${tip || "Consider using a different approach."}`,
				action: undefined,
			};
		}

		case "scratchpad_missing":
			return {
				severity: "warning",
				message:
					"You made file changes (edit/write) without updating scratchpad.\n\nUse the scratchpad tool to track:\n- Current goal\n- Decisions made\n- Next steps\n\nThis helps maintain context in long sessions.",
				action: "Call scratchpad tool to update your tracking.",
			};

		case "hallucination_detected":
			return {
				severity: "critical",
				message:
					"HALLUCINATION DETECTED: You claimed work is complete without actually doing it.\n\nYou verify your work:\n1. Run the actual tests\n2. Verify files were created/modified\n3. You don't claim success without evidence\n\nYour claim has been noted. Provide actual verification.",
				action: "Run verification commands and show the actual results.",
			};

		case "phase_mismatch": {
			const expected = (context.expected as string[]) || [];
			const received = context.received as string;
			return {
				severity: "info",
				message: `Unusual tool for current phase: ${received}\nExpected tools: ${expected.join(", ") || "any"}\n\nThis is informational only. Continue if intentional.`,
				action: undefined,
			};
		}

		case "success_tip": {
			const tipTool = context.tool as string;
			const successRate = context.successRate as number;
			return {
				severity: "info",
				message: `💡 Tip: ${tipTool} has ${((successRate as number) * 100).toFixed(0)}% success rate in similar tasks.\n\nConsider using it if appropriate.`,
				action: undefined,
			};
		}

		default:
			return {
				severity: "info",
				message: (context.message as string) || "General feedback",
				action: undefined,
			};
	}
}

/**
 * Check if we should send this nudge (rate limiting, deduplication)
 */
function shouldSendNudge(nudge: Nudge): boolean {
	const now = Date.now();

	// Cooldown check
	if (now - state.lastNudgeTime < state.config.nudgeCooldownMs) {
		return false;
	}

	// Max nudges per turn check
	if (state.nudgeCountThisTurn >= state.config.maxNudgesPerTurn) {
		return false;
	}

	// Deduplication check (don't repeat same nudge type within 5 turns)
	const recentTypes = state.nudgeHistory.slice(-5).map((n) => n.type);
	if (recentTypes.includes(nudge.type)) {
		// Allow critical nudges to repeat
		if (nudge.severity !== "critical") {
			return false;
		}
	}

	return true;
}

/**
 * Record nudge for analytics
 */
function recordNudge(nudge: Nudge): void {
	state.nudgeHistory.push(nudge);
	state.activeNudges.push(nudge);

	// Keep history manageable
	if (state.nudgeHistory.length > 500) {
		state.nudgeHistory = state.nudgeHistory.slice(-500);
	}

	// Write to file
	ensureStorageDir();
	writeFileSync(NUDGE_HISTORY_FILE, `${JSON.stringify(nudge)}\n`, { flag: "a" });

	state.lastNudgeTime = Date.now();
	state.nudgeCountThisTurn++;
}

// A/B Testing

/**
 * Get current A/B test variant configuration
 */
function getABTestConfig(): Record<string, unknown> {
	const activeTests = state.abTests.filter((t) => t.active);
	if (activeTests.length === 0) {
		return {};
	}

	// Use deterministic assignment based on turn number
	const turnMod = state.currentTurn % 2;
	const variant = turnMod === 0 ? "variantA" : "variantB";

	const _config: Record<string, unknown> = {};
	for (const test of activeTests) {
		const result = test.results[variant];
		result.impressions++;
		saveABTests();
	}

	return Object.assign({}, ...activeTests.map((t) => t[variant === "variantA" ? "variantA" : "variantB"]));
}

/**
 * Record A/B test outcome
 */
function _recordABTestOutcome(success: boolean): void {
	const activeTests = state.abTests.filter((t) => t.active);
	if (activeTests.length === 0) {
		return;
	}

	const turnMod = state.currentTurn % 2;
	const variant = turnMod === 0 ? "variantA" : "variantB";

	for (const test of activeTests) {
		if (success) {
			test.results[variant].success++;
		}
	}

	saveABTests();
}

// Tool Definitions

// feedback_status tool removed (2026-04-15) - use /feedback-stats command instead

// Extension Factory

export default function feedbackExtension(pi: ExtensionAPI) {
	// Admin-only tools - demoted from registerTool to registerCommand
	// These are configuration/debug tools the LLM should not call

	pi.registerCommand("feedback-config", {
		description: "Configure feedback system",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Feedback: ${JSON.stringify(state.config)}`, "info");
		},
	});

	pi.registerCommand("feedback-abtest", {
		description: "Manage A/B tests",
		handler: async (_args, ctx) => {
			const lines = state.abTests.map((t) => `${t.id}: ${t.active ? "active" : "inactive"} - ${t.name}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("feedback-model-prefs", {
		description: "View model preferences",
		handler: async (_args, ctx) => {
			ctx.ui.notify(JSON.stringify(state.modelPreferences), "info");
		},
	});

	pi.registerCommand("feedback-test-nudge", {
		description: "Test nudge generation",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Nudge testing via command", "info");
		},
	});

	// Tools removed (2026-04-15): feedback_status - use /feedback-stats command instead

	// Event Handlers

	// Initialize state on start
	pi.on("agent_start", async () => {
		state.nudgeHistory = loadNudgeHistory();
		state.abTests = loadABTests();
		state.modelPreferences = loadModelPreferences();
	});

	// Reset turn counter at turn start
	pi.on("turn_start", async () => {
		state.currentTurn++;
		state.nudgeCountThisTurn = 0;

		// Apply A/B test config
		if (state.config.enableABTesting) {
			const abConfig = getABTestConfig();
			if (abConfig.nudgeCooldownMs) {
				state.config.nudgeCooldownMs = abConfig.nudgeCooldownMs as number;
			}
			if (abConfig.maxNudgesPerTurn) {
				state.config.maxNudgesPerTurn = abConfig.maxNudgesPerTurn as number;
			}
		}
	});

	// Monitor for issues and generate nudges
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") {
			return;
		}

		// Hallucination detection is handled by the verification judge in enforcement.
		// This regex-based approach is disabled to avoid false positives on informational responses.
		const issues: { type: NudgeType; context: Record<string, unknown> }[] = [];

		// Send nudges
		for (const issue of issues) {
			const nudgeDef = generateNudge(issue.type, issue.context);
			const nudge: Nudge = {
				id: `${issue.type}-${Date.now()}`,
				timestamp: Date.now(),
				type: issue.type,
				severity: nudgeDef.severity,
				message: nudgeDef.message,
				triggeredBy: "message_end",
				action: nudgeDef.action,
				acknowledged: false,
			};

			if (shouldSendNudge(nudge)) {
				recordNudge(nudge);
				sendFeedbackWhisper(pi, nudgeDef.message);
			}
		}
	});

	// Track tool usage for sequence repetition detection
	pi.on("tool_call", async (event) => {
		const toolName = event.toolName;

		// Track repetition
		const recentTools = state.recentNudges.slice(-10);
		const repetitionCount = recentTools.filter((t) => t === toolName).length;

		if (repetitionCount >= 3) {
			const nudge: Nudge = {
				id: `repetition-${Date.now()}`,
				timestamp: Date.now(),
				type: "sequence_repetition",
				severity: "warning",
				message: "",
				triggeredBy: "tool_call",
				acknowledged: false,
			};

			const nudgeDef = generateNudge("sequence_repetition", {
				toolName,
				count: repetitionCount,
			});
			nudge.message = nudgeDef.message;
			nudge.action = nudgeDef.action;

			if (shouldSendNudge(nudge)) {
				recordNudge(nudge);
				sendFeedbackWhisper(pi, nudgeDef.message);
			}
		}

		state.recentNudges.push(toolName);
		if (state.recentNudges.length > 20) {
			state.recentNudges.shift();
		}

		// Track think tool usage
		if (toolName === "think") {
			state.lastThinkToolTurn = state.currentTurn;
			state.thinkToolNudgeActive = false; // Reset when think tool is called
		}
	});

	// Track scratchpad usage and enforce think tool cadence
	pi.on("turn_end", async (event) => {
		const tools = (event.toolResults || []).map((r) => r.toolName);

		// Scratchpad missing nudge
		const madeFileChanges = tools.some((t) => ["edit", "write"].includes(t));
		const usedScratchpad = tools.includes("scratchpad");

		if (madeFileChanges && !usedScratchpad) {
			const nudgeDef = generateNudge("scratchpad_missing", {});
			const nudge: Nudge = {
				id: `scratchpad-${Date.now()}`,
				timestamp: Date.now(),
				type: "scratchpad_missing",
				severity: "warning",
				message: nudgeDef.message,
				triggeredBy: "turn_end",
				action: nudgeDef.action,
				acknowledged: false,
			};

			if (shouldSendNudge(nudge)) {
				recordNudge(nudge);
				sendFeedbackWhisper(pi, nudgeDef.message);
			}
		}

		// Think tool enforcement - nudge every N turns without think tool
		const turnsSinceThink = state.currentTurn - state.lastThinkToolTurn;
		if (
			state.config.thinkToolEnforcementTurns > 0 &&
			turnsSinceThink >= state.config.thinkToolEnforcementTurns &&
			!state.thinkToolNudgeActive
		) {
			state.thinkToolNudgeActive = true;
			const nudgeDef = generateNudge("think_tool_missing", { turnsSince: turnsSinceThink });
			const nudge: Nudge = {
				id: `think-${Date.now()}`,
				timestamp: Date.now(),
				type: "think_tool_missing",
				severity: "info",
				message: nudgeDef.message,
				triggeredBy: "turn_end",
				action: nudgeDef.action,
				acknowledged: false,
			};

			if (shouldSendNudge(nudge)) {
				recordNudge(nudge);
				sendFeedbackWhisper(pi, nudgeDef.message);
			}
		}
	});

	// Before Agent Start: No-op (whispers are now sent immediately)
	// NOTE: Feedback nudges are now sent IMMEDIATELY in message_end/turn_end via pi.sendMessage().
	// This fixes the bug where whispers accumulated and only appeared when user sent a message.
	// The before_agent_start handler is kept as a no-op for backward compatibility.

	pi.on("before_agent_start", async (_event) => {
		// Whispers are now sent immediately - nothing to do here
		return undefined;
	});

	// Commands

	pi.registerCommand("feedback-stats", {
		description: "Show feedback system statistics",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Nudges: ${state.nudgeHistory.length} total, ${state.nudgeCountThisTurn} this turn`, "info");
		},
	});

	pi.registerCommand("feedback-reset", {
		description: "Reset feedback system state",
		handler: async (_args, ctx) => {
			state.nudgeHistory = [];
			state.activeNudges = [];
			state.recentNudges = [];
			state.nudgeCountThisTurn = 0;
			state.lastNudgeTime = 0;
			ctx.ui.notify("Feedback system state reset", "info");
		},
	});

	pi.registerCommand("feedback-report", {
		description: "Generate full feedback report",
		handler: async (_args, ctx) => {
			const lines: string[] = ["# Feedback System Report"];
			lines.push(`Generated: ${new Date().toLocaleString()}`);
			lines.push("");
			lines.push("## Configuration");
			lines.push(JSON.stringify(state.config, null, 2));
			lines.push("");
			lines.push("## Nudge Statistics");

			const nudgeTypes: Record<string, number> = {};
			for (const n of state.nudgeHistory) {
				nudgeTypes[n.type] = (nudgeTypes[n.type] || 0) + 1;
			}

			for (const [type, count] of Object.entries(nudgeTypes).sort((a, b) => b[1] - a[1])) {
				lines.push(`- ${type}: ${count}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
