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

	// BLOCK: Finalize without memory_store
	if (toolName === "finalize") {
		const turnsSinceMemory = stateRef.currentTurn - stateRef.lastMemoryCall;
		const hasUnverifiedClaims = stateRef.claimsWithoutVerification > 0;
		const needsVerification =
			stateRef.hasCodeChanges && stateRef.verificationsDone === 0 && stateRef.totalToolCalls > 20;

		if (stateRef.config.blockFinalizeWithoutMemory && turnsSinceMemory > 5) {
			queueBlockAction(
				toolName,
				"finalize() without memory usage. Store what you learned first with memory_store(), then retry.",
			);
			return { blocked: true, reason: "Call memory_store() before finalizing" };
		}

		if (stateRef.config.enforceVerificationBeforeFinalize && needsVerification) {
			const verificationHint = stateRef.hasCodeChanges
				? "Run tests to verify: bash pytest, npm test, cargo test, etc."
				: "No code changes detected. If you modified code, run tests first.";

			queueEnforcementWhisper(
				`Finalize without verification. ` +
					`Claims/Verifications: ${stateRef.claimsWithoutVerification}/${stateRef.verificationsDone}. ` +
					verificationHint,
			);
		}

		if (hasUnverifiedClaims) {
			queueEnforcementWhisper(
				`${stateRef.claimsWithoutVerification} unverified claim(s). Run tests and verify before finalizing.`,
			);
		}
	}

	// BLOCK: Dangerous bash commands
	if (toolName === "bash" && stateRef.config.blockDangerousCommands) {
		const command = (eventInput as { command?: string } | undefined)?.command || "";
		if (isDangerousCommand(command)) {
			queueBlockAction(
				toolName,
				`Dangerous command blocked: ${command}. Break it into safer steps or use a specific path.`,
			);
			return { blocked: true, reason: `Dangerous command blocked: ${command}` };
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
