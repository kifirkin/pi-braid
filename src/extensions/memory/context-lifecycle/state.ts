/**
 * Session-scoped state for context-lifecycle.
 *
 * Extracted from index.ts to:
 * 1. Reduce index.ts size (was 890L, largest in the codebase)
 * 2. Allow helpers.ts to access `state()` without creating cycles
 * 3. Make state management testable in isolation
 *
 * State lifecycle:
 * - Module-level fallback (this file) is used when ctx is not available
 * - Session-scoped state (via getExtensionState) is preferred when ctx is accessible
 * - Reset on session_start
 *
 * TODO: Thread ctx through all callers and remove the module-level fallback.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../../../lib/state/extension-state.js";

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

export function state(): ContextLifecycleState {
    ensureFreshState();
    if (!_currentSessionState) {
        _currentSessionState = createState();
    }
    return _currentSessionState;
}

export function resetState(ctx: ExtensionContext): ContextLifecycleState {
    _currentSessionState = createState();
    _currentSessionId = ctx.cwd ?? null;
    return _currentSessionState;
}
