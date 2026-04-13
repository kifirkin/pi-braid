/**
 * Pijul Utilities - Shared module for Pijul operations
 *
 * This module provides utilities for Pijul version control operations
 * used by both the pijul-checkpoint extension and evolve extension.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "os";
import { join } from "path";

export interface PijulCheckpoint {
	hash: string;
	message: string;
	timestamp: number;
}

export interface PijulStatus {
	available: boolean;
	repoPath: string | null;
	patchCount: number;
}

let _isAvailable: boolean | null = null;
let _repoPath: string | null = null;

/**
 * Check if Pijul is available on the system
 */
export function isPijulAvailable(): boolean {
	if (_isAvailable !== null) return _isAvailable;

	try {
		execSync("pijul --version", { stdio: "ignore" });
		_isAvailable = true;
		return true;
	} catch {
		_isAvailable = false;
		return false;
	}
}

/**
 * Get the session checkpoint repository path
 */
export function getCheckpointRepoPath(): string | null {
	return _repoPath;
}

/**
 * Initialize or get the checkpoint repository
 */
export function ensureCheckpointRepo(): string | null {
	if (_repoPath) return _repoPath;

	const sessionDir = join(homedir(), ".pi", "agent", "sessions", "pijul-checkpoints");

	try {
		if (!fs.existsSync(sessionDir)) {
			fs.mkdirSync(sessionDir, { recursive: true });
		}

		// Check if already initialized
		try {
			execSync("pijul info", { cwd: sessionDir, stdio: "ignore" });
			_repoPath = sessionDir;
			return sessionDir;
		} catch {
			// Initialize
			execSync("pijul init", { cwd: sessionDir, stdio: "ignore" });
			_repoPath = sessionDir;
			return sessionDir;
		}
	} catch {
		return null;
	}
}

/**
 * Record a checkpoint
 */
export function recordCheckpoint(message: string): string | null {
	if (!isPijulAvailable()) return null;

	const repoPath = ensureCheckpointRepo();
	if (!repoPath) return null;

	try {
		// Add all files
		execSync("pijul add . --recursive", { cwd: repoPath, stdio: "ignore" });

		// Record the change
		const result = execSync(`pijul record -m "${message}"`, {
			cwd: repoPath,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Extract patch hash from output
		const hashMatch = result.match(/change ([A-Z0-9]{64})/i);
		if (hashMatch) {
			return hashMatch[1].substring(0, 16);
		}

		// Try alternate format
		const altMatch = result.match(/([A-Z0-9]{16})/);
		if (altMatch) {
			return altMatch[1];
		}

		return null;
	} catch (error) {
		console.error("Pijul record failed:", error);
		return null;
	}
}

/**
 * List patches in the repository
 */
export function listPatches(limit: number = 10): PijulCheckpoint[] {
	if (!isPijulAvailable() || !_repoPath) return [];

	try {
		const result = execSync(`pijul log --limit ${limit}`, {
			cwd: _repoPath,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		const patches: PijulCheckpoint[] = [];
		const lines = result.split("\n");

		for (const line of lines) {
			const hashMatch = line.match(/^([A-Z0-9]{16})/);
			if (hashMatch) {
				// Try to extract message from same or nearby line
				const msgMatch = line.match(/:\s*(.+)$/);
				patches.push({
					hash: hashMatch[1],
					message: msgMatch ? msgMatch[1].trim() : "",
					timestamp: Date.now(), // Pijul doesn't provide timestamps in log
				});
			}
		}

		return patches;
	} catch {
		return [];
	}
}

/**
 * Unapply (surgically rewind) a specific patch
 */
export function unapplyPatch(patchHash: string): boolean {
	if (!isPijulAvailable() || !_repoPath) return false;

	try {
		execSync(`pijul unrecord ${patchHash}`, {
			cwd: _repoPath,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return true;
	} catch (error) {
		console.error("Pijul unrecord failed:", error);
		return false;
	}
}

/**
 * Reset to a specific patch
 */
export function resetToPatch(patchHash: string): boolean {
	if (!isPijulAvailable() || !_repoPath) return false;

	try {
		execSync(`pijul unrecord ${patchHash}`, {
			cwd: _repoPath,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		execSync("pijul checkout .", {
			cwd: _repoPath,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		return true;
	} catch (error) {
		console.error("Pijul reset failed:", error);
		return false;
	}
}

/**
 * Get the latest checkpoint
 */
export function getLatestCheckpoint(): PijulCheckpoint | null {
	const patches = listPatches(1);
	return patches.length > 0 ? patches[0] : null;
}

/**
 * Get status of Pijul system
 */
export function getPijulStatus(): PijulStatus {
	const available = isPijulAvailable();
	const patches = available ? listPatches(1) : [];

	return {
		available,
		repoPath: _repoPath,
		patchCount: patches.length > 0 ? patches.length : 0,
	};
}

/**
 * Reset internal state (for testing)
 */
export function resetPijulState(): void {
	_isAvailable = null;
	_repoPath = null;
}
