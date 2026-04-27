/**
 * Dreamer Module — Proactive Cognitive Simulation
 *
 * Simulates likely future tool sequences based on historical patterns
 * and current session trajectory. Suggests proactive actions before
 * problems occur (not reactive like MARS).
 *
 * Based on: arXiv:2604.14178 Heartbeat Scheduling — proactive vs reactive
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "./extension-state.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SimulatedPath {
	sequence: string[];
	probability: number;
	outcome: "success" | "failure" | "stuck";
	estimatedTurns: number;
}

export interface DreamAdvice {
	message: string;
	priority: number; // 1-10
	action: string;
	confidence: number; // 0-1
}

interface DreamerState {
	pathHistory: SimulatedPath[];
	lastDreamAt: number;
	dreamCooldownMs: number;
}

function getState(ctx: ExtensionContext): DreamerState {
	return getExtensionState(ctx, "dreamer", () => ({
		pathHistory: [],
		lastDreamAt: 0,
		dreamCooldownMs: 60_000,
	}));
}

// ── Path Simulation ─────────────────────────────────────────────────────────

/**
 * Simulate likely future paths from current tool sequence.
 * Uses simple Markov-style transition probabilities from historical data.
 */
export function simulatePaths(
	currentSequence: string[],
	historicalSequences: string[][] = [],
): SimulatedPath[] {
	if (currentSequence.length === 0) return [];

	const lastTool = currentSequence[currentSequence.length - 1];

	// Build transition frequencies from history
	const transitions: Map<string, Map<string, number>> = new Map();
	for (const seq of historicalSequences) {
		for (let i = 0; i < seq.length - 1; i++) {
			const from = seq[i];
			const to = seq[i + 1];
			if (!transitions.has(from)) transitions.set(from, new Map());
			const counts = transitions.get(from)!;
			counts.set(to, (counts.get(to) ?? 0) + 1);
		}
	}

	// Generate possible next steps from last tool
	const nextCounts = transitions.get(lastTool);
	if (!nextCounts || nextCounts.size === 0) return [];

	const total = [...nextCounts.values()].reduce((a, b) => a + b, 0);

	const paths: SimulatedPath[] = [];
	for (const [nextTool, count] of nextCounts) {
		const prob = count / total;

		// Simulate 3-step lookahead
		const extended = [...currentSequence, nextTool];
		const nextNext = transitions.get(nextTool);
		let outcome: SimulatedPath["outcome"] = "success";
		let estimatedTurns = 1;

		if (nextNext) {
			const nextTotal = [...nextNext.values()].reduce((a, b) => a + b, 0);
			// If next step leads to high-frequency same-tool transitions → stuck
			const selfLoopRate = (nextNext.get(nextTool) ?? 0) / nextTotal;
			if (selfLoopRate > 0.5) {
				outcome = "stuck";
				estimatedTurns = 5;
			} else if (selfLoopRate > 0.3) {
				outcome = "failure";
				estimatedTurns = 3;
			}
		}

		paths.push({
			sequence: extended,
			probability: prob,
			outcome,
			estimatedTurns,
		});
	}

	// Sort by probability descending
	return paths.sort((a, b) => b.probability - a.probability).slice(0, 5);
}

// ── Advice Generation ───────────────────────────────────────────────────────

/**
 * Generate proactive advice from simulated paths.
 * Only returns advice if a concerning path is detected with sufficient confidence.
 */
export function dream(
	ctx: ExtensionContext,
	currentSequence: string[],
	historicalSequences?: string[][],
): DreamAdvice | null {
	const state = getState(ctx);
	const now = Date.now();

	// Cooldown check
	if (now - state.lastDreamAt < state.dreamCooldownMs) return null;

	const paths = simulatePaths(currentSequence, historicalSequences);
	if (paths.length === 0) return null;

	// Find most concerning path
	const stuckPaths = paths.filter((p) => p.outcome === "stuck" && p.probability > 0.15);
	const failPaths = paths.filter((p) => p.outcome === "failure" && p.probability > 0.2);

	if (stuckPaths.length > 0) {
		const worst = stuckPaths[0];
		state.lastDreamAt = now;
		return {
			message: `[dream] Likely to get stuck in ${worst.sequence.slice(-2).join("→")} loop (prob: ${(worst.probability * 100).toFixed(0)}%). Consider: verify approach or ask for clarification.`,
			priority: 7,
			action: "Call think(type='reflection') to verify approach.",
			confidence: worst.probability,
		};
	}

	if (failPaths.length > 0) {
		const worst = failPaths[0];
		state.lastDreamAt = now;
		return {
			message: `[dream] Historical pattern suggests failure path: ${worst.sequence.slice(-2).join("→")} (prob: ${(worst.probability * 100).toFixed(0)}%). Consider: run tests before more edits.`,
			priority: 6,
			action: "Run verification before proceeding.",
			confidence: worst.probability,
		};
	}

	return null;
}

/** Reset dreamer state (for testing or session reset) */
export function resetDreamer(ctx: ExtensionContext): void {
	const state = getState(ctx);
	state.pathHistory = [];
	state.lastDreamAt = 0;
}
