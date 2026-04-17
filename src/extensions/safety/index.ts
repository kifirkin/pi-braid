/**
 * Safety Extension - Guardrails for dangerous operations and session safety.
 *
 * Permission gate, protected paths, dirty repo guard, auto-commit on exit.
 */

import type { ExtensionAPI, SessionMessageEntry } from "@mariozechner/pi-coding-agent";

const DANGEROUS_PATTERNS = [
	/\brm\s+(-rf?|--recursive)/i, // rm -rf, rm -r
	/\bsudo\b/i, // sudo
	/\b(chmod|chown)\b.*777/i, // chmod/chown 777
];

const PROTECTED_PATTERNS = [
	/\.env$/,
	/\.env\..+$/,
	/secrets?\.(json|yaml|yml|toml)$/i,
	/credentials?\.(json|yaml|yml|toml)$/i,
	/\/\.ssh\//,
	/\/\.aws\//,
	/\/\.gnupg\//,
];

function isDangerousCommand(command: string): boolean {
	return DANGEROUS_PATTERNS.some((p) => p.test(command));
}

function isProtectedPath(path: string): boolean {
	return PROTECTED_PATTERNS.some((p) => p.test(path));
}

async function checkDirtyRepo(pi: ExtensionAPI, ctx: any, action: string): Promise<{ cancel: boolean } | undefined> {
	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);

	if (code !== 0) return; // Not a git repo
	if (!stdout.trim()) return; // No changes

	if (!ctx.hasUI) return { cancel: true }; // Non-interactive: block by default

	const changedFiles = stdout.trim().split("\n").filter(Boolean).length;
	const choice = await ctx.ui.select(`You have ${changedFiles} uncommitted file(s). ${action} anyway?`, [
		"Yes, proceed anyway",
		"No, let me commit first",
	]);

	if (choice !== "Yes, proceed anyway") {
		ctx.ui.notify("Commit your changes first", "warning");
		return { cancel: true };
	}
}

// ── Auto-Commit Message Builder ──────────────────────────────────────────────

interface CommitContext {
	scratchpadGoal: string | null;
	scratchpadPlan: string[];
	scratchpadDecisions: string[];
	scratchpadNotes: string[];
	filesChanged: string[];
	lastAssistantText: string;
	turnCount: number;
}

async function gatherCommitContext(pi: ExtensionAPI, ctx: any): Promise<CommitContext> {
	const entries = ctx.sessionManager.getEntries();

	// Collect last assistant message
	let lastAssistantText = "";
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message" && entry.message.role === "assistant") {
			const content = entry.message.content;
			if (Array.isArray(content)) {
				lastAssistantText = content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
			}
			break;
		}
	}

	// Collect scratchpad data from session entries
	let scratchpadGoal: string | null = null;
	const scratchpadPlan: string[] = [];
	const scratchpadDecisions: string[] = [];
	const scratchpadNotes: string[] = [];

	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const content = entry.message.content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if (block.type !== "text") continue;
				const text = block.text;

				// Detect scratchpad goal references
				const goalMatch = text.match(/Goal set: (.+?)(?:\n|$)/);
				if (goalMatch && !scratchpadGoal) scratchpadGoal = goalMatch[1].trim();

				// Detect plan steps
				const planMatches = text.matchAll(/^\d+\)\s+(.+)$/gm);
				for (const m of planMatches) {
					const step = m[1].trim();
					if (step && !scratchpadPlan.includes(step)) scratchpadPlan.push(step.slice(0, 80));
				}

				// Detect decisions
				const decisionMatches = text.matchAll(/decision:?\s*(.+)/gi);
				for (const m of decisionMatches) {
					const d = m[1].trim().slice(0, 100);
					if (d && !scratchpadDecisions.includes(d)) scratchpadDecisions.push(d);
				}

				// Detect notes
				const noteMatches = text.matchAll(/note:?\s*(.+)/gi);
				for (const m of noteMatches) {
					const n = m[1].trim().slice(0, 100);
					if (n && !scratchpadNotes.includes(n)) scratchpadNotes.push(n);
				}
			}
		}
	}

	// Count turns from agent-environment (via session entries)
	let turnCount = 0;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") turnCount++;
	}

	// Get file change stats
	const { stdout } = await pi.exec("git", ["diff", "--stat", "--summary"]);
	const filesChanged: string[] = [];
	for (const line of stdout.split("\n")) {
		const m = line.match(/\s+(create|modify|delete|rename)\s+(.+)/i);
		if (m) filesChanged.push(m[2]);
	}

	return { scratchpadGoal, scratchpadPlan, scratchpadDecisions, scratchpadNotes, filesChanged, lastAssistantText, turnCount };
}

