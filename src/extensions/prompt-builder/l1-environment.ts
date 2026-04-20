/**
 * L1 Environmental Awareness System - merged from agent-environment
 *
 * Combines:
 * - Agent environment: session time, turn count, last event
 * - Memory: stored cognitive memories
 * - Context: context usage percentage
 * - Pi paths: documentation locations (when discoverable)
 *
 * The native system already handles skill loading guidance.
 * Don't duplicate native sections here.
 */

import { existsSync, realpathSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getCognitiveMemory } from "../../lib/cognitive-memory.js";
import { gatherL1Environment, formatL1EnvironmentSection } from "../agent-environment/index.js";

interface L1Environment {
	contextPercent: number;
	memoryCount: number;
	stepsSinceCheckpoint: number;
	piRoot: string;
	agentEnv: {
		pid: number;
		sessionElapsedMs: number;
		turnCount: number;
		sinceLastEventMs: number;
		avgToolTimeMs: number;
		machine: {
			platform: string;
			type: string;
			hostname: string;
		};
	};
}

async function gatherL1State(pi: ExtensionAPI, ctx: ExtensionContext | undefined): Promise<L1Environment> {
	let contextPercent = 0;
	let stepsSinceCheckpoint = 0;

	try {
		const usage = ctx?.getContextUsage?.();
		if (usage) contextPercent = usage.percent ?? 0;

		const sm = ctx?.sessionManager;
		if (sm) {
			const branch = sm.getBranch();
			for (let i = branch.length - 1; i >= 0; i--) {
				const label = sm.getLabel(branch[i].id);
				if (label) {
					stepsSinceCheckpoint = branch.length - 1 - i;
					break;
				}
			}
		}
	} catch {
		// Non-fatal - missing APIs in some environments
 /* Non-fatal: memory count unavailable */
	}

	let memoryCount = 0;
	try {
		const memory = getCognitiveMemory();
		try {
			await memory.init();
		} catch { /* already initialized or init failed - non-fatal */ }
		memoryCount = memory.getAll(3).length;
	} catch {
		// Non-fatal - memory unavailable or init failed
 /* Non-fatal: memory count unavailable */
	}

	// Agent environment (session time, turns, etc.)
	const agentEnv = gatherL1Environment(pi, ctx);

	// Pi package root path (for docs, examples, etc.)
	const piRoot = discoverPiRootPath();

	// Machine info (platform, hostname) - already in agentEnv from gatherL1Environment
	// The OS is now included in agentEnv.machine

	return { contextPercent, memoryCount, stepsSinceCheckpoint, piRoot, agentEnv };
}

/**
 * Discover pi-coding-agent package root using multiple strategies.
 * This replicates the logic from pi's internal config.ts for use in extensions.
 * Handles global npm installs, linked packages, bun binaries, and local dev.
 */
function discoverPiRootPath(): string {
	// Strategy 1: Find pi binary in PATH and walk up to package.json
	// Most reliable for global installs
	try {
		const { execSync } = require("child_process");
		const piPath = execSync("which pi 2>/dev/null || echo ''", { encoding: "utf8", timeout: 5000 }).trim();
		if (piPath && existsSync(piPath)) {
			const realPath = realpathSync(piPath);
			let dir = dirname(realPath);
			for (let i = 0; i < 5; i++) {
				const pkgPath = join(dir, "package.json");
				if (existsSync(pkgPath)) {
					const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
					if (pkg.name === "@mariozechner/pi-coding-agent") {
						return dir;
					}
				}
				dir = dirname(dir);
			}
		}
	} catch {}

	// Strategy 2: Walk up from extension's location (works for local dev and linked packages)
	try {
		const extensionDir = dirname(fileURLToPath(import.meta.url));
		let dir = extensionDir;
		for (let i = 0; i < 10; i++) {
			const candidate = join(dir, "node_modules", "@mariozechner", "pi-coding-agent", "package.json");
			if (existsSync(candidate)) {
				const pkg = JSON.parse(readFileSync(candidate, "utf8"));
				if (pkg.name === "@mariozechner/pi-coding-agent") {
					return dirname(candidate);
				}
			}
			const parent = resolve(dir, "..");
			if (parent === dir) break;
			dir = parent;
		}
	} catch {}

	// Strategy 3: Check npm global prefix
	try {
		const { execSync } = require("child_process");
		const npmPrefix = execSync("npm root -g", { encoding: "utf8", timeout: 5000 }).trim();
		const candidate = join(npmPrefix, "@mariozechner", "pi-coding-agent", "package.json");
		if (existsSync(candidate)) {
			const pkg = JSON.parse(readFileSync(candidate, "utf8"));
			if (pkg.name === "@mariozechner/pi-coding-agent") {
				return dirname(candidate);
			}
		}
	} catch {}

	return "";
}

function formatL1Environment(env: L1Environment): string {
	const lines: string[] = [];

	// Time / session awareness (from agent-environment)
	lines.push(formatL1EnvironmentSection(env.agentEnv));

	// Context warning only when critical
	if (env.contextPercent > 75) {
		lines.push(`Context: ${env.contextPercent.toFixed(0)}%`);
	}

	// Memory count
	if (env.memoryCount > 0) {
		lines.push(`${env.memoryCount} prior experience(s)`);
	}

	// Checkpoint awareness
	if (env.stepsSinceCheckpoint > 20) {
		lines.push("Consider tagging context");
	}

	// Pi package root (environmental awareness)
	if (env.piRoot) {
		lines.push(`Root: ${env.piRoot}`);
	}

	return lines.join("\n");
}

/**
 * Get machine info for system prompt injection.
 * Returns OS and hostname for L1 awareness.
 */
export function getMachineInfo(): { platform: string; hostname: string; arch: string } {
	return {
		platform: process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : process.platform === "linux" ? "Linux" : process.platform,
		hostname: os.hostname(),
		arch: process.arch,
	};
}

export { formatL1Environment, gatherL1State };