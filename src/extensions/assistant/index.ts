/**
 * Assistant Extension — Tool management patterns from pi-mono examples.
 *
 * Currently:
 * - /tools: interactive tool enable/disable via selector, state persisted to session
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@mariozechner/pi-coding-agent";

export default function assistantExtension(pi: ExtensionAPI) {
	// ── /tools Command ─────────────────────────────────────────────────
	// Interactive tool enable/disable. State persisted to session so it survives
	// reloads and branch navigation.
	let toolEnabled: Set<string> = new Set();
	let toolList: ToolInfo[] = [];

	const persistToolState = () => {
		pi.appendEntry<{ enabledTools: string[] }>("tools-config", {
			enabledTools: Array.from(toolEnabled),
		});
	};

	const applyToolState = () => {
		pi.setActiveTools(Array.from(toolEnabled));
	};

	const restoreToolState = (ctx: ExtensionContext) => {
		toolList = pi.getAllTools();
		const branchEntries = ctx.sessionManager.getBranch();
		let saved: string[] | undefined;

		for (const entry of branchEntries) {
			if (entry.type === "custom" && (entry as any).customType === "tools-config") {
				const data = (entry as any).data as { enabledTools?: string[] } | undefined;
				if (data?.enabledTools) saved = data.enabledTools;
			}
		}

		if (saved) {
			const names = toolList.map((t) => t.name);
			toolEnabled = new Set(saved.filter((t) => names.includes(t)));
			applyToolState();
		} else {
			toolEnabled = new Set(pi.getActiveTools());
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
}