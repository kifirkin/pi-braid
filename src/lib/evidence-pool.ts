/**
 * Evidence Pool — Tracks knowledge from multiple sources with conflict detection.
 *
 * Based on: docs/RESEARCH_CONFLICT_QA.md
 * Key insight: "acknowledging conflict > arbitrary selection"
 *
 * Flow:
 * 1. memory_recall, web search, docs reading → addEvidence()
 * 2. message_end → detectConflicts() → unresolved → enforcement whisper
 * 3. resolveConflict() → verdict stored, conflict marked resolved
 *
 * Conflict detection: token-overlap based (no LLM needed for detection).
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "./extension-state.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type EvidenceSource = "memory" | "web" | "docs" | "code" | "session" | "unknown";

export interface Evidence {
	id: string;
	claim: string;            // Normalized claim text
	normalized: string;         // lowercase, stopwords removed
	content: string;            // Original content
	source: EvidenceSource;
	confidence: number;         // 0-1
	timestamp: number;
	turn?: number;             // Turn when added
}

export interface Conflict {
	id: string;
	claim: string;             // The claim being contradicted
	for: Evidence[];            // Evidence supporting
	against: Evidence[];       // Evidence contradicting
	verdict: "unresolved" | "resolved_for" | "resolved_against" | "uncertain";
	resolvedBy?: string;       // How it was resolved
	resolvedAt?: number;
	detectedAt: number;
}

export interface EvidencePoolState {
	evidence: Evidence[];
	conflicts: Conflict[];
	lastCleanup: number;
}

// ── State factory ──────────────────────────────────────────────────────────────

function getState(ctx: ExtensionContext): EvidencePoolState {
	return getExtensionState(ctx, "evidence-pool", () => ({
		evidence: [],
		conflicts: [],
		lastCleanup: Date.now(),
	}));
}

// ── Normalization helpers ───────────────────────────────────────────────────────

const STOP_WORDS = new Set([
	"the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
	"have", "has", "had", "do", "does", "did", "will", "would", "could",
	"should", "may", "might", "must", "shall", "can", "need", "dare",
	"that", "this", "these", "those", "what", "which", "who", "whom",
	"with", "without", "from", "into", "onto", "in", "out", "on", "off",
	"over", "under", "above", "below", "to", "for", "of", "and", "or",
	"but", "if", "then", "else", "when", "where", "how", "why", "not",
	"all", "each", "every", "both", "few", "more", "most", "other",
	"some", "such", "no", "nor", "only", "own", "same", "so", "than",
	"too", "very", "just", "also", "now", "here", "there", "then",
]);

/** Normalize claim for comparison: lowercase, remove stopwords, sort words */
function normalize(text: string): string {
	const tokens = text.toLowerCase().split(/\W+/).filter((t) => t.length > 2 && !STOP_WORDS.has(t));
	return tokens.sort().join(" ");
}

/** Token overlap ratio between two texts */
function tokenOverlap(a: string, b: string): number {
	const tokensA = new Set(normalize(a).split(" "));
	const tokensB = new Set(normalize(b).split(" "));
	if (tokensA.size === 0 || tokensB.size === 0) return 0;
	let overlap = 0;
	for (const t of tokensA) {
		if (tokensB.has(t)) overlap++;
	}
	return overlap / Math.max(tokensA.size, tokensB.size);
}

