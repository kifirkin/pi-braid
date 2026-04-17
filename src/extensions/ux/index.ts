/**
 * UX Extension - Convenience commands, notifications, and input transforms.
 *
 * /commands, /bookmark, /ask, /steer, /followup, /session-name,
 * native notifications, ?quick prefix, ping/time shortcuts.
 */

import type { ExtensionAPI, SlashCommandInfo } from "@mariozechner/pi-coding-agent";

// ── Native Notification ─────────────────────────────────────────────
// OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
// OSC 99: Kitty
// Windows toast: Windows Terminal (WSL)

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");
}

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
	const { execFile } = require("child_process");
	execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
}

function notify(title: string, body: string): void {
	if (process.env.WT_SESSION) {
		notifyWindows(title, body);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(title, body);
	} else {
		notifyOSC777(title, body);
	}
}

export default function uxExtension(pi: ExtensionAPI) {
	// ── Native Notifications ──────────────────────────────────────────
	// Send terminal notification when agent is done and waiting for input.
	pi.on("agent_end", async () => {
		notify("pi", "Ready for input");
	});

	// ── Input Transforms ──────────────────────────────────────────────
	// Intercept and transform user input before agent processing.
	pi.on("input", async (event, ctx) => {
		// Skip extension-injected messages
		if (event.source === "extension") {
			return { action: "continue" };
		}

		const text = event.text.trim();

		// ?quick prefix → brief response
		if (text.startsWith("?quick ")) {
			const query = text.slice(7).trim();
			if (!query) {
				ctx.ui.notify("Usage: ?quick <question>", "warning");
				return { action: "handled" };
			}
			return { action: "transform", text: `Respond briefly in 1-2 sentences: ${query}` };
		}

		// Instant responses (no LLM needed)
		if (text.toLowerCase() === "ping") {
			ctx.ui.notify("pong", "info");
			return { action: "handled" };
		}
		if (text.toLowerCase() === "time") {
			ctx.ui.notify(new Date().toLocaleString(), "info");
			return { action: "handled" };
		}

		return { action: "continue" };
	});

	// ── /ask, /steer, /followup Commands ──────────────────────────────
	// Send user messages with delivery control (trigger, steer, followUp).

	pi.registerCommand("ask", {
		description: "Send a user message to the agent (always triggers a turn)",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /ask <message>", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy. Use /steer or /followup.", "warning");
				return;
			}
			pi.sendUserMessage(args);
		},
	});

	pi.registerCommand("steer", {
		description: "Send a steering message (interrupts current processing)",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /steer <message>", "warning");
				return;
			}
			if (ctx.isIdle()) {
				pi.sendUserMessage(args);
			} else {
				pi.sendUserMessage(args, { deliverAs: "steer" });
			}
		},
	});

	pi.registerCommand("followup", {
		description: "Queue a follow-up message (waits for current processing)",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /followup <message>", "warning");
				return;
			}
			if (ctx.isIdle()) {
				pi.sendUserMessage(args);
			} else {
				pi.sendUserMessage(args, { deliverAs: "followUp" });
				ctx.ui.notify("Follow-up queued", "info");
			}
		},
	});

	// ── /commands Command ──────────────────────────────────────────────
	// List all slash commands, grouped by source (extension/prompt/skill).

	pi.registerCommand("commands", {
		description: "List available slash commands (optional: extensions|prompt|skill)",
		getArgumentCompletions: (prefix) => {
			const sources = ["extension", "prompt", "skill"];
			const filtered = sources.filter((s) => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const commands = pi.getCommands();
			const sourceFilter = args.trim() as "extension" | "prompt" | "skill" | "";
			const filtered = sourceFilter ? commands.filter((c) => c.source === sourceFilter) : commands;

			if (filtered.length === 0) {
				ctx.ui.notify(sourceFilter ? `No ${sourceFilter} commands found` : "No commands found", "info");
				return;
			}

			const formatCommand = (cmd: SlashCommandInfo): string => {
				const desc = cmd.description ? ` - ${cmd.description}` : "";
				return `/${cmd.name}${desc}`;
			};

			const items: string[] = [];
			const sources = [
				{ key: "extension", label: "Extensions" },
				{ key: "prompt", label: "Prompts" },
				{ key: "skill", label: "Skills" },
			];

			for (const { key, label } of sources) {
				const cmds = filtered.filter((c) => c.source === key);
				if (cmds.length > 0) {
					items.push(`--- ${label} ---`);
					items.push(...cmds.map(formatCommand));
				}
			}

			const selected = await ctx.ui.select("Available Commands", items);

			if (selected && !selected.startsWith("---")) {
				const cmdName = selected.split(" - ")[0].slice(1);
				const cmd = commands.find((c) => c.name === cmdName);
				if (cmd?.sourceInfo.path) {
					const showPath = await ctx.ui.confirm(cmd.name, `View source path?\n${cmd.sourceInfo.path}`);
					if (showPath) {
						ctx.ui.notify(cmd.sourceInfo.path, "info");
					}
				}
			}
		},
	});

	// ── /bookmark Command ──────────────────────────────────────────────
	// Label the last assistant message for easy navigation in /tree.

	pi.registerCommand("bookmark", {
		description: "Bookmark last message (usage: /bookmark [label])",
		handler: async (args, ctx) => {
			const label = args.trim() || `bookmark-${Date.now()}`;
			const entries = ctx.sessionManager.getEntries();

			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					pi.setLabel(entry.id, label);
					ctx.ui.notify(`Bookmarked as: ${label}`, "info");
					return;
				}
			}

			ctx.ui.notify("No assistant message to bookmark", "warning");
		},
	});

	pi.registerCommand("unbookmark", {
		description: "Remove bookmark from last labeled entry",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getEntries();
			for (let i = entries.length - 1; i >= 0; i--) {
				const label = ctx.sessionManager.getLabel(entries[i].id);
				if (label) {
					pi.setLabel(entries[i].id, undefined);
					ctx.ui.notify(`Removed bookmark: ${label}`, "info");
					return;
				}
			}
			ctx.ui.notify("No bookmarked entry found", "warning");
		},
	});

	// ── /session-name Command ──────────────────────────────────────────
	// Set or show the session's friendly name (visible in session selector).

	pi.registerCommand("session-name", {
		description: "Set or show session name (usage: /session-name [name])",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (name) {
				pi.setSessionName(name);
				ctx.ui.notify(`Session named: ${name}`, "info");
			} else {
				const current = pi.getSessionName();
				ctx.ui.notify(current ? `Session: ${current}` : "No session name set", "info");
			}
		},
	});
}
