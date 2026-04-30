/**
 * Agent Events — Unified Event Taxonomy for pi-braid
 *
 * This module formalizes pi-braid's async event model. All cognitive mechanisms
 * (timer, memory, enforcement, analytics, compaction) emit signals through a
 * unified system that feeds into the belief-policy-engine and drives agent behavior.
 *
 * ARCHITECTURE:
 *   emitSignal(ctx, domain, signal, severity, autoProceed, data)
 *       ↓
 *   belief-policy-engine.ts — stores signal, evaluates rules
 *       ↓
 *   policy action (whisper / steer / propose / block)
 *
 * The emitSignal() function is the central event bus. All extensions emit
 * through it — there's no separate event bus class.
 *
 * EVENT TAXONOMY:
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  DOMAIN        │ SIGNALS                     │ SEVERITY  │ FORCES? │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │  stability     │ decline, predicted-decline    │ crit/warn │ auto    │
 * │  tool-use      │ overuse                      │ warn      │ no      │
 * │  reflection    │ absent                       │ info      │ no      │
 * │  sycophancy   │ detected                     │ warn/info │ no      │
 * │  conflict      │ unresolved                   │ info      │ no      │
 * │  calibration   │ high-error                   │ warn      │ no      │
 * │  topic-drift  │ drifted, scatter             │ warn      │ no      │
 * │  memory       │ conflict, contamination      │ warn      │ no      │
 * │  reasoning    │ absent, decline              │ info/warn │ no      │
 * │  enforcement  │ L1/L2/L3 signals           │ varies    │ no      │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * SIGNAL → POLICY → ACTION FLOW:
 *
 *   emitSignal("tool-use", "overuse", "warn", false, {tools: [...]})
 *       ↓
 *   belief-policy-engine: reflection_gap rule fires
 *       ↓
 *   getNextRecommendation() → whisper "[policy] Consider reflecting..."
 *
 * TOPIC-DRIFT DOMAIN SIGNALS (from topic-drift extension):
 *   emitSignal("topic-drift", "drifted", "warn", false, {anchors: [...], scatter: 0.7})
 *   emitSignal("topic-drift", "scatter", "warn", false, {anchors: [...], scatter: 0.9})
 *
 * MEMORY DOMAIN SIGNALS (from three-memory-stores):
 *   emitSignal("memory", "conflict", "warn", false, {episodes: [...]})
 *   emitSignal("memory", "contamination", "warn", false, {crossProject: true, sessionId: "..."})
 *
 * ENFORCEMENT SIGNALS (via events.emit, not emitSignal):
 *   pi.events.emit("enforcement_signals", {turn, signals, contrastMode})
 *       ↓
 *   prompt-builder: updates ps.activeContrastMode → renders mode-specific phrases
 *
 * See also:
 *   - src/lib/belief-policy-engine.ts — signal storage + policy evaluation
 *   - src/extensions/cognitive/enforcement/index.ts — signal emission sites
 *   - src/extensions/heartbeat/analytics/index.ts — analytics signal emission
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Signal Domains ───────────────────────────────────────────────────────────

/** High-level domain/category for a signal. Maps to belief-policy-engine belief keys. */
export type SignalDomain =
  | "stability"      // System health: degrade, recovery, decline
  | "tool-use"       // Tool patterns: overuse, repetition, addiction
  | "reflection"      // Meta-cognition: absent reflection, reflection gap
  | "sycophancy"      // Alignment: detected sycophancy signals
  | "conflict"        // Evidence: unresolved belief conflicts
  | "calibration"     // Confidence: prediction accuracy signals
  | "topic-drift"     // Focus: drift from semantic anchors
  | "memory"          // Memory: contamination, cross-session leakage
  | "reasoning"       // Cognitive: absent/declining reasoning chains
  | "enforcement";    // Governance: policy signals (via events.emit)

/** Specific signal within a domain. Maps to belief key suffix. */
export type SignalType =
  // stability
  | "decline" | "predicted-decline" | "recovered" | "healthy"
  // tool-use
  | "overuse" | "repetition" | "addiction" | "idle"
  // reflection
  | "absent" | "present" | "deep"
  // sycophancy
  | "detected" | "corrected"
  // conflict
  | "unresolved" | "detected" | "resolved"
  // calibration
  | "high-error" | "calibrated" | "uncertain"
  // topic-drift
  | "drifted" | "scatter"
  // memory
  | "contamination" | "cross-project" | "stale" | "evicted"
  // reasoning
  | "absent" | "declining" | "enhanced"
  // enforcement
  | "L1" | "L2" | "L3";

/** How urgent is this signal? Determines policy evaluation priority. */
export type SignalSeverity = "info" | "warn" | "critical";

/**
 * Full signal structure — the canonical form emitted through emitSignal().
 * All signal-emitting extensions should emit through this structure.
 */
export interface AgentSignal {
  /** Domain (high-level category) */
  domain: SignalDomain;
  /** Specific signal type within domain */
  type: SignalType;
  /** Severity — info/warn/critical */
  severity: SignalSeverity;
  /**
   * If true, this signal should force a turn (auto-finalize, auto-proceed).
   * Only used by stability/decline signals for now.
   */
  autoProceed: boolean;
  /** Arbitrary data associated with this signal */
  data: Record<string, unknown>;
  /** Turn number when signal was emitted */
  turn: number;
  /** Timestamp (ms) */
  timestamp: number;
  /** Source extension path */
  source: string;
}

// ── Emit Helpers ─────────────────────────────────────────────────────────────

/**
 * Emit a signal through the belief-policy-engine event bus.
 * This is the primary way extensions communicate async state changes.
 *
 * Usage:
 *   import { emitSignal } from "../../lib/belief-policy-engine.js";
 *   emitSignal(ctx, "tool-use", "overuse", "warn", false, { tools: ["bash", "bash"] });
 */
export type EmitSignalFn = (
  ctx: ExtensionContext,
  domain: SignalDomain,
  type: SignalType,
  severity: SignalSeverity,
  autoProceed: boolean,
  data?: Record<string, unknown>,
) => void;

// ── Policy Action Types ──────────────────────────────────────────────────────

/** What the belief-policy-engine recommends when a rule fires. */
export type PolicyActionType =
  | "whisper"    // Inject reminder/nudge into context
  | "steer"       // Force a behavioral steer
  | "propose"     // Suggest an action to the agent
  | "block";     // Prevent an action

// ── Deprecated Aliases ────────────────────────────────────────────────────────
// Extensions may still emit via the old emitSignal() API directly.
// These are kept for backward compatibility during migration.

/** @deprecated Use AgentSignal fields directly */
export type LegacySignalData = {
  domain: SignalDomain;
  type: SignalType;
  severity: SignalSeverity;
  autoProceed: boolean;
  data: Record<string, unknown>;
};
