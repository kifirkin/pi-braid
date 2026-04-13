/**
 * Scratchpad Tool
 *
 * Per-loop state that persists across turns within a task.
 * Dies when task completes. Maintains continuity of thought.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { formatScratchpad, type TaskScratchpad } from "../lib/task-scratchpad.js";

export function createScratchpadTool(scratchpad: TaskScratchpad | null): AgentTool {
	const schema = Type.Object({
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
			{ description: "Action to perform" },
		),
		text: Type.Optional(
			Type.String({
				description:
					"Text for the action (required for set_goal, add_plan, mark_done, add_decision, add_hypothesis, add_note)",
			}),
		),
	});

	return {
		name: "scratchpad",
		label: "Scratchpad",
		description:
			"Per-loop scratchpad for continuity of thought. Persists across turns, dies with task. Use to track: goal, plan, progress, decisions, hypotheses.",
		parameters: schema,
		execute: async (_toolCallId: string, params: unknown) => {
			if (!scratchpad) {
				return {
					content: [{ type: "text" as const, text: "No active scratchpad. Start a task first." }],
					details: { error: "no_scratchpad" },
				};
			}

			const { action, text } = params as { action: string; text?: string };

			switch (action) {
				case "read":
					return {
						content: [{ type: "text" as const, text: formatScratchpad(scratchpad) }],
						details: scratchpad,
					};

				case "set_goal":
					if (!text)
						return {
							content: [{ type: "text" as const, text: "text required" }],
							details: { error: "missing_text" },
						};
					scratchpad.goal = text;
					return { content: [{ type: "text" as const, text: `Goal set: ${text}` }], details: { goal: text } };

				case "add_plan":
					if (!text)
						return {
							content: [{ type: "text" as const, text: "text required" }],
							details: { error: "missing_text" },
						};
					scratchpad.plan.push(text);
					return {
						content: [{ type: "text" as const, text: `Plan step added: ${text}` }],
						details: { plan: scratchpad.plan },
					};

				case "mark_done":
					if (!text)
						return {
							content: [{ type: "text" as const, text: "text required" }],
							details: { error: "missing_text" },
						};
					if (!scratchpad.done.includes(text)) scratchpad.done.push(text);
					return {
						content: [{ type: "text" as const, text: `Marked done: ${text}` }],
						details: { done: scratchpad.done },
					};

				case "add_decision":
					if (!text)
						return {
							content: [{ type: "text" as const, text: "text required" }],
							details: { error: "missing_text" },
						};
					scratchpad.decisions.push(text);
					return {
						content: [{ type: "text" as const, text: `Decision recorded: ${text}` }],
						details: { decisions: scratchpad.decisions },
					};

				case "add_hypothesis":
					if (!text)
						return {
							content: [{ type: "text" as const, text: "text required" }],
							details: { error: "missing_text" },
						};
					scratchpad.hypotheses.push(text);
					return {
						content: [{ type: "text" as const, text: `Hypothesis added: ${text}` }],
						details: { hypotheses: scratchpad.hypotheses },
					};

				case "add_note":
					if (!text)
						return {
							content: [{ type: "text" as const, text: "text required" }],
							details: { error: "missing_text" },
						};
					scratchpad.notes.push(text);
					return {
						content: [{ type: "text" as const, text: `Note added: ${text}` }],
						details: { notes: scratchpad.notes },
					};

				default:
					return {
						content: [{ type: "text" as const, text: `Unknown action: ${action}` }],
						details: { error: "unknown_action" },
					};
			}
		},
	};
}
