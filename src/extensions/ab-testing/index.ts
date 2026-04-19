/**
 * A/B Testing Framework Extension for pi-braid
 *
 * Based on research from "Prompt Optimization Is a Coin Flip" (arXiv:2604.14585):
 * - 49% of prompt optimization runs score BELOW zero-shot baseline
 * - Optimization only helps when task has "exploitable output structure"
 * - Without empirical validation, we don't know if signals help or hurt
 *
 * This extension tests:
 * - CONTROL: No/minimal enforcement signals
 * - TREATMENT: Full enforcement signals (as currently configured)
 *
 * Tracks outcomes to determine which approach works better.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Variant = "control" | "treatment";

export interface ABConfig {
	/** Probability of assignment to treatment (default: 0.5) */
	treatmentProbability: number;
	/** Minimum runs before computing statistics (default: 20) */
	minRunsForStats: number;
	/** Enable/disable the A/B test (default: true) */
	enabled: boolean;
	/** Store results in memory instead of file (default: false) */
	inMemoryOnly: boolean;
	/** Signal types to test (default: all) */
	signalTypes?: string[];
}

export interface TurnOutcome {
	/** Unique run identifier */
	runId: string;
	/** Session identifier */
	sessionId: string;
	/** Assigned variant */
	variant: Variant;
	/** Turn number within run */
	turnIndex: number;
	/** Whether task succeeded */
	success: boolean;
	/** Total tokens used in this turn */
	tokensUsed: number;
	/** Number of tools called */
	toolCount: number;
	/** Timestamp */
	timestamp: number;
	/** Optional: quality score if available (0-1) */
	qualityScore?: number;
	/** Signal types that were active in this turn */
	activeSignals: string[];
	/** Time spent on turn (ms) */
	durationMs: number;
}

export interface RunOutcome {
	/** Unique run identifier */
	runId: string;
	/** Session identifier */
	sessionId: string;
	/** Assigned variant */
	variant: Variant;
	/** User request/task description */
	task: string;
	/** Whether task succeeded */
	success: boolean;
	/** Total turns to completion */
	totalTurns: number;
	/** Total tokens used */
	totalTokens: number;
	/** Total tool calls */
	totalToolCalls: number;
	/** Timestamp when run started */
	startTime: number;
	/** Timestamp when run ended */
	endTime: number;
	/** Duration in ms */
	durationMs: number;
	/** Optional: quality score if available (0-1) */
	qualityScore?: number;
	/** Number of signals that fired */
	signalCount: number;
	/** Active signal types */
	activeSignals: string[];
}

export interface VariantStats {
	n: number;
	successes: number;
	successRate: number;
	avgTokens: number;
	avgTurns: number;
	avgToolCalls: number;
	avgDurationMs: number;
	avgQualityScore: number | null;
	stdDevTokens: number;
	stdDevTurns: number;
}

export interface ABStats {
	totalRuns: number;
	control: VariantStats;
	treatment: VariantStats;
	verdict: ABVerdict;
	confidence: ABConfidence;
	recommendation: string;
	effectSize: number;
	pValue: number;
	confidenceInterval: {
		control: [number, number];
		treatment: [number, number];
	};
	lastUpdated: number;
}

export type ABVerdict =
	| "TREATMENT_BETTER"
	| "CONTROL_BETTER"
	| "TREATMENT_UNDERPERFORMS"
	| "NO_SIGNIFICANT_DIFFERENCE"
	| "INSUFFICIENT_DATA";

export type ABConfidence = "low" | "moderate" | "high" | "very_high";

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ABConfig = {
	treatmentProbability: 0.5,
	minRunsForStats: 20,
	enabled: true,
	inMemoryOnly: false,
};

const STORAGE_DIR = join(homedir(), ".pi/agent/ab-testing");
const RUNS_FILE = join(STORAGE_DIR, "runs.jsonl");
const CONFIG_FILE = join(STORAGE_DIR, "config.json");

// ── State ─────────────────────────────────────────────────────────────────────

