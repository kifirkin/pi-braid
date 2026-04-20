// ── Context-Manager Shared State & Helpers ────────────────────────────────────
// Shared across all handler modules. Pure functions + session-scoped state.

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
	pruningState: any; // from pruning.ts — circular if typed here
}

export function getCmState(ctx: ExtensionContext): CmState {
	return getExtensionState<CmState>(ctx, "context-manager", () => ({
		checkoutParams: null,
		pruningState: null, // initialized by pruning module
	}));
}

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
		if (ctx.sessionManager.getLabel(node.entry.id) === target) {
			return node.entry.id;
		}
	}
	return target;
}

export function findByLabel(ctx: any, label: string): string | null {
	const tree = ctx.sessionManager.getTree();
	for (const node of tree) {
		if (ctx.sessionManager.getLabel(node.entry.id) === label) {
			return node.entry.id;
		}
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
	if (!targetId && branch.length > 0) {
		targetId = ctx.sessionManager.getLeafId();
	}
	return targetId;
}
