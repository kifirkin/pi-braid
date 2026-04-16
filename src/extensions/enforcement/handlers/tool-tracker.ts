/**
 * Tool tracking - centralized tracking logic for all tool usage patterns
 */
import { recordCodeChange as detectRecordCodeChange } from "../detection/verification.js";
import { state } from "../state.js";

/**
 * Record file paths from read/edit operations for re-read detection.
 * Called from tool_call event handler which has access to event.input.
 */
export function recordToolInput(toolName: string, input: Record<string, unknown> | undefined): void {
	if (!input) return;

	const path = (input.path as string) ?? (input.target as string) ?? "";
	if (!path) return;

	if (toolName === "read") {
		// Normalize path for comparison: resolve relative paths
		const normalized = path.startsWith("/") ? path : path;
		state.recentlyReadFiles.set(normalized, state.currentTurn);
		// Prune old entries (keep only last 50 files)
		if (state.recentlyReadFiles.size > 50) {
			const oldest = [...state.recentlyReadFiles.entries()]
				.sort((a, b) => a[1] - b[1])
				.slice(0, 10);
			for (const [k] of oldest) state.recentlyReadFiles.delete(k);
		}
	}
}

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



	// Track exploration (read, grep, find, ls)
	const exploreTools = ["read", "grep", "find", "ls"];
	if (exploreTools.includes(toolName)) {
		state.hasExplored = true;
		state.config.exploreCalledInSession = true;
		state.turnsSinceExplore = 0;
		state.exploreBeforeActNudged = false;
	}

	// Track context management tools usage
	const contextTools = ["context_tag", "context_log", "context_checkout", "context_prune", "context_audit"];
	if (contextTools.includes(toolName)) {
		state.lastContextToolCall = state.currentTurn;
		state.turnsSinceContextTool = 0;
		state.contextToolNudged = false;
	}

	// Track scratchpad usage as part of memory hygiene
	if (toolName === "scratchpad") {
		state.lastScratchpadNudgeTurn = -100; // Reset scratchpad nudge cooldown
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