interface ABTestingState {
	config: ABConfig;
	/** Current run tracking */
	currentRun: {
		runId: string;
		sessionId: string;
		variant: Variant;
		task: string;
		startTime: number;
		turnCount: number;
		tokenCount: number;
		toolCount: number;
		signalsFired: Set<string>;
		startTurn: number;
		lastActivityTime: number;
	} | null;
	/** In-memory run storage (also persisted to file) */
	runs: RunOutcome[];
	/** Token usage estimate per turn */
	estimatedTokensPerTurn: number;
	/** Flag to skip enforcement for control group */
	skipEnforcement: boolean;
	/** Track if we detected a task completion message */
	taskCompleted: boolean;
}

const state: ABTestingState = {
	config: { ...DEFAULT_CONFIG },
	currentRun: null,
	runs: [],
	estimatedTokensPerTurn: 400,
	skipEnforcement: false,
	taskCompleted: false,
};

// ── Persistence ───────────────────────────────────────────────────────────────

function ensureStorageDir(): void {
	if (!existsSync(STORAGE_DIR)) {
		mkdirSync(STORAGE_DIR, { recursive: true });
	}
}

function loadConfig(): ABConfig {
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

function saveConfig(): void {
	ensureStorageDir();
	writeFileSync(CONFIG_FILE, JSON.stringify(state.config, null, 2));
}

function loadRuns(): RunOutcome[] {
	ensureStorageDir();
	const path = RUNS_FILE;
	if (!existsSync(path)) {
		return [];
	}
	try {
		const content = readFileSync(path, "utf-8");
		const lines = content.trim().split("\n");
		return lines.filter((l) => l.trim()).map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

function saveRun(run: RunOutcome): void {
	if (state.config.inMemoryOnly) {
		return;
	}
	ensureStorageDir();
	writeFileSync(RUNS_FILE, `${JSON.stringify(run)}\n`, { flag: "a" });
}

// ── Variant Assignment ────────────────────────────────────────────────────────

/**
 * Randomly assign variant based on configured probability.
 * Uses session + turn as seed for reproducibility within a session.
 */
function assignVariant(sessionId: string, turnIndex: number): Variant {
	// Deterministic assignment within session for reproducibility
	const seed = hashString(`${sessionId}:${turnIndex}`);
	const normalized = (seed % 1000) / 1000;

	if (normalized < state.config.treatmentProbability) {
		return "treatment";
	}
	return "control";
}

/**
 * Simple string hash function for deterministic assignment.
 */
function hashString(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash; // Convert to 32-bit integer
	}
	return Math.abs(hash);
}

// ── Statistical Analysis ──────────────────────────────────────────────────────

/**
 * Calculate standard deviation.
 */
function standardDeviation(values: number[], mean: number): number {
	if (values.length < 2) return 0;
	const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
	const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
	return Math.sqrt(avgSquaredDiff);
}

/**
 * Calculate variant statistics from run outcomes.
 */
function calculateVariantStats(variant: Variant, runs: RunOutcome[]): VariantStats {
	const filtered = runs.filter((r) => r.variant === variant);

	if (filtered.length === 0) {
		return {
			n: 0,
			successes: 0,
			successRate: 0,
			avgTokens: 0,
			avgTurns: 0,
			avgToolCalls: 0,
			avgDurationMs: 0,
			avgQualityScore: null,
			stdDevTokens: 0,
			stdDevTurns: 0,
		};
	}

	const successes = filtered.filter((r) => r.success).length;
	const tokens = filtered.map((r) => r.totalTokens);
	const turns = filtered.map((r) => r.totalTurns);
	const toolCalls = filtered.map((r) => r.totalToolCalls);
	const durations = filtered.map((r) => r.durationMs);
	const qualityScores = filtered.filter((r) => r.qualityScore !== undefined).map((r) => r.qualityScore!);

	const avgTokens = tokens.reduce((a, b) => a + b, 0) / tokens.length;
	const avgTurns = turns.reduce((a, b) => a + b, 0) / turns.length;
	const avgToolCalls = toolCalls.reduce((a, b) => a + b, 0) / toolCalls.length;
	const avgDurationMs = durations.reduce((a, b) => a + b, 0) / durations.length;

	return {
		n: filtered.length,
		successes,
		successRate: successes / filtered.length,
		avgTokens: Math.round(avgTokens),
		avgTurns: Math.round(avgTurns * 10) / 10,
		avgToolCalls: Math.round(avgToolCalls * 10) / 10,
		avgDurationMs: Math.round(avgDurationMs),
		avgQualityScore:
			qualityScores.length > 0 ? qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length : null,
		stdDevTokens: standardDeviation(tokens, avgTokens),
		stdDevTurns: standardDeviation(turns, avgTurns),
	};
}

/**
 * Calculate 95% confidence interval for a proportion.
 */
function confidenceInterval95(successes: number, n: number): [number, number] {
	if (n === 0) return [0, 0];

	const p = successes / n;
	const z = 1.96; // 95% confidence
	const margin = z * Math.sqrt((p * (1 - p)) / n);

	return [Math.max(0, p - margin), Math.min(1, p + margin)];
}

/**
 * Two-proportion z-test for significance.
 * Returns p-value (two-tailed).
 */
function twoProportionZTest(
	n1: number,
	x1: number,
	n2: number,
	x2: number,
): { pValue: number; zScore: number } {
	if (n1 === 0 || n2 === 0) {
		return { pValue: 1, zScore: 0 };
	}

	const p1 = x1 / n1;
	const p2 = x2 / n2;
	const pPooled = (x1 + x2) / (n1 + n2);

	const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / n1 + 1 / n2));

	if (se === 0) {
		return { pValue: 1, zScore: 0 };
	}

	const z = (p1 - p2) / se;
	const pValue = 2 * (1 - normalCDF(Math.abs(z)));

	return { pValue, zScore: z };
}