function buildCommitMessage(ctx: CommitContext): string {
	const parts: string[] = [];

	// Primary: scratchpad goal (most descriptive)
	if (ctx.scratchpadGoal) {
		const goal = ctx.scratchpadGoal.slice(0, 80);
		parts.push(`goal: ${goal}`);
	}

	// Secondary: files changed (if no goal, use this)
	if (parts.length === 0 && ctx.filesChanged.length > 0) {
		const topFiles = ctx.filesChanged.slice(0, 3);
		if (topFiles.length === 1) {
			parts.push(`file: ${topFiles[0]}`);
		} else {
			parts.push(`files: ${topFiles.join(", ")}`);
		}
	}

	// Tertiary: plan steps completed
	if (ctx.scratchpadPlan.length > 0) {
		const planLine = ctx.scratchpadPlan.slice(0, 2).join(" → ");
		if (planLine) parts.push(`plan: ${planLine}`);
	}

	// Fallback: first line of assistant message
	if (parts.length === 0 && ctx.lastAssistantText.trim()) {
		const firstLine = ctx.lastAssistantText.split("\n")[0].trim().slice(0, 80);
		if (firstLine) parts.push(firstLine);
	}

	// Fallback: generic
	if (parts.length === 0) {
		parts.push("Work in progress");
	}

	// Turn count as secondary context
	const meta = ctx.turnCount > 1 ? ` (${ctx.turnCount} turns)` : "";

	// Compose the message
	const primary = parts[0];
	const secondary = parts.slice(1).join(" | ");

	if (secondary) {
		return `[pi] ${primary} | ${secondary}${meta}`;
	}
	return `[pi] ${primary}${meta}`;
}

function formatFilesSummary(files: string[]): string {
	if (files.length === 0) return "";
	if (files.length <= 5) return ` [+${files.length} files]`;
	return ` [+${files.length} files]`;
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function safetyExtension(pi: ExtensionAPI) {
	// ── Tool Call Interceptor ──────────────────────────────────────────
	// Blocks dangerous bash commands and protects sensitive paths.
	pi.on("tool_call", async (event, ctx) => {
		const { toolName, input } = event;

		// Dangerous bash command confirmation
		if (toolName === "bash") {
			const command = (input as { command?: string })?.command ?? "";
			if (isDangerousCommand(command)) {
				if (!ctx.hasUI) {
					return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
				}
				const choice = await ctx.ui.select(
					`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`,
					["Yes", "No"],
				);
				if (choice !== "Yes") {
					return { block: true, reason: "Blocked by user" };
				}
			}
			return undefined;
		}

		// Protected path block for write/edit
		if (toolName === "write" || toolName === "edit") {
			const path = (input as { path?: string })?.path ?? "";
			if (isProtectedPath(path)) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
				}
				return { block: true, reason: `Path "${path}" is protected` };
			}
		}

		return undefined;
	});

	// ── Dirty Repo Guard ────────────────────────────────────────────────
	// Block session switch/fork when there are uncommitted changes.
	pi.on("session_before_switch", async (event, ctx) => {
		const action = event.reason === "new" ? "new session" : "switch session";
		return checkDirtyRepo(pi, ctx, action);
	});

	pi.on("session_before_fork", async (_event, ctx) => {
		return checkDirtyRepo(pi, ctx, "fork");
	});

	// ── Auto-Commit on Exit ─────────────────────────────────────────────
	// Commits changes when the agent exits, using rich context from scratchpad + session.
	pi.on("session_shutdown", async (_event, ctx) => {
		const { stdout: status, code } = await pi.exec("git", ["status", "--porcelain"]);
		if (code !== 0 || !status.trim()) return; // No changes

		// Gather rich commit context
		const commitCtx = await gatherCommitContext(pi, ctx);

		// Build meaningful commit message
		const msg = buildCommitMessage(commitCtx);
		const fileSummary = formatFilesSummary(commitCtx.filesChanged);
		const fullMsg = fileSummary ? `${msg}${fileSummary}` : msg;

		// Also get diff stat for a more informative commit body
		const { stdout: diffStat } = await pi.exec("git", ["diff", "--stat", "HEAD"]);
		const bodyLines: string[] = [];
		if (diffStat.trim()) {
			bodyLines.push("---");
			bodyLines.push("Changes:");
			for (const line of diffStat.trim().split("\n").slice(0, 10)) {
				if (line.trim()) bodyLines.push(`  ${line.trim()}`);
			}
			if (commitCtx.scratchpadGoal) {
				bodyLines.push("");
				bodyLines.push(`Goal: ${commitCtx.scratchpadGoal}`);
			}
			if (commitCtx.scratchpadDecisions.length > 0) {
				bodyLines.push("");
				bodyLines.push("Decisions:");
				for (const d of commitCtx.scratchpadDecisions.slice(0, 3)) {
					bodyLines.push(`  - ${d}`);
				}
			}
		}

		const fullBody = bodyLines.length > 0 ? `${fullMsg}\n\n${bodyLines.join("\n")}` : fullMsg;

		await pi.exec("git", ["add", "-A"]);
		const { code: commitCode } = await pi.exec("git", ["commit", "-m", fullBody]);

		if (commitCode === 0 && ctx.hasUI) {
			ctx.ui.notify(`Auto-committed: ${msg}`, "info");
		}
	});
}