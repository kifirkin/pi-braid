import {
  USAGE_WHISPER_ADVISORY,
  USAGE_COMPACT_MEDIUM,
  USAGE_COMPACT_AGGRESSIVE,
} from "../../../lib/detection/context-thresholds.js";
import { tokenArms } from "../../../lib/detection/context-usage.js";
import { nextId } from "../../../lib/utils/id.js";

// Token arms are fractions of the resolved window (0.18W/0.30W/0.45W);
// evaluated once at catalog build, refreshed per session.
const ARMS = tokenArms();

/**
 * Context Lifecycle Types - S-MMU Core Interfaces
 *
 * Shared types for active context lifecycle management.
 * All state is stored in SessionManager via CustomEntry/CustomMessageEntry.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type SemanticSignalType =
  | "topic_shift"
  | "redundancy_detected"
  | "context_pressure"
  | "task_boundary"
  | "compaction_opportunity"
  | "checkpoint_opportunity"
  | "task_completion_candidate"
  // Context density signals (SimpleMem 2601.02553, GenericAgent 2604.17091)
  | "context_density_low"
  | "context_density_high"
  | "context_duplicates"
  | "task_complexity"
  | "decision_density";

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
    id: nextId("sig"),
    type,
    timestamp: Date.now(),
    turn,
    data,
    confidence,
  };
}

export type PolicyTrigger =
  | { type: "signal"; signal: SemanticSignalType }
  | { type: "context_usage"; threshold: number }
  | { type: "context_usage_tokens"; threshold: number }
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

// Proposals (stored as CustomMessageEntry)

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
    id: nextId("prop"),
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

// Snapshots (stored as CustomEntry)

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

export function isProposalEntry(
  entry: SessionEntry,
): entry is SessionEntry & { type: "custom_message" } {
  return (
    entry.type === "custom_message" &&
    (entry as { customType?: string }).customType === PROPOSAL_CUSTOM_TYPE
  );
}

export function isSnapshotEntry(entry: SessionEntry): entry is SessionEntry & { type: "custom" } {
  return (
    entry.type === "custom" &&
    (entry as { customType?: string }).customType === SNAPSHOT_CUSTOM_TYPE
  );
}

export function createDefaultPolicies(): ContextPolicy[] {
  return [
    // Auto-compaction (no approval needed, governance-validated)
    {
      id: "auto-dedup",
      name: "Light deduplication",
      priority: 100,
      cooldown_ms: 30_000,
      trigger: { type: "redundancy", count: 2 },
      action: { type: "compact", level: "light" },
      min_confidence: 0.6,
    },
    // Token-count thresholds - preventive, fire BEFORE percentages
    {
      id: "tokens-soft",
      name: "Token-count: soft preventive whisper",
      priority: 99,
      cooldown_ms: 300_000,
      trigger: { type: "context_usage_tokens", threshold: ARMS.soft },
      action: {
        type: "propose",
        message:
          "Context at ~{tokens} tokens. Consider compacting old tool results (context_compress action='compact').",
        priority: "low",
      },
      suggested_action: "context_compress",
    },
    {
      id: "tokens-advisory",
      name: "Token-count: advisory - tag and consider archiving",
      priority: 98,
      cooldown_ms: 300_000,
      trigger: { type: "context_usage_tokens", threshold: ARMS.advisory },
      action: {
        type: "propose",
        message:
          'Context grew past {tokens} tokens. Tag your position with context_navigate(action="tag"), then consider context_compress(action="archive") or context_navigate(action="checkout") to branch.',
        priority: "medium",
      },
      suggested_action: "context_navigate",
    },
    {
      id: "tokens-warning",
      name: "Token-count: warning - suggest full pipeline",
      priority: 97,
      cooldown_ms: 300_000,
      trigger: { type: "context_usage_tokens", threshold: ARMS.warning },
      action: {
        type: "propose",
        message:
          'Context at {tokens} tokens ({percent}). Pipeline: context_navigate(action="tag") -> context_navigate(action="checkout") -> context_compress(action="archive") -> context_compress(action="slide").',
        priority: "medium",
      },
      suggested_action: "context_navigate",
    },
    // Percentage-based thresholds (take over at higher levels)
    {
      id: "high-usage-aggressive",
      name: "Aggressive compact on critical usage",
      priority: 95,
      cooldown_ms: 30_000,
      trigger: { type: "context_usage", threshold: USAGE_COMPACT_AGGRESSIVE },
      action: { type: "compact", level: "aggressive" },
      min_confidence: 0.7,
      max_context_usage: 95,
    },
    {
      id: "medium-usage",
      name: "Medium compact on high usage",
      priority: 70,
      cooldown_ms: 60_000,
      trigger: { type: "context_usage", threshold: USAGE_COMPACT_MEDIUM },
      action: { type: "compact", level: "medium" },
      min_confidence: 0.5,
    },
    // Proposals (shown to LLM, with governance)
    {
      id: "pressure-proposal",
      name: "Propose offload when context > 50%",
      priority: 55,
      cooldown_ms: 90_000,
      trigger: { type: "context_usage", threshold: USAGE_WHISPER_ADVISORY },
      action: {
        type: "propose",
        message:
          'Context at {percent}. Consider `context_compress(action="archive")` for completed tasks.',
        priority: "low",
      },
      suggested_action: "context_compress",
    },
    {
      id: "decision-density-think",
      name: "Decision density - suggest think before next change",
      priority: 67,
      cooldown_ms: 90_000,
      trigger: { type: "signal", signal: "decision_density" },
      action: {
        type: "propose",
        message:
          "Dense decision-making detected ({high_stakes} high-stakes actions). Consider think(observation, decision, reason) before committing.",
        priority: "medium",
      },
      suggested_action: "think",
      min_confidence: 0.5,
    },
    {
      id: "density-low-prune",
      name: "Low context density - suggest pruning",
      priority: 65,
      cooldown_ms: 120_000,
      trigger: { type: "signal", signal: "context_density_low" },
      action: {
        type: "propose",
        message:
          "Context density low. Noisy: {noise} | Signal: {signal}. Consider context_compress(action='compact').",
        priority: "medium",
      },
      suggested_action: "context_compress",
      min_confidence: 0.5,
    },
    {
      id: "density-high-semantic",
      name: "High density + large context - semantic compression opportunity",
      priority: 58,
      cooldown_ms: 90_000,
      trigger: { type: "signal", signal: "context_density_high" },
      action: {
        type: "propose",
        message:
          "High density ({density}%) but context large ({token_ratio}% of limit). Semantic compression (SimpleMem): 30% token cost, preserves meaning.",
        priority: "low",
      },
      suggested_action: "context_compress",
      min_confidence: 0.5,
    },
    {
      id: "duplicates-dedup",
      name: "Duplicate messages - suggest dedup",
      priority: 62,
      cooldown_ms: 120_000,
      trigger: { type: "signal", signal: "context_duplicates" },
      action: {
        type: "propose",
        message: "{count} near-duplicate messages. context_compress(action='compact') to remove.",
        priority: "medium",
      },
      suggested_action: "context_compress",
      min_confidence: 0.5,
    },

    {
      id: "topic-shift-proposal",
      name: "Propose checkpoint on topic shift",
      priority: 40,
      cooldown_ms: 120_000,
      trigger: { type: "signal", signal: "topic_shift" },
      action: {
        type: "propose",
        message:
          'Topic shift detected. Consider `context_navigate(action="tag")` to mark the checkpoint.',
        priority: "medium",
      },
      suggested_action: "context_navigate",
    },
    {
      id: "task-boundary-proposal",
      name: "Propose snapshot at task boundaries",
      priority: 35,
      cooldown_ms: 30_000,
      trigger: { type: "signal", signal: "task_boundary" },
      action: {
        type: "propose",
        message: 'Task boundary detected. Create a `context_navigate(action="tag")` checkpoint?',
        priority: "low",
      },
      suggested_action: "context_navigate",
    },
    {
      id: "auto-snapshot",
      name: "Auto-snapshot before high context usage",
      priority: 90,
      cooldown_ms: 60_000,
      trigger: { type: "signal", signal: "context_pressure" },
      action: { type: "snapshot", reason: "pre-compaction" },
    },
    {
      id: "finalize-suggestion",
      name: "Suggest finalize when task appears complete",
      priority: 30, // Lower than other policies - suggestion only
      cooldown_ms: 120_000,
      trigger: { type: "signal", signal: "task_completion_candidate" },
      action: {
        type: "propose",
        message:
          "Task looks complete (explored, implemented, verified). finalize(completed=true, summary='...')?",
        priority: "medium",
      },
      suggested_action: "finalize",
      min_confidence: 0.6,
    },
  ];
}

// Governance: only constraints that actually do something — high-usage-safety
// blocks unsafe aggressive compaction; advisory-only constraints (spam
// guards, low-confidence warnings that just add noise) have no seat here.

export function createDefaultGovernance(): GovernanceConstraint[] {
  return [
    {
      id: "high-usage-safety",
      name: "Safety on critical context usage",
      description: "Block aggressive compaction when context > 90%",
      target: "action",
      validate: (proposal) => {
        if (proposal.suggested_action === "compact" && proposal.confidence < 0.8) {
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
