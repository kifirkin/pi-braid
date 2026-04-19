/**
 * User Message Preprocessor Extension
 *
 * Cleans up user messages before sending to main LLM:
 * - Translates non-English messages to English
 * - Corrects spelling/grammar in English messages
 * - Uses utility model via ctx.getUtilityModel() (respects /utility-model setting)
 *
 * Smart content detection:
 * - Skips code-heavy messages (>30% code characters)
 * - Skips well-written English text
 * - Preserves markdown, code blocks, and formatting
 *
 * Preprocessing happens ONCE per agentic session:
 * 1. User submits input -> preprocesses -> updates editor text
 * 2. User presses enter again -> no preprocessing, text goes straight to LLM
 * 3. Session ends (agent finishes) -> preprocessing enabled for next input
 *
 * Settings:
 * - Enabled state persists to ~/.pi/agent/settings.json
 * - Other config (minLength, skipCommands, etc.) stored in memory
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Context, ImageContent, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, InputEventResult } from "@mariozechner/pi-coding-agent";

const SYSTEM_PROMPT = `You are a automatic message preprocessor. Your only task is to translate or correct the message sent by User and provide response strictly following these guidelines:

- Translate message to English if it is not already
- Correct message if it has any spelling, grammar mistakes or meaning collisions
- Preserve technical terms, code, file paths, and markdown formatting
- Keep code blocks, lists, and other structural elements intact
- Respond with only the corrected message
`;

interface PreprocessorConfig {
	enabled: boolean;
	minLength: number;
	skipCommands: boolean;
	showDiff: boolean;
	timeoutSeconds: number;
}

const DEFAULT_CONFIG: PreprocessorConfig = {
	enabled: true,
	minLength: 10,
	skipCommands: true,
	showDiff: true,
	timeoutSeconds: 180,
};

// ============================================================================
// Settings Persistence
// ============================================================================

const SETTINGS_KEY = "preprocessorEnabled";
const CONFIG_DIR = join(homedir(), ".pi", "agent");
const SETTINGS_FILE = join(CONFIG_DIR, "settings.json");

function loadGlobalSetting<T>(key: string, defaultValue: T): T {
	if (!existsSync(SETTINGS_FILE)) return defaultValue;
	try {
		const content = readFileSync(SETTINGS_FILE, "utf-8");
		const settings = JSON.parse(content);
		if (key in settings) return settings[key] as T;
	} catch {}
	return defaultValue;
}

function saveGlobalSetting<T>(key: string, value: T): void {
	let settings: Record<string, unknown> = {};
	if (existsSync(SETTINGS_FILE)) {
		try {
			settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
		} catch {}
	}
	settings[key] = value;
	if (!existsSync(CONFIG_DIR)) {
		mkdirSync(CONFIG_DIR, { recursive: true });
	}
	writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
}

// ============================================================================
// Smart Content Detection
// ============================================================================

/** Characters that indicate code content */
const CODE_CHARS = new Set("{}[]();=>+-*/|&<>@#$%^~`\\");

