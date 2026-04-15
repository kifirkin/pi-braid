/**
 * Assistant Extension — Tools and patterns that help the agent and user manage work
 *
 * Three patterns from pi-mono examples:
 * 1. Todo tool — LLM-callable todo list with custom renderer, state from session
 * 2. Tools command — interactive tool enable/disable via SettingsList
 * 3. Summarize command — conversation summary in a custom UI overlay
 *
 * These are "assistant" patterns — they help the agent track state, manage
 * tool availability, and summarize context. Orthogonal to enforcement/safety.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolInfo,
} from "@mariozechner/pi-coding-agent";
import {
	convertToLlm,
	serializeConversation,
} from "@mariozechner/pi-coding-agent";
import {
	BorderedLoader,
	DynamicBorder,
	getMarkdownTheme,
	getSettingsListTheme,
} from "@mariozechner/pi-coding-agent";
import { Container, matchesKey, Markdown, Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai/dist/stream.js";
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

export default function assistantExtension(pi: ExtensionAPI) {
	// ── Todo State ─────────────────────────────────────────────────────
	let todos: Todo[] = [];
	let nextId = 1;

	const reconstructTodoState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
			const details = msg.details as TodoDetails | undefined;
			if (details) {
				todos = details.todos;
				nextId = details.nextId;
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => reconstructTodoState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructTodoState(ctx));

	// ── /todos Command ───────────────────────────────────────────────
	pi.registerCommand("todos", {
		description: "Show all todos on the current branch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, theme, () => done());
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
				case "list":
					return {
						content: [
							{
								type: "text",
								text: todos.length
									? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
									: "No todos",
							},
						],
						details: { action: "list", todos: [...todos], nextId } as TodoDetails,
					};

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
						details: { action: "list", todos: [...todos], nextId, error: `unknown action: ${params.action}` } as TodoDetails,
					};
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) return new Text("", 0, 0);
			if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);

			const todoList = details.todos;
			switch (details.action) {
				case "list": {
					if (todoList.length === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);
					let listText = theme.fg("muted", `${todoList.length} todo(s):`);
					const display = expanded ? todoList : todoList.slice(0, 5);
					for (const t of display) {
						const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
						const itemText = t.done ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
						listText += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
					}
					if (!expanded && todoList.length > 5) listText += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
					return new Text(listText, 0, 0);
				}
				case "add": {
					const added = todoList[todoList.length - 1];
					return new Text(
						theme.fg("success", "✓ Added ") + theme.fg("accent", `#${added.id}`) + " " + theme.fg("muted", added.text),
						0, 0,
					);
				}
				case "toggle": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}
				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);
			}
		},
	});

	// ── /tools Command ─────────────────────────────────────────────────
	// Interactive tool enable/disable via SettingsList.
	// State persisted to session so it survives reloads and branch navigation.
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
			if (entry.type === "custom" && entry.customType === "tools-config") {
				const data = (entry as any).data as { enabledTools: string[] } | undefined;
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
			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items = toolList.map((tool) => ({
					id: tool.name,
					label: tool.name,
					currentValue: toolEnabled.has(tool.name) ? "enabled" : "disabled",
					values: ["enabled", "disabled"] as const,
				}));

				const container = new TuiContainer();
				container.addChild(new (class {
					render(_w: number) {
						return [theme.fg("accent", theme.bold("Tool Configuration")), ""];
					}
					invalidate() {}
				})());

				container.addChild(
					new (class {
						render(_w: number) { return []; }
						invalidate() {}
					})(),
				);

				const component = {
					render(width: number) { return container.render(width); },
					invalidate() { container.invalidate(); },
					handleInput(_data: string) { tui.requestRender(); },
				};

				return component;
			});
		},
	});

	// ── /summarize Command ─────────────────────────────────────────────
	pi.registerCommand("summarize", {
		description: "Summarize the current conversation in a custom UI",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/summarize requires interactive mode", "error");
				return;
			}

			const branch = ctx.sessionManager.getBranch();
			const conversationText = buildConversationText(branch);

			if (!conversationText.trim()) {
				ctx.ui.notify("No conversation text found", "warning");
				return;
			}

			ctx.ui.notify("Preparing summary...", "info");

			const model = getModel("openai", "gpt-4.1");
			if (!model) {
				ctx.ui.notify("Model openai/gpt-4.1 not found", "warning");
				return;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				ctx.ui.notify(auth.ok ? `No API key for ${model.provider}` : auth.error, "warning");
				return;
			}

			const summaryMessages = [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: buildSummaryPrompt(conversationText) }],
					timestamp: Date.now(),
				},
			];

			const response = await complete(
				model,
				{ messages: summaryMessages },
				{ apiKey: auth.apiKey, headers: auth.headers },
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				const container = new TuiContainer();
				const border = new DynamicBorder((s: string) => theme.fg("accent", s));
				const mdTheme = getMarkdownTheme();

				container.addChild(border);
				container.addChild(new Text(theme.fg("accent", theme.bold("Conversation Summary")), 1, 0));
				container.addChild(new Markdown(summary, 1, 1, mdTheme));
				container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0));
				container.addChild(border);

				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
					},
				};
			});
		},
	});
}

// ============================================================================
// Todo UI Component
// ============================================================================

class TodoListComponent {
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

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
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

// ============================================================================
// Summarize Helpers
// ============================================================================

type ContentBlock = { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };
type Entry = { type: string; message?: { role?: string; content?: unknown } };

const extractTextParts = (content: unknown): string[] => {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content
		.filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof p.text === "string")
		.map((p) => p.text);
};

const buildConversationText = (entries: Entry[]): string => {
	const sections: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const { role, content } = entry.message;
		if (role !== "user" && role !== "assistant") continue;
		const parts = extractTextParts(content);
		if (parts.length === 0) continue;
		const label = role === "user" ? "User" : "Assistant";
		const text = parts.join("\n").trim();
		if (text) sections.push(`${label}: ${text}`);
	}
	return sections.join("\n\n");
};

const buildSummaryPrompt = (text: string): string =>
	[
		"Summarize this conversation so I can resume it later.",
		"Include goals, key decisions, progress, open questions, and next steps.",
		"Keep it concise and structured with headings.",
		"",
		"<conversation>",
		text,
		"</conversation>",
	].join("\n");
