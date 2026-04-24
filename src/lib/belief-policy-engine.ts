/**
 * Belief Policy Engine — Unifies all pi-braid subsystems via a signal bus.
 *
 * Problem: topic-drift, MARS, conflict detection, reasoning metrics are isolated
 * systems that don't talk to each other. The Belief Policy Engine connects them.
 *
 * Flow:
 * 1. All subsystems emit signals to the BeliefPolicyEngine
 * 2. Policy rules evaluate signal history → actionable recommendations
 * 3. Recommendations flow back to enforcement as coherent whispers
 *
 * Based on: ROADMAP-v1.0-FULL.md P2.4 Belief Policy Engine
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "./extension-state.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type SignalSource =
	| "topic-drift"
	| "conflict"
	| "stability"
	| "reasoning"
	| "reflection"
	| "calibration"
	| "tool-use";

export type SignalSeverity = "info" | "warn" | "critical";

export interface SystemSignal {
	id: string;
	source: SignalSource;
	type: string;
	severity: SignalSeverity;
	autoProceed: boolean;  // if true, signal should force a turn (auto-finalize, auto-next-step)
	data: Record<string, unknown>;
	timestamp: number;
}

export interface Belief {
	key: string;           // e.g., "topic:stable", "reasoning:declining"
	confidence: number;    // 0-1
	evidence: string[];    // signal IDs that support this belief
	updatedAt: number;
}

export interface PolicyRecommendation {
	id: string;
	type: string;
	priority: number;      // 1-10, higher = more important
	message: string;      // Whisper message to agent
	beliefs: string[];    // Beliefs that triggered this
	timestamp: number;
}

// ── Policy Rules ───────────────────────────────────────────────────────────────

interface PolicyRule {
	name: string;
	evaluate(signals: SystemSignal[], beliefs: Map<string, Belief>): PolicyRecommendation[];
}

const POLICY_RULES: PolicyRule[] = [
	// Rule 1: Consecutive stability decline → reasoning collapse warning
	{
		name: "stability_decline",
		evaluate(signals, beliefs): PolicyRecommendation[] {
			const stabilitySignals = signals.filter((s) => s.source === "stability" && s.type === "decline");
			if (stabilitySignals.length >= 3) {
				const trend = stabilitySignals.slice(-3).map((s) => (s.data.overlap as number) ?? 0);
				return [{
					id: `pr-${Date.now()}-sd`,
					type: "stability_decline",
					priority: Math.min(9, 5 + stabilitySignals.length),
					message: `[stability] Reasoning coherence declining (overlap: ${trend[0]?.toFixed(1)} → ${trend[2]?.toFixed(1)}). Consider: step back and verify assumptions.`,
					beliefs: ["stability:declining", "reasoning:possible-collapse"],
					timestamp: Date.now(),
				}];
			}
			return [];
		},
	},

	// Rule 2: Unresolved conflicts accumulate → epistemic debt warning
	{
		name: "conflict_accumulation",
		evaluate(signals, beliefs): PolicyRecommendation[] {
			const conflictSignals = signals.filter((s) => s.source === "conflict");
			const unresolved = conflictSignals.filter((s) => s.type === "unresolved");
			if (unresolved.length >= 5) {
				return [{
					id: `pr-${Date.now()}-ca`,
					type: "conflict_accumulation",
					priority: Math.min(9, 4 + Math.floor(unresolved.length / 3)),
					message: `[epistemic] ${unresolved.length} unresolved source conflicts. Epistemic debt accumulating. Consider: resolve one conflict explicitly.`,
					beliefs: ["conflicts:unresolved-multiple", "epistemic:debt"],
					timestamp: Date.now(),
				}];
			}
			return [];
		},
	},

	// Rule 3: Topic drift + tool overuse → scatter warning
	{
		name: "drift_plus_scatter",
		evaluate(signals, beliefs): PolicyRecommendation[] {
			const recent = signals.slice(-10);
			const hasDrift = recent.some((s) => s.source === "topic-drift" && s.severity !== "info");
			const toolSignals = recent.filter((s) => s.source === "tool-use" && s.type === "overuse");
			if (hasDrift && toolSignals.length >= 2) {
				return [{
					id: `pr-${Date.now()}-ds`,
					type: "drift_plus_scatter",
					priority: 7,
					message: `[focus] Topic drift + tool scatter detected. Consider: explicitly reaffirm the current task goal before continuing.`,
					beliefs: ["topic:drifted", "tool:scattered"],
					timestamp: Date.now(),
				}];
			}
			return [];
		},
	},

	// Rule 4: Calibration error high → confidence miscalibration
	{
		name: "calibration_error",
		evaluate(signals, beliefs): PolicyRecommendation[] {
			const calSignals = signals.filter((s) => s.source === "calibration" && s.type === "high-error");
			if (calSignals.length >= 2) {
				const recent = calSignals.slice(-2);
				const avgError = recent.reduce((s, sig) => s + ((sig.data.error as number) ?? 0), 0) / recent.length;
				return [{
					id: `pr-${Date.now()}-ce`,
					type: "calibration_error",
					priority: 6,
					message: `[calibration] Prediction error consistently high (avg: ${(avgError * 100).toFixed(0)}%). Consider being less confident in plans before executing.`,
					beliefs: ["calibration:miscalibrated", "confidence:inflated"],
					timestamp: Date.now(),
				}];
			}
			return [];
		},
	},

	// Rule 5: Reflection gap → reasoning without reflection
	{
		name: "reflection_gap",
		evaluate(signals, beliefs): PolicyRecommendation[] {
			const reflectionSignals = signals.filter((s) => s.source === "reflection");
			const recent = reflectionSignals.slice(-5);
			const hasReflection = recent.length > 0;
			if (!hasReflection) {
				// No reflection in last 5 signals — might need one
				const toolSignals = signals.filter((s) => s.source === "tool-use");
				if (toolSignals.length >= 8) {
					return [{
						id: `pr-${Date.now()}-rg`,
						type: "reflection_gap",
						priority: 5,
						message: `[reflection] 8+ consecutive tool calls without reflection. Consider: think(type="reflection") before proceeding.`,
						beliefs: ["reflection:absent", "reasoning:shallow"],
						timestamp: Date.now(),
					}];
				}
			}
			return [];
		},
	},

	// Rule 6: Reasoning decline + conflict → believe carefully
	{
		name: "reasoning_plus_conflict",
		evaluate(signals, beliefs): PolicyRecommendation[] {
			const recent = signals.slice(-15);
			const hasDecline = recent.some((s) => s.source === "reasoning" && s.type === "decline");
			const hasConflict = recent.some((s) => s.source === "conflict");
			if (hasDecline && hasConflict) {
				return [{
					id: `pr-${Date.now()}-rc`,
					type: "reasoning_plus_conflict",
					priority: 8,
					message: `[careful] Reasoning coherence declining AND source conflicts present. Recommend: slow down, verify facts, acknowledge uncertainty explicitly.`,
					beliefs: ["reasoning:declining", "conflicts:present", "epistemic:uncertain"],
					timestamp: Date.now(),
				}];
			}
			return [];
		},
	},
];

// ── State ─────────────────────────────────────────────────────────────────────

interface BPEState {
	signals: SystemSignal[];
	beliefs: Map<string, Belief>;
	recommendations: PolicyRecommendation[];
	lastRecommendationAt: number;
	recommendationCooldownMs: number;
}

function getState(ctx: ExtensionContext): BPEState {
	return getExtensionState(ctx, "belief-policy-engine", () => ({
		signals: [],
		beliefs: new Map(),
		recommendations: [],
		lastRecommendationAt: 0,
		recommendationCooldownMs: 30_000, // 30s between recommendations
	}));
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Emit a signal from any subsystem (topic-drift, conflict, stability, etc.)
 */
