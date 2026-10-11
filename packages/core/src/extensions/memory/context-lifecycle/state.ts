/**
 * Session-scoped state for context-lifecycle.
 *
 * State lifecycle:
 * - Module-level fallback (this file's `state()`) is used when `ctx` is
 *   not available at the call site (e.g. `helpers.ts:readProposalsFromSession`
 *   which operates on raw session entries during context replay).
 * - Session-scoped state (via getExtensionState) is preferred when ctx
 *   is accessible. Use `_getState(ctx)` from extension event handlers.
 * - `resetState(ctx)` is called from the session_start handler.
 *
 * Why the module-level fallback stays: helpers.ts:readProposalsFromSession
 * is called from contexts that don't have ExtensionContext (during
 * session replay from disk). Threading ctx would require redesigning
 * the replay flow. Module-level state is acceptable here because the
 * lifetime of `helpers.ts` operations is bounded by the extension's
 * own execution; cross-session leakage isn't a risk in practice.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { createPolicyEngineState, type PolicyEngineState } from "./policy-engine.js";
import { createDetectorState, type DetectorState } from "./signal-detector.js";

/** A single outcome record with TTL - for closed-loop feedback. */
export interface Outcome {
  proposalId: string;
  resolution: string;
  turnsToResolve: number;
  timestamp: number;
}

export interface ContextLifecycleState {
  proposalsThisTurn: number;
  proposalsTotal: number;
  initialized: boolean;
  sessionStartMs: number;
  turnCount: number;
  proposalsByEntryId: Map<string, any>;
  outcomes: Outcome[];
  /** How many compact nudges the agent has ignored consecutively */
  ignoredCompactNudges: number;
  /** Turn number when we last sent a compact nudge */
  lastCompactNudgeTurn: number;
  /** Context usage % at the time of last compact nudge */
  lastCompactNudgeUsage: number;
  /** Whether a compact nudge is currently waiting for agent action */
  compactNudgeActive: boolean;
  /** Whether the agent called a context management tool since the last nudge check */
  agentActedOnContext: boolean;
  // Navigation proposal escalation (mirrors compaction escalation)
  /** How many navigation proposals (topic_shift/task_boundary) the agent has ignored */
  ignoredNavigationProposals: number;
  /** Turn number when we last sent a navigation enforcement whisper */
  lastNavigationWhisperTurn: number;
  /**
   * The signal-policy engine state: cooldowns, policies, governance.
   * Migrated from a module-level const to per-session so each session
   * starts with a fresh engine (no cross-session cooldowns leaking).
   */
  policyEngine: PolicyEngineState;
  /**
   * The signal-detector state: topic history, tool sequence, pending
   * signals, completion tracking. Migrated from a module-level const
   * to per-session for the same reason.
   */
  detector: DetectorState;
  /**
   * Normalized suggestion key -> lastSentAt (ms) for same-suggestion
   * within-session dedupe. Seeded from persisted proposals (so a resumed /
   * compacted session doesn't re-inject a suggestion that was already
   * delivered and is replayed into context) and cleared (re-armed) when the
   * agent acts on context via a context-management tool.
   */
  proposalKeys: Map<string, number>;
  /** True once persisted proposals have been folded into proposalKeys. */
  proposalKeysSeeded: boolean;
  /** Turn number when the agent last acted on a context-management tool. */
  lastContextActionTurn: number;
  /**
   * Suggestion keys the agent explicitly declined via context_proposals
   * reject. The real-need gate backs off re-proposing a declined class.
   */
  declinedKeys: Set<string>;
  /**
   * Suggestion key -> turn when a same-class proposal was implicitly
   * approved (agent never acted -> ignored). Feeds the compliance-feedback
   * backoff (PROPOSAL_IGNORED_BACKOFF_TURNS).
   */
  proposalIgnoredTurns: Map<string, number>;
}

export function createState(): ContextLifecycleState {
  return {
    proposalsThisTurn: 0,
    proposalsTotal: 0,
    initialized: false,
    sessionStartMs: Date.now(),
    turnCount: 0,
    proposalsByEntryId: new Map(),
    outcomes: [],
    ignoredCompactNudges: 0,
    lastCompactNudgeTurn: 0,
    ignoredNavigationProposals: 0,
    lastNavigationWhisperTurn: 0,
    lastCompactNudgeUsage: 0,
    compactNudgeActive: false,
    agentActedOnContext: false,
    proposalKeys: new Map(),
    proposalKeysSeeded: false,
    lastContextActionTurn: 0,
    declinedKeys: new Set(),
    proposalIgnoredTurns: new Map(),
    policyEngine: createPolicyEngineState(),
    detector: createDetectorState(),
  };
}

export function _getState(ctx: ExtensionContext): ContextLifecycleState {
  return getExtensionState(ctx, "context-lifecycle", createState);
}

// Module-level fallback state - used when `ctx` is not available.
// Preferred pattern: use getState(ctx) wherever ctx is accessible.
// Reset on session_start; turn_end uses the session-scoped getState(ctx).
// FULL FIX: Thread ctx through all callers and remove this fallback.
let _currentSessionState: ContextLifecycleState | null = null;
let _currentSessionId: string | null = null;

export function ensureFreshState(sessionId?: string): void {
  const sid = sessionId ?? _currentSessionId;
  if (sid && sid !== _currentSessionId) {
    _currentSessionState = createState();
    _currentSessionId = sid;
  }
}

/**
 * `state()` prefers per-session state when ctx is provided; the module-level
 * fallback serves callers that genuinely have no ctx (e.g.
 * helpers.ts:readProposalsFromSession during session replay). Pass ctx for
 * per-session behavior.
 */
export function state(ctx?: ExtensionContext): ContextLifecycleState {
  if (ctx) {
    // Per-session path: the canonical getExtensionState resets on
    // session_start, so the fallback's manual resetState below does not
    // apply when ctx is available.
    return _getState(ctx);
  }
  ensureFreshState();
  if (!_currentSessionState) {
    _currentSessionState = createState();
  }
  return _currentSessionState;
}

export function resetState(ctx: ExtensionContext): ContextLifecycleState {
  // Clear both the per-session bucket and the module-level fallback.
  // The per-session bucket is recreated lazily on next access.
  const fresh = createState();
  _currentSessionState = fresh;
  _currentSessionId = ctx.cwd ?? null;
  return fresh;
}
