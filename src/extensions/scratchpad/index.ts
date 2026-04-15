/**
 * Scratchpad Extension
 *
 * Per-loop persistent state for continuity of thought across turns.
 * Persists to disk per-project so it survives process restarts.
 * Multiple agents on the same project share scratchpad state.
 *
 * Also includes lightweight task management (merged from task tools).
 * For complex planning, use plan_* tools. For simple task tracking, use scratchpad.
 *
 * Storage: ~/.pi/agent/scratchpads/{project-slug}/latest.json
 * Tasks:  ~/.pi/agent/scratchpads/{project-slug}/tasks.json
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Types

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
	/** Timestamp of last mutation */
	updatedAt: number;
	/** Project slug this scratchpad belongs to */
	projectSlug: string;
}

// Task Management (merged from task tools)

export interface TaskItem {
	id: string;
	description: string;
	status: "pending" | "running" | "completed" | "failed";
	priority: number;
	dependencies: string[];
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
	result?: string;
	error?: string;
	attempts: number;
	maxAttempts: number;
}

interface TaskStore {
	tasks: TaskItem[];
	updatedAt: number;
}

// Persistence

const SCRATCHPAD_BASE_DIR = path.join(os.homedir(), ".pi", "agent", "scratchpads");

function projectSlugFromCwd(cwd?: string): string {
	if (!cwd) return "default";
	// Convert path to slug: /Users/foo/projects/my-app -> --Users-foo-projects-my-app--
	const segments = cwd.split("/").filter(Boolean);
	return "--" + segments.join("-") + "--";
}

function scratchpadFilePath(projectSlug: string): string {
	return path.join(SCRATCHPAD_BASE_DIR, projectSlug, "latest.json");
}

function createScratchpad(goal: string, projectSlug: string): TaskScratchpad {
	return {
		goal,
		plan: [],
		done: [],
		decisions: [],
		hypotheses: [],
		notes: [],
		updatedAt: Date.now(),
		projectSlug,
	};
}

