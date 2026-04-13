/**
 * Knowledge VCS - Pijul-based version control for agent knowledge
 *
 * Features:
 * - Export memory to structured markdown files
 * - Version control with Pijul (commutative, surgical rewinds)
 * - Track evolution of patterns, errors, insights
 * - Diff and history viewing
 *
 * Storage: ~/.pi/memory/knowledge/
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type CognitiveMemoryEntry, formatMemoryTimestamp, getCognitiveMemory } from "./cognitive-memory.js";

const KNOWLEDGE_DIR = path.join(os.homedir(), ".pi", "memory", "knowledge");

// Files in the knowledge repo
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

// Configuration
const AUTO_CHECKPOINT_THRESHOLD = 5; // Checkpoint every N memory stores
const AUTO_EXPORT_THRESHOLD = 10; // Export every N memory stores

// State for auto-integration
let _memoryStoreCount = 0;
let _lastCheckpointHash: string | null = null;

/**
 * Get current integration state
 */
export function getIntegrationState(): {
	memoryStoreCount: number;
	lastCheckpointHash: string | null;
	autoCheckpointThreshold: number;
	autoExportThreshold: number;
} {
	return {
		memoryStoreCount: _memoryStoreCount,
		lastCheckpointHash: _lastCheckpointHash,
		autoCheckpointThreshold: AUTO_CHECKPOINT_THRESHOLD,
		autoExportThreshold: AUTO_EXPORT_THRESHOLD,
	};
}

/**
 * Reset integration state (for testing)
 */
export function resetIntegrationState(): void {
	_memoryStoreCount = 0;
	_lastCheckpointHash = null;
}

/**
 * Ensure knowledge directory and files exist
 */