/**
 * Standard normal CDF approximation.
 */
function normalCDF(x: number): number {
	const a1 = 0.254829592;
	const a2 = -0.284496736;
	const a3 = 1.421413741;
	const a4 = -1.453152027;
	const a5 = 1.061405429;
	const p = 0.3275911;

	const sign = x < 0 ? -1 : 1;
	x = Math.abs(x) / Math.sqrt(2);

	const t = 1.0 / (1.0 + p * x);
	const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

	return 0.5 * (1.0 + sign * y);
}

/**
 * Calculate effect size (Cohen's h) between two proportions.
 */
function cohensH(p1: number, p2: number): number {
	const phi1 = 2 * Math.asin(Math.sqrt(p1));
	const phi2 = 2 * Math.asin(Math.sqrt(p2));
	return Math.abs(phi1 - phi2);
}

/**
 * Determine overall A/B test verdict.
 */
function computeVerdict(
	controlStats: VariantStats,
	treatmentStats: VariantStats,
	pValue: number,
	effectSize: number,
): {
	verdict: ABVerdict;
	confidence: ABConfidence;
	recommendation: string;
} {
	const controlRate = controlStats.successRate;
	const treatmentRate = treatmentStats.successRate;
	const rateDiff = treatmentRate - controlRate;

	// Determine significance
	let significance: ABConfidence = "low";
	if (pValue < 0.01) significance = "very_high";
	else if (pValue < 0.05) significance = "high";
	else if (pValue < 0.10) significance = "moderate";

	// Determine verdict and recommendation
	if (controlStats.n < 10 || treatmentStats.n < 10) {
		return {
			verdict: "INSUFFICIENT_DATA",
			confidence: "low",
			recommendation: "Need more data to draw conclusions. Continue collecting runs.",
		};
	}

	if (pValue >= 0.10) {
		return {
			verdict: "NO_SIGNIFICANT_DIFFERENCE",
			confidence: significance,
			recommendation:
				"No significant difference detected between variants. Current enforcement signals may not be harmful, but also not clearly beneficial.",
		};
	}

	// Significant difference detected
	if (treatmentRate < controlRate) {
		// Treatment underperforms
		let recommendation = "TREATMENT UNDERPERFORMS control group.\n\n";
		if (effectSize < 0.2) {
			recommendation += "- Effect size is small but statistically significant\n";
		} else if (effectSize < 0.5) {
			recommendation += "- Effect size is moderate\n";
		} else {
			recommendation += "- Effect size is large - this is a serious concern\n";
		}
		recommendation += `- Treatment success rate: ${(treatmentRate * 100).toFixed(1)}% vs Control: ${(controlRate * 100).toFixed(1)}%\n`;
		recommendation += `- Difference: ${(Math.abs(rateDiff) * 100).toFixed(1)} percentage points\n\n`;
		recommendation += "Consider:\n";
		recommendation += "1. Reducing the number/type of enforcement signals\n";
		recommendation += "2. Investigating which specific signals correlate with failures\n";
		recommendation += "3. Making signals less intrusive or more context-aware";

		return {
			verdict: "TREATMENT_UNDERPERFORMS",
			confidence: significance,
			recommendation,
		};
	}

	// Treatment is better
	let recommendation = "Treatment outperforms control.\n\n";
	recommendation += `- Treatment success rate: ${(treatmentRate * 100).toFixed(1)}% vs Control: ${(controlRate * 100).toFixed(1)}%\n`;
	recommendation += `- Improvement: +${(rateDiff * 100).toFixed(1)} percentage points\n\n`;
	recommendation += "Enforcement signals appear to be beneficial for task completion.";

	return {
		verdict: "CONTROL_BETTER",
		confidence: significance,
		recommendation,
	};
}

