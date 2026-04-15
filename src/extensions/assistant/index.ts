/**
 * Assistant Extension — Tools and patterns that help the agent and user manage work
 *
 * Two patterns from pi-mono examples:
 * 1. Todo tool — LLM-callable todo list with custom renderer, state from session
 * 2. Tools command — interactive tool enable/disable via SettingsList
 *
 * Note: Summarize command excluded (requires `complete` from pi-ai).
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@mariozechner/pi-coding-agent";

import { matchesKey, Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ============================================================================
// Todo Tool
// ============================================================================

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoDetails {
	action: "list" | "add" | "toggle" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

// Minimal component interface (matches pi-tui's Component)
interface MinimalComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

class TodoListComponent implements MinimalComponent {
	private todos: Todo[];
	private theme: Theme;
	private onClose: () => void;
	private cachedLines?: string[];
	private cachedWidth?: number;

	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const lines: string[] = [];
		const th = this.theme;
		lines.push("");
		const title = th.fg("accent", " Todos ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) +
			title +
			th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(headerLine);
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(`  ${th.fg("dim", "No todos yet. Use todo tool to add some!")}`);
		} else {
			const done = this.todos.filter((t) => t.done).length;
			const total = this.todos.length;
			lines.push(`  ${th.fg("muted", `${done}/${total} completed`)}`);
			lines.push("");
			for (const todo of this.todos) {
				const check = todo.done ? th.fg("success", "✓") : th.fg("dim", "○");
				const text = todo.done ? th.fg("dim", todo.text) : th.fg("text", todo.text);
				const id = th.fg("accent", `#${todo.id}`);
				lines.push(`  ${check} ${id} ${text}`);
			}
		}
		lines.push("");
		lines.push(`  ${th.fg("dim", "Press Escape to close")}`);
		lines.push("");
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export default function assistantExtension(pi: ExtensionAPI) {
	// ── Todo State ─────────────────────────────────────────────────────
	let todos: Todo[] = [];
	let nextId = 1;

	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult") continue;
			const toolResult = msg as unknown as { toolName?: string; details?: TodoDetails };
			if (toolResult.toolName !== "todo") continue;
			if (toolResult.details) {
				todos = toolResult.details.todos;
				nextId = toolResult.details.nextId;
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// ── /todos Command ───────────────────────────────────────────────
	pi.registerCommand("todos", {
		description: "Show all todos on the current branch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				const comp = new TodoListComponent(todos, theme, () => done());
				return {
					render: (w: number) => comp.render(w),
					invalidate: () => comp.invalidate(),
					handleInput: (d: string) => comp.handleInput(d),
				} as unknown as { render(w: number): string[]; invalidate(): void; handleInput(d: string): void };
			});
		},
	});

	// ── Todo Tool ─────────────────────────────────────────────────────
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage a todo list. Actions: list, add (text), toggle (id), clear",
		parameters: TodoParams,

		async execute(_toolCallId, params) {
			switch (params.action) {
				case "list": {
					const list = todos.length
						? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
						: "No todos";
					return {
						content: [{ type: "text", text: list }],
						details: { action: "list", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: { action: "add", todos: [...todos], nextId, error: "text required" } as TodoDetails,
						};
					}
					const newTodo: Todo = { id: nextId++, text: params.text, done: false };
					todos.push(newTodo);
					return {
						content: [{ type: "text", text: `Added todo #${newTodo.id}: ${newTodo.text}` }],
						details: { action: "add", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for toggle" }],
							details: { action: "toggle", todos: [...todos], nextId, error: "id required" } as TodoDetails,
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: { action: "toggle", todos: [...todos], nextId, error: `#${params.id} not found` } as TodoDetails,
						};
					}
					todo.done = !todo.done;
					return {
						content: [{ type: "text", text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}` }],
						details: { action: "toggle", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					return {
						content: [{ type: "text", text: `Cleared ${count} todos` }],
						details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: { action: "list", todos: [...todos], nextId, error: `unknown: ${params.action}` } as TodoDetails,
					};
			}
		},

		renderCall(args: Record<string, unknown>, theme: { fg(c: string, s: string): string; bold(s: string): string }, _ctx: unknown) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", String(args.action));
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(
			result: { content: Array<{ type: string; text?: string }>; details?: TodoDetails; isError?: boolean },
			options: { expanded: boolean },
			theme: { fg(c: string, s: string): string },
			_ctx: unknown,
		) {
			const details = result.details as TodoDetails | undefined;
			if (!details) return new Text("", 0, 0);
			if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);

			switch (details.action) {
				case "list": {
					if (details.todos.length === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);
					let text = theme.fg("muted", `${details.todos.length} todo(s):`);
					const display = options.expanded ? details.todos : details.todos.slice(0, 5);
					for (const t of display) {
						const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
						const itemText = t.done ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
						text += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
					}
					if (!options.expanded && details.todos.length > 5) {
						text += `\n${theme.fg("dim", `... ${details.todos.length - 5} more`)}`;
					}
					return new Text(text, 0, 0);
				}
				case "add": {
					const added = details.todos[details.todos.length - 1];
					if (!added) return new Text("", 0, 0);
					return new Text(
						theme.fg("success", "✓ Added ") +
							theme.fg("accent", `#${added.id}`) +
							" " +
							theme.fg("muted", added.text),
						0,
						0,
					);
				}
				case "toggle": {
					const msg = result.content[0]?.text ?? "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}
				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);
				default:
					return new Text("", 0, 0);
			}
		},
	});

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
