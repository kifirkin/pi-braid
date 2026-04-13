/**
 * Goal Management System - Core infrastructure for hierarchical goal tracking
 *
 * Based on: docs/analysis/SUPER_AGENT_GAP_ANALYSIS.md
 * Provides goal hierarchy, decomposition, and dependency management.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
export type GoalStatus = "pending" | "active" | "blocked" | "completed" | "failed";

export interface Goal {
	id: string;
	description: string;
	status: GoalStatus;
	priority: number; // 0-10
	parentId?: string; // Hierarchical
	subgoals: string[];
	lineage: string[]; // Ancestor descriptions root→parent (fractals pattern)
	createdAt: number;
	completedAt?: number;
	dependencies: string[]; // Other goals that must complete first
	blockers: string[]; // Why blocked
	successCriteria: string[]; // How to know it's done
	attempts: number;
	maxAttempts: number;
	mapsToRequirements: string[]; // Parsed requirement IDs this goal addresses
	evidenceCollected: string[]; // Test results, file changes, etc.
	metadata?: Record<string, unknown>;
}

export interface GoalManagerState {
	goals: Goal[];
	activeStack: string[]; // Stack of active goal IDs
	version: number;
	originalRequest?: string; // The user's initial request for traceability
}

export class GoalManager {
	private goals = new Map<string, Goal>();
	private activeStack: string[] = [];
	private storagePath: string | null = null;

	/**
	 * Initialize goal manager with optional persistence
	 */
	initialize(storageDir?: string): void {
		if (storageDir) {
			this.storagePath = join(storageDir, "goals.json");
			this.load();
		}
	}

	/**
	 * Add a top-level goal
	 */
	/**
	 * Set the original user request for traceability
	 */
	setOriginalRequest(request: string): void {
		this.originalRequest = request;
		this.save();
	}

	/**
	 * Get the original user request
	 */
	getOriginalRequest(): string | undefined {
		return this.originalRequest;
	}

	/**
	 * Add a top-level goal
	 */
	addGoal(
		description: string,
		successCriteria: string[],
		options?: {
			priority?: number;
			dependencies?: string[];
			maxAttempts?: number;
			metadata?: Record<string, unknown>;
			mapsToRequirements?: string[]; // Parsed requirement IDs
			parentLineage?: string[]; // Inherited lineage from parent
		},
	): Goal {
		const id = this.generateGoalId();
		const goal: Goal = {
			id,
			description,
			status: "pending",
			priority: options?.priority ?? 5,
			subgoals: [],
			lineage: options?.parentLineage ?? [],
			dependencies: options?.dependencies ?? [],
			blockers: [],
			successCriteria,
			attempts: 0,
			maxAttempts: options?.maxAttempts ?? 3,
			mapsToRequirements: options?.mapsToRequirements ?? [],
			evidenceCollected: [],
			createdAt: Date.now(),
			metadata: options?.metadata,
		};
		this.goals.set(id, goal);
		this.save();
		return goal;
	}

	/**
	 * Decompose a goal into subgoals
	 */
	decompose(
		goalId: string,
		subgoals: {
			description: string;
			successCriteria: string[];
			priority?: number;
			mapsToRequirements?: string[]; // Parsed requirement IDs
		}[],
	): void {
		const parent = this.goals.get(goalId);
		if (!parent) throw new Error(`Goal ${goalId} not found`);

		// Build lineage: parent's lineage + parent description
		const childLineage = [...parent.lineage, parent.description];

		for (const sg of subgoals) {
			const subgoal = this.addGoal(sg.description, sg.successCriteria, {
				priority: sg.priority ?? parent.priority,
				mapsToRequirements: sg.mapsToRequirements,
				parentLineage: childLineage,
			});
			subgoal.parentId = goalId;
			parent.subgoals.push(subgoal.id);
		}

		this.save();
	}

	/**
	 * Get next actionable goal (dependencies satisfied, highest priority)
	 */
	getNextGoal(): Goal | undefined {
		const completedIds = new Set(
			Array.from(this.goals.values())
				.filter((g) => g.status === "completed")
				.map((g) => g.id),
		);

		const candidates = Array.from(this.goals.values())
			.filter((g) => g.status === "pending")
			.filter((g) => g.dependencies.every((depId) => completedIds.has(depId)))
			.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);

		return candidates[0];
	}

	/**
	 * Get goal by ID
	 */
	getById(id: string): Goal | undefined {
		return this.goals.get(id);
	}

	/**
	 * Activate a goal (mark as active and push to stack)
	 */
	activateGoal(id: string): Goal | null {
		const goal = this.goals.get(id);
		if (!goal) return null;

		goal.status = "active";
		goal.attempts++;
		if (!this.activeStack.includes(id)) {
			this.activeStack.push(id);
		}
		this.save();
		return goal;
	}

	/**
	 * Mark goal as completed
	 */
	markCompleted(id: string): Goal | null {
		const goal = this.goals.get(id);
		if (!goal) return null;

		goal.status = "completed";
		goal.completedAt = Date.now();

		// Remove from active stack
		this.activeStack = this.activeStack.filter((g) => g !== id);

		// Check if parent should auto-complete
		if (goal.parentId) {
			this.checkParentCompletion(goal.parentId);
		}

		this.save();
		return goal;
	}

	/**
	 * Mark goal as failed
	 */
	markFailed(id: string, error?: string): Goal | null {
		const goal = this.goals.get(id);
		if (!goal) return null;

		goal.status = "failed";
		goal.completedAt = Date.now();
		if (error) {
			goal.metadata = { ...goal.metadata, error };
		}

		// Remove from active stack
		this.activeStack = this.activeStack.filter((g) => g !== id);

		this.save();
		return goal;
	}

	/**
	 * Mark goal as blocked with reason
	 */
	markBlocked(id: string, reason: string): Goal | null {
		const goal = this.goals.get(id);
		if (!goal) return null;

		goal.status = "blocked";
		goal.blockers.push(reason);
		this.save();
		return goal;
	}

	/**
	 * Check if all subgoals complete, auto-complete parent
	 */
	private checkParentCompletion(parentId: string): void {
		const parent = this.goals.get(parentId);
		if (!parent) return;

		const allSubgoalsComplete = parent.subgoals.every((sgId) => {
			const sg = this.goals.get(sgId);
			return sg?.status === "completed";
		});

		if (allSubgoalsComplete && parent.subgoals.length > 0) {
			this.markCompleted(parentId);
		}
	}

	/**
	 * Unblock a goal and reset to pending
	 */
	unblock(id: string): Goal | null {
		const goal = this.goals.get(id);
		if (!goal) return null;
		if (goal.status !== "blocked") return null;

		goal.status = "pending";
		goal.blockers = [];
		this.save();
		return goal;
	}

	/**
	 * Get currently active goal (top of stack)
	 */
	getActiveGoal(): Goal | null {
		if (this.activeStack.length === 0) return null;
		const topId = this.activeStack[this.activeStack.length - 1];
		return this.goals.get(topId) || null;
	}

	/**
	 * Record evidence for a goal (test results, file changes, etc.)
	 */
	recordEvidence(id: string, evidence: string): Goal | null {
		const goal = this.goals.get(id);
		if (!goal) return null;
		goal.evidenceCollected.push(evidence);
		this.save();
		return goal;
	}

	/**
	 * Map a goal to parsed requirements
	 */
	mapToRequirements(goalId: string, requirementIds: string[]): Goal | null {
		const goal = this.goals.get(goalId);
		if (!goal) return null;
		goal.mapsToRequirements = [...new Set([...goal.mapsToRequirements, ...requirementIds])];
		this.save();
		return goal;
	}

	/**
	 * Evaluate if goal success criteria are actually met.
	 * Checks both criteria count AND evidence existence.
	 */
	evaluateCompletion(id: string): { met: boolean; reasons: string[] } {
		const goal = this.goals.get(id);
		if (!goal) return { met: false, reasons: ["Goal not found"] };

		const reasons: string[] = [];

		if (goal.successCriteria.length === 0) {
			reasons.push("No success criteria defined");
		}

		// Check if goal has evidence
		if (goal.status === "completed" && goal.evidenceCollected.length === 0) {
			reasons.push("Goal completed but no verification evidence collected");
		}

		// Check if goal maps to any requirements
		const hasRequirementMapping = goal.mapsToRequirements.length > 0;
		// Check if any sub-goals map to requirements (child goals inherit)
		const childMapped = goal.subgoals.some((sgId) => {
			const child = this.goals.get(sgId);
			return child && child.mapsToRequirements.length > 0;
		});
		if (!hasRequirementMapping && !childMapped) {
			reasons.push("Goal not mapped to any parsed requirement (traceability gap)");
		}

		return {
			met: reasons.length === 0,
			reasons,
		};
	}

	/**
	 * Get current active goal (top of stack)
	 */
	getCurrentGoal(): Goal | undefined {
		if (this.activeStack.length === 0) return undefined;
		const id = this.activeStack[this.activeStack.length - 1];
		return this.goals.get(id);
	}

	/**
	 * Get goal by ID
	 */
	get(id: string): Goal | undefined {
		return this.goals.get(id);
	}

	/**
	 * List all goals, optionally filtered by status
	 */
	list(status?: GoalStatus): Goal[] {
		const goals = Array.from(this.goals.values());
		if (status) {
			return goals.filter((g) => g.status === status);
		}
		return goals.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
	}

	/**
	 * Get goal tree (root goals with nested subgoals)
	 */
	getGoalTree(): Array<Goal & { nestedSubgoals?: Goal[] }> {
		const rootGoals = Array.from(this.goals.values())
			.filter((g) => !g.parentId)
			.sort((a, b) => b.priority - a.priority);

		return rootGoals.map((g) => ({
			...g,
			nestedSubgoals: g.subgoals.map((id) => this.goals.get(id)).filter((sg): sg is Goal => sg !== undefined),
		}));
	}

	/**
	 * Get statistics
	 */
	getStats(): {
		total: number;
		pending: number;
		active: number;
		completed: number;
		failed: number;
		blocked: number;
	} {
		const goals = Array.from(this.goals.values());
		return {
			total: goals.length,
			pending: goals.filter((g) => g.status === "pending").length,
			active: goals.filter((g) => g.status === "active").length,
			completed: goals.filter((g) => g.status === "completed").length,
			failed: goals.filter((g) => g.status === "failed").length,
			blocked: goals.filter((g) => g.status === "blocked").length,
		};
	}

	/**
	 * Clear all goals
	 */
	clear(): void {
		this.goals.clear();
		this.activeStack = [];
		this.save();
	}

	/**
	 * Format goal tree for display
	 */
	formatGoalTree(): string {
		const roots = this.getGoalTree();
		if (roots.length === 0) return "No goals.";

		const lines: string[] = [];
		for (const goal of roots) {
			this.formatGoalNode(goal, 0, lines);
		}
		return lines.join("\n");
	}

	private formatGoalNode(goal: Goal & { nestedSubgoals?: Goal[] }, indent: number, lines: string[]): void {
		const prefix = "  ".repeat(indent);
		const symbol =
			goal.status === "completed"
				? "✓"
				: goal.status === "active"
					? "▶"
					: goal.status === "failed"
						? "✗"
						: goal.status === "blocked"
							? "⊘"
							: "○";
		lines.push(`${prefix}${symbol} [${goal.priority}] ${goal.id}: ${goal.description} (${goal.status})`);

		if (goal.nestedSubgoals) {
			for (const sub of goal.nestedSubgoals) {
				this.formatGoalNode(sub, indent + 1, lines);
			}
		}
	}

	/**
	 * Get alignment data for all goals (used by traceability validation)
	 */
	getAlignmentData(): Array<{
		id: string;
		description: string;
		status: string;
		parentId?: string;
		mapsToRequirements: string[];
		successCriteria: string[];
		evidenceCollected: string[];
		subgoals: string[];
	}> {
		return Array.from(this.goals.values()).map((g) => ({
			id: g.id,
			description: g.description,
			status: g.status,
			parentId: g.parentId,
			mapsToRequirements: g.mapsToRequirements,
			successCriteria: g.successCriteria,
			evidenceCollected: g.evidenceCollected,
			subgoals: g.subgoals,
		}));
	}

	private originalRequest: string | undefined;

	private save(): void {
		if (!this.storagePath) return;

		try {
			const state: GoalManagerState = {
				goals: Array.from(this.goals.values()),
				activeStack: this.activeStack,
				version: 1,
				originalRequest: this.originalRequest,
			};
			const dir = dirname(this.storagePath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(this.storagePath, JSON.stringify(state, null, 2));
		} catch {
			// Silent fail - operates in memory
		}
	}

	private load(): void {
		if (!this.storagePath) return;
		if (!existsSync(this.storagePath)) return;

		try {
			const data = readFileSync(this.storagePath, "utf-8");
			const state: GoalManagerState = JSON.parse(data);
			if (state.goals) {
				for (const goal of state.goals) {
					// Back-fill new fields for older saved goals
					if (!goal.lineage) goal.lineage = [];
					if (!goal.mapsToRequirements) goal.mapsToRequirements = [];
					if (!goal.evidenceCollected) goal.evidenceCollected = [];
					this.goals.set(goal.id, goal);
				}
			}
			if (state.activeStack) {
				this.activeStack = state.activeStack;
			}
			if (state.originalRequest) {
				this.originalRequest = state.originalRequest;
			}
		} catch {
			// Silent fail - start fresh
		}
	}

	private generateGoalId(): string {
		return `goal-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	}
}
