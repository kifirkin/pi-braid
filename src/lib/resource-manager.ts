/**
 * Resource Manager - Token, cost, and time budget tracking
 *
 * Based on: docs/analysis/SUPER_AGENT_GAP_ANALYSIS.md
 * Provides resource-aware operation with budget enforcement.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ResourceBudget {
	maxTokens: number;
	usedTokens: number;
	maxCost: number; // USD
	usedCost: number;
	maxTime: number; // milliseconds
	startTime: number;
	warningThreshold: number; // 0.8 = warn at 80%
}

export interface ResourceUsage {
	tokens: number;
	cost: number;
	duration: number; // milliseconds
	timestamp: number;
}

export interface ResourceSnapshot {
	budget: ResourceBudget;
	history: ResourceUsage[];
	version: number;
}

export class ResourceManager {
	private budget: ResourceBudget | null = null;
	private history: ResourceUsage[] = [];
	private storagePath: string | null = null;

	/**
	 * Initialize with optional persistence
	 */
	initialize(storageDir?: string): void {
		if (storageDir) {
			this.storagePath = join(storageDir, "resources.json");
			this.load();
		}
	}

	/**
	 * Set budget for operation
	 */
	setBudget(options: {
		maxTokens?: number;
		maxCost?: number;
		maxTime?: number;
		warningThreshold?: number;
	}): ResourceBudget {
		this.budget = {
			maxTokens: options.maxTokens ?? 100000,
			usedTokens: 0,
			maxCost: options.maxCost ?? 5.0,
			usedCost: 0,
			maxTime: options.maxTime ?? 600000, // 10 min
			startTime: Date.now(),
			warningThreshold: options.warningThreshold ?? 0.8,
		};
		this.save();
		return this.budget;
	}

	/**
	 * Check if budget is set
	 */
	hasBudget(): boolean {
		return this.budget !== null;
	}

	/**
	 * Get current budget
	 */
	getBudget(): ResourceBudget | null {
		return this.budget ? { ...this.budget } : null;
	}

	/**
	 * Record token and cost usage
	 */
	recordUsage(tokens: number, cost: number): void {
		if (!this.budget) {
			// No budget set, just track usage
			this.history.push({
				tokens,
				cost,
				duration: 0,
				timestamp: Date.now(),
			});
			return;
		}

		this.budget.usedTokens += tokens;
		this.budget.usedCost += cost;

		this.history.push({
			tokens,
			cost,
			duration: Date.now() - this.budget.startTime,
			timestamp: Date.now(),
		});

		this.save();
	}

	/**
	 * Check current resource status
	 */
	checkStatus(): {
		tokenRatio: number;
		costRatio: number;
		timeRatio: number;
		isWarning: boolean;
		isExhausted: boolean;
		message?: string;
	} {
		if (!this.budget) {
			return {
				tokenRatio: 0,
				costRatio: 0,
				timeRatio: 0,
				isWarning: false,
				isExhausted: false,
			};
		}

		const elapsed = Date.now() - this.budget.startTime;
		const tokenRatio = this.budget.usedTokens / this.budget.maxTokens;
		const costRatio = this.budget.usedCost / this.budget.maxCost;
		const timeRatio = elapsed / this.budget.maxTime;

		const maxRatio = Math.max(tokenRatio, costRatio, timeRatio);
		const isWarning = maxRatio > this.budget.warningThreshold;
		const isExhausted = tokenRatio >= 1 || costRatio >= 1 || timeRatio >= 1;

		let message: string | undefined;
		if (isExhausted) {
			message = `Budget exhausted: ${Math.round(maxRatio * 100)}%`;
		} else if (isWarning) {
			message = `Budget warning: ${Math.round(maxRatio * 100)}%`;
		}

		return {
			tokenRatio,
			costRatio,
			timeRatio,
			isWarning,
			isExhausted,
			message,
		};
	}

	/**
	 * Check if operation should continue
	 */
	canContinue(): boolean {
		const status = this.checkStatus();
		return !status.isExhausted;
	}

	/**
	 * Estimate if operation fits in budget
	 */
	canFit(estimatedTokens: number, estimatedCost: number): boolean {
		if (!this.budget) return true;

		const forecastedTokens = this.budget.usedTokens + estimatedTokens;
		const forecastedCost = this.budget.usedCost + estimatedCost;

		return forecastedTokens <= this.budget.maxTokens && forecastedCost <= this.budget.maxCost;
	}

	/**
	 * Get usage summary
	 */
	getSummary(): {
		totalTokens: number;
		totalCost: number;
		avgTokensPerOp: number;
		avgCostPerOp: number;
		opCount: number;
	} {
		if (this.history.length === 0) {
			return {
				totalTokens: 0,
				totalCost: 0,
				avgTokensPerOp: 0,
				avgCostPerOp: 0,
				opCount: 0,
			};
		}

		const totalTokens = this.history.reduce((sum, h) => sum + h.tokens, 0);
		const totalCost = this.history.reduce((sum, h) => sum + h.cost, 0);
		const opCount = this.history.length;

		return {
			totalTokens,
			totalCost,
			avgTokensPerOp: totalTokens / opCount,
			avgCostPerOp: totalCost / opCount,
			opCount,
		};
	}

	/**
	 * Get statistics (alias for getSummary for compatibility)
	 */
	getStats(): {
		totalTokens: number;
		totalCost: number;
		avgTokensPerOp: number;
		avgCostPerOp: number;
		opCount: number;
	} {
		return this.getSummary();
	}

	/**
	 * Get remaining budget
	 */
	getRemaining(): {
		tokens: number;
		cost: number;
		time: number;
	} | null {
		if (!this.budget) return null;

		const elapsed = Date.now() - this.budget.startTime;
		return {
			tokens: Math.max(0, this.budget.maxTokens - this.budget.usedTokens),
			cost: Math.max(0, this.budget.maxCost - this.budget.usedCost),
			time: Math.max(0, this.budget.maxTime - elapsed),
		};
	}

	/**
	 * Clear budget and history
	 */
	clear(): void {
		this.budget = null;
		this.history = [];
		this.save();
	}

	/**
	 * Format budget status
	 */
	formatStatus(): string {
		if (!this.budget) {
			return "No budget set.";
		}

		const status = this.checkStatus();
		const remaining = this.getRemaining();

		const lines = [
			"# Resource Budget",
			"",
			`Tokens: ${this.budget.usedTokens.toLocaleString()} / ${this.budget.maxTokens.toLocaleString()} (${(status.tokenRatio * 100).toFixed(1)}%)`,
			`Cost: $${this.budget.usedCost.toFixed(2)} / $${this.budget.maxCost.toFixed(2)} (${(status.costRatio * 100).toFixed(1)}%)`,
			`Time: ${this.formatDuration(Date.now() - this.budget.startTime)} / ${this.formatDuration(this.budget.maxTime)} (${(status.timeRatio * 100).toFixed(1)}%)`,
			"",
			"## Remaining",
			`Tokens: ${remaining?.tokens.toLocaleString()}`,
			`Cost: $${remaining?.cost.toFixed(2)}`,
			`Time: ${this.formatDuration(remaining?.time ?? 0)}`,
		];

		if (status.message) {
			lines.push("", `⚠️ ${status.message}`);
		}

		return lines.join("\n");
	}

	private formatDuration(ms: number): string {
		const minutes = Math.floor(ms / 60000);
		const seconds = Math.floor((ms % 60000) / 1000);
		return `${minutes}m ${seconds}s`;
	}

	private save(): void {
		if (!this.storagePath) return;

		try {
			const snapshot: ResourceSnapshot = {
				budget: this.budget ?? {
					maxTokens: 0,
					usedTokens: 0,
					maxCost: 0,
					usedCost: 0,
					maxTime: 0,
					startTime: 0,
					warningThreshold: 0.8,
				},
				history: this.history,
				version: 1,
			};
			const dir = dirname(this.storagePath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(this.storagePath, JSON.stringify(snapshot, null, 2));
		} catch {
			// Silent fail
		}
	}

	private load(): void {
		if (!this.storagePath) return;
		if (!existsSync(this.storagePath)) return;

		try {
			const data = readFileSync(this.storagePath, "utf-8");
			const snapshot: ResourceSnapshot = JSON.parse(data);
			if (snapshot.budget && snapshot.budget.maxTokens > 0) {
				this.budget = snapshot.budget;
			}
			if (snapshot.history) {
				this.history = snapshot.history;
			}
		} catch {
			// Silent fail
		}
	}
}
