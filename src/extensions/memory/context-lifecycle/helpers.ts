/**
 * Helper utilities for context-lifecycle.
 *
 * Extracted from index.ts to keep the main file focused on
 * extension wiring (event handlers, tool registration, policy execution).
 *
 * These are stateless utility functions that can be tested in isolation.
 * They intentionally take `ctx: any` because they're called from many
 * different call sites with subtly different ExtensionContext shapes.
 */

import type { ContextProposal, ContextSnapshot } from "./types.js";
import { isProposalEntry, isSnapshotEntry } from "./types.js";
import { state } from "./state.js";

// ── Context accessors (graceful fallbacks) ──────────────────────────────────

/** Get current context usage as a percentage (0-100). Returns 0 on error. */
export function getContextUsage(ctx: any): number {
    try {
        const usage = ctx.getContextUsage?.();
        return usage?.percent ?? 0;
    } catch {
        return 0;
    }
}

/** Get current context token count. Returns 0 on error. */
export function getContextTokens(ctx: any): number {
    try {
        const usage = ctx.getContextUsage?.();
        return usage?.tokens ?? 0;
    } catch {
        return 0;
    }
}

/** Get all session entries. Returns [] on error. */
export function getAllEntries(ctx: any) {
    try {
        const sm = ctx.sessionManager;
        return sm.getEntries?.() ?? [];
    } catch {
        return [];
    }
}

/** Get current branch entries. Returns [] on error. */
export function getBranchEntries(ctx: any) {
    try {
        const sm = ctx.sessionManager;
        return sm.getBranch?.() ?? [];
    } catch {
        return [];
    }
}

// ── Entry readers (scan session entries for proposals/snapshots) ──────────

/**
 * Read all context proposals from session entries. Caches them in
 * state().proposalsByEntryId for fast lookup.
 */
export function readProposalsFromSession(entries: any[]): ContextProposal[] {
    const proposals: ContextProposal[] = [];
    for (const entry of entries) {
        if (isProposalEntry(entry)) {
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
export function readSnapshotsFromSession(entries: any[]): ContextSnapshot[] {
    const now = Date.now();
    const snapshots: ContextSnapshot[] = [];
    for (const entry of entries) {
        if (isSnapshotEntry(entry)) {
            // appendCustomEntry uses .data field
            const data = (entry as unknown as { data?: ContextSnapshot }).data;
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
    ctx: any,
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
