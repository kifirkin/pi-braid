/**
 * Validation Logic
 *
 * Validates turns and tool usage patterns with smart detection that avoids
 * false positives for legitimate workflows (e.g. reading different files).
 */

import { POST_TURN_VALIDATION_TEMPLATE } from "./prompts.js";
import { state } from "./state.js";
import type { TurnState, ValidationResult } from "./types.js";

// Tools that are cheap to repeat legitimately (different files/targets)
const LEGIT_REPEATABLE = new Set<string>(["read", "grep", "find", "bash"]);
// Tools that signal actual progress
const PROGRESS_TOOLS = new Set<string>(["edit", "write", "bash"]);

/**
 * Check if a tool sequence is semantically repetitive.
 * "read,read" on different files is fine. "read,read" on same file is wasteful.
 *
 * Returns:
 *  - null  : not a repetition problem
 *  - string: the issue message
 */
function checkSemanticRepetition(
	currentTools: string[],
	prevSeqs: string[][],
	warnThreshold: number,
): string | null {
	const uniqueInSeq = new Set(currentTools);
	// Single-tool repetition: "read,read", "bash,bash"
	// These are NOT flagged as issues since read can hit different files,
	// bash can run different commands. Only flag if same PATH is targeted
	// (detected elsewhere via file path tracking).
	if (currentTools.length === 1 || (currentTools.length === 2 && currentTools[0] === currentTools[1])) {
		return null;
	}

	const currentSeq = currentTools.join(",");
	const repetitions = prevSeqs.filter((s) => s.join(",") === currentSeq).length;

	if (repetitions >= warnThreshold) {
		// Build a contextual message instead of raw tool names
		const tools = currentTools.join(" → ");
		// If the sequence contains only cheap/repeatable tools, be softer
		const allRepeatable = currentTools.every((t) => LEGIT_REPEATABLE.has(t));
		if (allRepeatable) {
			return `Exploration sequence "${tools}" repeated ${repetitions + 1} times without progress. ` +
				`Consider: editing files, running commands, or using think() to plan next steps.`;
		}
		return `Tool sequence "${tools}" repeated ${repetitions + 1} times. Consider a different approach.`;
	}

	return null;
}

/**
 * Detect wasteful re-reads: same file read without intervening progress.
 * This is the real problem behind "read,read" false positives.
 */
function checkReReadWaste(currentTools: string[], prevTools: string[][], recentlyReadFiles: Map<string, number>): string | null {
	// Only relevant for read-heavy turns
	const readCount = currentTools.filter((t) => t === "read").length;
	if (readCount < 2) return null;

	// Check if we've seen a read-only streak recently (no progress tools in between)
	let streak = 0;
	for (let i = prevTools.length - 1; i >= 0; i--) {
		const tools = prevTools[i];
		if (tools.length === 1 && tools[0] === "read") {
			streak++;
		} else if (tools.some((t) => PROGRESS_TOOLS.has(t))) {
			break;
		} else {
			streak++;
			if (streak > 3) break;
		}
	}

	if (streak >= 3 && readCount >= 2) {
		return `You've spent ${streak + 1} turns mostly reading. Store what you've learned: ` +
			`memory_store(content="...", tags=["pattern", "codebase"]) and update scratchpad before continuing.`;
	}

	return null;
}

/**
 * Validate a turn's tool usage
 */
