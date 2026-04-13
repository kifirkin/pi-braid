/**
 * Reasoning Extension - Minimal Thinking Helper
 *
 * Key features:
 * 1. Detects malformed tool calls (XML tags as text) - catches common LLM errors
 * 2. Tracks simple step count for progress
 * 3. Reminds to verify before claiming done
 *
 * Simple and helpful, not prescriptive.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ============================================================================
// Helper: Send Enforcement Message as Custom (for visual distinction in TUI)
// ============================================================================

/**
 * Send a enforcement/nudge message that will be visually distinct in the TUI.
 * Uses role: "custom" with customType: "enforcement" so it renders with purple
 * background and [enforcement] label instead of looking like a user message.
 */
function sendSteerMessage(pi: ExtensionAPI, message: string): void {
	pi.sendMessage(
		{
			customType: "enforcement",
			content: [{ type: "text" as const, text: message }],
			display: true,
		},
		{ deliverAs: "steer" },
	);
}

// ============================================================================
// Types
// ============================================================================

interface ReasoningState {
	step: number;
	goal: string;
	timestamp: number;
}

interface ExtensionState {
	current: ReasoningState | null;
	history: ReasoningState[];
	turnCount: number;
}

// ============================================================================
// State
// ============================================================================

const state: ExtensionState = {
	current: null,
	history: [],
	turnCount: 0,
};

// ============================================================================
// Malformed Tool Call Detection
// ============================================================================

const MALFORMED_REGEX =
	/<(function|write|edit|read|bash|grep|find|ls|think|plan|scratchpad)[^>]*>[\s\S]*?<\/(function|write|edit|read|bash|grep|find|ls|think|plan|scratchpad)>/gi;

function detectMalformedToolCalls(text: string, pi: ExtensionAPI): void {
	MALFORMED_REGEX.lastIndex = 0;
	const match = MALFORMED_REGEX.exec(text);
	MALFORMED_REGEX.lastIndex = 0;

	if (match) {
		const toolNameMatch = text.match(/<(function|write|edit|read|bash|grep|find|ls|think|plan|scratchpad)/i);
		const detectedTool = toolNameMatch ? toolNameMatch[1].toLowerCase() : "unknown";

		if (state.current) {
			state.current.step++;
		}

		sendSteerMessage(
			pi,
			"Malformed tool call detected: <" +
				detectedTool +
				"> as TEXT. Use proper function calling format - do NOT output XML tags as plain text.",
		);
	}
}

// ============================================================================
// Simple Prompt
// ============================================================================

const THINK_STEP_BY_STEP = `
## Thinking

Think step by step. For complex tasks, think through the problem before acting.
`;

const VERIFICATION_REMINDER = `
## Before claiming done

Run tests to verify your work. Call signal_complete when verified.
`;

// ============================================================================
// Extension Factory
// ============================================================================

export default function reasoningExtension(pi: ExtensionAPI) {
	// =======================================================================
	// Pre-Turn: Inject simple prompts
	// =======================================================================

	pi.on("before_agent_start", async (event) => {
		state.turnCount++;

		// Initialize state if needed
		if (!state.current) {
			state.current = { step: 1, goal: "", timestamp: Date.now() };
		}

		// Build minimal prompt
		let prompt = event.systemPrompt;
		prompt += `\n\n${THINK_STEP_BY_STEP}`;
		prompt += `\n\n${VERIFICATION_REMINDER}`;

		// Add previous state if available
		if (state.current) {
			prompt +=
				"\n\n## Progress\n- Step: " +
				state.current.step +
				"\n- Goal: " +
				(state.current.goal || "(not set)") +
				"\n- Turns: " +
				state.turnCount;
		}

		return { systemPrompt: prompt };
	});

	// =======================================================================
	// Message End: Check for malformed tool calls
	// =======================================================================

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;

		// Extract text content
		const textContent = event.message.content
			.filter((c) => c.type === "text")
			.map((c) => (c as { type: "text"; text: string }).text)
			.join("\n");

		// Always check for malformed tool calls
		detectMalformedToolCalls(textContent, pi);

		// Increment step count for tracking
		if (state.current) {
			state.current.step++;
		}
	});

	// =======================================================================
	// Commands
	// =======================================================================

	pi.registerCommand("loop-status", {
		description: "Show reasoning status",
		handler: async (_args, ctx) => {
			if (state.current) {
				ctx.ui.notify(`Step ${state.current.step} | Turns: ${state.turnCount}`, "info");
			} else {
				ctx.ui.notify("No active reasoning. Start a task!", "info");
			}
		},
	});

	pi.registerCommand("loop-reset", {
		description: "Reset reasoning state",
		handler: async (_args, ctx) => {
			state.current = null;
			state.history = [];
			state.turnCount = 0;
			ctx.ui.notify("Reasoning reset.", "info");
		},
	});

	pi.registerCommand("loop-help", {
		description: "Show reasoning help",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Think step by step. Run tests before claiming done.", "info");
		},
	});
}

// ============================================================================
// Utilities
// ============================================================================

export function getCurrentReasoning(): ReasoningState | null {
	return state.current;
}

export function getReasoningHistory(): ReasoningState[] {
	return [...state.history];
}
