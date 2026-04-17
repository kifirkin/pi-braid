/**
 * Degradation Detector - Track performance metrics and detect degradation
 *
 * Monitors:
 * - Healthcheck scores over time
 * - Error rates per turn
 * - Tool success rates
 * - Turn durations
 * - Memory usage
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { saveStateImmediate } from "./async-storage.js";
import { taggedConsole } from "./logger.js";

const _log = taggedConsole("degradation-detector");

export interface PerformanceMetrics {
	timestamp: number;
	turnNumber: number;
	healthcheckScore: number; // 0-100
	errorRate: number; // errors / total_actions
	avgTurnDurationMs: number;
	toolSuccessRate: number; // 0-100
	memoryUsagePercent: number; // 0-100
	consecutiveErrors: number;
	toolCalls: number;
	errors: number;
	inputTokens: number;
	outputTokens: number;
	tokenUsage: {
		input: number;
		output: number;
	};
}

export interface DegradationConfig {
	healthcheckMinScore: number; // default: 80
	errorRateMax: number; // default: 0.1 (10%)
	toolSuccessMin: number; // default: 70
	checkIntervalMs: number; // default: 60000 (1 min)
	maxConsecutiveErrors: number; // default: 3
}

export interface DegradationState {
	metrics: PerformanceMetrics[];
	config: DegradationConfig;
	isDegraded: boolean;
	lastHealthcheck: {
		score: number;
		timestamp: number;
	} | null;
}

const DEFAULT_CONFIG: DegradationConfig = {
	healthcheckMinScore: 80,
	errorRateMax: 0.1,
	toolSuccessMin: 70,
	checkIntervalMs: 60000,
	maxConsecutiveErrors: 3,
};

const METRICS_FILE = path.join(os.homedir(), ".pi", "agent", "metrics", "degradation.json");

let state: DegradationState = {
	metrics: [],
	config: { ...DEFAULT_CONFIG },
	isDegraded: false,
	lastHealthcheck: null,
};

// Configuration

export function getConfig(): DegradationConfig {
	return { ...state.config };
}

export function updateConfig(partial: Partial<DegradationConfig>): void {
	state.config = { ...state.config, ...partial };
}

export function resetConfig(): void {
	state.config = { ...DEFAULT_CONFIG };
}

// Metrics Tracking

export function recordHealthcheckScore(score: number): void {
	state.lastHealthcheck = {
		score,
		timestamp: Date.now(),
	};
	state.isDegraded = score < state.config.healthcheckMinScore;
}

export function recordTurnMetrics(metrics: Omit<PerformanceMetrics, "timestamp" | "healthcheckScore">): void {
	const entry: PerformanceMetrics = {
		...metrics,
		timestamp: Date.now(),
		healthcheckScore: state.lastHealthcheck?.score ?? 100,
	};

	state.metrics.push(entry);

	// Keep only last 100 entries
	if (state.metrics.length > 100) {
		state.metrics = state.metrics.slice(-100);
	}

	// Update degradation status
	updateDegradationStatus();
}

export function recordError(): void {
	const last = state.metrics[state.metrics.length - 1];
	if (last) {
		last.consecutiveErrors++;
		last.errorRate = Math.min(1, last.errorRate + 0.1);
	}
}

export function recordToolSuccess(): void {
	const last = state.metrics[state.metrics.length - 1];
	if (last) {
		last.consecutiveErrors = 0;
		const total =
			(last.toolSuccessRate / 100) * (state.metrics.filter((m) => m.turnNumber === last.turnNumber).length + 1);
		last.toolSuccessRate = ((total + 1) / (total + 1)) * 100;
	}
}

// Analysis

function updateDegradationStatus(): void {
	const recent = state.metrics.slice(-5);

	if (recent.length === 0) {
		state.isDegraded = false;
		return;
	}

	// Check consecutive errors
	const hasConsecutiveErrors = recent.some((m) => m.consecutiveErrors >= state.config.maxConsecutiveErrors);
	if (hasConsecutiveErrors) {
		state.isDegraded = true;
		return;
	}

	// Check error rate trend
	const avgErrorRate = recent.reduce((s, m) => s + m.errorRate, 0) / recent.length;
	if (avgErrorRate > state.config.errorRateMax) {
		state.isDegraded = true;
		return;
	}

	// Check tool success rate
	const avgToolSuccess = recent.reduce((s, m) => s + m.toolSuccessRate, 0) / recent.length;
	if (avgToolSuccess < state.config.toolSuccessMin) {
		state.isDegraded = true;
		return;
	}

	// Check healthcheck score
	if (state.lastHealthcheck && state.lastHealthcheck.score < state.config.healthcheckMinScore) {
		state.isDegraded = true;
		return;
	}

	state.isDegraded = false;
}

export function isDegraded(): boolean {
	return state.isDegraded;
}

export function getDegradationReasons(): string[] {
	const reasons: string[] = [];
	const recent = state.metrics.slice(-5);

	if (recent.length === 0) return reasons;

	// Check consecutive errors
	const maxConsecutive = Math.max(...recent.map((m) => m.consecutiveErrors));
	if (maxConsecutive >= state.config.maxConsecutiveErrors) {
		reasons.push(`High consecutive errors (max: ${maxConsecutive})`);
	}

	// Check error rate
	const avgErrorRate = recent.reduce((s, m) => s + m.errorRate, 0) / recent.length;
	if (avgErrorRate > state.config.errorRateMax) {
		reasons.push(`High error rate: ${(avgErrorRate * 100).toFixed(1)}% (max: ${state.config.errorRateMax * 100}%)`);
	}

	// Check tool success rate
	const avgToolSuccess = recent.reduce((s, m) => s + m.toolSuccessRate, 0) / recent.length;
	if (avgToolSuccess < state.config.toolSuccessMin) {
		reasons.push(`Low tool success: ${avgToolSuccess.toFixed(1)}% (min: ${state.config.toolSuccessMin}%)`);
	}

	// Check healthcheck score
	if (state.lastHealthcheck && state.lastHealthcheck.score < state.config.healthcheckMinScore) {
		reasons.push(
			`Low healthcheck score: ${state.lastHealthcheck.score}% (min: ${state.config.healthcheckMinScore}%)`,
		);
	}

	return reasons;
}

// State Access

export function getCurrentMetrics(): PerformanceMetrics | null {
	return state.metrics[state.metrics.length - 1] ?? null;
}

export function getRecentMetrics(count: number = 10): PerformanceMetrics[] {
	return state.metrics.slice(-count);
}

export function getAllMetrics(): PerformanceMetrics[] {
	return [...state.metrics];
}

export function getMetricsSummary(): {
	totalTurns: number;
	avgHealthcheck: number;
	avgErrorRate: number;
	avgToolSuccess: number;
	degraded: boolean;
	reasons: string[];
} {
	const recent = state.metrics;
	const degraded = isDegraded();
	const reasons = getDegradationReasons();

	if (recent.length === 0) {
		return {
			totalTurns: 0,
			avgHealthcheck: 100,
			avgErrorRate: 0,
			avgToolSuccess: 100,
			degraded: false,
			reasons: [],
		};
	}

	return {
		totalTurns: recent.length,
		avgHealthcheck: recent.reduce((s, m) => s + m.healthcheckScore, 0) / recent.length,
		avgErrorRate: recent.reduce((s, m) => s + m.errorRate, 0) / recent.length,
		avgToolSuccess: recent.reduce((s, m) => s + m.toolSuccessRate, 0) / recent.length,
		degraded,
		reasons,
	};
}

// Persistence

export async function saveMetrics(): Promise<void> {
	try {
		const dir = path.dirname(METRICS_FILE);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		await saveStateImmediate(METRICS_FILE, state);
	} catch (error) {
		_log.error("Failed to save degradation metrics:", error);
	}
}

export async function loadMetrics(): Promise<void> {
	try {
		if (fs.existsSync(METRICS_FILE)) {
			const data = fs.readFileSync(METRICS_FILE, "utf-8");
			const loaded = JSON.parse(data) as DegradationState;
			state = {
				...state,
				...loaded,
				config: { ...DEFAULT_CONFIG, ...loaded.config },
			};
		}
	} catch (error) {
		_log.error("Failed to load degradation metrics:", error);
	}
}

export function resetMetrics(): void {
	state.metrics = [];
	state.isDegraded = false;
	state.lastHealthcheck = null;
}

// Quick Metrics Capture

export function captureSystemMetrics(): Pick<PerformanceMetrics, "memoryUsagePercent"> {
	const freeMem = os.freemem();
	const totalMem = os.totalmem();
	const memoryUsagePercent = ((totalMem - freeMem) / totalMem) * 100;

	return { memoryUsagePercent };
}

export function createTurnMetrics(
	turnNumber: number,
	durationMs: number,
	inputTokens: number,
	outputTokens: number,
	toolCalls: number,
	errors: number,
): Omit<PerformanceMetrics, "timestamp" | "healthcheckScore"> {
	const system = captureSystemMetrics();

	return {
		turnNumber,
		avgTurnDurationMs: durationMs,
		inputTokens,
		outputTokens,
		toolCalls,
		errors,
		errorRate: toolCalls > 0 ? errors / toolCalls : 0,
		toolSuccessRate: toolCalls > 0 ? ((toolCalls - errors) / toolCalls) * 100 : 100,
		memoryUsagePercent: system.memoryUsagePercent,
		consecutiveErrors: errors > 0 ? errors : 0,
		tokenUsage: { input: inputTokens, output: outputTokens },
	};
}
