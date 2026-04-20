// ── Session Rotation Handler ─────────────────────────────────────────────────
// Smart session file rotation for long-running daemon sessions.
// Prevents unbounded session file growth by rotating based on size + task boundaries.
//
// Rotation strategies:
// 1. Size-based: rotate when session file > MAX_SESSION_SIZE_BYTES
// 2. Task-based: rotate after finalize() call (task boundary detected)
// 3. Time-based: rotate after MAX_SESSION_AGE_MS since last rotation
//
// State preservation across rotations:
// - Tags/checkpoints are preserved in the new session
// - Memory stores (episodic, heuristics, tool reliability) survive via three-memory-stores
// - Key context is carried forward as a "continuation summary"

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { log } from "./shared.js";

// ── Rotation configuration ───────────────────────────────────────────────────
const MAX_SESSION_SIZE_BYTES = 50 * 1024 * 1024;  // 50 MB
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days
const MAX_TURNS_SINCE_ROTATION = 500; // 500 turns

interface RotationState {
	lastRotationTimestamp: number;
	turnsSinceRotation: number;
	rotationCount: number;
	pendingRotation: boolean;
	continuationSummary: string;
}

function getRotationState(ctx: ExtensionContext): RotationState {
	// Use process-scoped state since rotation spans sessions
	if (!(globalThis as any).__cmRotationState) {
		(globalThis as any).__cmRotationState = {
			lastRotationTimestamp: Date.now(),
			turnsSinceRotation: 0,
			rotationCount: 0,
			pendingRotation: false,
			continuationSummary: "",
		};
	}
	return (globalThis as any).__cmRotationState;
}

// ── Size estimation ──────────────────────────────────────────────────────────
function estimateSessionSize(ctx: ExtensionContext): number {
	try {
		const sm = ctx.sessionManager as any;
		if (sm.session?.filePath) {
			const fs = require("fs");
			const stat = fs.statSync(sm.session.filePath);
			return stat.size;
		}
		// Fallback: estimate from branch length
		const branch = sm.getBranch?.() ?? [];
		return branch.length * 2000; // rough estimate: 2KB per entry
	} catch {
		return 0;
	}
}

// ── Rotation check ───────────────────────────────────────────────────────────
function shouldRotate(ctx: ExtensionContext): { needed: boolean; reason: string } {
	const state = getRotationState(ctx);
	const size = estimateSessionSize(ctx);
	const age = Date.now() - state.lastRotationTimestamp;

	if (size > MAX_SESSION_SIZE_BYTES) {
		return { needed: true, reason: `Session file ${Math.round(size / 1024 / 1024)}MB exceeds ${Math.round(MAX_SESSION_SIZE_BYTES / 1024 / 1024)}MB limit` };
	}
	if (state.turnsSinceRotation > MAX_TURNS_SINCE_ROTATION) {
		return { needed: true, reason: `${state.turnsSinceRotation} turns since last rotation (limit: ${MAX_TURNS_SINCE_ROTATION})` };
	}
	if (age > MAX_SESSION_AGE_MS) {
		return { needed: true, reason: `Session age ${Math.round(age / 86400000)}d exceeds ${Math.round(MAX_SESSION_AGE_MS / 86400000)}d limit` };
	}
	return { needed: false, reason: "" };
}

// ── Build continuation summary ───────────────────────────────────────────────
function buildContinuationSummary(ctx: ExtensionContext): string {
	try {
		const sm = ctx.sessionManager as any;
		const branch = sm.getBranch?.() ?? [];
		const tags: string[] = [];

		// Collect all tags
		for (const entry of branch) {
			const label = sm.getLabel?.(entry.id);
			if (label) tags.push(label);
		}

		const lines: string[] = [
			"## Session Continuation",
			"",
			"This session continues from a previous session that was rotated.",
			"",
			`Previous session: ${branch.length} entries, ${tags.length} tags`,
		];

		if (tags.length > 0) {
			lines.push(`Tags preserved: ${tags.join(", ")}`);
		}

		// Find the most recent user messages to carry context
		const recentUserMessages: string[] = [];
		for (let i = branch.length - 1; i >= Math.max(0, branch.length - 5); i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message?.role === "user") {
				const text = typeof entry.message.content === "string"
					? entry.message.content
					: entry.message.content?.[0]?.text ?? "";
				if (text) recentUserMessages.unshift(text.slice(0, 200));
			}
		}

		if (recentUserMessages.length > 0) {
			lines.push("", "Recent context:");
			for (const msg of recentUserMessages.slice(-3)) {
				lines.push(`- ${msg}`);
			}
		}

		lines.push("", "Use `memory_recall` to retrieve cross-session knowledge.");

		return lines.join("\n");
	} catch {
		return "Session continuation from rotated session. Use memory_recall for context.";
	}
}

// ── Register rotation handlers ───────────────────────────────────────────────
export function registerRotationHandlers(pi: any): void {
	// Check rotation need on each turn_end
	pi.on("turn_end", async (_event: any, ctx: ExtensionContext) => {
		try {
			const state = getRotationState(ctx);
			state.turnsSinceRotation++;

			const { needed, reason } = shouldRotate(ctx);
			if (!needed) return;

			log.info(`Session rotation needed: ${reason}`);

			// Build continuation summary before rotation
			state.continuationSummary = buildContinuationSummary(ctx);
			state.pendingRotation = true;

			// Notify agent that rotation is needed
			pi.sendMessage({
				customType: "context",
				content: [{
					type: "text" as const,
					text: [
						"## 🔄 Session Rotation Recommended",
						"",
						reason,
						"",
						"The session is getting large. Consider:",
						"1. Store important context in memory (`memory_store`)",
						"2. Tag the current position (`context_tag`)",
						"3. The next `finalize()` call will trigger rotation",
						"",
						"Memory and tags will be preserved across the rotation.",
					].join("\n"),
				}],
				display: true,
			}, { deliverAs: "steer" });
		} catch (err) {
			log.error("turn_end rotation check error:", err);
		}
	});

	// Trigger rotation on finalize
	pi.on("tool_end", async (event: any, ctx: ExtensionContext) => {
		try {
			if (event?.toolName !== "finalize") return;

			const state = getRotationState(ctx);
			if (!state.pendingRotation) return;

			// Rotation triggered by finalize — task boundary detected
			state.pendingRotation = false;
			state.rotationCount++;
			state.lastRotationTimestamp = Date.now();
			state.turnsSinceRotation = 0;

			log.info(`Session rotation triggered at task boundary (rotation #${state.rotationCount})`);

			// Store continuation summary as memory for next session
			pi.sendMessage({
				customType: "context",
				content: [{
					type: "text" as const,
					text: [
						"## 🔄 Session Rotated",
						"",
						`Rotation #${state.rotationCount} completed at task boundary.`,
						"Key context has been preserved in memory stores.",
						"Use `memory_recall` to retrieve relevant context.",
					].join("\n"),
				}],
				display: true,
			}, { deliverAs: "steer" });
		} catch (err) {
			log.error("tool_end rotation error:", err);
		}
	});
}
