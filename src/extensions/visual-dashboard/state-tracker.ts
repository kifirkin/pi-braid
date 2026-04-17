/**
 * State Tracker - Agent state tracking for visual dashboard
 *
 * Tracks:
 * - Turns and timing
 * - Current phase (exploring, planning, implementing, verifying)
 * - Tool usage patterns
 * - Confidence scores
 * - Memory pressure
 * - Token budget
 */

import type { AgentMetrics } from "./index.js";

// Phase detection based on tool sequences
const EXPLORATION_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "analyze_image", "read_document"]);
const PLANNING_TOOLS = new Set(["think", "hypothesize", "plan", "goal"]);
const IMPLEMENTATION_TOOLS = new Set(["write", "edit", "create", "delete"]);
const VERIFICATION_TOOLS = new Set(["bash", "test", "repl", "verify"]);

export interface TrackedState {
	turns: number;
	sessionStartMs: number;
	turnStartMs: number;
	phase: AgentMetrics["phase"];
	confidence: number;
	memoryPressure: number;
	toolSequence: string[];
	toolCounts: Map<string, number>;
	errors: number;
	warnings: number;
	totalTokens: number;
	contextPercent: number;
	phaseStartTurn: number;
	tokenBudget: number;
}

export function createStateTracker(): TrackedState {
	return {
		turns: 0,
		sessionStartMs: Date.now(),
		turnStartMs: Date.now(),
		phase: "idle",
		confidence: 100,
		memoryPressure: 0,
		toolSequence: [],
		toolCounts: new Map(),
		errors: 0,
		warnings: 0,
		totalTokens: 0,
		contextPercent: 0,
		phaseStartTurn: 0,
		tokenBudget: 100000, // Default 100K context
	};
}

/**
 * Detect phase from recent tool sequence
 */
export function detectPhase(toolSequence: string[]): AgentMetrics["phase"] {
	if (toolSequence.length === 0) return "idle";

	const last10 = toolSequence.slice(-10);
	const counts = {
		exploring: 0,
		planning: 0,
		implementing: 0,
		verifying: 0,
	};

	for (const tool of last10) {
		if (EXPLORATION_TOOLS.has(tool)) counts.exploring++;
		if (PLANNING_TOOLS.has(tool)) counts.planning++;
		if (IMPLEMENTATION_TOOLS.has(tool)) counts.implementing++;
		if (VERIFICATION_TOOLS.has(tool)) counts.verifying++;
	}

	// Find dominant phase (at least 2 occurrences)
	const maxCount = Math.max(...Object.values(counts));
	if (maxCount < 2) return "idle";

	if (counts.verifying === maxCount) return "verifying";
	if (counts.implementing === maxCount) return "implementing";
	if (counts.planning === maxCount) return "planning";
	if (counts.exploring === maxCount) return "exploring";

	return "idle";
}

/**
 * Update phase if changed
 */
export function updatePhase(state: TrackedState): AgentMetrics["phase"] {
	const newPhase = detectPhase(state.toolSequence);
	if (newPhase !== state.phase) {
		state.phaseStartTurn = state.turns;
		state.phase = newPhase;
	}
	return state.phase;
}

/**
 * Record a tool call
 */
export function recordToolCall(state: TrackedState, toolName: string): void {
	state.toolSequence.push(toolName);
	if (state.toolSequence.length > 50) {
		state.toolSequence = state.toolSequence.slice(-50);
	}
	const count = state.toolCounts.get(toolName) || 0;
	state.toolCounts.set(toolName, count + 1);
}

/**
 * Format phase for display
 */
export function formatPhase(phase: AgentMetrics["phase"]): string {
	const labels: Record<AgentMetrics["phase"], string> = {
		idle: "⏸ idle",
		exploring: "🔍 exploring",
		planning: "🧠 planning",
		implementing: "⚙️ implementing",
		verifying: "✅ verifying",
	};
	return labels[phase] || phase;
}
