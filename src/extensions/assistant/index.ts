/**
 * Assistant Extension — Tool management patterns from pi-mono examples.
 *
 * Features:
 * - /tools: interactive tool enable/disable with fuzzy search and scrollable list
 * - /tool-status: show current tool configuration
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@mariozechner/pi-coding-agent";
import { Box, fuzzyFilter, Input, SelectItem, SelectList } from "@mariozechner/pi-tui";

const TOOLS_CONFIG_TYPE = "tools-config";

interface ToolsConfigData {
	enabledTools: string[];
	version: number;
}

export default function assistantExtension(pi: ExtensionAPI) {
	// ── /tools Command ─────────────────────────────────────────────────
	// Interactive tool enable/disable with fuzzy search and scrollable list.
	// State persisted to session so it survives reloads and branch navigation.
	let toolEnabled: Set<string> = new Set();
	let toolList: ToolInfo[] = [];
	let configVersion = 0;

	const persistToolState = () => {
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
		description: "Enable/disable tools with fuzzy search",
		handler: async (_args, ctx) => {
			toolList = pi.getAllTools();

			// Build items with enabled/disabled state in description
			const buildItems = (filter: string = ""): SelectItem[] => {
				const items: SelectItem[] = toolList.map((tool) => ({
					value: tool.name,
					label: tool.name,
					description: toolEnabled.has(tool.name) ? "enabled" : "disabled",
				}));
				if (!filter) return items;
				return fuzzyFilter(items, filter, (item) => item.label);
			};

			let currentFilter = "";
			const maxVisible = 15;

			await ctx.ui.custom(
				async (tui, _theme, _keybindings, done) => {
					// Filter input at the top
					const filterInput = new Input();
					filterInput.onSubmit = () => {
						currentFilter = filterInput.getValue();
						refreshList();
					};

					// Scrollable tool list
					let selectList = new SelectList(buildItems(""), maxVisible, {
						selectedPrefix: (t) => t,
						selectedText: (t) => t,
						description: (t) => t,
						scrollInfo: (t) => t,
						noMatch: (t) => t,
					});

					// Container for filter input + list
					const container = new Box();
					container.addChild(filterInput);
					container.addChild(selectList);

					function refreshList() {
						const newItems = buildItems(currentFilter);
						const newList = new SelectList(newItems, maxVisible, {
							selectedPrefix: (t) => t,
							selectedText: (t) => t,
							description: (t) => t,
							scrollInfo: (t) => t,
							noMatch: (t) => t,
						});
						newList.onSelect = handleSelect;
						newList.onCancel = () => done(undefined);
						container.removeChild(container.children[1]);
						container.addChild(newList);
						selectList = newList;
						selectList.invalidate();
					}

					function handleSelect(item: SelectItem) {
						// Toggle the tool
						if (toolEnabled.has(item.value)) {
							toolEnabled.delete(item.value);
						} else {
							toolEnabled.add(item.value);
						}
						applyToolState();
						persistToolState();
						ctx.ui.notify(`Tool ${item.value} ${toolEnabled.has(item.value) ? "enabled" : "disabled"}`, "info");
						// Refresh list with updated state
						refreshList();
					}

					selectList.onSelect = handleSelect;
					selectList.onCancel = () => done(undefined);

					return container;
				},
				{ overlay: true },
			);
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
