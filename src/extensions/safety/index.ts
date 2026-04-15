/**
 * Safety Extension — Guardrails for dangerous operations and session safety.
 *
 * Permission gate, protected paths, dirty repo guard, auto-commit on exit.
 */

import type { ExtensionAPI, SessionMessageEntry } from "@mariozechner/pi-coding-agent";

const DANGEROUS_PATTERNS = [
	/\brm\s+(-rf?|--recursive)/i,  // rm -rf, rm -r
	/\bsudo\b/i,                     // sudo
	/\b(chmod|chown)\b.*777/i,       // chmod/chown 777
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

async function checkDirtyRepo(
	pi: ExtensionAPI,
	ctx: any,
	action: string,
): Promise<{ cancel: boolean } | undefined> {
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
	// Commits changes when the agent exits, using last assistant message as context.
	pi.on("session_shutdown", async (_event, ctx) => {
		const { stdout: status, code } = await pi.exec("git", ["status", "--porcelain"]);
		if (code !== 0 || !status.trim()) return; // No changes

		// Find last assistant message for commit context
		const entries = ctx.sessionManager.getEntries();
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

		const firstLine = lastAssistantText.split("\n")[0] || "Work in progress";
		const msg = `[pi] ${firstLine.slice(0, 50)}${firstLine.length > 50 ? "..." : ""}`;

		await pi.exec("git", ["add", "-A"]);
		const { code: commitCode } = await pi.exec("git", ["commit", "-m", msg]);

		if (commitCode === 0 && ctx.hasUI) {
			ctx.ui.notify(`Auto-committed: ${msg}`, "info");
		}
	});
}
