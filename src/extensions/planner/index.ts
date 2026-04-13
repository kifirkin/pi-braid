/**
 * Planner Extension
 *
 * Unified planning system: tasks, goals, plans, execution control, and coordination tools.
 * Merges what was previously spread across cognitive-systems, standalone tools, and the old
 * enforcement-style plan tool.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { GoalManager } from "../../lib/goal-manager.js";
import { Planner } from "../../lib/planner.js";
import { TaskQueue } from "../../lib/task-queue.js";
import { createAutonomousControlTools } from "../../tools/autonomous-control.js";
import { createFinalizeTool } from "../../tools/finalize.js";
import { createGoalTools } from "../../tools/goals.js";
import { createPlanningTools } from "../../tools/planning.js";
import { createTaskTools } from "../../tools/task.js";

// Shared state
const state = {
	taskQueue: new TaskQueue(),
	goalManager: new GoalManager(),
	planner: new Planner(),
};

export default function plannerExtension(pi: ExtensionAPI) {
	// Task tools
	const taskTools = createTaskTools({ queue: state.taskQueue });
	for (const [name, tool] of Object.entries(taskTools)) {
		pi.registerTool({
			name,
			label: tool.label ?? name,
			description: tool.description,
			parameters: tool.parameters,
			execute: async (toolCallId, params) => tool.execute(toolCallId, params, {} as any),
		});
	}

	// Goal tools
	const goalTools = createGoalTools({ manager: state.goalManager });
	for (const [name, tool] of Object.entries(goalTools)) {
		pi.registerTool({
			name,
			label: tool.label ?? name,
			description: tool.description,
			parameters: tool.parameters,
			execute: async (toolCallId, params) => tool.execute(toolCallId, params, {} as any),
		});
	}

	// Planning tools
	const planningTools = createPlanningTools({ planner: state.planner });
	for (const [name, tool] of Object.entries(planningTools)) {
		pi.registerTool({
			name,
			label: tool.label ?? name,
			description: tool.description,
			parameters: tool.parameters,
			execute: async (toolCallId, params) => tool.execute(toolCallId, params, {} as any),
		});
	}

	// Finalize tool
	const finalizeTool = createFinalizeTool();
	pi.registerTool({
		name: finalizeTool.name,
		label: finalizeTool.label,
		description: finalizeTool.description,
		parameters: finalizeTool.parameters,
		execute: finalizeTool.execute,
	});

// Autonomous control tools (signal_complete, signal_stuck)
	const autonomousTools = createAutonomousControlTools({
		onComplete: () => {},
		onStuck: (_reason) => {},
	});
	for (const [name, tool] of Object.entries(autonomousTools)) {
		pi.registerTool({
			name,
			label: tool.label ?? name,
			description: tool.description,
			parameters: tool.parameters,
			execute: tool.execute,
		});
	}

	// Retry command - retry failed tasks (autonomous queue)
	pi.registerCommand("task-retry", {
		description: "Retry failed tasks in the autonomous queue",
		handler: async (args, ctx) => {
			const failedTasks = state.taskQueue.list("failed");

			if (failedTasks.length === 0) {
				ctx.ui.notify("No failed tasks to retry.", "info");
				return;
			}

			if (!args || args.trim() === "") {
				// List failed tasks
				const lines = failedTasks.map((t) => {
					const canRetry = t.attempts < t.maxAttempts;
					return `${t.id}: ${t.description} (${t.attempts}/${t.maxAttempts} attempts)${canRetry ? " - can retry" : " - max attempts reached"}`;
				});
				ctx.ui.notify(`Failed tasks:\n${lines.join("\n")}\n\nUse /task-retry <task-id> to retry a specific task.`, "info");
				return;
			}

			// Try to retry specific task
			const taskId = args.trim();
			const task = state.taskQueue.getById(taskId);

			if (!task) {
				ctx.ui.notify(`Task ${taskId} not found.`, "error");
				return;
			}

			if (task.status !== "failed") {
				ctx.ui.notify(`Task ${taskId} is not failed (status: ${task.status}).`, "error");
				return;
			}

			if (task.attempts >= task.maxAttempts) {
				ctx.ui.notify(`Task ${taskId} has reached max attempts (${task.maxAttempts}). Cannot retry.`, "error");
				return;
			}

			const retried = state.taskQueue.retry(taskId);
			if (retried) {
				ctx.ui.notify(`Retried task ${taskId}. Now pending (attempt ${retried.attempts + 1}/${retried.maxAttempts}).`, "info");
			} else {
				ctx.ui.notify(`Failed to retry task ${taskId}.`, "error");
			}
		},
	});

	// Retry command - abort and trigger new turn
	pi.registerCommand("retry", {
		description: "Retry the last agent turn (abort and retry)",
		handler: async (_args, ctx) => {
			ctx.abort();
			// Trigger a new turn after abort
			pi.sendMessage(
				{
					customType: "retry",
					content: [{ type: "text" as const, text: "" }],
					display: false,
				},
				{ triggerTurn: true },
			);
		},
	});
}
