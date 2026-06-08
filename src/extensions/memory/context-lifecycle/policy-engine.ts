/**
 * Policy Engine — Pure function for evaluating context policies against signals.
 *
 * Transformed from class-based PolicyEngine to a pure evaluation function.
 * Cooldown tracking is managed externally via a state object.
 */

import { createLogger } from "../../../lib/core/logger.js";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import {
  evaluateContextDensity,
  recommendCompressionStrategy,
} from "../../../lib/detection/context-density.js";
import {
  DENSITY_LOW,
  DENSITY_HIGH,
  TOKEN_RATIO_LARGE_CONTEXT,
} from "../../../lib/detection/context-thresholds.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const log = createLogger("context-lifecycle");

import type { ContextPolicy, GovernanceConstraint, PolicyAction, SemanticSignal } from "./types.js";
import { createDefaultPolicies, createDefaultGovernance } from "./types.js";

// ── Policy Evaluation State ─────────────────────────────────────────────────

export interface PolicyEngineState {
  cooldowns: Map<string, number>;
  policies: ContextPolicy[];
  governance: GovernanceConstraint[];
}

export function createPolicyEngineState(
  policies?: ContextPolicy[],
  governance?: GovernanceConstraint[],
): PolicyEngineState {
  return {
    cooldowns: new Map(),
    policies: policies ?? createDefaultPolicies(),
    governance: governance ?? createDefaultGovernance(),
  };
}

// ── Policy Context ──────────────────────────────────────────────────────────

export interface PolicyContext {
  signals: SemanticSignal[];
  contextUsage: number;
  contextTokens: number;
  turnCount: number;
  redundancyCount: number;
}

// ── Evaluated Action ────────────────────────────────────────────────────────

export interface EvaluatedAction {
  action: PolicyAction;
  policy: ContextPolicy;
  validation: GovernanceResult;
  canExecute: boolean;
  signal?: SemanticSignal;
}

export interface GovernanceResult {
  valid: boolean;
  severity: "ok" | "warn" | "block";
  messages: string[];
}

// ── Pure Evaluation ─────────────────────────────────────────────────────────

function matchesTrigger(trigger: ContextPolicy["trigger"], ctx: PolicyContext): boolean {
  switch (trigger.type) {
    case "signal":
      return ctx.signals.some((s) => s.type === trigger.signal);
    case "context_usage":
      return ctx.contextUsage >= trigger.threshold;
    case "context_usage_tokens":
      return ctx.contextTokens >= trigger.threshold;
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

function validateAction(
  action: PolicyAction,
  signals: SemanticSignal[],
  governance: GovernanceConstraint[],
): GovernanceResult {
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
  const warnings: string[] = [];

  for (const constraint of governance) {
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

export function evaluatePolicies(state: PolicyEngineState, ctx: PolicyContext): EvaluatedAction[] {
  const actions: EvaluatedAction[] = [];
  const now = Date.now();

  const sorted = [...state.policies].sort((a, b) => b.priority - a.priority);

  for (const policy of sorted) {
    const cooldown = state.cooldowns.get(policy.id);
    if (cooldown && now - cooldown < policy.cooldown_ms) continue;

    if (policy.min_confidence !== undefined) {
      const maxSignalConfidence =
        ctx.signals.length > 0 ? Math.max(...ctx.signals.map((s) => s.confidence)) : 0;
      if (maxSignalConfidence < policy.min_confidence) continue;
    }

    if (policy.max_context_usage !== undefined) {
      if (ctx.contextUsage > policy.max_context_usage) continue;
    }

    if (!matchesTrigger(policy.trigger, ctx)) continue;

    const matchingSignal =
      policy.trigger.type === "signal"
        ? ctx.signals.find(
            (s) => s.type === (policy.trigger as { type: "signal"; signal: string }).signal,
          )
        : undefined;

    const action: PolicyAction = policy.action;
    const validation = validateAction(action, ctx.signals, state.governance);

    actions.push({
      action,
      policy,
      validation,
      canExecute: validation.valid || validation.severity === "warn",
      signal: matchingSignal,
    });

    state.cooldowns.set(policy.id, now);
  }

  return actions;
}

export function touchCooldown(state: PolicyEngineState, policyId: string): void {
  state.cooldowns.set(policyId, Date.now());
}

// ── Context Density Signal Generator ────────────────────────────────────────────

export function generateDensitySignals(ctx: ExtensionContext): SemanticSignal[] {
  const signals: SemanticSignal[] = [];
  const density = evaluateContextDensity(ctx);
  const strategy = recommendCompressionStrategy(density);

  if (density.density < DENSITY_LOW) {
    signals.push({
      id: `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      type: "context_density_low",
      data: {
        density: density.density,
        signal: density.signalMessages,
        noise: density.noisyMessages,
      },
      timestamp: Date.now(),
      turn: 0,
      confidence: 0.8,
    });
  } else if (density.density >= DENSITY_HIGH && density.tokenRatio > TOKEN_RATIO_LARGE_CONTEXT) {
    signals.push({
      id: `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      type: "context_density_high",
      data: { density: density.density, token_ratio: density.tokenRatio },
      timestamp: Date.now(),
      turn: 0,
      confidence: 0.8,
    });
  }

  if (density.duplicates > 2) {
    signals.push({
      id: `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      type: "context_duplicates",
      data: { count: density.duplicates },
      timestamp: Date.now(),
      turn: 0,
      confidence: 0.8,
    });
  }

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

/**
 * Shape of a density-policy proposal. Distinct from `EvaluatedAction`
 * because density proposals have an id and a numeric priority for sorting.
 */
export interface DensityPolicyProposal {
    id: string;
    policy_id: string;
    action: PolicyAction;
    priority: number;
    canExecute: boolean;
    signal?: SemanticSignal;
    confidence?: number;
}

export function evaluateDensityPolicies(ctx: ExtensionContext, signals: SemanticSignal[]): DensityPolicyProposal[] {
  const proposals: DensityPolicyProposal[] = [];

  for (const signal of signals) {
    const signalType = signal.type;

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
          "High density ({density}%) but context large ({token_ratio}% of limit). Semantic compression (SimpleMem): 30% token cost, preserves meaning.",
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

  proposals.sort((a, b) => b.priority - a.priority);
  return proposals;
}
