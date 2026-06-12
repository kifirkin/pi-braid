/**
 * Helper utilities for context-lifecycle.
 *
 * Extracted from index.ts to keep the main file focused on
 * extension wiring (event handlers, tool registration, policy execution).
 *
 * These are stateless utility functions that can be tested in isolation.
 *
 * The `ctx` parameter is typed as `unknown` (with safe narrowing inside) because
 * helpers are called from many different call sites: ExtensionContext from
 * tool exec, partial ctx objects from event handlers, the writable
 * SessionManager, etc. They all expose a duck-typed `getContextUsage()`,
 * `sessionManager.getEntries()`, `sessionManager.getBranch()` shape - but
 * TypeScript can't unify them statically, so we use unknown + narrowing.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ContextProposal, ContextSnapshot } from "./types.js";
import { isProposalEntry, isSnapshotEntry } from "./types.js";
import { state } from "./state.js";

// ── Context accessors (graceful fallbacks) ──────────────────────────────────

/**
 * The minimal shape we duck-type against. Using `unknown` (with safe
 * narrowing) is more honest than `any` and prevents accidental
 * cross-callsite confusion.
 */
type ContextLike = {
    getContextUsage?: () => { percent?: number; tokens?: number } | undefined;
    sessionManager?: {
        getEntries?: () => unknown[];
        getBranch?: () => unknown[];
    };
};

/** Get current context usage as a percentage (0-100). Returns 0 on error. */
export function getContextUsage(ctx: unknown): number {
    try {
        const c = ctx as ContextLike;
        const usage = c.getContextUsage?.();
        return usage?.percent ?? 0;
    } catch {
        return 0;
    }
}

/** Get current context token count. Returns 0 on error. */
export function getContextTokens(ctx: unknown): number {
    try {
        const c = ctx as ContextLike;
        const usage = c.getContextUsage?.();
        return usage?.tokens ?? 0;
    } catch {
        return 0;
    }
}

/** Get all session entries. Returns [] on error. */
export function getAllEntries(ctx: unknown): unknown[] {
    try {
        const c = ctx as ContextLike;
        return c.sessionManager?.getEntries?.() ?? [];
    } catch {
        return [];
    }
}

/** Get current branch entries. Returns [] on error. */
export function getBranchEntries(ctx: unknown): unknown[] {
    try {
        const c = ctx as ContextLike;
        return c.sessionManager?.getBranch?.() ?? [];
    } catch {
        return [];
    }
}

// ── Entry readers (scan session entries for proposals/snapshots) ──────────

/**
 * Read all context proposals from session entries. Caches them in
 * state().proposalsByEntryId for fast lookup.
 */
export function readProposalsFromSession(entries: readonly unknown[]): ContextProposal[] {
    const proposals: ContextProposal[] = [];
    for (const raw of entries) {
        if (isProposalEntry(raw as SessionEntry)) {
            const entry = raw as SessionEntry & { details?: unknown };
            // Use details (set via appendCustomMessageEntry's 4th param)
            const data = entry.details as ContextProposal;
            if (data && data.id && data.created_at !== undefined) {
                proposals.push(data);
                state().proposalsByEntryId.set(entry.id, data);
            }
        }
    }
    return proposals;
}

/**
 * Read all context snapshots from session entries. Filters out
 * expired snapshots (expires_at <= now).
 */
export function readSnapshotsFromSession(entries: readonly unknown[]): ContextSnapshot[] {
    const now = Date.now();
    const snapshots: ContextSnapshot[] = [];
    for (const raw of entries) {
        if (isSnapshotEntry(raw as SessionEntry)) {
            // appendCustomEntry uses .data field
            const e = raw as SessionEntry & { data?: unknown };
            const data = e.data as ContextSnapshot | undefined;
            if (data && data.id && data.expires_at > now) {
                snapshots.push(data);
            }
        }
    }
    return snapshots;
}

// ── Formatting ─────────────────────────────────────────────────────────────

/** Format a duration in ms as a human-readable string. */
export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
    return `${(ms / 60000).toFixed(0)}m`;
}

/**
 * Interpolate template placeholders in a message:
 * - {percent} → current context usage %
 * - {tokens} → current context tokens (in K)
 * - {<key>}   → arbitrary signal data field
 */
export function interpolateMessage(
    message: string,
    ctx: unknown,
    signalData?: Record<string, unknown>,
): string {
    const usage = getContextUsage(ctx);
    const tokens = getContextTokens(ctx);
    let result = message.replace("{percent}", `${usage.toFixed(0)}%`);
    result = result.replace("{tokens}", `${Math.round(tokens / 1000)}K`);

    // Interpolate signal data fields (e.g., {noise}, {signal}, {count}, {density}, {token_ratio})
    if (signalData) {
        for (const [key, value] of Object.entries(signalData)) {
            result = result.replaceAll(`{${key}}`, String(value ?? ""));
        }
    }

    return result;
}