export function emitSignal(
	ctx: ExtensionContext,
	source: SignalSource,
	type: string,
	severity: SignalSeverity = "info",
	autoProceed: boolean = false,
	data: Record<string, unknown> = {},
): void {
	const state = getState(ctx);
	const signal: SystemSignal = {
		id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
		source,
		type,
		severity,
		autoProceed,
		data,
		timestamp: Date.now(),
	};
	state.signals.push(signal);

	// Keep last 50 signals
	if (state.signals.length > 50) {
		state.signals = state.signals.slice(-30);
	}

	// Update beliefs based on signal
	updateBeliefs(state, signal);

	// Evaluate policies and generate recommendations
	evaluatePolicies(state);
}

/** Update belief state based on incoming signal */
function updateBeliefs(state: BPEState, signal: SystemSignal): void {
	// Map signals to belief keys
	const beliefMap: Record<string, { key: string; confidence: number }> = {
		"stability:decline": { key: "stability:declining", confidence: 0.8 },
		"conflict:unresolved": { key: "conflicts:unresolved", confidence: 0.7 },
		"topic-drift:detected": { key: "topic:drifted", confidence: signal.severity === "critical" ? 0.9 : 0.7 },
		"calibration:high-error": { key: "calibration:miscalibrated", confidence: 0.8 },
		"reflection:absent": { key: "reflection:absent", confidence: 0.6 },
	};

	const entry = beliefMap[`${signal.source}:${signal.type}`];
	if (!entry) return;

	const existing = state.beliefs.get(entry.key);
	if (existing) {
		// Bayesian update: blend confidence
		existing.confidence = existing.confidence * 0.7 + entry.confidence * 0.3;
		existing.evidence.push(signal.id);
		existing.updatedAt = Date.now();
	} else {
		state.beliefs.set(entry.key, {
			key: entry.key,
			confidence: entry.confidence,
			evidence: [signal.id],
			updatedAt: Date.now(),
		});
	}

	// Decay old beliefs
	const now = Date.now();
	for (const [key, belief] of state.beliefs) {
		if (now - belief.updatedAt > 5 * 60_000) {
			// Decay: reduce confidence
			belief.confidence *= 0.8;
			if (belief.confidence < 0.1) state.beliefs.delete(key);
		}
	}
}

