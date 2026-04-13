/**
 * Task Queue - Core infrastructure for autonomous agent operation
 *
 * Based on: docs/proposals/SMART_AGENT_LOOP.md
 * Integrated into AgentSession for automatic task processing.
 *
 * The task queue is the foundation for autonomy:
 * - When idle, agent automatically picks next task
 * - Executes task, marks done/failed
 * - Continues to next task without user intervention
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Task {
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
	/** Number of retry attempts */
	attempts: number;
	/** Max retry attempts before marking failed */
	maxAttempts: number;
}

export interface TaskQueueState {
	tasks: Task[];
	version: number;
}

export class TaskQueue {
	private tasks = new Map<string, Task>();
	private taskIdCounter = 0;
	private storagePath: string | null = null;

	/**
	 * Initialize task queue with optional persistence
	 * @param storageDir Directory to save task queue state
	 */
	initialize(storageDir?: string): void {
		if (storageDir) {
			this.storagePath = join(storageDir, "task-queue.json");
			this.load();
		}
	}

	/**
	 * Add a task to the queue
	 */
	add(
		description: string,
		options?: {
			priority?: number;
			dependencies?: string[];
			maxAttempts?: number;
		},
	): Task {
		const id = this.generateTaskId();
		const task: Task = {
			id,
			description,
			status: "pending",
			priority: options?.priority ?? 0,
			dependencies: options?.dependencies ?? [],
			createdAt: Date.now(),
			attempts: 0,
			maxAttempts: options?.maxAttempts ?? 3,
		};
		this.tasks.set(id, task);
		this.save();
		return task;
	}

	/**
	 * Get next ready task (dependencies satisfied, highest priority)
	 * Returns null if no ready tasks
	 */
	getNext(): Task | null {
		const completedIds = new Set(
			Array.from(this.tasks.values())
				.filter((t) => t.status === "completed")
				.map((t) => t.id),
		);

		const next = Array.from(this.tasks.values())
			.filter((t) => t.status === "pending")
			.filter((t) => t.dependencies.every((d) => completedIds.has(d)))
			.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)[0];

		return next ?? null;
	}

	/**
	 * Get task by ID
	 */
	getById(id: string): Task | undefined {
		return this.tasks.get(id);
	}

	/**
	 * Mark a task as running
	 */
	markRunning(id: string): Task | null {
		const task = this.tasks.get(id);
		if (!task) return null;

		task.status = "running";
		task.startedAt = Date.now();
		task.attempts++;
		this.save();
		return task;
	}

	/**
	 * Mark a task as completed
	 */
	markCompleted(id: string, result?: string): Task | null {
		const task = this.tasks.get(id);
		if (!task) return null;

		task.status = "completed";
		task.completedAt = Date.now();
		if (result) task.result = result;
		this.save();
		return task;
	}

	/**
	 * Mark a task as failed
	 */
	markFailed(id: string, error: string): Task | null {
		const task = this.tasks.get(id);
		if (!task) return null;

		task.status = "failed";
		task.completedAt = Date.now();
		task.error = error;
		this.save();
		return task;
	}

	/**
	 * Check if a failed task should be retried
	 */
	shouldRetry(id: string): boolean {
		const task = this.tasks.get(id);
		if (!task) return false;
		return task.status === "failed" && task.attempts < task.maxAttempts;
	}

	/**
	 * Retry a failed task (resets to pending)
	 */
	retry(id: string): Task | null {
		const task = this.tasks.get(id);
		if (!task || task.status !== "failed") return null;
		if (task.attempts >= task.maxAttempts) return null;

		task.status = "pending";
		task.error = undefined;
		this.save();
		return task;
	}

	/**
	 * Get task by ID
	 */
	get(id: string): Task | undefined {
		return this.tasks.get(id);
	}

	/**
	 * List all tasks, optionally filtered by status
	 */
	list(status?: Task["status"]): Task[] {
		const tasks = Array.from(this.tasks.values());
		if (status) {
			return tasks.filter((t) => t.status === status);
		}
		return tasks.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
	}

	/**
	 * Get queue statistics
	 */
	getStats(): {
		total: number;
		pending: number;
		running: number;
		completed: number;
		failed: number;
	} {
		const tasks = Array.from(this.tasks.values());
		return {
			total: tasks.length,
			pending: tasks.filter((t) => t.status === "pending").length,
			running: tasks.filter((t) => t.status === "running").length,
			completed: tasks.filter((t) => t.status === "completed").length,
			failed: tasks.filter((t) => t.status === "failed").length,
		};
	}

	/**
	 * Check if there are any pending or running tasks
	 */
	hasWork(): boolean {
		return this.getNext() !== null;
	}

	/**
	 * Clear all tasks
	 */
	clear(): void {
		this.tasks.clear();
		this.save();
	}

	/**
	 * Remove a task by ID
	 */
	remove(id: string): boolean {
		const deleted = this.tasks.delete(id);
		if (deleted) this.save();
		return deleted;
	}

	/**
	 * Save queue to disk
	 */
	private save(): void {
		if (!this.storagePath) return;

		try {
			const state: TaskQueueState = {
				tasks: Array.from(this.tasks.values()),
				version: 1,
			};
			const dir = dirname(this.storagePath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(this.storagePath, JSON.stringify(state, null, 2));
		} catch {
			// Silent fail - queue operates in memory
		}
	}

	/**
	 * Load queue from disk
	 */
	private load(): void {
		if (!this.storagePath) return;
		if (!existsSync(this.storagePath)) return;

		try {
			const data = readFileSync(this.storagePath, "utf-8");
			const state: TaskQueueState = JSON.parse(data);
			if (state.tasks) {
				for (const task of state.tasks) {
					this.tasks.set(task.id, task);
				}
			}
		} catch {
			// Silent fail - start with empty queue
		}
	}

	private generateTaskId(): string {
		return `task-${Date.now()}-${++this.taskIdCounter}`;
	}
}
