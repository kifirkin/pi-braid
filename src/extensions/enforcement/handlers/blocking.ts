/**
 * Blocking enforcement - prevents tool execution that violates patterns
 *
 * L3 signals (dangerous commands): sent directly via sendEnforcementWhisper.
 * L2 signals (soft nudges): tracked in state, bundled by index.ts turn_end.
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isDangerousCommand } from "../detection/dangerous.js";
import type { state } from "../state.js";
import { queueBlockAction, sendEnforcementWhisper } from "../whisper.js";

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
	stateRef: typeof state,
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

		if (!stateRef.config.exploreCalledInSession && !stateRef.hasExplored && !isWriteToNewFile) {
			const fileStatus =
				targetPath && fileExists(targetPath)
					? `File "${targetPath}" exists. Read it first.`
					: `No exploration done in this session.`;

			queueBlockAction(
				toolName,
				`${toolName}() without exploration. ${fileStatus} Read the file first, then retry.`,
			);
			return { blocked: true, reason: "Explore (read files) before editing" };
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

	// DANGEROUS COMMAND ENFORCEMENT: 2-stage handling
	// Stage 1: Block with warning + explicit retry instruction
	// Stage 2: Allow with L3 warning
	if (toolName === "bash") {
		const command = (eventInput as { command?: string } | undefined)?.command || "";
		if (isDangerousCommand(command)) {
			const commandHash = command.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 200);
			const wasWarnedBefore = stateRef.warnedDangerousCommands.has(commandHash);

			if (!wasWarnedBefore) {
				// Stage 1: Block
				stateRef.warnedDangerousCommands.set(commandHash, stateRef.currentTurn);
				const warningMsg =
					`⚠️ **DANGEROUS COMMAND DETECTED**\n\n` +
					`Command: \`${command}\`\n\n` +
					`This command could cause data loss or security issues.\n\n` +
					`**Before proceeding:**\n` +
					`1. Verify this is necessary and safe\n` +
					`2. Consider safer alternatives (e.g., specific paths instead of wildcards)\n` +
					`3. Back up important data if unsure\n\n` +
					`**If verified safe**, retry the command and it will be allowed.`;

				queueBlockAction(toolName, warningMsg);
				return {
					blocked: true,
					reason: "⚠️ Dangerous command blocked - review warning above. Retry if verified safe.",
				};
			} else {
				// Stage 2: L3 - dangerous command passed review, warn only
				const firstWarnedTurn = stateRef.warnedDangerousCommands.get(commandHash);
				sendEnforcementWhisper(
					pi,
					`⚠️ Running potentially dangerous command (first warned turn ${firstWarnedTurn}).\n` +
						`Command: \`${command}\`\n` +
						`Ensure you've verified this is safe.`,
				);
				return { blocked: false, reason: "" };
			}
		}
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