function ensureKnowledgeRepo(): boolean {
	if (!fs.existsSync(KNOWLEDGE_DIR)) {
		fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
	}

	// Initialize Pijul if not already
	try {
		const initialized = fs.existsSync(path.join(KNOWLEDGE_DIR, ".pijul"));
		if (!initialized) {
			execSync("pijul init", { cwd: KNOWLEDGE_DIR, stdio: "ignore" });
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if Pijul is available
 */
export function isPijulAvailable(): boolean {
	try {
		execSync("pijul --version", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Export a memory entry to markdown format
 */
function memoryToMarkdown(entry: CognitiveMemoryEntry): string {
	const tags = entry.tags.length > 0 ? `\`${entry.tags.join("`, `")}\`` : "";
	const source = entry.source ? `\n  **Source:** ${entry.source}` : "";
	const age = formatMemoryTimestamp(entry.timestamp);

	return `
### ${entry.id.slice(0, 12)} (${age})

${entry.content}

**Tags:** ${tags || "none"} | **Utility:** ${entry.utility.toFixed(2)}${source}
`;
}

/**
 * Export memories to markdown files grouped by type
 */
export async function exportMemories(): Promise<{ success: boolean; message: string }> {
	const memory = getCognitiveMemory();
	const allMemories = memory.getAll(1000);

	if (allMemories.length === 0) {
		return { success: false, message: "No memories to export" };
	}

	const initialized = ensureKnowledgeRepo();
	if (!initialized) {
		return { success: false, message: "Failed to initialize knowledge repo" };
	}

	// Group by type
	const byType: Record<MemoryFileType, CognitiveMemoryEntry[]> = {
		patterns: [],
		errors: [],
		insights: [],
		preferences: [],
		goals: [],
		episodic: [],
		semantic: [],
		procedural: [],
	};

	for (const mem of allMemories) {
		// Map memory type to file key (insight→insights, pattern→patterns, etc.)
		const typeToFileKey: Record<string, MemoryFileType> = {
			insight: "insights",
			pattern: "patterns",
			preference: "preferences",
			goal: "goals",
			error: "errors",
			episodic: "episodic",
			semantic: "semantic",
			procedural: "procedural",
		};
		const fileKey = typeToFileKey[mem.type];
		if (fileKey && fileKey in byType) {
			byType[fileKey].push(mem);
		}
	}

	// Write each file
	const timestamps: string[] = [];
	for (const [type, entries] of Object.entries(byType)) {
		const filename = FILES[type as MemoryFileType];
		const filepath = path.join(KNOWLEDGE_DIR, filename);

		if (entries.length === 0) {
			// Remove file if no entries
			if (fs.existsSync(filepath)) {
				fs.unlinkSync(filepath);
			}
			continue;
		}

		// Sort by utility (best first)
		entries.sort((a, b) => b.utility - a.utility);

		// Generate header
		let content = `# ${type.charAt(0).toUpperCase() + type.slice(1)}\n\n`;
		content += `*Exported: ${new Date().toISOString()} | ${entries.length} entries*\n\n---\n`;

		// Add entries
		for (const entry of entries) {
			content += memoryToMarkdown(entry);
		}

		fs.writeFileSync(filepath, content);
		timestamps.push(`${type}: ${entries.length} entries`);
	}

	// Create summary
	const summaryContent = `# Knowledge Export Summary\n\n**Generated:** ${new Date().toISOString()}\n**Total Memories:** ${allMemories.length}\n\n## Counts\n${timestamps.map((t) => `- ${t}`).join("\n")}\n`;
	fs.writeFileSync(path.join(KNOWLEDGE_DIR, "summary.md"), summaryContent);

	return {
		success: true,
		message: `Exported ${allMemories.length} memories to ${KNOWLEDGE_DIR}`,
	};
}

/**
 * Record a checkpoint in Pijul
 */
export function recordCheckpoint(message: string): { success: boolean; hash?: string; message: string } {
	if (!isPijulAvailable()) {
		return { success: false, message: "Pijul not available" };
	}

	const initialized = ensureKnowledgeRepo();
	if (!initialized) {
		return { success: false, message: "Failed to initialize knowledge repo" };
	}

	try {
		// Add all files
		execSync("pijul add .", { cwd: KNOWLEDGE_DIR, stdio: "ignore" });

		// Record
		const result = execSync(`pijul record -m "${message}"`, {
			cwd: KNOWLEDGE_DIR,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Extract hash (Pijul uses 16-char hex identifiers)
		const hashMatch = result.match(/([A-Z0-9]{16})/);
		const hash = hashMatch ? hashMatch[1] : null;

		return {
			success: true,
			hash: hash ?? undefined,
			message: `Checkpoint recorded: ${message}`,
		};
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : "Unknown error";
		return { success: false, message: `Pijul record failed: ${errMsg}` };
	}
}

/**
 * Get checkpoint history
 */
export function getHistory(limit: number = 20): Array<{ hash: string; message: string; timestamp: string }> {
	if (!isPijulAvailable() || !fs.existsSync(path.join(KNOWLEDGE_DIR, ".pijul"))) {
		return [];
	}

	try {
		const result = execSync(`pijul log --limit ${limit}`, {
			cwd: KNOWLEDGE_DIR,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		const patches: Array<{ hash: string; message: string; timestamp: string }> = [];
		const lines = result.split("\n");

		for (const line of lines) {
			const hashMatch = line.match(/^([A-Z0-9]{16})/);
			if (hashMatch) {
				patches.push({
					hash: hashMatch[1],
					message:
						line
							.replace(hashMatch[1], "")
							.replace(/^[\s:]+/, "")
							.trim() || "No message",
					timestamp: new Date().toISOString(), // Pijul log doesn't show timestamps
				});
			}
		}

		return patches;
	} catch {
		return [];
	}
}

/**
 * Show diff between current state and a checkpoint
 */
export function showDiff(sinceHash?: string): { success: boolean; diff: string } {
	if (!isPijulAvailable() || !fs.existsSync(path.join(KNOWLEDGE_DIR, ".pijul"))) {
		return { success: false, diff: "Pijul not available or repo not initialized" };
	}

	try {
		let diff: string;
		if (sinceHash) {
			diff = execSync(`pijul diff -r ${sinceHash}`, {
				cwd: KNOWLEDGE_DIR,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
		} else {
			diff = execSync("pijul diff", {
				cwd: KNOWLEDGE_DIR,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
		}
		return { success: true, diff: diff || "No changes" };
	} catch {
		return { success: false, diff: "No changes or error getting diff" };
	}
}

/**
 * Surgically rewind to a previous checkpoint
 */
export function rewindTo(hash: string): { success: boolean; message: string } {
	if (!isPijulAvailable()) {
		return { success: false, message: "Pijul not available" };
	}

	try {
		// Unrecord the patch (removes from history)
		execSync(`pijul unrecord ${hash}`, {
			cwd: KNOWLEDGE_DIR,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		return { success: true, message: `Rewound to checkpoint ${hash.slice(0, 8)}` };
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : "Unknown error";
		return { success: false, message: `Rewind failed: ${errMsg}` };
	}
}

/**
 * Get knowledge repo status
 */
export function getKnowledgeStatus(): {
	initialized: boolean;
	pijulAvailable: boolean;
	repoPath: string;
	fileCount: number;
	patchCount: number;
} {
	const pijulAvailable = isPijulAvailable();
	const repoPath = KNOWLEDGE_DIR;
	const initialized = fs.existsSync(path.join(KNOWLEDGE_DIR, ".pijul"));

	let fileCount = 0;
	let patchCount = 0;

	if (initialized) {
		// Count markdown files
		const files = fs.readdirSync(KNOWLEDGE_DIR).filter((f) => f.endsWith(".md"));
		fileCount = files.length;

		// Count patches
		if (pijulAvailable) {
			try {
				const result = execSync("pijul log --limit 100", {
					cwd: KNOWLEDGE_DIR,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				});
				patchCount = (result.match(/^[A-Z0-9]{16}/gm) || []).length;
			} catch {
				patchCount = 0;
			}
		}
	}

	return {
		initialized,
		pijulAvailable,
		repoPath,
		fileCount,
		patchCount,
	};
}

/**
 * Full export + checkpoint workflow
 */
export async function syncAndCheckpoint(message: string): Promise<{
	exported: boolean;
	committed: boolean;
	hash?: string;
	message: string;
}> {
	const exportResult = await exportMemories();
	if (!exportResult.success) {
		return {
			exported: false,
			committed: false,
			message: exportResult.message,
		};
	}

	const checkpointResult = recordCheckpoint(message);
	return {
		exported: true,
		committed: checkpointResult.success,
		hash: checkpointResult.hash,
		message: checkpointResult.message,
	};
}

// ============================================================================
// Phase 4: Auto-Integration
// ============================================================================

/**
 * Called after each memory store to track and potentially trigger auto-actions
 */
export async function onMemoryStored(): Promise<{
	shouldCheckpoint: boolean;
	shouldExport: boolean;
	reason?: string;
}> {
	_memoryStoreCount++;

	// Check if we should export
	if (_memoryStoreCount >= AUTO_EXPORT_THRESHOLD) {
		_memoryStoreCount = 0;
		await exportMemories();
		return {
			shouldCheckpoint: true,
			shouldExport: true,
			reason: `Auto-export triggered after ${AUTO_EXPORT_THRESHOLD} stores`,
		};
	}

	// Check if we should checkpoint (more frequent than export)
	if (_memoryStoreCount % AUTO_CHECKPOINT_THRESHOLD === 0) {
		return {
			shouldCheckpoint: true,
			shouldExport: false,
			reason: `Auto-checkpoint after ${AUTO_CHECKPOINT_THRESHOLD} stores`,
		};
	}

	return { shouldCheckpoint: false, shouldExport: false };
}

/**
 * Called on session end - performs final export and checkpoint
 */
export async function onSessionEnd(): Promise<{
	exported: boolean;
	committed: boolean;
	hash?: string;
	message: string;
}> {
	const timestamp = new Date().toISOString().split("T")[0];
	const result = await syncAndCheckpoint(`Session end: ${timestamp}`);
	if (result.committed) {
		_lastCheckpointHash = result.hash ?? null;
	}
	return result;
}

/**
 * Called when a task is completed - stores pattern memory
 */
export function onTaskCompleted(task: { id?: string; description?: string; duration?: number; success?: boolean }): {
	success: boolean;
	message: string;
} {
	const memory = getCognitiveMemory();

	try {
		const content = task.success
			? `Successfully completed task: ${task.description || "unnamed"}`
			: `Failed to complete task: ${task.description || "unnamed"}`;

		const importance = task.success ? 0.7 : 0.9;

		memory.store(content, task.success ? "pattern" : "error", {
			tags: ["task", task.success ? "success" : "failure"],
			importance,
			context: task.duration ? { duration: task.duration } : undefined,
		});

		return {
			success: true,
			message: `Task ${task.success ? "completed" : "failed"} stored as ${task.success ? "pattern" : "error"}`,
		};
	} catch (e) {
		return { success: false, message: `Failed to store task: ${e instanceof Error ? e.message : "Unknown"}` };
	}
}

/**
 * Called when a goal is achieved - stores goal completion pattern
 */
export function onGoalAchieved(goal: { id?: string; description?: string; subgoalCount?: number }): {
	success: boolean;
	message: string;
} {
	const memory = getCognitiveMemory();

	try {
		const content = `Achieved goal: ${goal.description || "unnamed"}`;

		memory.store(content, "episodic", {
			tags: ["goal", "achieved", "milestone"],
			importance: 0.9,
			context: {
				goalId: goal.id,
				subgoalCount: goal.subgoalCount,
			},
		});

		return { success: true, message: "Goal achievement stored" };
	} catch (e) {
		return { success: false, message: `Failed to store goal: ${e instanceof Error ? e.message : "Unknown"}` };
	}
}

/**
 * Analyze tool result and auto-capture patterns/errors
 */
export function analyzeToolResult(
	toolName: string,
	result: { success: boolean; error?: string; output?: string },
): { captured: boolean; type?: "pattern" | "error"; id?: string } {
	const memory = getCognitiveMemory();

	// Only capture from important tools
	const importantTools = ["edit", "write", "bash", "read", "grep", "find", "task", "plan", "goal"];
	if (!importantTools.includes(toolName)) {
		return { captured: false };
	}

	// Capture errors
	if (!result.success && result.error) {
		try {
			const memory_entry = memory.store(result.error.slice(0, 500), "error", {
				tags: ["tool", toolName, "auto-captured"],
				importance: 0.8,
				context: {
					error: { message: result.error },
					tool: toolName,
				},
			});
			return { captured: true, type: "error", id: memory_entry.id };
		} catch {
			// Duplicate or failed to store
		}
	}

	// Capture successful patterns (only for certain tools)
	const successPatternTools = ["edit", "write", "bash"];
	if (result.success && successPatternTools.includes(toolName)) {
		// Don't capture every success - only those with meaningful output
		if (result.output && result.output.length > 50 && result.output.length < 500) {
			try {
				const memory_entry = memory.store(result.output.slice(0, 500), "pattern", {
					tags: ["tool", toolName, "auto-captured"],
					importance: 0.5,
					context: { tool: toolName },
				});
				return { captured: true, type: "pattern", id: memory_entry.id };
			} catch {
				// Duplicate or failed
			}
		}
	}

	return { captured: false };
}

/**
 * Get session summary for memory injection
 */
export function getSessionSummary(): {
	memoryCount: number;
	patchCount: number;
	lastCheckpoint: string | null;
	sinceLastCheckpoint: number;
} {
	const status = getKnowledgeStatus();
	const state = getIntegrationState();

	return {
		memoryCount: status.fileCount,
		patchCount: status.patchCount,
		lastCheckpoint: state.lastCheckpointHash,
		sinceLastCheckpoint: state.memoryStoreCount,
	};
}
