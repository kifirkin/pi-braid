/**
 * Blocking enforcement - prevents tool execution that violates patterns
 */
import * as fs from "node:fs";
import { isDangerousCommand } from "../detection/dangerous.js";
import type { state } from "../state.js";
import { queueBlockAction, queueEnforcementWhisper } from "../whisper.js";

/** Result of a blocking check */
export interface BlockResult {
	blocked: boolean;
	reason: string;
}

/** Check if a tool call should be blocked based on enforcement rules */
export function checkBlocking(
	toolName: string,
	eventInput: Record<string, unknown> | undefined,
	stateRef: typeof state,
): BlockResult {
	const writeTools = ["edit", "write"];

	// Helper to check if a file exists and is readable (regular file)
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

	// WHISPER: Edit without think() ever called in session (soft nudge, not blocking)
	if (toolName === "edit" && stateRef.config.enforceThinkBeforeEdit) {
		if (!stateRef.config.thinkCalledInSession) {
			stateRef.toolChain.recentEditWithoutThink.push(stateRef.currentTurn);
			queueEnforcementWhisper(
				"Think before editing. Call think() with your observation, decision, and reason. " +
					"Proceeding with edit this time.",
			);
		}
	}

	// WHISPER: First meaningful work without memory_recall
	if (
		toolName === "edit" &&
		stateRef.config.enforceMemoryRecallOnStart &&
		!stateRef.hasRecalledOnStart &&
		!stateRef.firstWorkDone
	) {
		stateRef.firstWorkDone = true;
		queueEnforcementWhisper(
			"First code change without recalling context. Use memory_recall(), goal_list(), or scratchpad() first.",
		);
	}

	// DANGEROUS COMMAND ENFORCEMENT: 2-stage handling
	// Stage 1 (first time): Block with warning + explicit retry instruction
	// Stage 2 (subsequent): Allow with warning
	if (toolName === "bash") {
		const command = (eventInput as { command?: string } | undefined)?.command || "";
		if (isDangerousCommand(command)) {
			// Create a hash of the command for tracking (normalize whitespace)
			const commandHash = command.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 200);
			const wasWarnedBefore = stateRef.warnedDangerousCommands.has(commandHash);

			if (!wasWarnedBefore) {
				// First time: block with explicit warning + retry instruction
				stateRef.warnedDangerousCommands.set(commandHash, stateRef.currentTurn);
				const warningMsg =
					`⚠️ **DANGEROUS COMMAND DETECTED**

` +
					`Command: \`${command}\`

` +
					`This command matches patterns that could cause data loss or security issues.

` +
					`**Before proceeding, please:**
` +
					`1. Verify this is absolutely necessary and safe
` +
					`2. Consider safer alternatives (e.g., specific paths instead of wildcards)
` +
					`3. Back up important data if unsure

` +
					`**If you've verified this is safe**, retry the command and it will be allowed.

` +
					`Example safer approach: \`rm specific-file.txt\` instead of \`rm -rf *\``;
				queueBlockAction(toolName, warningMsg);
				return {
					blocked: true,
					reason: `⚠️ Dangerous command blocked — review warning above. Retry if verified safe.`,
				};
			} else {
				// Subsequent time: warn only, allow execution
				const firstWarnedTurn = stateRef.warnedDangerousCommands.get(commandHash);
				queueEnforcementWhisper(
					`⚠️ **Warning:** Running potentially dangerous command (warned at turn ${firstWarnedTurn}).
` +
					`Command: \`${command}\`
` +
					`Ensure you've verified this is safe before proceeding.`,
				);
				// Allow execution (don't block)
				return { blocked: false, reason: "" };
			}
		}
	}

	// WHISPER: Edit without plan (softer nudge)
	if (toolName === "edit" && stateRef.config.enforceHypothesisBeforeFix) {
		const turnsSincePlan = stateRef.currentTurn - stateRef.toolChain.lastPlanCall;
		if (turnsSincePlan > 3 && stateRef.config.thinkCalledInSession) {
			stateRef.toolChain.recentEditWithoutPlan.push(stateRef.currentTurn);
			queueEnforcementWhisper(
				"For complex bugs, use plan() with 2+ hypotheses from different files to avoid tunnel vision.",
			);
		}
	}

	// WHISPER: Tool diversity low
	const actionTools = ["bash", "read", "write", "edit", "grep", "find"];
	if (stateRef.totalToolCalls >= 10 && stateRef.config.enforceToolDiversity) {
		const actionToolCount = actionTools.filter((t) => stateRef.uniqueToolsUsed.has(t)).length;
		if (actionToolCount <= 2 && !stateRef.toolDiversityNudged) {
			stateRef.toolDiversityNudged = true;
			const missingTools = actionTools.filter((t) => !stateRef.uniqueToolsUsed.has(t) && t !== toolName);
			queueEnforcementWhisper(
				`Low tool diversity (${actionToolCount} types). Consider using: ${missingTools.slice(0, 3).join(", ")}`,
			);
		}
	}

	return { blocked: false, reason: "" };
}