/** Evaluate all policy rules and generate recommendations */
function evaluatePolicies(state: BPEState): void {
	const newRecs: PolicyRecommendation[] = [];

	for (const rule of POLICY_RULES) {
		try {
			const results = rule.evaluate(state.signals, state.beliefs);
			for (const rec of results) {
				// Deduplicate by type
				if (!state.recommendations.some((r) => r.type === rec.type)) {
					newRecs.push(rec);
				}
			}
		} catch { /* silent — policy evaluation errors shouldn't break enforcement */ }
	}

	if (newRecs.length > 0) {
		// Sort by priority descending
		newRecs.sort((a, b) => b.priority - a.priority);
		state.recommendations.push(...newRecs);
		// Keep last 5
		if (state.recommendations.length > 5) {
			state.recommendations = state.recommendations.slice(-5);
		}
	}
}

/**
 * Get pending recommendations (called by enforcement in turn_end).
 * Returns highest priority recommendation that's not on cooldown.
 */
export function getNextRecommendation(ctx: ExtensionContext): PolicyRecommendation | null {
	const state = getState(ctx);
	const now = Date.now();

	// Check cooldown
	if (now - state.lastRecommendationAt < state.recommendationCooldownMs) {
		return null;
	}

	// Get highest priority pending recommendation
	if (state.recommendations.length > 0) {
		const rec = state.recommendations[0];
		state.lastRecommendationAt = now;
		state.recommendations.shift();
		return rec;
	}

	return null;
}

/** Get all current beliefs */
export function getBeliefs(ctx: ExtensionContext): Belief[] {
	return [...getState(ctx).beliefs.values()];
}

/** Get signal history */
export function getSignals(ctx: ExtensionContext, count = 20): SystemSignal[] {
	return getState(ctx).signals.slice(-count);
}

/** Clear all state (for testing or session reset) */
export function clearBeliefEngine(ctx: ExtensionContext): void {
	const state = getState(ctx);
	state.signals = [];
	state.beliefs.clear();
	state.recommendations = [];
	state.lastRecommendationAt = 0;
}
