/**
 * Routing Handler - Route to correct tools based on task intent
 *
 * Research: Routing-based enforcement directs agents to appropriate tools.
 * Uses task classification + tool recommendation.
 *
 * Design: Non-blocking routing nudge that suggests alternative/specialized tools.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type TaskIntent =
	| "exploration"      // Reading, searching, understanding
	| "implementation"  // Writing, editing code
	| "verification"    // Testing, validating
	| "refactoring"    // Improving existing code
	| "debugging"       // Finding and fixing bugs
	| "planning"        // Thinking, planning, strategizing
	| "documentation"   // Writing docs, comments
	| "unknown";        // Unclassified

interface ToolMapping {
	intent: TaskIntent;
	primaryTools: string[];
	specializedTools: string[];
	warning?: string;
}

const INTENT_TOOLS: ToolMapping[] = [
	{
		intent: "exploration",
		primaryTools: ["read", "grep", "find", "ls", "bash"],
		specializedTools: ["codebase_tree", "analyze_image"],
	},
	{
		intent: "implementation",
		primaryTools: ["write", "edit", "bash"],
		specializedTools: [],
	},
	{
		intent: "verification",
		primaryTools: ["bash"],
		specializedTools: ["repl"],
		warning: "Verify with tests, not just code review",
	},
	{
		intent: "debugging",
		primaryTools: ["grep", "read", "bash", "think"],
		specializedTools: ["repl"],
		warning: "Hypothesize before debugging - understand root cause first",
	},
	{
		intent: "refactoring",
		primaryTools: ["read", "edit", "bash"],
		specializedTools: [],
		warning: "Ensure tests pass before and after",
	},
	{
		intent: "planning",
		primaryTools: ["think", "hypothesize"],
		specializedTools: ["plan"],
		warning: "Use think() or hypothesize() to explore paths before implementing",
	},
	{
		intent: "documentation",
		primaryTools: ["write", "edit"],
		specializedTools: ["read_document"],
	},
];

// Detect intent from recent tool sequence and context
export function detectIntent(
	recentTools: string[],
	message: string,
): { intent: TaskIntent; confidence: number; reasoning: string } {
	const toolSet = new Set(recentTools);
	const msg = message.toLowerCase();

	// Count intent matches
	const scores: Record<TaskIntent, number> = {
		exploration: 0,
		implementation: 0,
		verification: 0,
		refactoring: 0,
		debugging: 0,
		planning: 0,
		documentation: 0,
		unknown: 0,
	};

	// Tool-based scoring
	for (const mapping of INTENT_TOOLS) {
		for (const tool of mapping.primaryTools) {
			if (toolSet.has(tool)) {
				scores[mapping.intent] += 2;
			}
		}
		for (const tool of mapping.specializedTools) {
			if (toolSet.has(tool)) {
				scores[mapping.intent] += 3; // Specialized tools are strong signals
			}
		}
	}

	// Message-based scoring
	const intentKeywords: Record<TaskIntent, string[]> = {
		exploration: ["find", "search", "look", "where", "how does", "what is", "understand", "explore"],
		implementation: ["write", "create", "add", "implement", "build", "make"],
		verification: ["test", "verify", "check", "run", "validate", "confirm"],
		refactoring: ["refactor", "improve", "clean", "restructure", "simplify"],
		debugging: ["bug", "fix", "error", "crash", "issue", "problem", "wrong", "broken", "debug"],
		planning: ["plan", "think", "design", "approach", "strategy", "how should"],
		documentation: ["doc", "comment", "readme", "explain", "describe", "document"],
		unknown: [],
	};

	for (const [intent, keywords] of Object.entries(intentKeywords)) {
		if (intent === "unknown") continue;
		for (const keyword of keywords) {
			if (msg.includes(keyword)) {
				scores[intent as TaskIntent] += 1;
			}
		}
	}

	// Find highest scoring intent
	let bestIntent: TaskIntent = "unknown";
	let bestScore = 0;
	for (const [intent, score] of Object.entries(scores)) {
		if (score > bestScore) {
			bestScore = score;
			bestIntent = intent as TaskIntent;
		}
	}

	// Confidence based on score
	const confidence = Math.min(0.95, bestScore * 0.15 + 0.2);
	const reasoning = `Based on ${recentTools.length} recent tools and message analysis`;

	return { intent: bestIntent, confidence, reasoning };
}

/**
 * Check if current tool is appropriate for detected intent
 */
export function checkRoutingMismatch(
	currentTool: string,
	detectedIntent: TaskIntent,
): { mismatch: boolean; suggestion: string } {
	const mapping = INTENT_TOOLS.find((m) => m.intent === detectedIntent);
	if (!mapping) {
		return { mismatch: false, suggestion: "" };
	}

	// Check if tool is in primary or specialized
	const isPrimary = mapping.primaryTools.includes(currentTool);
	const isSpecialized = mapping.specializedTools.includes(currentTool);

	if (isPrimary || isSpecialized) {
		return { mismatch: false, suggestion: "" };
	}

	// Tool doesn't match intent
	const suggestions: string[] = [];
	if (mapping.primaryTools.length > 0) {
		suggestions.push(`For ${detectedIntent}, consider: ${mapping.primaryTools.join(", ")}`);
	}
	if (mapping.warning) {
		suggestions.push(mapping.warning);
	}

	return {
		mismatch: true,
		suggestion: suggestions.join(". "),
	};
}

/**
 * Get routing hint for current context
 */
export function getRoutingHint(
	detectedIntent: TaskIntent,
	turnHistory: string[],
): string | null {
	const mapping = INTENT_TOOLS.find((m) => m.intent === detectedIntent);
	if (!mapping) return null;

	// Only suggest if no recent specialized tools used
	const recentSpecialized = turnHistory.slice(-5).filter((t) =>
		mapping.specializedTools.includes(t),
	);

	if (recentSpecialized.length > 0) {
		return null; // Already using specialized tools
	}

	// Only suggest if context is simple enough to benefit
	if (detectedIntent === "planning" && !turnHistory.includes("think")) {
		return "Planning detected - use think() or hypothesize() before implementing";
	}

	if (detectedIntent === "verification" && !turnHistory.includes("bash")) {
		return "Verification needed - run tests to confirm, not just review";
	}

	return null;
}
