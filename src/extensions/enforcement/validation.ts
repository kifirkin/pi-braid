/**
 * Validation Logic
 *
 * Validates turns and tool usage patterns.
 */

import { POST_TURN_VALIDATION_TEMPLATE } from "./prompts.js";
import { state } from "./state.js";
import type { TurnState, ValidationResult } from "./types.js";

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

	// Check for tool sequence repetition - skip if tools had errors
	if (!hadErrors && currentState.actualTools.length > 0) {
		const currentSeq = currentState.actualTools.join(",");
		const prevSeqs = state.recentToolSequences.slice(-state.config.warnOnToolSequenceRepetition);
		const repetitions = prevSeqs.filter((s) => s.join(",") === currentSeq).length;

		const isSingleToolSequence = currentState.actualTools.length === 1;

		if (repetitions >= state.config.warnOnToolSequenceRepetition && !isSingleToolSequence) {
			issues.push(`Tool sequence "${currentSeq}" repeated ${repetitions + 1} times. Consider a different approach.`);
		}

		if (!isSingleToolSequence) {
			state.recentToolSequences.push(currentState.actualTools);
			if (state.recentToolSequences.length > 20) {
				state.recentToolSequences.shift();
			}
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
