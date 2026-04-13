/**
 * Scratchpad Extension
 *
 * Per-loop persistent state for continuity of thought across turns.
 * Similar to Hermes's TodoStore - dies when task completes.
 * Maintains continuity of thought without bloating context.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ============================================================================
// State
// ============================================================================

/**
 * TaskScratchpad - Per-loop state that persists across turns.
 */
export interface TaskScratchpad {
	/** Original goal/task */
	goal: string;
	/** Steps to complete */
	plan: string[];
	/** Steps completed */
	done: string[];
	/** Key decisions made */
	decisions: string[];
	/** Multiple hypotheses (for debugging) */
	hypotheses: string[];
	/** Notes/thoughts */
	notes: string[];
}

/**
 * Module-level scratchpad state.
 * This is shared across all calls within a session.
 */
let _taskScratchpad: TaskScratchpad = createScratchpad("");

/**
 * Create a new scratchpad with the given goal.
 */
export function createScratchpad(goal: string): TaskScratchpad {
	return {
		goal,
		plan: [],
		done: [],
		decisions: [],
		hypotheses: [],
		notes: [],
	};
}

/**
 * Format scratchpad for display.
 */
export function formatScratchpad(pad: TaskScratchpad): string {
	const lines = [`Goal: ${pad.goal}`];

	if (pad.plan.length > 0) {
		lines.push("\nPlan:");
		for (let i = 0; i < pad.plan.length; i++) {
			const step = pad.plan[i];
			const status = pad.done.includes(step) ? "✅" : "⬜";
			lines.push(`  ${status} ${i + 1}. ${step}`);
		}
	}

	if (pad.decisions.length > 0) {
		lines.push("\nDecisions:");
		for (const d of pad.decisions) {
			lines.push(`  - ${d}`);
		}
	}

	if (pad.hypotheses.length > 0) {
		lines.push("\nHypotheses:");
		for (let i = 0; i < pad.hypotheses.length; i++) {
			lines.push(`  ${i + 1}. ${pad.hypotheses[i]}`);
		}
	}

	if (pad.notes.length > 0) {
		lines.push("\nNotes:");
		for (const n of pad.notes) {
			lines.push(`  - ${n}`);
		}
	}

	return lines.join("\n");
}

// ============================================================================
// Scratchpad Control Functions
// ============================================================================

/**
 * Create or update the task scratchpad with a new goal.
 * Called when starting a new task.
 */
export function startScratchpad(goal: string): void {
	_taskScratchpad = createScratchpad(goal);
}

/**
 * Clear the scratchpad when the task completes.
 */
export function clearScratchpad(): void {
	_taskScratchpad = createScratchpad("");
}

/**
 * Get current scratchpad state.
 */
export function getScratchpad(): TaskScratchpad {
	return _taskScratchpad;
}

// ============================================================================
// Tool
// ============================================================================

const scratchpadSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("read", { description: "Read current scratchpad" }),
			Type.Literal("set_goal", { description: "Set or update goal" }),
			Type.Literal("add_plan", { description: "Add step to plan" }),
			Type.Literal("mark_done", { description: "Mark step as done" }),
			Type.Literal("add_decision", { description: "Record a decision" }),
			Type.Literal("add_hypothesis", { description: "Add hypothesis (for debugging)" }),
			Type.Literal("add_note", { description: "Add a note" }),
		],
		{ description: "Action to perform on the scratchpad" },
	),
	text: Type.Optional(
		Type.String({
			description:
				"Text content for the action (required for set_goal, add_plan, mark_done, add_decision, add_hypothesis, add_note)",
		}),
	),
});

type ScratchpadAction = "read" | "set_goal" | "add_plan" | "mark_done" | "add_decision" | "add_hypothesis" | "add_note";

type ScratchpadToolInput = {
	action: ScratchpadAction;
	text?: string;
};

// ============================================================================
// Extension
// ============================================================================

export default function scratchpadExtension(pi: ExtensionAPI): void {
	const scratchpadTool: AgentTool<typeof scratchpadSchema> = {
		name: "scratchpad",
		label: "Scratchpad",
		description:
			"Per-loop scratchpad for continuity of thought. Persists across turns, dies with task. Use to track: goal, plan, progress, decisions, hypotheses.",
		parameters: scratchpadSchema,
		execute: async (_toolCallId: string, params: unknown): Promise<AgentToolResult<unknown>> => {
			const { action, text } = params as ScratchpadToolInput;

			switch (action) {
				case "read":
					return {
						content: [{ type: "text" as const, text: formatScratchpad(_taskScratchpad) }],
						details: _taskScratchpad,
					};

				case "set_goal":
					if (!text)
						return {
							content: [{ type: "text" as const, text: "text required" }],
							details: { error: "missing_text" },
						};
					_taskScratchpad.goal = text;
					return { content: [{ type: "text" as const, text: `Goal set: ${text}` }], details: { goal: text } };

				case "add_plan":
					if (!text)
						return {
							content: [{ type: "text" as const, text: "text required" }],
							details: { error: "missing_text" },
						};
					_taskScratchpad.plan.push(text);
					return {
						content: [{ type: "text" as const, text: `Plan step added: ${text}` }],
						details: { plan: _taskScratchpad.plan },
					};

				case "mark_done":
					if (!text)
						return {
							content: [{ type: "text" as const, text: "text required" }],
							details: { error: "missing_text" },
						};
					if (!_taskScratchpad.done.includes(text)) _taskScratchpad.done.push(text);
					return {
						content: [{ type: "text" as const, text: `Marked done: ${text}` }],
						details: { done: _taskScratchpad.done },
					};

				case "add_decision":
					if (!text)
						return {
							content: [{ type: "text" as const, text: "text required" }],
							details: { error: "missing_text" },
						};
					_taskScratchpad.decisions.push(text);
					return {
						content: [{ type: "text" as const, text: `Decision recorded: ${text}` }],
						details: { decisions: _taskScratchpad.decisions },
					};

				case "add_hypothesis":
					if (!text)
						return {
							content: [{ type: "text" as const, text: "text required" }],
							details: { error: "missing_text" },
						};
					_taskScratchpad.hypotheses.push(text);
					return {
						content: [{ type: "text" as const, text: `Hypothesis added: ${text}` }],
						details: { hypotheses: _taskScratchpad.hypotheses },
					};

				case "add_note":
					if (!text)
						return {
							content: [{ type: "text" as const, text: "text required" }],
							details: { error: "missing_text" },
						};
					_taskScratchpad.notes.push(text);
					return {
						content: [{ type: "text" as const, text: `Note added: ${text}` }],
						details: { notes: _taskScratchpad.notes },
					};

				default:
					return {
						content: [{ type: "text" as const, text: `Unknown action: ${action}` }],
						details: { error: "unknown_action" },
					};
			}
		},
	};

	pi.registerTool({
		name: scratchpadTool.name,
		label: scratchpadTool.label,
		description: scratchpadTool.description,
		parameters: scratchpadTool.parameters,
		execute: scratchpadTool.execute,
	});
}
