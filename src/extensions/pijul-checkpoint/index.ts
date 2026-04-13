/**
 * Pijul Checkpoint Extension
 *
 * Creates Pijul patches at the start of each turn so you can:
 * - View full patch history of the session
 * - Surgically rewind to any previous state (un-apply specific patches)
 * - Fork with partial history
 *
 * Advantages over Git checkpoints:
 * - Patches commute (order-independent)
 * - Lighter weight (delta vs full snapshot)
 * - First-class conflict handling
 * - Agent can track its own changes
 *
 * Usage:
 * - Requires Pijul installed: cargo install pijul
 * - Creates .pijul repo in session directory
 * - Records patches at turn_start
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { homedir } from "os";
import { join } from "path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Reserved for future git-ref-like namespacing
// const REF_PREFIX = "refs/pijul-checkpoints/";
// Reserved for future checkpoint limiting
// const MAX_CHECKPOINTS = 100;

const readPijulSchema = Type.Object({
	patchHash: Type.Optional(Type.String({ description: "Patch hash prefix to show" })),
	limit: Type.Optional(Type.Number({ default: 10, description: "Max patches to show" })),
});

const applyPatchSchema = Type.Object({
	patchHash: Type.String({ description: "Patch hash to apply" }),
});

export default function pijulCheckpointExtension(pi: ExtensionAPI) {
	let isPijulAvailable = false;
	let sessionRepoPath: string | null = null;
	let sessionId: string | null = null;
	const checkpoints: Map<string, string> = new Map();

	// Check if Pijul is available
	function checkPijul(): boolean {
		try {
			execSync("pijul --version", { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	}

	// Get or create Pijul repo for this session
	async function ensureSessionRepo(cwd: string): Promise<string | null> {
		if (sessionRepoPath) return sessionRepoPath;

		// Reserved for session-specific repo if needed
		// const repoPath = join(cwd, ".pijul-session");

		try {
			// Check if already a Pijul repo
			execSync("pijul info", { cwd, stdio: "ignore" });
			sessionRepoPath = cwd;
			return cwd;
		} catch {
			// Not a Pijul repo, could initialize but let's not pollute user's repo
			// Instead, create a temporary directory for session patches
			const sessionDir = join(homedir(), ".pi", "agent", "sessions", "pijul-checkpoints");
			fs.mkdirSync(sessionDir, { recursive: true });

			try {
				execSync("pijul init", { cwd: sessionDir, stdio: "ignore" });
				sessionRepoPath = sessionDir;
				return sessionDir;
			} catch {
				return null;
			}
		}
	}

	// Record current state as a patch
	async function recordCheckpoint(message: string): Promise<string | null> {
		if (!isPijulAvailable || !sessionRepoPath) return null;

		try {
			// Add all files
			execSync("pijul add . --recursive", { cwd: sessionRepoPath, stdio: "ignore" });

			// Record the change
			const result = execSync(`pijul record -m "${message}"`, {
				cwd: sessionRepoPath,
				encoding: "utf-8",
			});

			// Extract patch hash from output
			const hashMatch = result.match(/change ([A-Z0-9]{64})/i);
			if (hashMatch) {
				return hashMatch[1].substring(0, 16); // Return short hash
			}
			return null;
		} catch (error) {
			console.error("Pijul checkpoint failed:", error);
			return null;
		}
	}

	// List patch history
	async function listPatches(limit: number = 10): Promise<string[]> {
		if (!isPijulAvailable || !sessionRepoPath) return [];

		try {
			const result = execSync(`pijul log --limit ${limit}`, {
				cwd: sessionRepoPath,
				encoding: "utf-8",
			});

			const patches: string[] = [];
			const lines = result.split("\n");
			for (const line of lines) {
				const match = line.match(/^([A-Z0-9]{16})/);
				if (match) {
					patches.push(match[1]);
				}
			}
			return patches;
		} catch {
			return [];
		}
	}

	// Unapply a specific patch (surgical rewind)
	async function unapplyPatch(patchHash: string): Promise<boolean> {
		if (!isPijulAvailable || !sessionRepoPath) return false;

		try {
			execSync(`pijul unrecord ${patchHash}`, {
				cwd: sessionRepoPath,
				encoding: "utf-8",
			});
			return true;
		} catch (error) {
			console.error("Pijul unrecord failed:", error);
			return false;
		}
	}

	// Reset to specific patch
	async function resetTo(patchHash: string): Promise<boolean> {
		if (!isPijulAvailable || !sessionRepoPath) return false;

		try {
			// Unrecord target patch
			execSync(`pijul unrecord ${patchHash}`, {
				cwd: sessionRepoPath,
				encoding: "utf-8",
			});

			// Reset working directory
			execSync("pijul checkout .", {
				cwd: sessionRepoPath,
				encoding: "utf-8",
			});

			return true;
		} catch (error) {
			console.error("Pijul reset failed:", error);
			return false;
		}
	}

	// Initialize on session start
	pi.on("session_start", async (_event, ctx) => {
		isPijulAvailable = checkPijul();

		if (!isPijulAvailable) {
			console.log("Pijul not available - checkpoint extension disabled");
			return;
		}

		sessionId = ctx.sessionManager.getSessionId();
		await ensureSessionRepo(ctx.cwd);

		// Record initial state
		if (sessionRepoPath) {
			await recordCheckpoint(`Session start: ${sessionId}`);
		}
	});

	// Record checkpoint at turn start
	pi.on("turn_start", async (event, ctx) => {
		if (!isPijulAvailable || !sessionRepoPath) return;

		const message = `Turn ${event.turnIndex}: ${ctx.cwd}`;
		const patchHash = await recordCheckpoint(message);

		if (patchHash) {
			checkpoints.set(`turn-${event.turnIndex}`, patchHash);

			if (ctx.hasUI) {
				const count = checkpoints.size;
				ctx.ui.setStatus("pijul-checkpoint", `◆ ${count} patches`);
			}
		}
	});

	// Register tools for manual interaction
	pi.registerTool({
		name: "pijul_log",
		label: "Pijul History",
		description: "View Pijul patch history for this session",
		parameters: readPijulSchema,
		execute: async (_toolCallId, params): Promise<AgentToolResult<{ count: number }>> => {
			const patches = await listPatches(params.limit || 10);

			if (patches.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No patches recorded yet." }],
					details: { count: 0 },
				};
			}

			let output = "Session Patches (newest first):\n\n";
			patches.forEach((hash, i) => {
				output += `${i + 1}. ${hash}\n`;
			});

			return {
				content: [{ type: "text" as const, text: output }],
				details: { count: patches.length },
			};
		},
	});

	pi.registerTool({
		name: "pijul_surgical_rewind",
		label: "Surgical Rewind",
		description: "Unapply a specific patch (surgical rewind)",
		parameters: applyPatchSchema,
		execute: async (_toolCallId, params): Promise<AgentToolResult<{ success: boolean }>> => {
			const success = await unapplyPatch(params.patchHash);

			if (success) {
				return {
					content: [{ type: "text" as const, text: `Successfully unapplied patch ${params.patchHash}` }],
					details: { success: true },
				};
			} else {
				return {
					content: [{ type: "text" as const, text: `Failed to unapply patch ${params.patchHash}` }],
					details: { success: false },
				};
			}
		},
	});

	pi.registerTool({
		name: "pijul_reset",
		label: "Reset to Patch",
		description: "Reset working directory to a specific patch",
		parameters: applyPatchSchema,
		execute: async (_toolCallId, params): Promise<AgentToolResult<{ success: boolean }>> => {
			const success = await resetTo(params.patchHash);

			if (success) {
				return {
					content: [{ type: "text" as const, text: `Reset to patch ${params.patchHash}` }],
					details: { success: true },
				};
			} else {
				return {
					content: [{ type: "text" as const, text: `Failed to reset to patch ${params.patchHash}` }],
					details: { success: false },
				};
			}
		},
	});
}
