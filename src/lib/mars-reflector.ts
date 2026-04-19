/**
 * MARS Reflection — Meta-Analysis of Reasoning Sessions
 *
 * Analyzes agent behavior patterns over a session and generates adaptive advice.
 * Based on: ROADMAP-v0.6.md Task 6
 *
 * Trigger: adaptive (not fixed N turns) — check on every turn_end.
 * Only whispers if actionable advice exists.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "./extension-state.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SessionPattern {
	toolDistribution: Map<string, number>;
	errorTypes: Map<string, number>;
	confidenceTrend: number[];
	stabilityTrend: number[];
	errorRate: number;
	consecutiveErrors: number;
}

export interface MARSAdvice {
	type: "tool_overuse" | "error_recurrence" | "confidence_decline" | "stability_decline";
	message: string;
	severity: "info" | "warn";
}

// ── State factory ──────────────────────────────────────────────────────────────

interface MARSState {
	patternSnapshot: SessionPattern | null;
	lastAdviceAt: number;
	adviceCooldownMs: number;
}

function getState(ctx: ExtensionContext): MARSState {
	return getExtensionState(ctx, "mars-reflector", () => ({
		patternSnapshot: null,
		lastAdviceAt: 0,
		adviceCooldownMs: 60_000, // 60s between advice
	}));
}

// ── Pattern analysis ──────────────────────────────────────────────────────────

/** Build current session pattern from enforcement state */
export function buildPattern(ctx: ExtensionContext): SessionPattern {
	const state = getState(ctx);
	// Get pattern from enforcement state if available
	const enforcementState = (ctx: ExtensionContext): Record<string, unknown> | null => {
		try {
			return getExtensionState(ctx, "enforcement", () => ({} as Record<string, unknown>));
		} catch {
			return null;
		}
	};

	const eState = enforcementState(ctx);
	if (!eState) {
		return {
			toolDistribution: new Map(),
			errorTypes: new Map(),
			confidenceTrend: [],
			stabilityTrend: [],
			errorRate: 0,
			consecutiveErrors: 0,
		};
	}

	// Build tool distribution
	const toolDist = new Map<string, number>();
	for (const tool of (eState.toolLog as string[] || [])) {
		toolDist.set(tool, (toolDist.get(tool) || 0) + 1);
	}

	// Build stability trend from recent stability signals
	const stabilityTrend: number[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const signals = (eState as any).enforcementSignals || {};
	for (const [, signal] of Object.entries(signals)) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const s = signal as any;
		if (s?.turn !== undefined && s?.text?.includes("[stability]")) {
			const match = s.text.match(/overlap=([0-9.]+)/);
			if (match) stabilityTrend.push(parseFloat(match[1]));
		}
	}

	return {
		toolDistribution: toolDist,
		errorTypes: new Map(),
		confidenceTrend: [],
		stabilityTrend,
		errorRate: 0,
		consecutiveErrors: (eState as any).consecutiveErrors || 0,
	};
}

/** Generate actionable advice based on pattern */
export function generateAdvice(current: SessionPattern, previous: SessionPattern | null): MARSAdvice | null {
	const now = Date.now();

	// Tool over-reliance: one tool > 60% of calls
	if (current.toolDistribution.size > 0) {
		const total = [...current.toolDistribution.values()].reduce((a, b) => a + b, 0);
		for (const [tool, count] of current.toolDistribution) {
			if (count / total > 0.6) {
				return {
					type: "tool_overuse",
					message: `[mars] ${tool} used ${count}/${total} times (${Math.round(count / total * 100)}%). Consider: alternative tools, grep/find vs bash, or step back to verify approach.`,
					severity: "warn",
				};
			}
		}
	}

	// Error recurrence: same error type 3+ times
	if (current.consecutiveErrors >= 3) {
		return {
			type: "error_recurrence",
			message: `[mars] ${current.consecutiveErrors} consecutive errors detected. Consider: think(type="reflection") to identify root cause before continuing.`,
			severity: "warn",
		};
	}

	// Stability decline: trend going down
	if (previous && current.stabilityTrend.length > 2 && previous.stabilityTrend.length > 2) {
		const prevAvg = previous.stabilityTrend.slice(-3).reduce((a, b) => a + b, 0) / 3;
		const currAvg = current.stabilityTrend.slice(-3).reduce((a, b) => a + b, 0) / 3;
		if (currAvg < prevAvg * 0.7) {
			return {
				type: "stability_decline",
				message: `[mars] Response quality declining (avg stability ${currAvg.toFixed(2)} vs ${prevAvg.toFixed(2)} earlier). Consider refocusing on the original task.`,
				severity: "info",
			};
		}
	}

	return null;
}

/** Check if MARS should give advice on this turn */
export function shouldAdvise(ctx: ExtensionContext): MARSAdvice | null {
	const state = getState(ctx);
	const now = Date.now();

	// Cooldown check
	if (now - state.lastAdviceAt < state.adviceCooldownMs) return null;

	const current = buildPattern(ctx);
	const advice = generateAdvice(current, state.patternSnapshot);

	if (advice) {
		state.lastAdviceAt = now;
		state.patternSnapshot = current;
	}

	return advice;
}

/** Reset MARS state for a new session */
export function resetMARS(ctx: ExtensionContext): void {
	const state = getState(ctx);
	state.patternSnapshot = null;
	state.lastAdviceAt = 0;
}
