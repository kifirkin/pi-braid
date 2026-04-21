import { createLogger } from "../../lib/logger.js";

const log = createLogger("context-lifecycle");
/**
 * Context Lifecycle Types - S-MMU Core Interfaces
 *
 * Shared types for active context lifecycle management.
 * All state is stored in SessionManager via CustomEntry/CustomMessageEntry.
 */

import type { SessionEntry } from "@mariozechner/pi-coding-agent";

// ── Semantic Signals ────────────────────────────────────────────────────────

export type SemanticSignalType =
	| "topic_shift"
	| "redundancy_detected"
	| "tool_sequence_pattern"
	| "context_pressure"
	| "task_boundary"
	| "compaction_opportunity"
	| "checkpoint_opportunity"
	| "task_completion_candidate";

export interface SemanticSignal {
	id: string;
	type: SemanticSignalType;
	timestamp: number;
	turn: number;
	data: Record<string, unknown>;
	confidence: number;
}

export function createSignal(
	type: SemanticSignalType,
	turn: number,
	data: Record<string, unknown> = {},
	confidence = 1.0,
): SemanticSignal {
	return {
		id: `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
		type,
		timestamp: Date.now(),
		turn,
		data,
		confidence,
	};
}

// ── Policies ───────────────────────────────────────────────────────────────

export type PolicyTrigger =
	| { type: "signal"; signal: SemanticSignalType }
	| { type: "context_usage"; threshold: number }
	| { type: "turn_count"; threshold: number }
	| { type: "redundancy"; count: number }
	| { type: "any_signal" };

export type PolicyAction =
	| { type: "compact"; level: "light" | "medium" | "aggressive" }
	| { type: "propose"; message: string; priority: "low" | "medium" | "high" }
	| { type: "snapshot"; reason: string }
	| { type: "nudge"; message: string }
	| { type: "govern"; constraint: string } // Governance action: validate constraint
	| { type: "finalize_suggestion"; summary?: string }; // Suggest finalize to agent

export interface ContextPolicy {
	id: string;
	name: string;
	priority: number;
	cooldown_ms: number;
	trigger: PolicyTrigger;
	action: PolicyAction;
	/** Safety: minimum confidence required */
	min_confidence?: number;
	/** Safety: maximum context_usage threshold */
	max_context_usage?: number;
	/** Safety: suggested action for governance hints */
	suggested_action?: string;
}

// ── Proposals (stored as CustomMessageEntry) ────────────────────────────────

export const PROPOSAL_CUSTOM_TYPE = "context-lifecycle:proposal";

export interface ContextProposal {
	id: string;
	type: "offload" | "compact" | "snapshot" | "branch" | "govern";
	message: string;
	priority: "low" | "medium" | "high";
	created_at: number;
	turn: number;
	/** Policy that generated this proposal */
	policy_id: string;
	confidence: number;
	/** What action was suggested */
	suggested_action?: string;
	/** Outcome tracking (closed-loop) */
	resolution?: "approved" | "rejected" | "implicit_approved" | "expired" | "action_taken";
	resolved_at?: number;
	/** Outcome evaluation */
	outcome?: {
		action_taken: boolean;
		turns_to_resolve: number;
		context_delta?: number;
	};
}

export function createProposal(
	type: ContextProposal["type"],
	message: string,
	policyId: string,
	turn: number,
	priority: ContextProposal["priority"] = "medium",
	confidence = 0.7,
	suggestedAction?: string,
): ContextProposal {
	return {
		id: `prop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
		type,
		message,
		priority,
		created_at: Date.now(),
		turn,
		policy_id: policyId,
		confidence,
		suggested_action: suggestedAction,
	};
}

// ── Governance Constraints ─────────────────────────────────────────────────

export interface GovernanceConstraint {
	id: string;
	name: string;
	description: string;
	/** What to validate: "proposal", "action", "snapshot" */
	target: "proposal" | "action" | "snapshot";
	/** Validation function */
	validate: (proposal: ContextProposal, signals: SemanticSignal[]) => ValidationResult;
	/** Severity if violated */
	severity: "warn" | "block";
}

export interface ValidationResult {
	valid: boolean;
	message?: string;
	suggestion?: string;
}

// ── Snapshots (stored as CustomEntry) ───────────────────────────────────────

export const SNAPSHOT_CUSTOM_TYPE = "context-lifecycle:snapshot";

export interface ContextSnapshot {
	id: string;
	reason: string;
	turn: number;
	timestamp: number;
	token_count: number;
	learnings: string[];
	goals: string[];
	decisions: string[];
	ttl_ms: number;
	expires_at: number;
}

