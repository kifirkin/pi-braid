// ── Context-Manager Shared State & Helpers ────────────────────────────────────
// Shared across all handler modules. Module-level singletons + session-scoped factories.

import { getExtensionState } from "../../../lib/extension-state.js";
import { createLogger } from "../../../lib/logger.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export const log = createLogger("context-manager");

// ── Internal tool detection ───────────────────────────────────────────────────
export const INTERNAL_TOOLS = new Set([
	"context_tag", "context_log", "context_checkout", "context_compress",
	"context_prune", "context_audit", "context_proposals", "context_signal",
	"think", "hypothesize", "finalize", "heuristics_evaluate", "cognition_evaluate",
	"memory_store", "memory_recall", "memory_list", "memory_get",
	"memory_episodes", "memory_heuristics", "memory_tool_stats",
	"goal", "plan", "scratchpad", "evolve",
]);

export function isInternal(toolName: string): boolean {
	return INTERNAL_TOOLS.has(toolName);
}

// ── Session-scoped state ──────────────────────────────────────────────────────
interface CmState {
	checkoutParams: { target: string; newId: string; targetId: string; backupTag?: string } | null;
	pruningState: any;
}

export function getCmState(ctx: ExtensionContext): CmState {
	return getExtensionState<CmState>(ctx, "context-manager", () => ({
		checkoutParams: null,
		pruningState: null,
	}));
}

// ── Module-level retry state (process-scoped, not session-scoped) ─────────────
export interface RetryState {
	attempt: number;
	lastError: string;
	lastReason: string;
	retryTimeout: ReturnType<typeof setTimeout> | null;
}

export const compactionRetryState: RetryState = {
	attempt: 0, lastError: "", lastReason: "", retryTimeout: null,
};

export const overflowRetryState: RetryState = {
	attempt: 0, lastError: "", lastReason: "", retryTimeout: null,
};

export const _compactedEntries = new Set<string>();

// ── Constants ─────────────────────────────────────────────────────────────────
export const COMPACTION_RETRY_MAX_ATTEMPTS = 3;
export const OVERFLOW_RETRY_MAX_ATTEMPTS = 3;
export const OVERFLOW_RETRY_KEEP_REDUCTION_FACTOR = 0.6;
export const COMPACTION_RETRY_CUSTOM_TYPE = "__compaction_retry_trigger";

// ── Navigation helpers ────────────────────────────────────────────────────────
export function resolveTarget(ctx: any, target?: string): string | null {
	if (!target) return null;
	if (target.toLowerCase() === "root") {
		const tree = ctx.sessionManager.getTree();
		return tree.length > 0 ? tree[0].entry.id : target;
	}
	if (/^[0-9a-f]{8,}$/i.test(target)) return target;
	const tree = ctx.sessionManager.getTree();
	for (const node of tree) {
		if (ctx.sessionManager.getLabel(node.entry.id) === target) return node.entry.id;
	}
	return target;
}

export function findByLabel(ctx: any, label: string): string | null {
	const tree = ctx.sessionManager.getTree();
	for (const node of tree) {
		if (ctx.sessionManager.getLabel(node.entry.id) === label) return node.entry.id;
	}
	return null;
}

export function resolveDefaultTarget(ctx: any): string | null {
	const branch = ctx.sessionManager.getBranch();
	let targetId: string | null = null;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message") {
			const msg = entry.message;
			if (msg.role === "toolResult") {
				if (!isInternal(String((msg as any).toolName ?? ""))) { targetId = entry.id; break; }
			} else if (msg.role === "assistant") {
				const hasInternal = msg.content.some(
					(c: any) => c.type === "toolCall" && isInternal(String(c.name ?? "")),
				);
				if (!hasInternal) { targetId = entry.id; break; }
			}
		}
		break;
	}
	if (!targetId && branch.length > 0) targetId = ctx.sessionManager.getLeafId();
	return targetId;
}

// ── Retry helpers ─────────────────────────────────────────────────────────────
export function resetCompactionRetry(): void {
	if (compactionRetryState.retryTimeout) clearTimeout(compactionRetryState.retryTimeout);
	compactionRetryState.attempt = 0;
	compactionRetryState.lastError = "";
	compactionRetryState.lastReason = "";
	compactionRetryState.retryTimeout = null;
}

export function resetOverflowRetry(): void {
	if (overflowRetryState.retryTimeout) clearTimeout(overflowRetryState.retryTimeout);
	overflowRetryState.attempt = 0;
	overflowRetryState.lastError = "";
	overflowRetryState.lastReason = "";
	overflowRetryState.retryTimeout = null;
}

export function getCompactionRetryDelay(attempt: number): number {
	return 3000 * Math.pow(2, attempt - 1); // 3s, 6s, 12s
}

export function getOverflowRetryDelay(attempt: number): number {
	return 2000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s
}

export function isTransientCompactionError(errorMessage?: string): boolean {
	if (!errorMessage) return false;
	const transientPatterns = [
		/529/, /overloaded/i, /rate.?limit/i, /too many requests/i,
		/server error/i, /service unavailable/i, /503/, /502/,
		/network/i, /timeout/i, /ECONNRESET/i,
	];
	return transientPatterns.some((p) => p.test(errorMessage));
}

export function formatPruneCandidates(candidates: any[], count?: number): string {
	const lines: string[] = [];
	for (let i = 0; i < (count ?? candidates.length); i++) {
		const c = candidates[i];
		if (!c) break;
		const role = c.role || "?";
		const preview = (c.preview || "").slice(0, 60);
		const reason = c.reason || "unknown";
		const age = c.age !== undefined ? `${c.age} turns` : "?";
		const score = c.score !== undefined ? `${(c.score * 100).toFixed(0)}%` : "?";
		lines.push(`${i + 1}. [${role}] ${preview} (age: ${age}, score: ${score})`);
		lines.push(`   Reason: ${reason}`);
	}
	return lines.join("\n");
}
