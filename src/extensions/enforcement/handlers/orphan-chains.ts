import { createLogger } from "../../../lib/logger.js";

const log = createLogger("enforcement");
/**
 * Orphan Chain Detector — extracted from enforcement/index.ts
 *
 * Finds reasoning chains (grouped by parent_id) with 3+ thoughts but no
 * conclusion/reflection type. Suggests the agent close the chain.
 */

import type { EnforcementState } from "../state.js";

export interface OrphanChainResult {
	count: number;
	description: string;
	suggestion: string;
}

export function detectOrphanChains(state: EnforcementState): OrphanChainResult | null {
	if (state.thoughtChains.length === 0) return null;

	// Group thoughts by root (follow parent chain to root)
	const rootMap = new Map<string, string[]>();
	for (const thought of state.thoughtChains) {
		let root = thought.parentId;
		const visited = new Set<string>();
		while (root && !visited.has(root)) {
			visited.add(root);
			const parent = state.thoughtChains.find((t) => t.id === root);
			root = parent?.parentId || null;
		}
		const chainRoot = root || thought.id;
		if (!rootMap.has(chainRoot)) rootMap.set(chainRoot, []);
		rootMap.get(chainRoot)!.push(thought.id);
	}

	// Orphan = chain with 3+ thoughts but no conclusion type
	const orphanChains: string[] = [];
	for (const [chainId, thoughtIds] of rootMap) {
		if (thoughtIds.length >= 3) {
			const hasConclusion = thoughtIds.some((id) => {
				const t = state.thoughtChains.find((tc) => tc.id === id);
				return t?.type === "conclusion" || t?.type === "reflection";
			});
			if (!hasConclusion) {
				orphanChains.push(`chain ${thoughtIds.length} thoughts (no conclusion)`);
			}
		}
	}

	if (orphanChains.length === 0) return null;

	return {
		count: orphanChains.length,
		description: orphanChains.join(", "),
		suggestion: `[chains] ${orphanChains.length} reasoning chain(s) without conclusion: ${orphanChains[0]}`,
	};
}