// ── Core Functions ────────────────────────────────────────────────────────────

/**
 * Start a new A/B test run.
 */
function startRun(sessionId: string, task: string): Variant {
	const variant = assignVariant(sessionId, 0);

	state.currentRun = {
		runId: `run-${Date.now()}-${hashString(sessionId) % 10000}`,
		sessionId,
		variant,
		task: task.slice(0, 200), // Truncate long tasks
		startTime: Date.now(),
		turnCount: 0,
		tokenCount: 0,
		toolCount: 0,
		signalsFired: new Set(),
		startTurn: 0,
		lastActivityTime: Date.now(),
	};

	// Set enforcement skip flag for control group
	state.skipEnforcement = variant === "control";
	state.taskCompleted = false;

	return variant;
}

/**
 * Record a turn outcome within the current run.
 */
function recordTurn(
	turnIndex: number,
	success: boolean,
	tokensUsed: number,
	toolCount: number,
	activeSignals: string[],
	durationMs: number,
): void {
	if (!state.currentRun) return;

	state.currentRun.turnCount++;
	state.currentRun.tokenCount += tokensUsed;
	state.currentRun.toolCount += toolCount;
	state.currentRun.lastActivityTime = Date.now();

	for (const signal of activeSignals) {
		state.currentRun.signalsFired.add(signal);
	}

	// Update estimated tokens per turn
	state.estimatedTokensPerTurn =
		(state.estimatedTokensPerTurn * 0.7) + (tokensUsed * 0.3);
}

/**
 * End the current run and save outcome.
 */
function endRun(success: boolean, qualityScore?: number): RunOutcome | null {
	if (!state.currentRun) return null;

	const run: RunOutcome = {
		runId: state.currentRun.runId,
		sessionId: state.currentRun.sessionId,
		variant: state.currentRun.variant,
		task: state.currentRun.task,
		success,
		totalTurns: state.currentRun.turnCount,
		totalTokens: state.currentRun.tokenCount || Math.round(state.currentRun.turnCount * state.estimatedTokensPerTurn),
		totalToolCalls: state.currentRun.toolCount,
		startTime: state.currentRun.startTime,
		endTime: Date.now(),
		durationMs: Date.now() - state.currentRun.startTime,
		qualityScore,
		signalCount: state.currentRun.signalsFired.size,
		activeSignals: Array.from(state.currentRun.signalsFired),
	};

	// Save to memory and file
	state.runs.push(run);
	saveRun(run);

	// Reset current run
	state.currentRun = null;
	state.skipEnforcement = false;

	return run;
}

/**
 * Get comprehensive A/B test statistics.
 */
