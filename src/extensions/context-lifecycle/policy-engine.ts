/**
 * Policy Engine - Declarative rule evaluation for S-MMU
 *
 * Evaluates semantic signals against policies with governance validation.
 * Outputs: immediate actions (compact) or proposals with constraint checking.
 */

import type {
	ContextPolicy,
	GovernanceConstraint,
	PolicyAction,
	SemanticSignal,
	ValidationResult,
} from "./types.js";
import { createDefaultPolicies, createDefaultGovernance } from "./types.js";

// ── Policy Evaluation ────────────────────────────────────────────────────────

function matchesTrigger(
	trigger: ContextPolicy["trigger"],
	ctx: PolicyContext,
): boolean {
	switch (trigger.type) {
		case "signal":
			return ctx.signals.some((s) => s.type === trigger.signal);

		case "context_usage":
			return ctx.contextUsage >= trigger.threshold;

		case "turn_count":
			return ctx.turnCount >= trigger.threshold;

		case "redundancy":
			return ctx.redundancyCount >= trigger.count;

		case "any_signal":
			return ctx.signals.length > 0;

		default:
			return false;
	}
}

// ── Policy Context ──────────────────────────────────────────────────────────

interface PolicyContext {
	signals: SemanticSignal[];
	contextUsage: number;
	turnCount: number;
	redundancyCount: number;
}

// ── Policy Engine ───────────────────────────────────────────────────────────

export class PolicyEngine {
	private policies: ContextPolicy[];
	private cooldowns: Map<string, number> = new Map();
	private governance: GovernanceConstraint[];

	constructor(policies?: ContextPolicy[], governance?: GovernanceConstraint[]) {
		this.policies = policies ?? createDefaultPolicies();
		this.governance = governance ?? createDefaultGovernance();
	}

	/** Evaluate policies and return validated actions */
	evaluate(ctx: PolicyContext): EvaluatedAction[] {
		const actions: EvaluatedAction[] = [];
		const now = Date.now();

		// Sort by priority (higher first)
		const sorted = [...this.policies].sort((a, b) => b.priority - a.priority);

		for (const policy of sorted) {
			// Check cooldown
			const cooldown = this.cooldowns.get(policy.id);
			if (cooldown && now - cooldown < policy.cooldown_ms) continue;

			// Check confidence threshold
			if (policy.min_confidence !== undefined) {
				const maxSignalConfidence = ctx.signals.length > 0
					? Math.max(...ctx.signals.map((s) => s.confidence))
					: 0;
				if (maxSignalConfidence < policy.min_confidence) continue;
			}

			// Check context usage threshold
			if (policy.max_context_usage !== undefined) {
				if (ctx.contextUsage > policy.max_context_usage) continue;
			}

			// Check trigger
			if (!matchesTrigger(policy.trigger, ctx)) continue;

			// Policy fires
			const action: PolicyAction = policy.action;

			// Apply governance validation
			const validation = this.validateAction(action, ctx.signals);

			actions.push({
				action,
				policy,
				validation,
				canExecute: validation.valid || validation.severity === "warn",
			});

			this.cooldowns.set(policy.id, now);
		}

		return actions;
	}

	/** Validate an action against governance constraints */
	private validateAction(
		action: PolicyAction,
		signals: SemanticSignal[],
	): GovernanceResult {
		// Mock proposal for validation
		const mockProposal = {
			id: "validate",
			type: "compact" as const,
			message: "",
			priority: "medium" as const,
			created_at: Date.now(),
			turn: 0,
			policy_id: "",
			confidence: signals[0]?.confidence ?? 0.5,
			suggested_action: action.type === "propose" ? "context_compress" : undefined,
		};

		let blocked = false;
		let warnings: string[] = [];

		for (const constraint of this.governance) {
			if (constraint.target !== "action" && constraint.target !== "proposal") continue;

			const result = constraint.validate(mockProposal, signals);
			if (!result.valid && constraint.severity === "block") {
				blocked = true;
				warnings.push(`BLOCKED: ${result.message}`);
			} else if (result.message && constraint.severity === "warn") {
				warnings.push(`WARN: ${result.message}`);
			}
		}

		return {
			valid: !blocked,
			severity: blocked ? "block" : warnings.length > 0 ? "warn" : "ok",
			messages: warnings,
		};
	}

	/** Reset all cooldowns */
	resetCooldowns(): void {
		this.cooldowns.clear();
	}

	/** Get policies */
	getPolicies(): ContextPolicy[] {
		return [...this.policies];
	}

	/** Touch a specific policy cooldown */
	touchCooldown(policyId: string): void {
		this.cooldowns.set(policyId, Date.now());
	}

	/** Get governance constraints */
	getGovernance(): GovernanceConstraint[] {
		return [...this.governance];
	}
}

// ── Evaluated Action ────────────────────────────────────────────────────────

export interface EvaluatedAction {
	action: PolicyAction;
	policy: ContextPolicy;
	validation: GovernanceResult;
	canExecute: boolean;
}

export interface GovernanceResult {
	valid: boolean;
	severity: "ok" | "warn" | "block";
	messages: string[];
}
