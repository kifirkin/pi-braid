/**
 * Task management tools for autonomous agent operation
 *
 * These tools allow the agent to manage its own task queue:
 * - task_add: Add new tasks
 * - task_list: View task status
 * - task_complete: Mark task as done
 * - task_fail: Mark task as failed
 * - task_next: Get next ready task
 *
 * Based on: docs/proposals/SMART_AGENT_LOOP.md
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Task, TaskQueue } from "../lib/task-queue.js";

// Schema definitions
const taskAddSchema = Type.Object({
	description: Type.String({ description: "What the agent should do" }),
	priority: Type.Optional(Type.Number({ default: 0, description: "Higher = more important" })),
	dependencies: Type.Optional(
		Type.Array(Type.String(), { default: [], description: "Task IDs that must complete first" }),
	),
});

const taskListSchema = Type.Object({
	status: Type.Optional(
		Type.String({ default: "all", description: "Filter by status: pending, running, completed, failed" }),
	),
});

const taskCompleteSchema = Type.Object({
	id: Type.String({ description: "Task ID to complete" }),
	result: Type.Optional(Type.String({ description: "Summary of what was accomplished" })),
});

const taskFailSchema = Type.Object({
	id: Type.String({ description: "Task ID that failed" }),
	error: Type.String({ description: "Why the task failed" }),
});

const taskNextSchema = Type.Object({});

/** Options for creating task tools */
export interface TaskToolOptions {
	/** Task queue instance to operate on */
	queue: TaskQueue;
}

/** Create task management tools bound to a specific queue */
export function createTaskTools(options: TaskToolOptions): Record<string, AgentTool<any>> {
	const { queue } = options;

	const taskAddTool: AgentTool<typeof taskAddSchema> = {
		name: "task_add",
		label: "Add Task",
		description: "Add a task to the autonomous queue. Dependencies are task IDs that must complete first.",
		parameters: taskAddSchema,
		execute: async (_toolCallId, params) => {
			const task = queue.add(params.description, {
				priority: params.priority,
				dependencies: params.dependencies,
			});
			return {
				content: [{ type: "text" as const, text: `Added ${task.id}: ${task.description}` }],
				details: { id: task.id },
			};
		},
	};

	const taskListTool: AgentTool<typeof taskListSchema> = {
		name: "task_list",
		label: "List Tasks",
		description: "List all tasks. Use status filter to see pending/running/completed/failed.",
		parameters: taskListSchema,
		execute: async (_toolCallId, params) => {
			const tasks = queue.list(params.status as Task["status"] | undefined);

			if (tasks.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No tasks." }],
					details: { count: 0 },
				};
			}

			const lines = tasks.map((t) => {
				const deps = t.dependencies.length > 0 ? ` [deps: ${t.dependencies.join(", ")}]` : "";
				return `[${t.status}] ${t.id}: ${t.description}${deps}`;
			});

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { count: tasks.length },
			};
		},
	};

	const taskCompleteTool: AgentTool<typeof taskCompleteSchema> = {
		name: "task_complete",
		label: "Complete Task",
		description: "Mark a task as completed with optional result summary.",
		parameters: taskCompleteSchema,
		execute: async (_toolCallId, params) => {
			const task = queue.markCompleted(params.id, params.result);
			if (!task) {
				throw new Error(`Task ${params.id} not found`);
			}
			return {
				content: [{ type: "text" as const, text: `Completed ${params.id}` }],
				details: undefined,
			};
		},
	};

	const taskFailTool: AgentTool<typeof taskFailSchema> = {
		name: "task_fail",
		label: "Fail Task",
		description: "Mark a task as failed with error reason. Will retry if under max attempts.",
		parameters: taskFailSchema,
		execute: async (_toolCallId, params) => {
			const task = queue.markFailed(params.id, params.error);
			if (!task) {
				throw new Error(`Task ${params.id} not found`);
			}

			// Check if task should be retried
			if (queue.shouldRetry(params.id)) {
				queue.retry(params.id);
				return {
					content: [
						{
							type: "text" as const,
							text: `Task ${params.id} failed but will retry (attempt ${task.attempts + 1}/${task.maxAttempts})`,
						},
					],
					details: { willRetry: true },
				};
			}

			return {
				content: [
					{ type: "text" as const, text: `Task ${params.id} failed permanently after ${task.attempts} attempts` },
				],
				details: { willRetry: false },
			};
		},
	};

	const taskNextTool: AgentTool<typeof taskNextSchema> = {
		name: "task_next",
		label: "Next Task",
		description: "Get next ready task (dependencies satisfied, highest priority). Returns empty if no ready tasks.",
		parameters: taskNextSchema,
		execute: async () => {
			const next = queue.getNext();
			if (!next) {
				return {
					content: [{ type: "text" as const, text: "No ready tasks." }],
					details: null,
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `${next.id}: ${next.description}\nPriority: ${next.priority}`,
					},
				],
				details: { id: next.id, description: next.description, priority: next.priority },
			};
		},
	};

	return {
		task_add: taskAddTool,
		task_list: taskListTool,
		task_complete: taskCompleteTool,
		task_fail: taskFailTool,
		task_next: taskNextTool,
	};
}
