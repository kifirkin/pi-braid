/**
 * Conflict QA System — Detects knowledge contradictions and generates resolution questions.
 *
 * Papers:
 * - 2604.11209 (ConflictQA): LLMs fail at faithful aggregation of conflicting evidence.
 *   Key: "acknowledging conflict > arbitrary selection"
 * - 2604.14525 (Cross-Query Contradictions): Contradictions appear across queries, not within one.
 *   Key: "Detect across the full evidence timeline, not per-query."
 *
 * Architecture:
 * 1. XoT Stage 1 — Source identification + conflict classification
 * 2. XoT Stage 2 — Generate resolution questions for unresolved conflicts
 * 3. Enforcement hook — Whisper unresolved conflicts at turn boundaries
 *
 * Conflict types (from ConflictQA):
 * - direct: Two sources make opposite claims about the same fact
 * - implication: One source's claim logically contradicts another
 * - reliability: Source has low historical accuracy on this topic
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "./extension-state.js";
import {
	type Conflict,
	type EvidenceSource,
	addEvidence,
	getUnresolvedConflicts,
	resolveConflict,
	detectConflicts,
	getAllConflicts,
	getEvidence,
	formatConflictMessage,
} from "./evidence-pool.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type ConflictType = "direct" | "implication" | "reliability";

export type ResolutionStrategy =
	| "favor_text"       // Prefer docs/code evidence
	| "favor_kg"         // Prefer structured memory
	| "favor_param"      // Prefer model's parametric knowledge
	| "favor_recent"     // Prefer most recent evidence
	| "acknowledge";     // Don't resolve — surface to user

export interface ConflictQA {
	id: string;
	conflictId: string;
	type: ConflictType;
	question: string;
	resolutionStrategy: ResolutionStrategy;
	suggestedAnswer?: string;
	sources: Array<{
		type: EvidenceSource | "parametric";
		content: string;
		confidence: number;
	}>;
	createdAt: number;
	resolvedAt?: number;
	verdict?: string;
}

interface ConflictQAState {
	qas: ConflictQA[];
	resolutionHistory: Array<{
		qaId: string;
		verdict: string;
		strategy: ResolutionStrategy;
		timestamp: number;
	}>;
	totalGenerated: number;
	totalResolved: number;
}

// ── State ────────────────────────────────────────────────────────────────────

function createQAState(): ConflictQAState {
	return {
		qas: [],
		resolutionHistory: [],
		totalGenerated: 0,
		totalResolved: 0,
	};
}

function getState(ctx: ExtensionContext): ConflictQAState {
	return getExtensionState(ctx, "conflict-qa", createQAState);
}

// ── Conflict Classification ──────────────────────────────────────────────────

function classifyConflict(conflict: Conflict): ConflictType {
	// Direct: High token overlap between for/against claims
	const forText = conflict.for.map((e) => e.claim).join(" ");
	const againstText = conflict.against.map((e) => e.claim).join(" ");
	const overlap = tokenOverlap(forText, againstText);

	if (overlap > 0.5) return "direct";

	// Reliability: One source has significantly lower confidence
	const forConf = conflict.for[0]?.confidence ?? 0.5;
	const againstConf = conflict.against[0]?.confidence ?? 0.5;
	if (Math.abs(forConf - againstConf) > 0.3) return "reliability";

	// Default: implication-based conflict
	return "implication";
}

function tokenOverlap(a: string, b: string): number {
	const tokensA = new Set(a.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
	const tokensB = new Set(b.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
	if (tokensA.size === 0 || tokensB.size === 0) return 0;
	let overlap = 0;
	for (const t of tokensA) {
		if (tokensB.has(t)) overlap++;
	}
	return overlap / Math.max(tokensA.size, tokensB.size);
}

// ── Resolution Strategy Selection ────────────────────────────────────────────

function selectStrategy(conflict: Conflict, type: ConflictType): ResolutionStrategy {
	// For direct conflicts: prefer higher-confidence source
	if (type === "direct") {
		const forSource = conflict.for[0];
		const againstSource = conflict.against[0];

		// Code/docs are highly reliable for factual claims
		if (forSource?.source === "code" && againstSource?.source !== "code") return "favor_text";
		if (againstSource?.source === "code" && forSource?.source !== "code") return "favor_text";

		// Recent evidence is more likely current
		if (forSource && againstSource) {
			if (forSource.timestamp > againstSource.timestamp + 3600000) return "favor_recent";
			if (againstSource.timestamp > forSource.timestamp + 3600000) return "favor_recent";
		}

		return "acknowledge";
	}

	// For reliability conflicts: acknowledge and surface
	if (type === "reliability") return "acknowledge";

	// For implication conflicts: favor text (explicit evidence)
	return "favor_text";
}

// ── Question Generation ──────────────────────────────────────────────────────

function generateQuestion(conflict: Conflict, type: ConflictType): string {
	const forContent = conflict.for[0]?.content?.slice(0, 100) ?? "unknown";
	const againstContent = conflict.against[0]?.content?.slice(0, 100) ?? "unknown";
	const claim = conflict.claim;

	if (type === "direct") {
		return `Direct contradiction detected: "${claim.slice(0, 80)}". ` +
			`Source A says: "${forContent}...". ` +
			`Source B says: "${againstContent}...". ` +
			`Which is correct based on available evidence?`;
	}

	if (type === "reliability") {
		const lowConf = conflict.for[0]?.confidence ?? 0.5;
		const highConf = conflict.against[0]?.confidence ?? 0.5;
		return `Reliability conflict on "${claim.slice(0, 80)}". ` +
			`Source A confidence: ${(lowConf * 100).toFixed(0)}%, ` +
			`Source B confidence: ${(highConf * 100).toFixed(0)}%. ` +
			`Should the lower-confidence claim be discounted?`;
	}

	// Implication
	return `Potential implication conflict on "${claim.slice(0, 80)}". ` +
		`"${forContent}..." may contradict "${againstContent}...". ` +
		`Are these claims compatible, or does one invalidate the other?`;
}

// ── Core API ─────────────────────────────────────────────────────────────────

/**
 * Process all unresolved conflicts and generate QAs.
 * Call at turn boundaries (turn_end).
 */