function getStats(): ABStats {
	const allRuns = [...loadRuns(), ...state.runs];

	const controlStats = calculateVariantStats("control", allRuns);
	const treatmentStats = calculateVariantStats("treatment", allRuns);

	// Calculate statistical significance
	const { pValue } = twoProportionZTest(
		controlStats.n,
		controlStats.successes,
		treatmentStats.n,
		treatmentStats.successes,
	);

	// Calculate effect size
	const effectSize = cohensH(controlStats.successRate, treatmentStats.successRate);

	// Calculate confidence intervals
	const controlCI = confidenceInterval95(controlStats.successes, controlStats.n);
	const treatmentCI = confidenceInterval95(treatmentStats.successes, treatmentStats.n);

	// Compute verdict
	const { verdict, confidence, recommendation } = computeVerdict(
		controlStats,
		treatmentStats,
		pValue,
		effectSize,
	);

	return {
		totalRuns: allRuns.length,
		control: controlStats,
		treatment: treatmentStats,
		verdict,
		confidence,
		recommendation,
		effectSize: Math.round(effectSize * 1000) / 1000,
		pValue: Math.round(pValue * 10000) / 10000,
		confidenceInterval: {
			control: [Math.round(controlCI[0] * 1000) / 1000, Math.round(controlCI[1] * 1000) / 1000],
			treatment: [Math.round(treatmentCI[0] * 1000) / 1000, Math.round(treatmentCI[1] * 1000) / 1000],
		},
		lastUpdated: Date.now(),
	};
}

/**
 * Format stats as readable text.
 */
function formatStats(stats: ABStats): string {
	const lines: string[] = [];

	lines.push("# A/B Testing Framework - Statistics");
	lines.push("");
	lines.push(`**Total Runs:** ${stats.totalRuns}`);
	lines.push(`**Last Updated:** ${new Date(stats.lastUpdated).toLocaleString()}`);
	lines.push("");

	lines.push("## Control Group (No/Minimal Enforcement)");
	lines.push(`- **N:** ${stats.control.n}`);
	lines.push(`- **Success Rate:** ${(stats.control.successRate * 100).toFixed(1)}%`);
	lines.push(`- **Avg Tokens:** ${stats.control.avgTokens.toLocaleString()}`);
	lines.push(`- **Avg Turns:** ${stats.control.avgTurns.toFixed(1)}`);
	lines.push(`- **Avg Tool Calls:** ${stats.control.avgToolCalls.toFixed(1)}`);
	lines.push(`- **Confidence Interval:** [${(stats.confidenceInterval.control[0] * 100).toFixed(1)}%, ${(stats.confidenceInterval.control[1] * 100).toFixed(1)}%]`);
	lines.push("");

	lines.push("## Treatment Group (Full Enforcement)");
	lines.push(`- **N:** ${stats.treatment.n}`);
	lines.push(`- **Success Rate:** ${(stats.treatment.successRate * 100).toFixed(1)}%`);
	lines.push(`- **Avg Tokens:** ${stats.treatment.avgTokens.toLocaleString()}`);
	lines.push(`- **Avg Turns:** ${stats.treatment.avgTurns.toFixed(1)}`);
	lines.push(`- **Avg Tool Calls:** ${stats.treatment.avgToolCalls.toFixed(1)}`);
	lines.push(`- **Confidence Interval:** [${(stats.confidenceInterval.treatment[0] * 100).toFixed(1)}%, ${(stats.confidenceInterval.treatment[1] * 100).toFixed(1)}%]`);
	lines.push("");

	lines.push("## Statistical Analysis");
	lines.push(`- **P-Value:** ${stats.pValue}`);
	lines.push(`- **Effect Size (Cohen's h):** ${stats.effectSize}`);
	lines.push(`- **Confidence:** ${stats.confidence}`);
	lines.push("");

	lines.push("## Verdict");
	lines.push(`**${stats.verdict}**`);
	lines.push("");
	lines.push(stats.recommendation);

	return lines.join("\n");
}

/**
 * Track enforcement signals for the current turn.
 */
function trackSignals(activeSignals: string[]): void {
	if (!state.currentRun) return;

	for (const signal of activeSignals) {
		state.currentRun.signalsFired.add(signal);
	}
}

