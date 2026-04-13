/**
 * Metacognition System - Self-awareness and performance tracking
 *
 * Based on: docs/analysis/SUPER_AGENT_GAP_ANALYSIS.md
 * Tracks confidence, knowledge gaps, and performance metrics.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PerformanceMetrics {
	successRate: number;
	avgTokensPerTask: number;
	errorRate: number;
	retryRate: number;
	totalTasks: number;
	completedTasks: number;
	failedTasks: number;
}

export interface SelfAssessment {
	strengths: string[];
	weaknesses: string[];
	recentImprovements: string[];
}

export interface ErrorCase {
	timestamp: number;
	errorType: string;
	cause: string;
	suggestedFix: string;
	context?: string;
}

export interface MetacognitiveState {
	confidence: number; // 0-1
	knowledgeGaps: string[];
	metrics: PerformanceMetrics;
	assessment: SelfAssessment;
	recentErrors: ErrorCase[];
	lastReviewAt?: number;
}

const DEFAULT_STATE: MetacognitiveState = {
	confidence: 0.8,
	knowledgeGaps: [],
	metrics: {
		successRate: 1.0,
		avgTokensPerTask: 0,
		errorRate: 0,
		retryRate: 0,
		totalTasks: 0,
		completedTasks: 0,
		failedTasks: 0,
	},
	assessment: {
		strengths: [],
		weaknesses: [],
		recentImprovements: [],
	},
	recentErrors: [],
};

export class Metacognition {
	private state: MetacognitiveState = { ...DEFAULT_STATE };
	private storagePath: string | null = null;

	/**
	 * Initialize with optional persistence
	 */
	initialize(storageDir?: string, reset = false): void {
		// Reset to defaults first
		this.state = JSON.parse(JSON.stringify(DEFAULT_STATE));
		if (storageDir) {
			this.storagePath = join(storageDir, "metacognition.json");
			if (reset && this.storagePath && existsSync(this.storagePath)) {
				// Don't load - start fresh
				this.save();
			} else {
				this.load();
			}
		}
	}

	/**
	 * Get current state
	 */
	getState(): MetacognitiveState {
		return { ...this.state };
	}

	/**
	 * Get confidence level
	 */
	getConfidence(): number {
		return this.state.confidence;
	}

	/**
	 * Adjust confidence by a delta
	 */
	adjustConfidence(delta: number): void {
		this.state.confidence = Math.max(0, Math.min(1, this.state.confidence + delta));
		this.save();
	}

	/**
	 * Record a successful task completion
	 */
	recordSuccess(tokensUsed: number): void {
		this.state.metrics.totalTasks++;
		this.state.metrics.completedTasks++;

		// Update success rate
		const total = this.state.metrics.totalTasks;
		const completed = this.state.metrics.completedTasks;
		this.state.metrics.successRate = completed / total;

		// Update average tokens
		const prevAvg = this.state.metrics.avgTokensPerTask;
		this.state.metrics.avgTokensPerTask = (prevAvg * (total - 1) + tokensUsed) / total;

		// Slightly boost confidence on success
		this.adjustConfidence(0.02);

		this.save();
	}

	/**
	 * Record a task failure
	 */
	recordFailure(errorType: string, cause: string, suggestedFix: string, context?: string): void {
		this.state.metrics.totalTasks++;
		this.state.metrics.failedTasks++;

		// Update success rate and error rate
		const total = this.state.metrics.totalTasks;
		const completed = this.state.metrics.completedTasks;
		this.state.metrics.successRate = completed / total;
		this.state.metrics.errorRate = this.state.metrics.failedTasks / total;

		// Store error case
		const errorCase: ErrorCase = {
			timestamp: Date.now(),
			errorType,
			cause,
			suggestedFix,
			context,
		};
		this.state.recentErrors.unshift(errorCase);

		// Keep only last 20 errors
		if (this.state.recentErrors.length > 20) {
			this.state.recentErrors = this.state.recentErrors.slice(0, 20);
		}

		// Reduce confidence on failure
		this.adjustConfidence(-0.1);

		// Track knowledge gap
		if (!this.state.knowledgeGaps.includes(errorType)) {
			this.state.knowledgeGaps.push(errorType);
		}

		this.save();
	}

	/**
	 * Record a retry
	 */
	recordRetry(): void {
		this.state.metrics.retryRate++;
		this.adjustConfidence(-0.05);
		this.save();
	}

	/**
	 * Add knowledge gap
	 */
	addKnowledgeGap(gap: string): void {
		if (!this.state.knowledgeGaps.includes(gap)) {
			this.state.knowledgeGaps.push(gap);
			this.save();
		}
	}

	/**
	 * Mark knowledge gap as resolved
	 */
	resolveKnowledgeGap(gap: string): void {
		this.state.knowledgeGaps = this.state.knowledgeGaps.filter((g) => g !== gap);
		this.save();
	}

	/**
	 * Get recent errors
	 */
	getRecentErrors(limit = 5): ErrorCase[] {
		return this.state.recentErrors.slice(0, limit);
	}

	/**
	 * Get error patterns (grouped by type)
	 */
	getErrorPatterns(): Map<string, number> {
		const patterns = new Map<string, number>();
		for (const error of this.state.recentErrors) {
			const count = patterns.get(error.errorType) || 0;
			patterns.set(error.errorType, count + 1);
		}
		return patterns;
	}

	/**
	 * Update self-assessment
	 */
	updateAssessment(assessment: Partial<SelfAssessment>): void {
		if (assessment.strengths) {
			this.state.assessment.strengths = [...new Set([...this.state.assessment.strengths, ...assessment.strengths])];
		}
		if (assessment.weaknesses) {
			this.state.assessment.weaknesses = [
				...new Set([...this.state.assessment.weaknesses, ...assessment.weaknesses]),
			];
		}
		if (assessment.recentImprovements) {
			this.state.assessment.recentImprovements = assessment.recentImprovements;
		}
		this.state.lastReviewAt = Date.now();
		this.save();
	}

	/**
	 * Check if confidence is low enough to request help
	 */
	shouldRequestHelp(): boolean {
		return this.state.confidence < 0.3;
	}

	/**
	 * Get recommendation based on state
	 */
	getRecommendation(): string | null {
		if (this.state.confidence < 0.3) {
			return "Low confidence - consider requesting help";
		}
		if (this.state.metrics.errorRate > 0.5) {
			return "High error rate - review recent failures";
		}
		if (this.state.knowledgeGaps.length > 5) {
			return "Many knowledge gaps - consider learning phase";
		}
		return null;
	}

	/**
	 * Format assessment for display
	 */
	formatAssessment(): string {
		const lines = [
			"# Self-Assessment",
			"",
			`| Confidence | ${(this.state.confidence * 100).toFixed(0)}% |`,
			`| Success Rate | ${(this.state.metrics.successRate * 100).toFixed(0)}% (${this.state.metrics.completedTasks}/${this.state.metrics.totalTasks}) |`,
			`| Error Rate | ${(this.state.metrics.errorRate * 100).toFixed(0)}% |`,
			"",
		];

		if (this.state.knowledgeGaps.length > 0) {
			lines.push("## Knowledge Gaps");
			for (const gap of this.state.knowledgeGaps) {
				lines.push(`- ${gap}`);
			}
			lines.push("");
		}

		if (this.state.recentErrors.length > 0) {
			lines.push("## Recent Errors");
			for (const error of this.state.recentErrors.slice(0, 3)) {
				lines.push(`- ${error.errorType}: ${error.cause}`);
			}
			lines.push("");
		}

		const recommendation = this.getRecommendation();
		if (recommendation) {
			lines.push(`## Recommendation`);
			lines.push(recommendation);
		}

		return lines.join("\n");
	}

	/**
	 * Reset state
	 */
	reset(): void {
		this.state = { ...DEFAULT_STATE };
		this.save();
	}

	private save(): void {
		if (!this.storagePath) return;

		try {
			const dir = dirname(this.storagePath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(this.storagePath, JSON.stringify(this.state, null, 2));
		} catch {
			// Silent fail
		}
	}

	private load(): void {
		if (!this.storagePath) return;
		if (!existsSync(this.storagePath)) return;

		try {
			const data = readFileSync(this.storagePath, "utf-8");
			const loaded = JSON.parse(data);
			// Deep merge - explicitly handle arrays to avoid undefined issues
			this.state = {
				...DEFAULT_STATE,
				...loaded,
				metrics: { ...DEFAULT_STATE.metrics, ...(loaded.metrics || {}) },
				assessment: { ...DEFAULT_STATE.assessment, ...(loaded.assessment || {}) },
				knowledgeGaps: loaded.knowledgeGaps || [],
				recentErrors: loaded.recentErrors || [],
			};
		} catch {
			// Silent fail - use defaults
		}
	}
}
