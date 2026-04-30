import { createLogger } from "../../../lib/logger.js";
import { getExtensionState } from "../../../lib/extension-state.js";
import {
  evaluateContextDensity,
  recommendCompressionStrategy,
} from "../../../lib/context-density.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

const log = createLogger("context-lifecycle");
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

function matchesTrigger(trigger: ContextPolicy["trigger"], ctx: PolicyContext): boolean {
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
        const maxSignalConfidence =
          ctx.signals.length > 0 ? Math.max(...ctx.signals.map((s) => s.confidence)) : 0;
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
  private validateAction(action: PolicyAction, signals: SemanticSignal[]): GovernanceResult {
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
      suggested_action: action.type === "propose" ? "context_archive" : undefined,
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

// ── Context Density Signal Generator ────────────────────────────────────────────

/**
 * Evaluate context information density and emit signals.
 * Based on: SimpleMem (2601.02553), GenericAgent (2604.17091)
 *
 * density < 0.4  → noisy context → aggressive pruning
 * density 0.4-0.7 → mixed → semantic compression
 * density > 0.7 + large context → semantic compression opportunity
 * duplicates > 2 → dedup signal
 */
export function generateDensitySignals(ctx: ExtensionContext): SemanticSignal[] {
  const signals: SemanticSignal[] = [];
  const density = evaluateContextDensity(ctx);
  const strategy = recommendCompressionStrategy(density);

  if (density.density < 0.4) {
    signals.push({
      id: `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      type: "context_density_low",
      data: {
        density: density.density,
        signal: density.signalMessages,
        noise: density.noisyMessages,
      },
      timestamp: Date.now(),
      turn: undefined as any,
      confidence: 0.8,
    });
  } else if (density.density >= 0.7 && density.tokenRatio > 0.6) {
    signals.push({
      id: `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      type: "context_density_high",
      data: { density: density.density, token_ratio: density.tokenRatio },
      timestamp: Date.now(),
      turn: undefined as any,
      confidence: 0.8,
    });
  }

  if (density.duplicates > 2) {
    signals.push({
      id: `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      type: "context_duplicates",
      data: { count: density.duplicates },
      timestamp: Date.now(),
      turn: undefined as any,
      confidence: 0.8,
    });
  }

  // Also add to extension state for policy evaluation
  const state = getExtensionState(ctx, "context-density", () => ({
    density: density.density,
    tokenRatio: density.tokenRatio,
    duplicates: density.duplicates,
    strategy,
    timestamp: Date.now(),
  }));
  state.density = density.density;
  state.tokenRatio = density.tokenRatio;
  state.duplicates = density.duplicates;
  state.strategy = strategy;
  state.timestamp = Date.now();

  return signals;
}

// ── Policy Evaluation for Density Signals ───────────────────────────────────────

export function evaluatePolicies(ctx: ExtensionContext, signals: SemanticSignal[]): any[] {
  const proposals: any[] = [];

  for (const signal of signals) {
    const signalType = signal.type;

    // Map signal type to matching policies
    const policy_map: Record<
      string,
      { priority: number; message: string; suggested_action: string; min_confidence: number }
    > = {
      context_density_low: {
        priority: 65,
        message:
          "Context density low. Noisy: {noise} | Signal: {signal}. Consider context_prune().",
        suggested_action: "context_prune",
        min_confidence: 0.5,
      },
      context_density_high: {
        priority: 58,
        message:
          "High density ({density}%) but context large ({ratio}% of limit). Semantic compression (SimpleMem): 30% token cost, preserves meaning.",
        suggested_action: "context_archive",
        min_confidence: 0.5,
      },
      context_duplicates: {
        priority: 62,
        message: "{count} near-duplicate messages. context_prune() to remove.",
        suggested_action: "context_prune",
        min_confidence: 0.5,
      },
    };

    const policy = policy_map[signalType];
    if (policy && (signal.confidence ?? 1) >= policy.min_confidence) {
      proposals.push({
        id: `policy-${signalType}`,
        policy_id: signalType,
        action: { type: "propose", message: policy.message, priority: "medium" as const },
        priority: policy.priority,
        canExecute: true,
        signal,
        confidence: signal.confidence ?? 1,
      });
    }
  }

  // Sort by priority descending
  proposals.sort((a, b) => b.priority - a.priority);
  return proposals;
}