/**
 * Extract text content from a message (handles different message types).
 */
function extractMessageText(message: any): string {
	if (!message) return "";

	// Handle messages with content array
	if (Array.isArray(message.content)) {
		return message.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text || "")
			.join("\n");
	}

	// Handle messages with direct text property
	if (typeof message.content === "string") {
		return message.content;
	}

	// Handle other formats
	return String(message.content || message.text || "");
}

/**
 * Check if a message indicates task completion.
 */
function isTaskCompletionMessage(message: any): boolean {
	const text = extractMessageText(message).toLowerCase();

	// Check for common completion indicators
	const completionPatterns = [
		"task completed",
		"task finished",
		"all done",
		"done!",
		"completed successfully",
		"finished successfully",
		"✅",
		"/finalize",
	];

	return completionPatterns.some((pattern) => text.includes(pattern));
}

// ── Extension Factory ──────────────────────────────────────────────────────────

export default function abTestingExtension(pi: ExtensionAPI) {
	// Initialize state
	state.config = loadConfig();
	state.runs = loadRuns();

	// ── session_start ─────────────────────────────────────────────────────────
	pi.on("session_start", async (_event, _ctx) => {
		// Session started - ready for new runs
		state.currentRun = null;
		state.skipEnforcement = false;
		state.taskCompleted = false;
	});

	// ── agent_start ───────────────────────────────────────────────────────────
	// This fires when the agent starts processing a user message
	pi.on("agent_start", async (_event, ctx) => {
		if (!state.config.enabled) {
			return;
		}

		// Extract task from context
		const messages = (ctx as any)?.messages || [];
		const userMessage = messages.find((m: any) => m.role === "user");
		const task = userMessage
			? extractMessageText(userMessage).slice(0, 500)
			: "unknown";

		// Get session ID
		const sessionFile = ctx.sessionManager?.getSessionFile?.();
		const sessionId = sessionFile || `session-${Date.now()}`;

		// Start new run
		const variant = startRun(sessionId, task);

		// Emit event for other extensions (especially enforcement)
		pi.events.emit("ab_test_variant_assigned", {
			variant,
			runId: state.currentRun?.runId,
			skipEnforcement: state.skipEnforcement,
		});

		// Log for debugging
		console.log(`[A/B Testing] Started run ${state.currentRun?.runId} with variant: ${variant}`);
	});

	// ── tool_execution_start ───────────────────────────────────────────────────
	// Track tool calls for metrics
	pi.on("tool_execution_start", async (event) => {
		if (!state.currentRun) return;

		// Update tool count
		state.currentRun.toolCount++;
		state.currentRun.lastActivityTime = Date.now();

		// Estimate input tokens (rough)
		const inputStr = JSON.stringify(event.args || {});
		const inputTokens = Math.ceil(inputStr.length / 4);
		state.currentRun.tokenCount += inputTokens;
	});

	// ── turn_end ──────────────────────────────────────────────────────────────
	pi.on("turn_end", async (event: any) => {
		if (!state.currentRun) return;

		state.currentRun.turnCount++;

		// Get tool count and errors from event
		const toolResults = event.toolResults || [];
		const toolCount = toolResults.length;
		const erroredCount = toolResults.filter((r: any) => r.isError).length;

		// Estimate tokens from response (rough approximation)
		const responseText = extractMessageText(event.message);
		const responseTokens = Math.ceil(responseText.length / 4);
		state.currentRun.tokenCount += responseTokens;
		state.currentRun.lastActivityTime = Date.now();

		// Try to get enforcement signals from event context
		let activeSignals: string[] = [];
		try {
			// Check for enforcement signals in event or context
			const enforcementCtx = (event as any).enforcementSignals;
			if (enforcementCtx && typeof enforcementCtx === "object") {
				activeSignals = Object.keys(enforcementCtx);
			}
		} catch {
			// No signals available
		}

		recordTurn(
			state.currentRun.turnCount,
			erroredCount === 0,
			responseTokens,
			toolCount,
			activeSignals,
			0, // Duration not tracked per turn
		);

		// Check for task completion - if assistant signals done, end the run
		if (event.message?.role === "assistant" && isTaskCompletionMessage(event.message)) {
			if (!state.taskCompleted) {
				state.taskCompleted = true;
				// Give a brief delay to allow final verifications
				setTimeout(() => {
					if (state.currentRun && state.taskCompleted) {
						endRun(true);
						console.log(`[A/B Testing] Run ${state.currentRun?.runId} completed (success detected)`);
					}
				}, 100);
			}
		}
	});

	// ── message_end ────────────────────────────────────────────────────────────
	// Use this to track token usage and detect completion
	pi.on("message_end", async (event: any) => {
		if (!state.currentRun) return;

		// Update tokens from message usage if available
		if (event.message?.usage) {
			const usage = event.message.usage;
			const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
			if (tokens > 0) {
				// Use actual usage when available
				state.currentRun.tokenCount = tokens;
			}
		}
	});

	// ── session_shutdown ───────────────────────────────────────────────────────
	// End the current run when session ends
	pi.on("session_shutdown", async () => {
		if (state.currentRun) {
			// End run - if we didn't detect explicit completion, assume partial
			const success = state.taskCompleted;
			endRun(success);
			console.log(`[A/B Testing] Run ${state.currentRun?.runId} ended (session shutdown)`);
		}
	});

	// ── Commands ──────────────────────────────────────────────────────────────

	pi.registerCommand("ab-stats", {
		description: "Show A/B test statistics",
		handler: async (_args, ctx) => {
			if (!state.config.enabled) {
				ctx.ui.notify("A/B testing is disabled. Enable with /ab-enable", "warning");
				return;
			}

			const stats = getStats();
			const formatted = formatStats(stats);
			ctx.ui.notify(formatted, "info");
		},
	});

	pi.registerCommand("ab-enable", {
		description: "Enable A/B testing",
		handler: async (_args, ctx) => {
			state.config.enabled = true;
			saveConfig();
			ctx.ui.notify("A/B testing enabled", "info");
		},
	});

	pi.registerCommand("ab-disable", {
		description: "Disable A/B testing",
		handler: async (_args, ctx) => {
			state.config.enabled = false;
			saveConfig();
			ctx.ui.notify("A/B testing disabled", "info");
		},
	});

	pi.registerCommand("ab-reset", {
		description: "Reset A/B test data",
		handler: async (_args, ctx) => {
			ensureStorageDir();
			try {
				writeFileSync(RUNS_FILE, "");
				state.runs = [];
				ctx.ui.notify("A/B test data reset", "info");
			} catch {
				ctx.ui.notify("Failed to reset data", "error");
			}
		},
	});

	pi.registerCommand("ab-config", {
		description: "Show A/B test configuration",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`A/B Testing Config:\n- Enabled: ${state.config.enabled}\n- Treatment Probability: ${state.config.treatmentProbability}\n- Min Runs for Stats: ${state.config.minRunsForStats}`,
				"info",
			);
		},
	});

	// ── Tool: get_ab_stats ────────────────────────────────────────────────────
	// Primary tool for querying stats (can be called by agent)

	pi.registerCommand("get_ab_stats", {
		description: "Get A/B test statistics as JSON",
		handler: async (_args, ctx) => {
			if (!state.config.enabled) {
				ctx.ui.notify(JSON.stringify({ error: "A/B testing disabled" }), "info");
				return;
			}

			const stats = getStats();
			ctx.ui.notify(JSON.stringify(stats, null, 2), "info");
		},
	});

	// ── Expose helper for other extensions ────────────────────────────────────
	// Other extensions can check if enforcement should be skipped


}

// ── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Export state for external access (e.g., from enforcement extension).
 */
export function getABState(): Readonly<typeof state> {
	return state;
}

/**
 * Check if enforcement should be skipped for current variant.
 */
export function shouldSkipEnforcement(): boolean {
	return state.skipEnforcement;
}

/**
 * Get current variant.
 */
export function getCurrentVariant(): Variant | null {
	return state.currentRun?.variant || null;
}
