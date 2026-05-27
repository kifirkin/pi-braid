import { createLogger } from "../../../lib/logger.js";
import {
  USAGE_WHISPER_ADVISORY,
  USAGE_COMPACT_MEDIUM,
  USAGE_COMPACT_AGGRESSIVE,
  USAGE_TOKENS_SOFT,
  USAGE_TOKENS_ADVISORY,
  USAGE_TOKENS_WARNING,
} from "../../../lib/context-thresholds.js";

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
  | "context_pressure"
  | "task_boundary"
  | "compaction_opportunity"
  | "checkpoint_opportunity"
  | "task_completion_candidate"
  // ── Context Density Signals (SimpleMem 2601.02553, GenericAgent 2604.17091) ──────
  | "context_density_low"
  | "context_density_high"
  | "context_duplicates"
  // ── Task State Signals ───────────────────────────────────────────────────────
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

// ── Outcome Tracking Removed ─────────────────────────────────────────────────
// Proposal state machine types (resolution/outcome) removed in Phase 2.3
// because they were only used for logging, never for decision-making.
// ---
// OutcomeRecord, PolicyStats, resolution tracking — removed.
// Kept: ContextProposal structure without lifecycle tracking fields.

// ── Session Entry Helpers ───────────────────────────────────────────────────

export function isProposalEntry(
  entry: SessionEntry,
): entry is SessionEntry & { type: "custom_message" } {
  return (
    entry.type === "custom_message" &&
    (entry as unknown as { customType?: string }).customType === PROPOSAL_CUSTOM_TYPE
  );
}

export function isSnapshotEntry(entry: SessionEntry): entry is SessionEntry & { type: "custom" } {
  return (
    entry.type === "custom" &&
    (entry as unknown as { customType?: string }).customType === SNAPSHOT_CUSTOM_TYPE
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
    // ── Token-count thresholds — preventive, fire BEFORE percentages ────────
    {
      id: "tokens-soft",
      name: "Token-count: soft preventive whisper",
      priority: 99,
      cooldown_ms: 120_000,
      trigger: { type: "context_usage_tokens", threshold: USAGE_TOKENS_SOFT },
      action: {
        type: "propose",
        message:
          "Context at ~{tokens}K tokens. Consider pruning old tool results (context_prune dry-run).",
        priority: "low",
      },
      suggested_action: "context_prune",
    },
    {
      id: "tokens-advisory",
      name: "Token-count: advisory — tag and consider archiving",
      priority: 98,
      cooldown_ms: 120_000,
      trigger: { type: "context_usage_tokens", threshold: USAGE_TOKENS_ADVISORY },
      action: {
        type: "propose",
        message:
          "Context grew past {tokens}K tokens. Tag your position (context_tag), then consider context_archive or context_checkout to branch.",
        priority: "medium",
      },
      suggested_action: "context_tag",
    },
    {
      id: "tokens-warning",
      name: "Token-count: warning — suggest full pipeline",
      priority: 97,
      cooldown_ms: 120_000,
      trigger: { type: "context_usage_tokens", threshold: USAGE_TOKENS_WARNING },
      action: {
        type: "propose",
        message:
          "Context at {tokens}K tokens ({percent}%). Pipeline: context_tag → context_checkout → context_archive → compact (last resort).",
        priority: "medium",
      },
      suggested_action: "context_tag",
    },
    // ── Percentage-based thresholds (take over at higher levels) ────────────
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
    // ── Proposals (shown to LLM, with governance) ─────────────────────────
    {
      id: "pressure-proposal",
      name: "Propose offload when context > 50%",
      priority: 55,
      cooldown_ms: 90_000,
      trigger: { type: "context_usage", threshold: USAGE_WHISPER_ADVISORY },
      action: {
        type: "propose",
        message: "Context at {percent}%. Consider `context_archive` for completed tasks.",
        priority: "low",
      },
      suggested_action: "context_archive",
    },
    // ── Task-state signal policies ──────────────────────────────────────────
    {
      id: "complexity-scratchpad",
      name: "Task complexity — suggest scratchpad",
      priority: 68,
      cooldown_ms: 90_000,
      trigger: { type: "signal", signal: "task_complexity" },
      action: {
        type: "propose",
        message:
          "Complex task detected ({unique_tools} unique tools). Consider updating scratchpad to track goal, decisions, and next steps.",
        priority: "medium",
      },
      suggested_action: "scratchpad",
      min_confidence: 0.5,
    },
    {
      id: "decision-density-think",
      name: "Decision density — suggest think before next change",
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
      name: "Low context density — suggest pruning",
      priority: 65,
      cooldown_ms: 120_000,
      trigger: { type: "signal", signal: "context_density_low" },
      action: {
        type: "propose",
        message:
          "Context density low. Noisy: {noise} | Signal: {signal}. Consider context_prune().",
        priority: "medium",
      },
      suggested_action: "context_prune",
      min_confidence: 0.5,
    },
    {
      id: "density-high-semantic",
      name: "High density + large context — semantic compression opportunity",
      priority: 58,
      cooldown_ms: 90_000,
      trigger: { type: "signal", signal: "context_density_high" },
      action: {
        type: "propose",
        message:
          "High density ({density}%) but context large ({token_ratio}% of limit). Semantic compression (SimpleMem): 30% token cost, preserves meaning.",
        priority: "low",
      },
      suggested_action: "context_archive",
      min_confidence: 0.5,
    },
    {
      id: "duplicates-dedup",
      name: "Duplicate messages — suggest dedup",
      priority: 62,
      cooldown_ms: 120_000,
      trigger: { type: "signal", signal: "context_duplicates" },
      action: {
        type: "propose",
        message: "{count} near-duplicate messages. context_prune() to remove.",
        priority: "medium",
      },
      suggested_action: "context_prune",
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
        message:
          "Task looks complete (explored, implemented, verified). finalize(completed=true, summary='...')?",
        priority: "medium",
      },
      suggested_action: "finalize",
      min_confidence: 0.6,
    },
  ];
}

// ── Default Governance Constraints ────────────────────────────────────────────

// Simplified governance. Only keep constraints that actually do something.
// Removed: no-proposal-spam (always returns valid:true, does nothing),
// low-confidence-warning (generates noisy warnings that don't help).
// Kept: high-usage-safety (actually blocks unsafe aggressive compaction).

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
