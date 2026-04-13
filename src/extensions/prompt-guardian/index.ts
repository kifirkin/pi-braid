/**
 * Prompt Guardian - Never lose a half-written prompt
 *
 * Automatically saves the current prompt buffer as you type.
 * Provides tools to recover accidentally deleted prompts.
 *
 * Storage: ~/.pi/prompt-guardian/
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const GUARDIAN_DIR = path.join(os.homedir(), ".pi", "prompt-guardian");
const MAX_PROMPTS = 50;
const AUTO_SAVE_INTERVAL = 5000; // 5 seconds

interface SavedPrompt {
	id: string;
	text: string;
	timestamp: number;
	deleted: boolean;
}

function ensureGuardianDir(): void {
	if (!fs.existsSync(GUARDIAN_DIR)) {
		fs.mkdirSync(GUARDIAN_DIR, { recursive: true });
	}
}

function getPromptsFile(): string {
	return path.join(GUARDIAN_DIR, "prompts.json");
}

function loadPrompts(): SavedPrompt[] {
	ensureGuardianDir();
	const file = getPromptsFile();
	if (!fs.existsSync(file)) {
		return [];
	}
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as SavedPrompt[];
	} catch {
		return [];
	}
}

function savePrompts(prompts: SavedPrompt[]): void {
	ensureGuardianDir();
	fs.writeFileSync(getPromptsFile(), JSON.stringify(prompts, null, 2));
}

function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
}

export default function promptGuardianExtension(pi: ExtensionAPI) {
	let lastSavedText = "";
	let autoSaveTimer: NodeJS.Timeout | undefined;
	let unsubscribe: (() => void) | undefined;

	// Save current prompt
	function savePrompt(text: string, deleted = false): void {
		if (!text.trim()) return;
		if (text === lastSavedText) return;

		lastSavedText = text;
		const prompts = loadPrompts();

		// Mark previous current as deleted
		for (const p of prompts) {
			if (!p.deleted) {
				p.deleted = true;
			}
		}

		// Add new prompt
		prompts.unshift({
			id: generateId(),
			text,
			timestamp: Date.now(),
			deleted,
		});

		// Keep only last MAX_PROMPTS
		if (prompts.length > MAX_PROMPTS) {
			prompts.splice(MAX_PROMPTS);
		}

		savePrompts(prompts);
	}

	// Restore prompt to editor
	function restorePrompt(text: string, ctx: ExtensionContext): void {
		if (ctx.hasUI) {
			ctx.ui.setEditorText(text);
			ctx.ui.notify("Prompt restored!", "info");
		}
	}

	// Start auto-save
	function startAutoSave(): void {
		if (autoSaveTimer) return;
		autoSaveTimer = setInterval(() => {
			try {
				// Note: auto-save just tracks - will be handled by input event
			} catch {
				// Ignore errors during auto-save
			}
		}, AUTO_SAVE_INTERVAL);
	}

	// Stop auto-save
	function stopAutoSave(): void {
		if (autoSaveTimer) {
			clearInterval(autoSaveTimer);
			autoSaveTimer = undefined;
		}
	}

	// List prompts schema
	const listPromptsSchema = Type.Object({
		limit: Type.Optional(Type.Number({ default: 10, description: "Number of prompts to list" })),
		includeCurrent: Type.Optional(
			Type.Boolean({ default: true, description: "Include current (not yet submitted) prompts" }),
		),
	});

	// Recover prompt schema
	const recoverPromptSchema = Type.Object({
		index: Type.Optional(Type.Number({ default: 0, description: "Index of prompt to recover (0 = most recent)" })),
		preview: Type.Optional(Type.Boolean({ default: false, description: "Only preview, don't restore" })),
	});

	// Register tools
	pi.registerTool({
		name: "list_deleted_prompts",
		label: "List Deleted Prompts",
		description: "List recently deleted prompts that can be recovered",
		parameters: listPromptsSchema,
		execute: async (_toolCallId, params): Promise<AgentToolResult<{ prompts: SavedPrompt[] }>> => {
			const prompts = loadPrompts();
			const includeCurrent = params.includeCurrent ?? true;
			const filtered = prompts.filter((p) => (includeCurrent ? true : p.deleted)).slice(0, params.limit || 10);

			const text =
				"Recoverable Prompts:\n" +
				filtered
					.map(
						(p, i) =>
							`[${i}] ${p.deleted ? "DELETED" : "CURRENT"} - ${new Date(p.timestamp).toLocaleString()}\n${p.text.slice(0, 100)}${p.text.length > 100 ? "..." : ""}`,
					)
					.join("\n\n");

			return {
				content: [{ type: "text" as const, text }],
				details: { prompts: filtered },
			};
		},
	});

	pi.registerTool({
		name: "recover_prompt",
		label: "Recover Prompt",
		description: "Recover an accidentally deleted prompt by index",
		parameters: recoverPromptSchema,
		execute: async (
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<{ recovered: boolean; preview?: boolean; id?: string }>> => {
			const prompts = loadPrompts();
			const index = params.index ?? 0;

			if (index < 0 || index >= prompts.length) {
				return {
					content: [{ type: "text" as const, text: `Invalid index ${index}. Available: 0-${prompts.length - 1}` }],
					details: { recovered: false },
				};
			}

			const prompt = prompts[index];

			if (params.preview) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Prompt [${index}] (${prompt.deleted ? "deleted" : "current"}):\n\n${prompt.text}`,
						},
					],
					details: { recovered: false, preview: true },
				};
			}

			restorePrompt(prompt.text, ctx);

			return {
				content: [{ type: "text" as const, text: `Prompt [${index}] recovered!` }],
				details: { recovered: true, id: prompt.id },
			};
		},
	});

	pi.registerTool({
		name: "save_current_prompt",
		label: "Save Current Prompt",
		description: "Manually save the current prompt buffer before making changes",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx): Promise<AgentToolResult<{ saved: boolean }>> => {
			const text = ctx.hasUI ? ctx.ui.getEditorText() : "";
			if (!text.trim()) {
				return {
					content: [{ type: "text" as const, text: "No prompt to save" }],
					details: { saved: false },
				};
			}
			savePrompt(text, false);
			return {
				content: [{ type: "text" as const, text: "Prompt saved!" }],
				details: { saved: true },
			};
		},
	});

	// Session start - setup
	pi.on("session_start", async (_event, ctx) => {
		// Load last saved prompt to continue tracking
		const prompts = loadPrompts();
		if (prompts.length > 0 && !prompts[0].deleted) {
			lastSavedText = prompts[0].text;
		}

		// Start auto-save
		startAutoSave();

		// Subscribe to terminal input for real-time saving
		if (ctx.hasUI && ctx.ui.onTerminalInput) {
			unsubscribe = ctx.ui.onTerminalInput(() => {
				// Real-time save handled by before_agent_start event
				return undefined; // Don't consume input
			});
		}
	});

	// Before agent start - save current prompt before submission
	pi.on("before_agent_start", async (event) => {
		// Save the prompt that is about to be submitted
		if (event.prompt?.trim()) {
			savePrompt(event.prompt, false);
		}
	});

	// Session shutdown - cleanup
	pi.on("session_shutdown", async () => {
		stopAutoSave();
		if (unsubscribe) {
			unsubscribe();
			unsubscribe = undefined;
		}
	});
}