/** Extract the core claim from text (first sentence, stripped) */
function extractClaim(text: string, maxLen = 80): string {
	const first = text.split(/[.!?\n]/)[0].trim();
	return first.length > maxLen ? first.slice(0, maxLen) + "..." : first;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Add evidence to the pool from a knowledge source.
 * Call after memory_recall, web search, docs reading, code reading.
 */
export function addEvidence(
	ctx: ExtensionContext,
	claim: string,
	source: EvidenceSource,
	content: string,
	confidence = 0.7,
): string {
	const state = getState(ctx);
	const evidence: Evidence = {
		id: `e${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
		claim: extractClaim(claim),
		normalized: normalize(claim),
		content: content.slice(0, 500),
		source,
		confidence,
		timestamp: Date.now(),
	};
	state.evidence.push(evidence);

	// Cleanup old evidence (>50 entries → keep last 30)
	if (state.evidence.length > 50) {
		state.evidence = state.evidence.slice(-30);
	}

	// Check for conflicts with this new evidence
	detectConflictsFor(ctx, evidence.id);

	return evidence.id;
}

/**
 * Get all evidence for a given context (optional filter by source).
 */
export function getEvidence(
	ctx: ExtensionContext,
	source?: EvidenceSource,
): Evidence[] {
	const state = getState(ctx);
	if (source) return state.evidence.filter((e) => e.source === source);
	return [...state.evidence];
}

/**
 * Get unresolved conflicts.
 */
export function getUnresolvedConflicts(ctx: ExtensionContext): Conflict[] {
	return getState(ctx).conflicts.filter((c) => c.verdict === "unresolved");
}

/**
 * Get all conflicts.
 */
export function getAllConflicts(ctx: ExtensionContext): Conflict[] {
	return [...getState(ctx).conflicts];
}

/**
 * Resolve a conflict with a verdict.
 */
export function resolveConflict(
	ctx: ExtensionContext,
	conflictId: string,
	verdict: "resolved_for" | "resolved_against" | "uncertain",
	resolvedBy: string,
): void {
	const state = getState(ctx);
	const conflict = state.conflicts.find((c) => c.id === conflictId);
	if (!conflict) return;
	conflict.verdict = verdict;
	conflict.resolvedBy = resolvedBy;
	conflict.resolvedAt = Date.now();
}

/**
 * Detect conflicts among all evidence in the pool.
 * Returns newly detected conflicts.
 */
export function detectConflicts(ctx: ExtensionContext): Conflict[] {
	const state = getState(ctx);
	const evidence = state.evidence;
	const newConflicts: Conflict[] = [];

	// For each pair of evidence from different sources with overlapping claims
	for (let i = 0; i < evidence.length; i++) {
		for (let j = i + 1; j < evidence.length; j++) {
			const a = evidence[i];
			const b = evidence[j];

			// Skip same source (internal consistency assumed)
			if (a.source === b.source) continue;

			// Check overlap
			const overlap = tokenOverlap(a.claim, b.claim);
			if (overlap < 0.3) continue; // Not related claims

			// Check confidence difference → potential conflict
			const confidenceDiff = Math.abs(a.confidence - b.confidence);
			if (confidenceDiff < 0.15) continue; // Both low confidence, not a conflict

			// Found a potential conflict — check if already tracked
			const existing = state.conflicts.find(
				(c) =>
					c.for.some((e) => e.id === a.id || e.id === b.id) ||
					c.against.some((e) => e.id === a.id || e.id === b.id),
			);
			if (existing) continue;

			// Create conflict
			const conflict: Conflict = {
				id: `c${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
				claim: overlap >= 0.5 ? a.claim : `${a.claim.slice(0, 40)}... vs ${b.claim.slice(0, 40)}...`,
				for: confidenceDiff > 0 ? [a] : [b],
				against: confidenceDiff > 0 ? [b] : [a],
				verdict: "unresolved",
				detectedAt: Date.now(),
			};
			state.conflicts.push(conflict);
			newConflicts.push(conflict);
		}
	}

	// Cleanup old resolved conflicts (>20 → keep last 10)
	if (state.conflicts.length > 20) {
		state.conflicts = state.conflicts.slice(-10);
	}

	return newConflicts;
}

/** Detect conflicts for a single new evidence entry */
function detectConflictsFor(ctx: ExtensionContext, evidenceId: string): Conflict[] {
	const state = getState(ctx);
	const newEvidence = state.evidence.find((e) => e.id === evidenceId);
	if (!newEvidence) return [];

	const newConflicts: Conflict[] = [];
	for (const existing of state.evidence) {
		if (existing.id === evidenceId) continue;
		if (existing.source === newEvidence.source) continue;

		const overlap = tokenOverlap(newEvidence.claim, existing.claim);
		if (overlap < 0.3) continue;

		const confidenceDiff = Math.abs(newEvidence.confidence - existing.confidence);
		if (confidenceDiff < 0.15) continue;

		// Check not already tracked
		const existingConflict = state.conflicts.find(
			(c) =>
				c.for.some((e) => e.id === evidenceId || e.id === existing.id) ||
				c.against.some((e) => e.id === evidenceId || e.id === existing.id),
		);
		if (existingConflict) continue;

		const conflict: Conflict = {
			id: `c${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			claim: overlap >= 0.5
				? newEvidence.claim
				: `${newEvidence.claim.slice(0, 40)}... vs ${existing.claim.slice(0, 40)}...`,
			for: newEvidence.confidence > existing.confidence ? [newEvidence] : [existing],
			against: newEvidence.confidence > existing.confidence ? [existing] : [newEvidence],
			verdict: "unresolved",
			detectedAt: Date.now(),
		};
		state.conflicts.push(conflict);
		newConflicts.push(conflict);
	}

	return newConflicts;
}

/**
 * Generate a faithful conflict acknowledgment message for enforcement.
 */
export function formatConflictMessage(conflict: Conflict): string {
	const forSource = conflict.for[0]?.source || "unknown";
	const againstSource = conflict.against[0]?.source || "unknown";
	return (
		`[conflict] Sources disagree: "${conflict.claim.slice(0, 60)}". ` +
		`${forSource} (conf ${(conflict.for[0]?.confidence ?? 0).toFixed(1)}) ` +
		`vs ${againstSource} (conf ${(conflict.against[0]?.confidence ?? 0).toFixed(1)}). ` +
		`Consider acknowledging: "Sources disagree on X. Based on Y, I conclude Z."`
	);
}

/**
 * Clear all evidence and conflicts (for testing or session reset).
 */
export function clearEvidence(ctx: ExtensionContext): void {
	const state = getState(ctx);
	state.evidence = [];
	state.conflicts = [];
}
