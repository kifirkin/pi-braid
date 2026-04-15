/**
 * Assistant Extension — Tool management patterns from pi-mono examples.
 *
 * Features:
 * - /tools: interactive tool enable/disable via selector, state persisted to session
 * - /tool-status: show current tool configuration
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@mariozechner/pi-coding-agent";

const TOOLS_CONFIG_TYPE = "tools-config";

interface ToolsConfigData {
	enabledTools: string[];
	version: number;
}

export default function assistantExtension(pi: ExtensionAPI) {
	// ── /tools Command ─────────────────────────────────────────────────
	// Interactive tool enable/disable. State persisted to session so it survives
	// reloads and branch navigation.
	//
	// Uses version-based approach: each tools-config entry has a version number.
	// On restore, we find the entry with the highest version number (most recent).
	// Old entries accumulate in the session file but are ignored during restore.
	// During compaction, older entries are cleaned up.
	let toolEnabled: Set<string> = new Set();
	let toolList: ToolInfo[] = [];
	let configVersion = 0;

	const persistToolState = () => {
		// Increment version and append new config
		configVersion++;
		pi.appendEntry<ToolsConfigData>(TOOLS_CONFIG_TYPE, {
			enabledTools: Array.from(toolEnabled),
			version: configVersion,
		});
	};

	const applyToolState = () => {
		pi.setActiveTools(Array.from(toolEnabled));
	};

	const restoreToolState = (ctx: ExtensionContext) => {
		toolList = pi.getAllTools();

		// Find the tools-config entry with the highest version number
		let maxVersion = -1;
		let saved: string[] | undefined;

		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && (entry as any).customType === TOOLS_CONFIG_TYPE) {
				const data = (entry as any).data as ToolsConfigData | undefined;
				if (data?.enabledTools && typeof data.version === "number") {
					if (data.version > maxVersion) {
						maxVersion = data.version;
						saved = data.enabledTools;
					}
				}
			}
		}

		if (saved) {
			const names = toolList.map((t) => t.name);
			toolEnabled = new Set(saved.filter((t) => names.includes(t)));
			configVersion = maxVersion;
			applyToolState();
		} else {
			toolEnabled = new Set(pi.getActiveTools());
			configVersion = 0;
		}
	};

	pi.on("session_start", async (_event, ctx) => restoreToolState(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreToolState(ctx));

	pi.registerCommand("tools", {
		description: "Enable/disable tools interactively",
		handler: async (_args, ctx) => {
			toolList = pi.getAllTools();
			const choice = await ctx.ui.select(
				"Tool Configuration",
				toolList.map((tool) => tool.name + ": " + (toolEnabled.has(tool.name) ? "enabled" : "disabled")),
			);
			if (choice) {
				const name = choice.split(":")[0].trim();
				if (toolEnabled.has(name)) {
					toolEnabled.delete(name);
					applyToolState();
					persistToolState();
					ctx.ui.notify("Tool " + name + " disabled", "info");
				} else {
					toolEnabled.add(name);
					applyToolState();
					persistToolState();
					ctx.ui.notify("Tool " + name + " enabled", "info");
				}
			}
		},
	});

	pi.registerCommand("tool-status", {
		description: "Show current tool configuration",
		handler: async (_args, ctx) => {
			toolList = pi.getAllTools();
			const enabled = Array.from(toolEnabled);
			const disabled = toolList.map((t) => t.name).filter((n) => !enabled.includes(n));
			ctx.ui.notify(
				enabled.length + " enabled, " + disabled.length + " disabled (version " + configVersion + ")",
				"info",
			);
		},
	});
}