export function createSnapshot(
	reason: string,
	turn: number,
	tokenCount: number,
	ttlMs = 24 * 60 * 60 * 1000,
): ContextSnapshot {
	const now = Date.now();
	return {
		id: `snap-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
		reason,
		turn,
		timestamp: now,
		token_count: tokenCount,
		learnings: [],
		goals: [],
		decisions: [],
		ttl_ms: ttlMs,
		expires_at: now + ttlMs,
	};
}

// ── Outcome Tracking (Closed-Loop) ───────────────────────────────────────────

export interface OutcomeRecord {
	proposal_id: string;
	policy_id: string;
	action_type: string;
	resolution: ContextProposal["resolution"];
	turns_to_resolve: number;
	context_delta: number;
	timestamp: number;
}

export interface PolicyStats {
	policy_id: string;
	fired_count: number;
	approval_rate: number;
	avg_turns_to_resolve: number;
	action_taken_rate: number;
}

// ── Session Entry Helpers ───────────────────────────────────────────────────

export function isProposalEntry(entry: SessionEntry): entry is SessionEntry & { type: "custom_message" } {
	return (
		entry.type === "custom_message" &&
		(entry as any).customType === PROPOSAL_CUSTOM_TYPE
	);
}

export function isSnapshotEntry(entry: SessionEntry): entry is SessionEntry & { type: "custom" } {
	return (
		entry.type === "custom" &&
		(entry as any).customType === SNAPSHOT_CUSTOM_TYPE
	);
}

// ── Default Policies ─────────────────────────────────────────────────────────

export function createDefaultPolicies(): ContextPolicy[] {
	return [
		// ── Auto-compaction (no approval needed, governance-validated) ──────────
		{
			id: "auto-dedup",
			name: "Light deduplication",
			priority: 100,
			cooldown_ms: 30_000,
			trigger: { type: "redundancy", count: 2 },
			action: { type: "compact", level: "light" },
			min_confidence: 0.6,
		},
		{
			id: "high-usage-aggressive",
			name: "Aggressive compact on critical usage",
			priority: 95,
			cooldown_ms: 30_000,
			trigger: { type: "context_usage", threshold: 85 },
			action: { type: "compact", level: "aggressive" },
			min_confidence: 0.7,
			max_context_usage: 90,
		},
		{
			id: "medium-usage",
			name: "Medium compact on high usage",
			priority: 70,
			cooldown_ms: 60_000,
			trigger: { type: "context_usage", threshold: 70 },
			action: { type: "compact", level: "medium" },
			min_confidence: 0.5,
		},
		// ── Proposals (shown to LLM, with governance) ─────────────────────────
		{
			id: "pressure-proposal",
			name: "Propose offload when context > 60%",
			priority: 55,
			cooldown_ms: 90_000,
			trigger: { type: "context_usage", threshold: 60 },
			action: {
				type: "propose",
				message: "Context at {percent}%. Consider `context_compress` for completed tasks.",
				priority: "low",
			},
			suggested_action: "context_compress",
		},
		{
			id: "topic-shift-proposal",
			name: "Propose checkpoint on topic shift",
			priority: 40,
			cooldown_ms: 120_000,
			trigger: { type: "signal", signal: "topic_shift" },
			action: {
				type: "propose",
				message: "Topic shift detected. Consider `context_tag` to mark the checkpoint.",
				priority: "medium",
			},
			suggested_action: "context_tag",
		},
		{
			id: "task-boundary-proposal",
			name: "Propose snapshot at task boundaries",
			priority: 35,
			cooldown_ms: 30_000,
			trigger: { type: "signal", signal: "task_boundary" },
			action: {
				type: "propose",
				message: "Task boundary detected. Create a `context_tag` checkpoint?",
				priority: "low",
			},
			suggested_action: "context_tag",
		},
		// ── Snapshots ─────────────────────────────────────────────────────────
		{
			id: "auto-snapshot",
			name: "Auto-snapshot before high context usage",
			priority: 90,
			cooldown_ms: 60_000,
			trigger: { type: "signal", signal: "context_pressure" },
			action: { type: "snapshot", reason: "pre-compaction" },
		},
		// ── Task Completion Suggestion ──────────────────────────────────────────
		{
			id: "finalize-suggestion",
			name: "Suggest finalize when task appears complete",
			priority: 30, // Lower than other policies - suggestion only
			cooldown_ms: 120_000,
			trigger: { type: "signal", signal: "task_completion_candidate" },
			action: {
				type: "propose",
				message: "Task looks complete (explored, implemented, verified). finalize(completed=true, summary='...')?",
				priority: "medium",
			},
			suggested_action: "finalize",
			min_confidence: 0.6,
		},
	];
}

// ── Default Governance Constraints ────────────────────────────────────────────

export function createDefaultGovernance(): GovernanceConstraint[] {
	return [
		{
			id: "no-proposal-spam",
			name: "Proposal rate limiting",
			description: "Max 3 proposals per 10 turns",
			target: "proposal",
			validate: (proposal, signals) => {
				// This would need access to proposal history - simplified check
				return {
					valid: true,
				};
			},
			severity: "warn",
		},
		{
			id: "low-confidence-warning",
			name: "Warn on low confidence proposals",
			description: "Warn if proposal confidence < 0.5",
			target: "proposal",
			validate: (proposal) => {
				if (proposal.confidence < 0.5) {
					return {
						valid: true,
						message: `Low confidence proposal (${(proposal.confidence * 100).toFixed(0)}%)`,
						suggestion: "Consider waiting for more signals before acting",
					};
				}
				return { valid: true };
			},
			severity: "warn",
		},
		{
			id: "high-usage-safety",
			name: "Safety on critical context usage",
			description: "Block aggressive compaction when context > 90%",
			target: "action",
			validate: (proposal) => {
				if (
					proposal.suggested_action === "compact" &&
					proposal.confidence < 0.8
				) {
					return {
						valid: false,
						message: "Unsafe to compact: confidence too low for critical context",
						suggestion: "Wait for context to stabilize or use lighter compaction",
					};
				}
				return { valid: true };
			},
			severity: "block",
		},
	];
}
