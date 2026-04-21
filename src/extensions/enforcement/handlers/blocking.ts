import { createLogger } from "../../../lib/logger.js";

const log = createLogger("enforcement");
/**
 * Blocking enforcement - prevents tool execution that violates patterns
 *
 * L2 signals (soft nudges): tracked in state, bundled by index.ts turn_end.
 * 
 * Note: Dangerous command handling is in safety extension with user-facing widget.
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { EnforcementState } from "../state.js";
import { queueBlockAction } from "../whisper.js";

/** Result of a blocking check */
export interface BlockResult {
	blocked: boolean;
	reason: string;
}

/** Check if a tool call should be blocked based on enforcement rules */
export function checkBlocking(
	pi: ExtensionAPI,
	toolName: string,
	eventInput: Record<string, unknown> | undefined,
	stateRef: EnforcementState,
): BlockResult {
	const writeTools = ["edit", "write"];

	function fileExists(filePath: string): boolean {
		try {
			const stats = fs.statSync(filePath);
			return stats.isFile();
		} catch {
			return false;
		}
	}

	// BLOCK: Edit/Write without any prior exploration in session (existing files only)
	if (writeTools.includes(toolName) && stateRef.config.blockExploreBeforeWrite) {
		const targetPath = (eventInput as { path?: string } | undefined)?.path;
		const isWriteToNewFile = toolName === "write" && targetPath && !fileExists(targetPath);

		// Downgraded from block to passthrough: too noisy to force exploration.
		// Agent may already know file contents from context or prior session.
		if (!stateRef.config.exploreCalledInSession && !stateRef.hasExplored && !isWriteToNewFile) {
			return { blocked: false, reason: "explore-before-edit (downgraded)" };
		}
	}

	// L2: Edit without think() - track for Session Signals bundle
	if (toolName === "edit" && stateRef.config.enforceThinkBeforeEdit) {
		if (!stateRef.config.thinkCalledInSession) {
			stateRef.toolChain.recentEditWithoutThink.push(stateRef.currentTurn);
			// Bundled by index.ts turn_end - don't send individually
		}
	}

	// L2: First meaningful work without memory_recall - track for Session Signals bundle
	if (
		toolName === "edit" &&
		stateRef.config.enforceMemoryRecallOnStart &&
		!stateRef.hasRecalledOnStart &&
		!stateRef.firstWorkDone
	) {
		stateRef.firstWorkDone = true;
		// Bundled by index.ts turn_end - don't send individually
	}

	// L2: Edit without plan - track for Session Signals bundle
	if (toolName === "edit" && stateRef.config.enforceHypothesisBeforeFix) {
		const turnsSincePlan = stateRef.currentTurn - stateRef.toolChain.lastPlanCall;
		if (turnsSincePlan > 3 && stateRef.config.thinkCalledInSession) {
			stateRef.toolChain.recentEditWithoutPlan.push(stateRef.currentTurn);
			// Bundled by index.ts turn_end - don't send individually
		}
	}

	// L2: Tool diversity low - track for Session Signals bundle
	const actionTools = ["bash", "read", "write", "edit", "grep", "find"];
	if (stateRef.totalToolCalls >= 10 && stateRef.config.enforceToolDiversity) {
		const actionToolCount = actionTools.filter((t) => stateRef.uniqueToolsUsed.has(t)).length;
		if (actionToolCount <= 2 && !stateRef.toolDiversityNudged) {
			stateRef.toolDiversityNudged = true;
			// Bundled by index.ts turn_end - don't send individually
		}
	}

	return { blocked: false, reason: "" };
}
