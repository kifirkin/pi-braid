/**
 * Session-scoped state for context-lifecycle.
 *
 * Extracted from index.ts to:
 * 1. Reduce index.ts size (was 890L, largest in the codebase)
 * 2. Allow helpers.ts to access `state()` without creating cycles
 * 3. Make state management testable in isolation
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
    // ── Compaction escalation tracking ──────────────────────────────────────
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
    // ── Policy + detector (migrated 2026-06-22, was DR-C-2) ─────────────────
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
        lastCompactNudgeUsage: 0,
        compactNudgeActive: false,
        agentActedOnContext: false,
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
 * ROADMAP P1-1 / DR-C-2: `state()` now prefers per-session state when ctx
 * is provided. The module-level fallback is retained for callers that
 * genuinely have no ctx (e.g. helpers.ts:readProposalsFromSession during
 * session replay). Pass ctx to get correct per-session behavior.
 *
 * Migration: callers that have ctx available should call `state(ctx)`.
 * The old `state()` (no args) is still supported for the small set of
 * legacy callers, but should be considered for migration.
 */
export function state(ctx?: ExtensionContext): ContextLifecycleState {
    if (ctx) {
        // Per-session path: use the canonical getExtensionState. This
        // resets on session_start, so the fallback's manual resetState
        // (below) is no longer needed when ctx is available.
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