export function validateTurn(
	previousState: TurnState | undefined,
	currentState: TurnState,
	erroredTools: Set<string> = new Set(),
	isInfrastructureError: boolean = false,
): ValidationResult {
	const issues: string[] = [];
	const hadErrors = erroredTools.size > 0;

	// Check for silent turns (no tools called)
	// Skip if infrastructure error (API timeout, rate-limit, etc.) - the agent tried to work but couldn't
	if (isInfrastructureError) {
		// Don't penalize the agent for infrastructure failures
		state.silentTurns = 0;
	} else if (currentState.actualTools.length === 0) {
		state.silentTurns++;
		if (state.silentTurns >= state.config.maxSilentTurns) {
			issues.push(
				`${state.silentTurns} turns without tool calls. You work through tools — reach for read, bash, edit, write to make progress.`,
			);
		}
	} else {
		state.silentTurns = 0;
	}

	// Check for planned vs actual tools - skip if tools had errors
	if (!hadErrors && previousState && previousState.plannedTools.length > 0) {
		const missedTools = previousState.plannedTools.filter((t) => !currentState.actualTools.includes(t));
		if (missedTools.length > 0) {
			issues.push(`You planned to use ${missedTools.join(", ")} but didn't. Either use them or update your plan.`);
		}
	}

	// Check for tool sequence repetition — smart detection avoids false positives
	if (!hadErrors && currentState.actualTools.length > 0) {
		const prevSeqs = state.recentToolSequences.slice(-state.config.warnOnToolSequenceRepetition);

		// Semantic repetition check (handles read,read etc. properly)
		const seqIssue = checkSemanticRepetition(
			currentState.actualTools,
			prevSeqs,
			state.config.warnOnToolSequenceRepetition,
		);
		if (seqIssue) {
			issues.push(seqIssue);
		}

		// Re-read waste detection
		const readWasteIssue = checkReReadWaste(currentState.actualTools, prevSeqs, state.recentlyReadFiles);
		if (readWasteIssue) {
			issues.push(readWasteIssue);
		}

		// Track sequence (always, for next-turn analysis)
		state.recentToolSequences.push([...currentState.actualTools]);
		if (state.recentToolSequences.length > 20) {
			state.recentToolSequences.shift();
		}
	}

	// Check for scratchpad requirement - skip if tools had errors
	const scratchpadCooldownTurns = 5;
	const recentlyNudgedForScratchpad = state.currentTurn - state.lastScratchpadNudgeTurn < scratchpadCooldownTurns;

	if (
		!hadErrors &&
		state.config.enforceScratchpad &&
		currentState.actualTools.some((t) => ["edit", "write"].includes(t)) &&
		!currentState.scratchpadUpdated &&
		!recentlyNudgedForScratchpad
	) {
		issues.push(
			"You made file changes without updating scratchpad. Use `scratchpad()` to track: goal, plan, decisions.",
		);
		state.lastScratchpadNudgeTurn = state.currentTurn;
	}

	// Generate nudge message
	let nudge: string | null = null;
	let severity: "info" | "warning" | "critical" = "info";

	if (issues.length > 0) {
		if (!hadErrors) {
			state.validationFailures++;
		}
		severity = state.validationFailures > 3 ? "critical" : state.validationFailures > 1 ? "warning" : "info";
		nudge = POST_TURN_VALIDATION_TEMPLATE.replace("{issues}", issues.map((i) => `- ${i}`).join("\n"));
	}

	return {
		passed: issues.length === 0,
		issues,
		nudge,
		severity,
	};
}

/**
 * Check if tool call is appropriate for current phase
 */
export function validateToolForPhase(toolName: string, _turnIndex: number): { valid: boolean; message: string | null } {
	const recentTools = Array.from(state.turnHistory.values())
		.slice(-5)
		.flatMap((t) => t.actualTools);

	let phase: "exploration" | "implementation" | "verification" | "unknown" = "unknown";

	if (recentTools.some((t) => ["grep", "find", "ls", "read"].includes(t))) {
		phase = "exploration";
	}
	if (recentTools.some((t) => ["edit", "write"].includes(t))) {
		phase = "implementation";
	}

	const phaseAppropriate: Record<string, string[]> = {
		exploration: ["read", "grep", "find", "ls", "bash", "think", "scratchpad"],
		implementation: ["read", "write", "edit", "bash", "scratchpad", "think"],
		verification: ["bash", "read", "think"],
		unknown: ["read", "grep", "find", "ls", "bash", "write", "edit", "think", "scratchpad"],
	};

	const appropriate = phaseAppropriate[phase] || phaseAppropriate.unknown;

	if (!appropriate.includes(toolName)) {
		return {
			valid: true,
			message: `Note: ${toolName} is unusual for ${phase} phase. Expected: ${appropriate.join(", ")}`,
		};
	}

	return { valid: true, message: null };
}
