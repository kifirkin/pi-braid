/**
 * Tool tracking - centralized tracking logic for all tool usage patterns
 */
import { recordCodeChange as detectRecordCodeChange } from "../detection/verification.js";
import { state } from "../state.js";

export function recordToolCall(toolName: string): void {
	// Track think
	if (toolName === "think") {
		state.toolChain.lastThinkCall = state.currentTurn;
		state.config.thinkCalledInSession = true;
	}

	// Track plan
	if (toolName === "plan") {
		state.toolChain.lastPlanCall = state.currentTurn;
	}

	// Track memory tool usage
	const memoryTools = ["memory_store", "memory_recall", "memory_list"];
	if (memoryTools.includes(toolName)) {
		state.lastMemoryCall = state.currentTurn;
		state.turnsSinceMemory = 0;
		state.toolCallsSinceLastMemory = 0;
		state.memoryNudgeSent = false;
		if (toolName === "memory_recall" && !state.hasRecalledOnStart) {
			state.hasRecalledOnStart = true;
		}
	}

	// Track memory_analyze_tool for analysis ratio enforcement
	if (toolName === "memory_analyze_tool") {
		state.memoryAnalysisCount++;
		state.lastAnalysisTurn = state.currentTurn;
		state.escalationCounts.memoryAnalysis = 0;
	}

	// Track memory_task_complete for task completion
	if (toolName === "memory_task_complete" || toolName === "memory_goal_achieve") {
		state.taskCompleteCount++;
		state.hasCompletedTask = true;
	}

	// Update tool analysis ratio
	if (state.totalToolCalls > 0) {
		state.toolAnalysisRatio = state.memoryAnalysisCount / state.totalToolCalls;
	}

	// Track exploration (read, grep, find, ls)
	const exploreTools = ["read", "grep", "find", "ls"];
	if (exploreTools.includes(toolName)) {
		state.hasExplored = true;
		state.config.exploreCalledInSession = true;
		state.turnsSinceExplore = 0;
		state.exploreBeforeActNudged = false;
	}

	// Track code changes (edit/write) for verification context
	if (toolName === "edit" || toolName === "write") {
		state.hasCodeChanges = true;
		detectRecordCodeChange(state.currentTurn);
	}

	// Track total tool calls
	state.totalToolCalls++;
	state.toolCallsSinceLastMemory++;

	// Track unique tools
	const actionTools = ["bash", "read", "write", "edit", "grep", "find"];
	if (actionTools.includes(toolName)) {
		state.uniqueToolsUsed.add(toolName);
	}

	// Track tool sequence patterns
	const seqKey = toolName;
	const existing = state.toolSequencePatterns.get(seqKey);
	if (existing) {
		existing.count++;
		existing.lastSeen = 0;
	} else {
		state.toolSequencePatterns.set(seqKey, { sequence: [toolName], count: 1, lastSeen: 0 });
	}
	for (const [, pattern] of state.toolSequencePatterns) {
		pattern.lastSeen++;
	}
	for (const [key, pattern] of state.toolSequencePatterns) {
		if (pattern.lastSeen > 20) {
			state.toolSequencePatterns.delete(key);
		}
	}
}

export function recordBashDetails(command: string): void {
	state.bashCalls = (state.bashCalls || 0) + 1;
	const cmd = command.toLowerCase();

	// bash with directory exploration also counts as exploration
	if (cmd.includes("ls ") || cmd === "ls" || cmd.startsWith("cd ") || cmd.includes("pwd")) {
		state.hasExplored = true;
		state.config.exploreCalledInSession = true;
	}

	// Record verification when tests are run
	if (state.config.enforceVerificationBeforeFinalize) {
		const testPatterns = [
			"pytest",
			"python -m pytest",
			"python -m unittest",
			"vitest",
			"jest",
			"npm test",
			"npx tsx",
			"npx vitest",
			"npx jest",
			"tsx",
			"mocha",
			"cargo test",
			"go test",
			"rspec",
			"phpunit",
		];
		if (testPatterns.some((p) => cmd.includes(p))) {
			state.verificationsDone++;
		}
	}
}
