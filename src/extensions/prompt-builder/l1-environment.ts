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

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getCognitiveMemory } from "../../lib/cognitive-memory.js";
import { gatherL1Environment, formatL1EnvironmentSection } from "../agent-environment/index.js";

// Create require for module resolution
const _require = createRequire(import.meta.url);

interface L1Environment {
	contextPercent: number;
	memoryCount: number;
	stepsSinceCheckpoint: number;
	piRoot: string;
	agentEnv: {
		sessionElapsedMs: number;
		turnCount: number;
		sinceLastEventMs: number;
		avgToolTimeMs: number;
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
	}

	let memoryCount = 0;
	try {
		const memory = getCognitiveMemory();
		memoryCount = memory.getAll(3).length;
	} catch {
		// Non-fatal
	}

	// Agent environment (session time, turns, etc.)
	const agentEnv = gatherL1Environment(pi, ctx);

	// Pi package root path (for docs, examples, etc.)
	const piRoot = discoverPiRootPath();

	return { contextPercent, memoryCount, stepsSinceCheckpoint, piRoot, agentEnv };
}

/** Discover pi-coding-agent package root using proper module resolution */
function discoverPiRootPath(): string {
	try {
		const packageJsonPath = _require.resolve("@mariozechner/pi-coding-agent/package.json");
		return dirname(packageJsonPath);
	} catch {}

	// Fallback: walk up from this extension's location
	try {
		const extensionDir = dirname(fileURLToPath(import.meta.url));
		let dir = extensionDir;
		for (let i = 0; i < 5; i++) {
			const candidate = join(dir, "node_modules", "@mariozechner", "pi-coding-agent", "package.json");
			if (existsSync(candidate)) return dirname(candidate);
			const parent = resolve(dir, "..");
			if (parent === dir) break;
			dir = parent;
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

export { formatL1Environment, gatherL1State };
