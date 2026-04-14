/**
 * Memory Export - Structured memory export and lifecycle hooks
 *
 * Extracted from knowledge-vcs.ts, keeping only the Pijul-free parts:
 * - Memory → markdown export (grouped by type, sorted by utility)
 * - Lifecycle hooks (onMemoryStored, onTaskCompleted, onGoalAchieved)
 * - Tool result analysis (auto-capture patterns/errors)
 *
 * Storage: ~/.pi/memory/export/
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type CognitiveMemoryEntry, formatMemoryTimestamp, getCognitiveMemory } from "./cognitive-memory.js";

const EXPORT_DIR = path.join(os.homedir(), ".pi", "memory", "export");

const FILES = {
	patterns: "patterns.md",
	errors: "errors.md",
	insights: "insights.md",
	preferences: "preferences.md",
	goals: "goals.md",
	episodic: "episodic.md",
	semantic: "semantic.md",
	procedural: "procedural.md",
} as const;

type MemoryFileType = keyof typeof FILES;

const TYPE_TO_FILE: Record<string, MemoryFileType> = {
	insight: "insights",
	pattern: "patterns",
	preference: "preferences",
	goal: "goals",
	error: "errors",
	episodic: "episodic",
	semantic: "semantic",
	procedural: "procedural",
};

function entryToMarkdown(entry: CognitiveMemoryEntry): string {
	const tags = entry.tags.length > 0 ? `\`${entry.tags.join("`, `")}\`` : "none";
	const source = entry.source ? `\n**Source:** ${entry.source}` : "";
	const age = formatMemoryTimestamp(entry.timestamp);
	return `### ${entry.id.slice(0, 12)} (${age})\n\n${entry.content}\n\n**Tags:** ${tags} | **Utility:** ${entry.utility.toFixed(2)}${source}\n`;
}

/**
 * Export all memories to markdown files grouped by type.
 */
export function exportMemories(): { success: boolean; message: string; counts: Record<string, number> } {
	const memory = getCognitiveMemory();
	const allMemories = memory.getAll(1000);

	if (allMemories.length === 0) {
		return { success: false, message: "No memories to export", counts: {} };
	}

	if (!fs.existsSync(EXPORT_DIR)) {
		fs.mkdirSync(EXPORT_DIR, { recursive: true });
	}

	// Group by type
	const byType: Record<MemoryFileType, CognitiveMemoryEntry[]> = {
		patterns: [], errors: [], insights: [], preferences: [],
		goals: [], episodic: [], semantic: [], procedural: [],
	};

	for (const mem of allMemories) {
		const fileKey = TYPE_TO_FILE[mem.type];
		if (fileKey && fileKey in byType) {
			byType[fileKey].push(mem);
		}
	}

	const counts: Record<string, number> = {};

	for (const [type, entries] of Object.entries(byType)) {
		const filepath = path.join(EXPORT_DIR, FILES[type as MemoryFileType]);

		if (entries.length === 0) {
			if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
			continue;
		}

		entries.sort((a, b) => b.utility - a.utility);

		let content = `# ${type.charAt(0).toUpperCase() + type.slice(1)}\n\n*Exported: ${new Date().toISOString()} | ${entries.length} entries*\n\n---\n`;
		for (const entry of entries) {
			content += entryToMarkdown(entry);
		}

		fs.writeFileSync(filepath, content);
		counts[type] = entries.length;
	}

	// Summary
	const summary = `# Knowledge Export Summary\n\n**Generated:** ${new Date().toISOString()}\n**Total Memories:** ${allMemories.length}\n\n## Counts\n${Object.entries(counts).map(([t, c]) => `- ${t}: ${c}`).join("\n")}\n`;
	fs.writeFileSync(path.join(EXPORT_DIR, "summary.md"), summary);

	return {
		success: true,
		message: `Exported ${allMemories.length} memories to ${EXPORT_DIR}`,
		counts,
	};
}

/**
 * Analyze tool result and auto-capture patterns/errors into memory.
 */
export function analyzeToolResult(
	toolName: string,
	result: { success: boolean; error?: string; output?: string },
): { captured: boolean; type?: string; id?: string } {
	const memory = getCognitiveMemory();
	const trackableTools = ["edit", "write", "bash", "read"];

	if (!trackableTools.includes(toolName)) return { captured: false };

	// Capture errors
	if (!result.success && result.error) {
		try {
			const entry = memory.store(result.error.slice(0, 500), "error", {
				tags: ["tool", toolName, "auto-captured"],
				importance: 0.8,
			});
			return { captured: true, type: "error", id: entry.id };
		} catch { /* duplicate */ }
	}

	// Capture meaningful successes
	if (result.success && result.output && result.output.length > 50 && result.output.length < 500) {
		try {
			const entry = memory.store(result.output.slice(0, 500), "pattern", {
				tags: ["tool", toolName, "auto-captured"],
				importance: 0.5,
			});
			return { captured: true, type: "pattern", id: entry.id };
		} catch { /* duplicate */ }
	}

	return { captured: false };
}

/**
 * Record task completion as episodic memory.
 */
export function onTaskCompleted(task: { description?: string; success?: boolean; duration?: number }): void {
	const memory = getCognitiveMemory();
	try {
		const content = task.success
			? `Completed task: ${task.description || "unnamed"}`
			: `Failed task: ${task.description || "unnamed"}`;
		memory.store(content, task.success ? "pattern" : "error", {
			tags: ["task", task.success ? "success" : "failure"],
			importance: task.success ? 0.7 : 0.9,
		});
	} catch { /* silent */ }
}

/**
 * Record goal achievement as episodic memory.
 */
export function onGoalAchieved(goal: { description?: string }): void {
	const memory = getCognitiveMemory();
	try {
		memory.store(`Achieved goal: ${goal.description || "unnamed"}`, "episodic", {
			tags: ["goal", "achieved", "milestone"],
			importance: 0.9,
		});
	} catch { /* silent */ }
}