/** Markdown/formatting indicators to preserve */
const FORMATTING_PATTERNS = [
	/^\s*[-*+]|\n\s*[-*+]/m, // List items
	/^\s*\d+\.|\n\s*\d+\./m, // Numbered lists
	/```[\s\S]*?```/, // Code blocks
	/`[^`]+`/, // Inline code
	/^\s*#/m, // Headings
	/^\s*>\s/m, // Blockquotes
	/\|.*\|/, // Tables
];

/**
 * Check if message is code-heavy and should be skipped.
 * Returns true if >30% of non-whitespace characters are code-like.
 */
function isCodeHeavy(text: string): boolean {
	let totalChars = 0;
	let codeChars = 0;
	for (const char of text) {
		if (!/\s/.test(char)) {
			totalChars++;
			if (CODE_CHARS.has(char)) codeChars++;
		}
	}
	return totalChars > 0 && codeChars / totalChars > 0.3;
}

/**
 * Check if message contains significant markdown/formatting.
 * Returns true if message has substantial formatting that should be preserved.
 */
function hasSignificantFormatting(text: string): boolean {
	for (const pattern of FORMATTING_PATTERNS) {
		if (pattern.test(text)) return true;
	}
	return false;
}

/**
 * Check if message looks already well-written.
 * Simple heuristic: proper sentence structure, capitalization, no obvious typos.
 */
function looksWellWritten(text: string): boolean {
	// Must have multiple sentences
	const sentenceCount = (text.match(/[.!?]+\s/g) || []).length;
	if (sentenceCount < 2) return false;

	// Check for basic capitalization (sentences start with capital letters)
	const sentences = text.split(/[.!?]+\s/);
	let capitalizedCount = 0;
	for (const s of sentences) {
		const trimmed = s.trim();
		if (trimmed.length > 0 && /^[A-Z]/.test(trimmed)) capitalizedCount++;
	}
	if (capitalizedCount < sentenceCount * 0.5) return false;

	// No excessive repeated characters (common typo pattern)
	if (/(.)\1{4,}/.test(text)) return false;

	// Check for balanced brackets (common in code/formatted text)
	const brackets = { "(": 0, ")": 0, "[": 0, "]": 0, "{": 0, "}": 0 };
	for (const char of text) {
		if (char in brackets) brackets[char as keyof typeof brackets]++;
	}
	const balanced =
		brackets["("] === brackets[")"] && brackets["["] === brackets["]"] && brackets["{"] === brackets["}"];

	// If brackets are balanced and there's substantial formatting, likely well-structured
	if (balanced && hasSignificantFormatting(text)) return true;

	return false;
}

// ============================================================================
// Enhanced Diff Display
// ============================================================================

// Minimal ANSI color helpers (no external dependency)
const colors = {
	red: (text: string) => `\x1b[31m${text}\x1b[0m`,
	green: (text: string) => `\x1b[32m${text}\x1b[0m`,
	dim: (text: string) => `\x1b[2m${text}\x1b[0m`,
};

/**
 * Generate unified diff lines with change indicators.
 * Returns lines with: additions (green +), deletions (red -), unchanged.
 */
function generateDiffLines(original: string, cleaned: string): string[] {
	const lines: string[] = [];
	lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	lines.push("  Preprocessed");
	lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

	const origLines = original.split("\n");
	const cleanLines = cleaned.split("\n");

	const additions: string[] = [];
	const deletions: string[] = [];

	// Simple line-by-line diff (show first 10 lines)
	const maxLines = 10;
	for (let i = 0; i < maxLines; i++) {
		const origLine = origLines[i];
		const cleanLine = cleanLines[i];

		if (origLine === undefined && cleanLine !== undefined) {
			additions.push(cleanLine);
		} else if (cleanLine === undefined && origLine !== undefined) {
			deletions.push(origLine);
		} else if (origLine !== undefined && cleanLine !== undefined && origLine !== cleanLine) {
			deletions.push(origLine);
			additions.push(cleanLine);
		}
	}

	// Show deletions first (red -)
	for (const line of deletions.slice(0, 5)) {
		const truncated = line.length > 60 ? `${line.slice(0, 60)}…` : line;
		lines.push(`  ${colors.red("-")} ${truncated}`);
	}

	// Then additions (green +)
	for (const line of additions.slice(0, 5)) {
		const truncated = line.length > 60 ? `${line.slice(0, 60)}…` : line;
		lines.push(`  ${colors.green("+")} ${truncated}`);
	}

	// Show truncation indicator if needed
	const totalChanges = deletions.length + additions.length;
	if (deletions.length + additions.length > 10) {
		lines.push(`  ${colors.dim("…")} ${totalChanges} total changes`);
	}

	lines.push("");
	lines.push(`  ${original.length} → ${cleaned.length} chars`);
	lines.push(`  ${colors.green("✓")} Press Enter to send`);

	return lines;
}

// ============================================================================
// State
// ============================================================================

interface QueuedMessage {
	text: string;
	images?: ImageContent[];
	resolve: (result: InputEventResult) => void;
}

const state = {
	config: { ...DEFAULT_CONFIG, enabled: loadGlobalSetting(SETTINGS_KEY, DEFAULT_CONFIG.enabled) },
	preprocessedCount: 0,
	skippedCount: 0,
	errorCount: 0,
	queue: [] as QueuedMessage[],
	isProcessing: false,
	/** Text that was already preprocessed in the current agentic session */
	preprocessedText: "" as string | undefined,
	/** Whether preprocessing is temporarily disabled (after preprocessing, until agent ends) */
	preprocessingExhausted: false,
};

async function processMessage(
	original: string,
	_images: ImageContent[] | undefined,
	ctx: ExtensionContext,
	resolve: (result: InputEventResult) => void,
) {
	state.isProcessing = true;

	let model = ctx.getUtilityModel();
	ctx.ui.setStatus("preprocessor", `⏳ Preprocessing with ${model?.id ?? "no model"}...`);

	if (model?.reasoning) {
		if (ctx.model && !ctx.model.reasoning) {
			model = ctx.model;
		} else {
			const availableModels = ctx.modelRegistry.getAvailable();
			const nonReasoning = availableModels.filter((m) => !m.reasoning);
			nonReasoning.sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output));
			model = nonReasoning[0];
			if (!model) {
				state.skippedCount++;
				resolve({ action: "continue" });
				processQueue(ctx);
				return;
			}
		}
	}

	if (!model) {
		state.skippedCount++;
		resolve({ action: "continue" });
		processQueue(ctx);
		return;
	}

	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
	if (!apiKey) {
		state.skippedCount++;
		resolve({ action: "continue" });
		processQueue(ctx);
		return;
	}

	try {
		const context: Context = {
			systemPrompt: SYSTEM_PROMPT,
			messages: [{ role: "user", content: `<user_message>${original}</user_message>`, timestamp: Date.now() }],
		};

		// Race between preprocessing and timeout
		const timeoutMs = state.config.timeoutSeconds * 1000;
		const timeoutPromise = new Promise<AssistantMessage>((_, reject) => {
			setTimeout(() => reject(new Error("timeout")), timeoutMs);
		});

		// Calculate sufficient output tokens: ~1:1 with input length (4 chars/token), min 500, max 4096
		const outputTokens = Math.min(Math.max(500, Math.floor(original.length / 4)), 4096);
		const preprocessPromise = completeSimple(model as Model<Api>, context, {
			apiKey,
			maxTokens: outputTokens,
			temperature: 0.1,
		});

		let result: AssistantMessage | null = null;
		try {
			result = await Promise.race([preprocessPromise, timeoutPromise]);
		} catch (err: unknown) {
			if (err instanceof Error && err.message === "timeout") {
				state.errorCount++;
				state.skippedCount++;
				const origPreview = original.length > 100 ? `${original.slice(0, 100)}...` : original;
				ctx.ui.setStatus("preprocessor", "⏱️ Preprocessing timeout!");
				ctx.ui.notify(`Timeout on: "${origPreview}"`, "warning");
				resolve({ action: "continue" });
				processQueue(ctx);
				return;
			}
			throw err;
		}

		if (result.errorMessage) {
			state.errorCount++;
			state.skippedCount++;
			const origPreview = original.length > 100 ? `${original.slice(0, 100)}...` : original;
			ctx.ui.setStatus("preprocessor", "❌ Preprocessing error!");
			ctx.ui.notify(`Error on: "${origPreview}"`, "error");
			resolve({ action: "continue" });
			processQueue(ctx);
			return;
		}

		const textContent = result.content.filter((c): c is { type: "text"; text: string } => c.type === "text");
		let cleaned = textContent.length > 0 ? textContent[0].text.trim() : null;

		// Strip <user_message> XML tags that the LLM might echo back
		if (cleaned) {
			cleaned = cleaned
				.replace(/^<user_message>/i, "")
				.replace(/<\/user_message>$/i, "")
				.trim();
		}

		if (cleaned && cleaned !== original && cleaned.length > 0) {
			state.preprocessedCount++;
			state.preprocessingExhausted = true;
			state.preprocessedText = cleaned;

			if (state.config.showDiff) {
				const lines = generateDiffLines(original, cleaned);
				ctx.ui.setWidget("preprocessor-diff", lines, { placement: "aboveEditor" });
				setTimeout(() => {
					ctx.ui.setWidget("preprocessor-diff", undefined);
				}, 15000);
			}

			// Update editor text with cleaned version
			ctx.ui.setEditorText(cleaned);
			ctx.ui.setStatus("preprocessor", "✓ Preprocessed - press Enter to continue");

			// Return "handled" to stop the current prompt cycle.
			// User reviews the edited text in the editor and presses Enter to send it to the LLM.
			resolve({ action: "handled" });
		} else {
			state.skippedCount++;
			state.preprocessingExhausted = true;
			state.preprocessedText = original;
			// No change needed, proceed normally
			resolve({ action: "continue" });
		}
	} catch (err: unknown) {
		state.errorCount++;
		state.skippedCount++;
		const origPreview = original.length > 100 ? `${original.slice(0, 100)}...` : original;
		const errorMsg = err instanceof Error ? err.message : "Unknown error";
		ctx.ui.setStatus("preprocessor", "❌ Preprocessing error!");
		ctx.ui.notify(`Error on: "${origPreview}" - ${errorMsg}`, "error");
		resolve({ action: "continue" });
	}

	processQueue(ctx);
}

function processQueue(ctx: ExtensionContext) {
	if (state.queue.length === 0) {
		state.isProcessing = false;
		ctx.ui.setStatus("preprocessor", undefined);
		return;
	}

	const next = state.queue.shift()!;
	processMessage(next.text, next.images, ctx, next.resolve);

	if (state.queue.length > 0) {
		ctx.ui.setStatus("preprocessor", `⏳ Queue: ${state.queue.length + 1} messages...`);
	}
}

export default function userMessagePreprocessorExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "preprocessor_config",
		label: "Configure Message Preprocessor",
		description: "Configure the user message preprocessor.",
		parameters: Type.Object({
			enabled: Type.Optional(Type.Boolean()),
			minLength: Type.Optional(Type.Number()),
			skipCommands: Type.Optional(Type.Boolean()),
			showDiff: Type.Optional(Type.Boolean()),
			timeoutSeconds: Type.Optional(Type.Number()),
		}),
		execute: async (
			_toolCallId,
			params: Partial<PreprocessorConfig>,
		): Promise<AgentToolResult<{ config: PreprocessorConfig }>> => {
			if (params.enabled !== undefined) {
				state.config.enabled = params.enabled;
				saveGlobalSetting(SETTINGS_KEY, params.enabled);
			}
			if (params.minLength !== undefined) state.config.minLength = params.minLength;
			if (params.skipCommands !== undefined) state.config.skipCommands = params.skipCommands;
			if (params.showDiff !== undefined) state.config.showDiff = params.showDiff;
			if (params.timeoutSeconds !== undefined) state.config.timeoutSeconds = params.timeoutSeconds;

			return {
				content: [{ type: "text" as const, text: `Preprocessor config: ${JSON.stringify(state.config, null, 2)}` }],
				details: { config: state.config },
			};
		},
	});

	pi.registerTool({
		name: "preprocessor_stats",
		label: "Preprocessor Stats",
		description: "Get preprocessing statistics.",
		parameters: Type.Object({}),
		execute: async (): Promise<
			AgentToolResult<{ preprocessed: number; skipped: number; errors: number; queued: number }>
		> => {
			return {
				content: [
					{
						type: "text" as const,
						text: `Preprocessor Stats:\n- Preprocessed: ${state.preprocessedCount}\n- Skipped: ${state.skippedCount}\n- Errors: ${state.errorCount}\n- Queued: ${state.queue.length}`,
					},
				],
				details: {
					preprocessed: state.preprocessedCount,
					skipped: state.skippedCount,
					errors: state.errorCount,
					queued: state.queue.length,
				},
			};
		},
	});

	pi.on("input", async (event, ctx): Promise<InputEventResult> => {
		if (!state.config.enabled) {
			return { action: "continue" };
		}

		const original = event.text;

		if (original.length === 0) {
			return { action: "continue" };
		}

		if (original.length < state.config.minLength) {
			state.skippedCount++;
			return { action: "continue" };
		}

		// If preprocessing was already done in this agentic session, skip
		// This handles both unchanged preprocessed text AND user modifications
		if (state.preprocessingExhausted) {
			return { action: "continue" };
		}

		if (state.config.skipCommands && (original.startsWith("/") || original.startsWith("!"))) {
			state.skippedCount++;
			return { action: "continue" };
		}

		// Smart content detection: skip code-heavy messages
		if (isCodeHeavy(original)) {
			state.skippedCount++;
			return { action: "continue" };
		}

		// Smart content detection: skip well-written text
		if (looksWellWritten(original)) {
			state.skippedCount++;
			return { action: "continue" };
		}

		if (state.isProcessing) {
			const queuePosition = state.queue.length + 1;
			ctx.ui.setStatus("preprocessor", `⏳ Queue: ${queuePosition} messages waiting...`);

			return new Promise<InputEventResult>((resolve) => {
				state.queue.push({
					text: original,
					images: event.images,
					resolve,
				});
			});
		}

		return new Promise<InputEventResult>((resolve) => {
			processMessage(original, event.images, ctx, resolve);
		});
	});

	// Reset preprocessing state when agent finishes, so next user input
	// can be processed. This ensures preprocessing runs once per user message,
	// not on every agent turn in a conversation.
	pi.on("agent_end", async (_event, _ctx) => {
		state.preprocessingExhausted = false;
		state.preprocessedText = undefined;
	});

	pi.registerCommand("preprocessor", {
		description: "Toggle message preprocessing",
		handler: async (_args, ctx) => {
			state.config.enabled = !state.config.enabled;
			saveGlobalSetting(SETTINGS_KEY, state.config.enabled);
			ctx.ui.notify(`Message preprocessor ${state.config.enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
