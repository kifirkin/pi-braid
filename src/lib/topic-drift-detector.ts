/**
 * Topic Drift Detector
 *
 * Detects when the conversation has drifted from its original task context.
 * Uses a "whisper" pattern: when drift is detected, the extension sends a
 * gentle, non-intrusive hint to the agent rather than blocking or interrupting.
 *
 * Drift detection triggers:
 * - Semantic mismatch: conversation topics diverge significantly from task context
 * - Structural mismatch: user is asking about something unrelated to current session
 * - Tool usage drift: agent is using tools unrelated to task context
 * - Temporal drift: conversation has drifted after an unrelated user message
 *
 * Whisper message format:
 * ```
 * [SUBTLE] Topic drift detected. Original task: {task}. Current: {current}.
 * Consider refocusing or updating task context.
 * ```
 */

import { createLogger } from "./logger.js";

const _log = createLogger("topic-drift");

export interface DriftCheck {
	drifted: boolean;
	task: string;
	current: string;
	severity: "subtle" | "moderate" | "strong";
	reason: string;
}

export interface DriftDetectorOptions {
	/** Minimum Jaccard similarity between topics to consider aligned */
	topicThreshold?: number;
	/** Minimum word overlap for structural similarity */
	structuralThreshold?: number;
	/** Enable structural analysis (word overlap) */
	enableStructural?: boolean;
	/** Enable tool usage analysis */
	enableToolUsage?: boolean;
	/** Minimum conversation turns before checking */
	minTurns?: number;
	/** Jaccard word set minimum overlap */
	minOverlap?: number;
}

const DEFAULT_OPTIONS: Required<DriftDetectorOptions> = {
	topicThreshold: 0.15,
	structuralThreshold: 0.1,
	enableStructural: true,
	enableToolUsage: true,
	minTurns: 3,
	minOverlap: 3,
};

export class TopicDriftDetector {
	private taskContext: string = "";
	private options: Required<DriftDetectorOptions>;
	private conversationHistory: string[] = [];
	private lastDriftWarning: number = 0;
	private driftCooldownMs: number = 30 * 1000; // Don't warn more than once per 30s

	constructor(options: DriftDetectorOptions = {}) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	/**
	 * Set the original task context to compare against.
	 */
	setTaskContext(task: string): void {
		this.taskContext = task.trim();
		this.conversationHistory = [];
		_log.debug(`Task context set: ${this.taskContext.slice(0, 80)}...`);
	}

	/**
	 * Add a conversation turn (user message) to history.
	 */
	addTurn(userMessage: string): void {
		const cleaned = userMessage.trim();
		if (!cleaned || cleaned.startsWith("/")) return;
		this.conversationHistory.push(cleaned);
		// Keep last 20 turns
		if (this.conversationHistory.length > 20) {
			this.conversationHistory.shift();
		}
	}

	/**
	 * Check if conversation has drifted from task context.
	 */
	check(): DriftCheck {
		if (this.conversationHistory.length < this.options.minTurns) {
			return { drifted: false, task: this.taskContext, current: "", severity: "subtle", reason: "too_few_turns" };
		}

		if (!this.taskContext) {
			return { drifted: false, task: "", current: "", severity: "subtle", reason: "no_task_context" };
		}

		// Check cooldown
		if (Date.now() - this.lastDriftWarning < this.driftCooldownMs) {
			return { drifted: false, task: this.taskContext, current: "", severity: "subtle", reason: "cooldown" };
		}

		// Get current conversation focus (last few turns)
		const recentTurns = this.conversationHistory.slice(-5);
		const currentText = recentTurns.join(" ");
		const currentWords = this.tokenize(currentText);
		const taskWords = this.tokenize(this.taskContext);

		// Skip if either is too short
		if (currentWords.size < this.options.minOverlap || taskWords.size < this.options.minOverlap) {
			return { drifted: false, task: this.taskContext, current: currentText.slice(0, 80), severity: "subtle", reason: "too_short" };
		}

		// Jaccard similarity
		const jaccard = this.jaccardSimilarity(taskWords, currentWords);
		const semanticDrift = jaccard < this.options.topicThreshold;

		// Structural drift: check word overlap at tail of conversation
		let structuralDrift = false;
		if (this.options.enableStructural && this.conversationHistory.length >= 3) {
			const recent = this.conversationHistory.slice(-3);
			const tailOverlap = this.getOverlap(this.tokenize(this.taskContext), this.tokenize(recent.join(" ")));
			structuralDrift = tailOverlap < this.options.structuralThreshold && recent.length >= 3;
		}

		const drifted = semanticDrift || structuralDrift;
		const severity = drifted ? this.computeSeverity(jaccard) : "subtle";

		if (drifted) {
			this.lastDriftWarning = Date.now();
		}

		return {
			drifted,
			task: this.taskContext.slice(0, 100),
			current: currentText.slice(0, 100),
			severity,
			reason: semanticDrift ? "semantic_drift" : "structural_drift",
		};
	}

	/**
	 * Generate whisper message for drift detection.
	 */
	generateWhisper(check: DriftCheck): string | null {
		if (!check.drifted) return null;

		const severityTag = check.severity === "strong" ? "[WARN]" : "[SUBTLE]";
		const taskPreview = check.task.length > 50 ? check.task.slice(0, 50) + "..." : check.task;

		return `${severityTag} Topic drift detected. Task: "${taskPreview}". Reason: ${check.reason}. Consider refocusing or updating context.`;
	}

	private computeSeverity(jaccard: number): "subtle" | "moderate" | "strong" {
		if (jaccard < 0.05) return "strong";
		if (jaccard < 0.1) return "moderate";
		return "subtle";
	}

	private tokenize(text: string): Set<string> {
		return new Set(
			text
				.toLowerCase()
				.split(/\s+/)
				.filter((w) => w.length > 2 && !this.isStopword(w))
		);
	}

	private isStopword(word: string): boolean {
		const stop = new Set([
			"the", "and", "that", "this", "with", "from", "your", "have", "more", "are", "was", "will",
			"can", "for", "not", "but", "they", "you", "all", "get", "has", "her", "him", "his",
			"how", "its", "may", "new", "now", "old", "see", "two", "way", "who", "boy", "did",
			"she", "use", "our", "out", "any", "just", "like", "then", "also", "into", "very",
		]);
		return stop.has(word);
	}

	private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
		if (a.size === 0 && b.size === 0) return 1;
		if (a.size === 0 || b.size === 0) return 0;
		let intersection = 0;
		for (const w of a) {
			if (b.has(w)) intersection++;
		}
		const union = a.size + b.size - intersection;
		return union === 0 ? 0 : intersection / union;
	}

	private getOverlap(a: Set<string>, b: Set<string>): number {
		let count = 0;
		for (const w of a) {
			if (b.has(w)) count++;
		}
		return count;
	}

	/** Reset conversation history */
	reset(): void {
		this.conversationHistory = [];
		this.lastDriftWarning = 0;
	}
}