export function processConflicts(ctx: ExtensionContext): ConflictQA[] {
	const state = getState(ctx);
	const unresolved = getUnresolvedConflicts(ctx);

	if (unresolved.length === 0) return [];

	const newQAs: ConflictQA[] = [];

	for (const conflict of unresolved) {
		// Skip if we already have a QA for this conflict
		if (state.qas.some((q) => q.conflictId === conflict.id)) continue;

		const type = classifyConflict(conflict);
		const strategy = selectStrategy(conflict, type);
		const question = generateQuestion(conflict, type);

		const qa: ConflictQA = {
			id: `qa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			conflictId: conflict.id,
			type,
			question,
			resolutionStrategy: strategy,
			sources: [
				...conflict.for.map((e) => ({ type: e.source, content: e.content.slice(0, 200), confidence: e.confidence })),
				...conflict.against.map((e) => ({ type: e.source, content: e.content.slice(0, 200), confidence: e.confidence })),
			],
			createdAt: Date.now(),
		};

		state.qas.push(qa);
		state.totalGenerated++;
		newQAs.push(qa);
	}

	// Prune old QAs
	if (state.qas.length > 50) {
		state.qas = state.qas.slice(-30);
	}

	return newQAs;
}

/**
 * Resolve a QA with a verdict.
 */
export function resolveQA(
	ctx: ExtensionContext,
	qaId: string,
	verdict: string,
): void {
	const state = getState(ctx);
	const qa = state.qas.find((q) => q.id === qaId);
	if (!qa) return;

	qa.verdict = verdict;
	qa.resolvedAt = Date.now();
	state.totalResolved++;

	state.resolutionHistory.push({
		qaId,
		verdict,
		strategy: qa.resolutionStrategy,
		timestamp: Date.now(),
	});

	// Also resolve the underlying conflict
	resolveConflict(ctx, qa.conflictId, "uncertain", `QA resolved: ${verdict}`);

	// Prune history
	if (state.resolutionHistory.length > 100) {
		state.resolutionHistory = state.resolutionHistory.slice(-50);
	}
}

/**
 * Get pending (unresolved) QAs.
 */
export function getPendingQAs(ctx: ExtensionContext): ConflictQA[] {
	const state = getState(ctx);
	return state.qas.filter((q) => !q.resolvedAt);
}

/**
 * Get all QAs.
 */
export function getAllQAs(ctx: ExtensionContext): ConflictQA[] {
	return [...getState(ctx).qas];
}

/**
 * Get conflict QA statistics.
 */
export function getQAStats(ctx: ExtensionContext): {
	totalGenerated: number;
	totalResolved: number;
	pendingCount: number;
	resolutionsByStrategy: Record<string, number>;
} {
	const state = getState(ctx);
	const resolutionsByStrategy: Record<string, number> = {};
	for (const r of state.resolutionHistory) {
		resolutionsByStrategy[r.strategy] = (resolutionsByStrategy[r.strategy] ?? 0) + 1;
	}

	return {
		totalGenerated: state.totalGenerated,
		totalResolved: state.totalResolved,
		pendingCount: state.qas.filter((q) => !q.resolvedAt).length,
		resolutionsByStrategy,
	};
}

/**
 * Generate enforcement whisper message for pending conflicts.
 */
export function formatConflictWhisper(qas: ConflictQA[]): string {
	if (qas.length === 0) return "";

	const lines: string[] = [];
	lines.push(`[conflict-qa] ${qas.length} unresolved knowledge conflict(s):`);

	for (const qa of qas.slice(0, 3)) {
		lines.push(`  ${qa.type}: ${qa.question.slice(0, 120)}...`);
		lines.push(`    Strategy: ${qa.resolutionStrategy}`);
	}

	if (qas.length > 3) {
		lines.push(`  ...and ${qas.length - 3} more`);
	}

	lines.push("Consider acknowledging: \"Sources disagree on X. Based on Y, I conclude Z.\"");

	return lines.join("\n");
}

/**
 * Get the most relevant conflict QA for a given topic.
 */
export function getRelevantQA(ctx: ExtensionContext, topic: string): ConflictQA | null {
	const pending = getPendingQAs(ctx);
	if (pending.length === 0) return null;

	const topicTokens = new Set(topic.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
	if (topicTokens.size === 0) return null;

	let bestQA: ConflictQA | null = null;
	let bestScore = 0;

	for (const qa of pending) {
		const qaTokens = new Set(qa.question.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
		let score = 0;
		for (const t of topicTokens) {
			if (qaTokens.has(t)) score++;
		}
		if (score > bestScore) {
			bestScore = score;
			bestQA = qa;
		}
	}

	return bestScore > 0 ? bestQA : null;
}