function saveScratchpadToDisk(scratchpad: TaskScratchpad): void {
	try {
		const filePath = scratchpadFilePath(scratchpad.projectSlug);
		const dir = path.dirname(filePath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(filePath, JSON.stringify(scratchpad, null, 2));
	} catch {
		// Silent fail — operates in memory if disk write fails
	}
}

function loadScratchpadFromDisk(projectSlug: string): TaskScratchpad | null {
	try {
		const filePath = scratchpadFilePath(projectSlug);
		if (fs.existsSync(filePath)) {
			const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			// Ensure new fields exist
			if (!data.updatedAt) data.updatedAt = Date.now();
			if (!data.projectSlug) data.projectSlug = projectSlug;
			return data as TaskScratchpad;
		}
	} catch {
		// Silent fail
	}
	return null;
}

// Task Persistence

function taskFilePath(projectSlug: string): string {
	return path.join(SCRATCHPAD_BASE_DIR, projectSlug, "tasks.json");
}

function saveTaskStore(slug: string, store: TaskStore): void {
	try {
		const filePath = taskFilePath(slug);
		const dir = path.dirname(filePath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		store.updatedAt = Date.now();
		fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
	} catch {
		// Silent fail
	}
}

function loadTaskStore(projectSlug: string): TaskStore {
	try {
		const filePath = taskFilePath(projectSlug);
		if (fs.existsSync(filePath)) {
			return JSON.parse(fs.readFileSync(filePath, "utf-8")) as TaskStore;
		}
	} catch {
		// Silent fail
	}
	return { tasks: [], updatedAt: Date.now() };
}

function generateTaskId(): string {
	return "task-" + Date.now().toString(36) + "-" + Math.random().toString(36).substring(2, 6);
}

// Display

export function formatScratchpad(pad: TaskScratchpad): string {
	const lines = [`Goal: ${pad.goal}`];

	if (pad.plan.length > 0) {
		lines.push("\nPlan:");
		for (let i = 0; i < pad.plan.length; i++) {
			const step = pad.plan[i];
			const status = pad.done.includes(step) ? "[done]" : "[ ]";
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

// Module State

let _taskScratchpad: TaskScratchpad | null = null;
let _currentProjectSlug: string = "";
let _taskStore: TaskStore = { tasks: [], updatedAt: Date.now() };

function getOrCreateScratchpad(projectSlug: string): TaskScratchpad {
	if (_taskScratchpad && _currentProjectSlug === projectSlug) {
		return _taskScratchpad;
	}

	// Try loading from disk
	const loaded = loadScratchpadFromDisk(projectSlug);
	if (loaded) {
		_taskScratchpad = loaded;
	} else {
		_taskScratchpad = createScratchpad("", projectSlug);
	}
	_currentProjectSlug = projectSlug;
	return _taskScratchpad;
}

function mutateAndSave(scratchpad: TaskScratchpad): void {
	scratchpad.updatedAt = Date.now();
	saveScratchpadToDisk(scratchpad);
}

// Schema
// Schema

const scratchpadSchema = Type.Object({
	action: Type.Union(
		[
			// Scratchpad actions
			Type.Literal("read", { description: "Read current scratchpad" }),
			Type.Literal("set_goal", { description: "Set or update goal" }),
			Type.Literal("add_plan", { description: "Add step to plan" }),
			Type.Literal("mark_done", { description: "Mark step as done" }),
			Type.Literal("add_decision", { description: "Record a decision" }),
			Type.Literal("add_hypothesis", { description: "Add hypothesis (for debugging)" }),
			Type.Literal("add_note", { description: "Add a note" }),
			// Elevation to formal systems
			Type.Literal("elevate_to_goal", { description: "Promote scratchpad goal to formal goal with success criteria" }),
			Type.Literal("elevate_to_plan", { description: "Promote scratchpad plan to formal execution plan" }),
			// Task management (merged from task tools)
			Type.Literal("task_add", { description: "Add a task to the queue" }),
			Type.Literal("task_list", { description: "List all tasks" }),
			Type.Literal("task_complete", { description: "Mark a task as completed" }),
			Type.Literal("task_fail", { description: "Mark a task as failed" }),
			Type.Literal("task_next", { description: "Get next ready task" }),
			Type.Literal("task_remove", { description: "Remove a task by ID" }),
			Type.Literal("task_stats", { description: "Get task counts by status" }),
			Type.Literal("task_clear", { description: "Clear completed/failed tasks" }),
		],
		{ description: "Action to perform on the scratchpad" },
	),
	text: Type.Optional(
		Type.String({
			description: "Text content (set_goal, add_plan, add_decision, add_hypothesis, add_note, elevate_to_goal, elevate_to_plan, task_add, task_complete, task_fail)",
		}),
	),
	successCriteria: Type.Optional(
		Type.Array(Type.String(), { description: "Success criteria (for elevate_to_goal)" }),
	),
	priority: Type.Optional(
		Type.Number({ description: "Priority 0-10 (for elevate_to_goal, task_add)" }),
	),
	dependencies: Type.Optional(
		Type.Array(Type.String(), { description: "Dependencies (for elevate_to_goal, task_add)" }),
	),
	task_id: Type.Optional(
		Type.String({ description: "Task ID (for task_complete, task_fail)" }),
	),
});

type ScratchpadAction =
	| "read"
	| "set_goal"
	| "add_plan"
	| "mark_done"
	| "add_decision"
	| "add_hypothesis"
	| "add_note"
	| "elevate_to_goal"
	| "elevate_to_plan"
	| "task_add"
	| "task_list"
	| "task_complete"
	| "task_fail"
	| "task_next"
	| "task_remove"
	| "task_stats"
	| "task_clear";

type ScratchpadToolInput = {
	action: ScratchpadAction;
	text?: string;
	successCriteria?: string[];
	priority?: number;
	dependencies?: string[];
	task_id?: string;
};

// Extension

export default function scratchpadExtension(pi: ExtensionAPI): void {
	/**
	 * Resolve project slug from the extension context.
	 * Falls back to process.cwd() if context doesn't provide it.
	 */
	function resolveProjectSlug(): string {
		try {
			return projectSlugFromCwd(process.cwd());
		} catch {
			return "default";
		}
	}

	const scratchpadTool: AgentTool<typeof scratchpadSchema> = {
		name: "scratchpad",
		label: "Scratchpad",
		description:
			"Per-loop scratchpad for continuity of thought. Also includes: task queue, goal elevation (elevate_to_goal), plan elevation (elevate_to_plan).",
		parameters: scratchpadSchema,
		execute: async (_toolCallId: string, params: unknown): Promise<AgentToolResult<unknown>> => {
			const { action, text } = params as ScratchpadToolInput;
			const pad = getOrCreateScratchpad(resolveProjectSlug());

			switch (action) {
				case "read":
					return {
						content: [{ type: "text" as const, text: formatScratchpad(pad) }],
						details: pad,
					};

				case "set_goal":
					if (!text)
						return {
							content: [{ type: "text" as const, text: "text required" }],
							details: { error: "missing_text" },
						};
					pad.goal = text;
					mutateAndSave(pad);
					return { content: [{ type: "text" as const, text: `Goal set: ${text}` }], details: { goal: text } };

				case "add_plan":
					if (!text)
						return {
							content: [{ type: "text" as const, text: "text required" }],
							details: { error: "missing_text" },
						};
					pad.plan.push(text);
					mutateAndSave(pad);
					return {
						content: [{ type: "text" as const, text: `Plan step added: ${text}` }],
						details: { plan: pad.plan },
					};

				case "mark_done":
					if (!text)
						return {
							content: [{ type: "text" as const, text: "text required" }],
							details: { error: "missing_text" },
						};
					if (!pad.done.includes(text)) pad.done.push(text);
					mutateAndSave(pad);
					return {
						content: [{ type: "text" as const, text: `Marked done: ${text}` }],
						details: { done: pad.done },
					};

				case "add_decision":
					if (!text)
						return {
							content: [{ type: "text" as const, text: "text required" }],
							details: { error: "missing_text" },
						};
					pad.decisions.push(text);
					mutateAndSave(pad);
					return {
						content: [{ type: "text" as const, text: `Decision recorded: ${text}` }],
						details: { decisions: pad.decisions },
					};

				case "add_hypothesis":
					if (!text)
						return {
							content: [{ type: "text" as const, text: "text required" }],
							details: { error: "missing_text" },
						};
					pad.hypotheses.push(text);
					mutateAndSave(pad);
					return {
						content: [{ type: "text" as const, text: `Hypothesis added: ${text}` }],
						details: { hypotheses: pad.hypotheses },
					};

				case "add_note":
					if (!text)
						return {
							content: [{ type: "text" as const, text: "text required" }],
							details: { error: "missing_text" },
						};
					pad.notes.push(text);
					mutateAndSave(pad);
					return {
						content: [{ type: "text" as const, text: `Note added: ${text}` }],
						details: { notes: pad.notes },
					};

				// Elevation to formal systems

				case "elevate_to_goal": {
					if (!pad.goal) {
						return {
							content: [{ type: "text" as const, text: "No goal set in scratchpad. Use set_goal first." }],
							details: { error: "no_goal" },
						};
					}
					const criteria = (params as ScratchpadToolInput).successCriteria ??
						(text ? text.split(",").map((s: string) => s.trim()) : []);
					const priority = (params as ScratchpadToolInput).priority ?? 5;

					return {
						content: [
							{
								type: "text" as const,
								text: `Ready to elevate scratchpad goal to formal goal:

Goal: ${pad.goal}
Priority: ${priority}
Success criteria: ${criteria.length > 0 ? criteria.join(", ") : "(none)"}

Use: goal(action="create", description="...", successCriteria=[...], priority=${priority})

Provide success criteria as text parameter to complete the elevation.`,
							},
						],
						details: {
							ready: true,
							goal: pad.goal,
							priority,
							successCriteria: criteria,
							action: "elevate_to_goal",
						},
					};
				}

				case "elevate_to_plan": {
					if (pad.plan.length === 0) {
						return {
							content: [{ type: "text" as const, text: "No plan steps in scratchpad. Use add_plan first." }],
							details: { error: "no_plan" },
						};
					}

					const steps = pad.plan.map((s: string, i: number) => {
						const status = pad.done.includes(s) ? "[done]" : "[ ]";
						return `${status} ${i + 1}. ${s}`;
					});

					return {
						content: [
							{
								type: "text" as const,
								text: `Ready to elevate scratchpad plan to formal plan:\n\nGoal: ${pad.goal || "Untitled plan"}\nSteps:\n${steps.join("\n")}\n\nProvide plan details as text or I can format the steps for plan_create.`,
							},
						],
						details: {
							ready: true,
							goal: pad.goal,
							steps: pad.plan,
							done: pad.done,
							action: "elevate_to_plan",
						},
					};
				}

				// Task Management (merged from task tools)

				case "task_add": {
					const slug = resolveProjectSlug();
					_taskStore = loadTaskStore(slug);

					const task: TaskItem = {
						id: generateTaskId(),
						description: text ?? "",
						status: "pending",
						priority: (params as ScratchpadToolInput).priority ?? 0,
						dependencies: (params as ScratchpadToolInput).dependencies ?? [],
						createdAt: Date.now(),
						attempts: 0,
						maxAttempts: 3,
					};

					_taskStore.tasks.push(task);
					saveTaskStore(slug, _taskStore);

					return {
						content: [{ type: "text" as const, text: `Task added: ${task.id} — ${task.description}` }],
						details: { id: task.id, total: _taskStore.tasks.length },
					};
				}

				case "task_list": {
					const slug = resolveProjectSlug();
					_taskStore = loadTaskStore(slug);

					if (_taskStore.tasks.length === 0) {
						return {
							content: [{ type: "text" as const, text: "No tasks." }],
							details: { count: 0 },
						};
					}

					const lines = _taskStore.tasks.map((t) => {
						const deps = t.dependencies.length > 0 ? ` [deps: ${t.dependencies.join(", ")}]` : "";
						return `[${t.status}] ${t.id}: ${t.description}${deps}`;
					});

					return {
						content: [{ type: "text" as const, text: lines.join("\n") }],
						details: { count: _taskStore.tasks.length, tasks: _taskStore.tasks },
					};
				}

				case "task_complete": {
					const slug = resolveProjectSlug();
					_taskStore = loadTaskStore(slug);
					const tid = (params as ScratchpadToolInput).task_id;
					if (!tid) {
						return {
							content: [{ type: "text" as const, text: "task_id required" }],
							details: { error: "missing_task_id" },
						};
					}

					const task = _taskStore.tasks.find((t) => t.id === tid);
					if (!task) {
						return {
							content: [{ type: "text" as const, text: `Task ${tid} not found` }],
							details: { error: "not_found" },
						};
					}

					task.status = "completed";
					task.completedAt = Date.now();
					task.result = text;
					saveTaskStore(slug, _taskStore);

					return {
						content: [{ type: "text" as const, text: `Task ${tid} completed` }],
						details: { id: tid },
					};
				}

				case "task_fail": {
					const slug = resolveProjectSlug();
					_taskStore = loadTaskStore(slug);
					const tid = (params as ScratchpadToolInput).task_id;
					if (!tid) {
						return {
							content: [{ type: "text" as const, text: "task_id required" }],
							details: { error: "missing_task_id" },
						};
					}

					const task = _taskStore.tasks.find((t) => t.id === tid);
					if (!task) {
						return {
							content: [{ type: "text" as const, text: `Task ${tid} not found` }],
							details: { error: "not_found" },
						};
					}

					task.attempts++;
					if (task.attempts >= task.maxAttempts) {
						task.status = "failed";
						task.completedAt = Date.now();
						task.error = text;
						return {
							content: [{ type: "text" as const, text: `Task ${tid} failed permanently (${task.attempts} attempts)` }],
							details: { id: tid, permanent: true },
						};
					} else {
						return {
							content: [{ type: "text" as const, text: `Task ${tid} failed (attempt ${task.attempts}/${task.maxAttempts})` }],
							details: { id: tid, willRetry: true, attempts: task.attempts },
						};
					}
				}

				case "task_next": {
					const slug = resolveProjectSlug();
					_taskStore = loadTaskStore(slug);

					// Find next ready task (dependencies satisfied, highest priority)
					const pending = _taskStore.tasks
						.filter((t) => t.status === "pending")
						.filter((t) => {
							// Check all dependencies are completed
							return t.dependencies.every((depId) => {
								const dep = _taskStore.tasks.find((d) => d.id === depId);
								return dep?.status === "completed";
							});
						})
						.sort((a, b) => b.priority - a.priority);

					if (pending.length === 0) {
						return {
							content: [{ type: "text" as const, text: "No ready tasks." }],
							details: null,
						};
					}

					const next = pending[0];
					return {
						content: [{ type: "text" as const, text: `${next.id}: ${next.description}` }],
						details: { id: next.id, description: next.description, priority: next.priority },
					};
				}

				case "task_remove": {
				const slug = resolveProjectSlug();
				_taskStore = loadTaskStore(slug);
				const tid = (params as ScratchpadToolInput).task_id;
				if (!tid) {
					return {
						content: [{ type: "text" as const, text: "task_id required" }],
						details: { error: "missing_task_id" },
					};
				}

				const idx = _taskStore.tasks.findIndex((t) => t.id === tid);
				if (idx === -1) {
					return {
						content: [{ type: "text" as const, text: `Task ${tid} not found` }],
						details: { error: "not_found" },
					};
				}

				_taskStore.tasks.splice(idx, 1);
				saveTaskStore(slug, _taskStore);

				return {
					content: [{ type: "text" as const, text: `Removed ${tid}` }],
					details: { id: tid, remaining: _taskStore.tasks.length },
				};
			}

			case "task_stats": {
				const slug = resolveProjectSlug();
				_taskStore = loadTaskStore(slug);

				const stats = {
					total: _taskStore.tasks.length,
					pending: _taskStore.tasks.filter((t) => t.status === "pending").length,
					running: _taskStore.tasks.filter((t) => t.status === "running").length,
					completed: _taskStore.tasks.filter((t) => t.status === "completed").length,
					failed: _taskStore.tasks.filter((t) => t.status === "failed").length,
				};
				const hasWork = stats.pending > 0 || stats.running > 0;

				return {
					content: [{ type: "text" as const, text: `Tasks: ${stats.total} total (${stats.pending} pending, ${stats.running} running, ${stats.completed} done, ${stats.failed} failed)${hasWork ? " — work available" : " — no work remaining"}` }],
					details: { ...stats, hasWork },
				};
			}

			case "task_clear": {
					const slug = resolveProjectSlug();
					_taskStore = loadTaskStore(slug);
					const before = _taskStore.tasks.length;
					_taskStore.tasks = _taskStore.tasks.filter((t) => t.status === "pending" || t.status === "running");
					saveTaskStore(slug, _taskStore);
					return {
						content: [{ type: "text" as const, text: `Cleared ${before - _taskStore.tasks.length} completed/failed tasks` }],
						details: { removed: before - _taskStore.tasks.length, remaining: _taskStore.tasks.length },
					};
				}

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

	// Register scratchpad management commands
	pi.registerCommand("scratchpad-clear", {
		description: "Clear the current project scratchpad",
		handler: async (_args, ctx) => {
			const slug = resolveProjectSlug();
			_taskScratchpad = createScratchpad("", slug);
			_currentProjectSlug = slug;
			saveScratchpadToDisk(_taskScratchpad);
			ctx.ui.notify("Scratchpad cleared", "info");
		},
	});
}
