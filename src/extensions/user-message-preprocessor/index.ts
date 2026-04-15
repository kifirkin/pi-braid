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
 * Uses `transform` action so preprocessed text flows to the agent in the same
 * input cycle. The user sees the diff widget with cleaned text, but pressing
 * Enter sends the cleaned text directly — no second submit needed.
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

	// If brackets are balanced, likely well-structured
	return balanced;
}

// ============================================================================
// State
// ============================================================================

const state = {
	config: { ...DEFAULT_CONFIG, enabled: loadGlobalSetting(SETTINGS_KEY, DEFAULT_CONFIG.enabled) },
	preprocessedCount: 0,
	skippedCount: 0,
	errorCount: 0,
	/** Last cleaned text (for diff display on submit) */
	lastCleaned: null as string | null,
	/** Last original text (for diff display on submit) */
	lastOriginal: null as string | null,
};

function clearPreprocessorWidget(ctx: ExtensionContext) {
	ctx.ui.setWidget("preprocessor-diff", undefined);
	ctx.ui.setStatus("preprocessor", undefined);
}

// ============================================================================
// Preprocessing (runs before the input event returns)
// ============================================================================

async function preprocess(
	original: string,
	_images: ImageContent[] | undefined,
	ctx: ExtensionContext,
): Promise<string | null> {
	let model = (ctx as any).getUtilityModel?.();
	if (!model) {
		state.skippedCount++;
		return null;
	}

	// If reasoning model, try to find non-reasoning model
	if (model?.reasoning) {
		if (ctx.model && !ctx.model.reasoning) {
			model = ctx.model;
		} else {
			const availableModels = ctx.modelRegistry.getAvailable();
			const nonReasoning = availableModels.filter((m) => !m.reasoning);
			nonReasoning.sort((a, b) => a.cost.input + b.cost.output - (b.cost.input + b.cost.output));
			model = nonReasoning[0];
			if (!model) {
				state.skippedCount++;
				return null;
			}
		}
	}

	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
	if (!apiKey) {
		state.skippedCount++;
		return null;
	}

	const context: Context = {
		systemPrompt: SYSTEM_PROMPT,
		messages: [{ role: "user", content: `<user_message>${original}</user_message>`, timestamp: Date.now() }],
	};

	// Race between preprocessing and timeout
	const timeoutMs = state.config.timeoutSeconds * 1000;
	const timeoutPromise = new Promise<never>((_, reject) => {
		const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
		ctx.signal?.addEventListener("abort", () => clearTimeout(t), { once: true });
	});

	// Calculate sufficient output tokens
	const outputTokens = Math.min(Math.max(500, Math.floor(original.length / 4)), 4096);
	const preprocessPromise = completeSimple(model as Model<Api>, context, {
		apiKey,
		maxTokens: outputTokens,
		temperature: 0.1,
		signal: ctx.signal,
	});

	let result: AssistantMessage | null = null;
	try {
		result = await Promise.race([preprocessPromise, timeoutPromise]);
	} catch (err: unknown) {
		if (err instanceof Error && err.message === "timeout") {
			state.errorCount++;
			ctx.ui.notify(`Preprocessing timeout on: "${original.slice(0, 80)}..."`, "warning");
			return null;
		}
		// Abort — don't show error, just return original
		if ((err as Error)?.name === "AbortError" || ctx.signal?.aborted) {
			return null;
		}
		throw err;
	}

	if (!result || result.errorMessage) {
		state.errorCount++;
		const errorMsg = result?.errorMessage ?? "Unknown error";
		ctx.ui.notify(`Preprocessing error: ${errorMsg}`, "error");
		return null;
	}

	const textContent = result.content.filter((c): c is { type: "text"; text: string } => c.type === "text");
	let cleaned = textContent.length > 0 ? textContent[0].text.trim() : null;

	// Strip <user_message> XML tags
	if (cleaned) {
		cleaned = cleaned
			.replace(/^<user_message>/i, "")
			.replace(/<\/user_message>$/i, "")
			.trim();
	}

	return cleaned && cleaned !== original && cleaned.length > 0 ? cleaned : null;
}

// ============================================================================
// Extension Registration
// ============================================================================

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
						text: `Preprocessor Stats:\n- Preprocessed: ${state.preprocessedCount}\n- Skipped: ${state.skippedCount}\n- Errors: ${state.errorCount}`,
					},
				],
				details: {
					preprocessed: state.preprocessedCount,
					skipped: state.skippedCount,
					errors: state.errorCount,
					queued: 0,
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

		if (original.startsWith("/") || original.startsWith("!")) {
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

		// Run preprocessing — await result and return transform
		ctx.ui.setStatus("preprocessor", `Preprocessing...`);
		ctx.ui.setWidget("preprocessor-diff", undefined);

		try {
			const cleaned = await preprocess(original, event.images, ctx);
			clearPreprocessorWidget(ctx);

			if (cleaned) {
				state.preprocessedCount++;
				state.lastOriginal = original;
				state.lastCleaned = cleaned;

				if (state.config.showDiff) {
					const diffLines = generateDiffLines(original, cleaned);
					ctx.ui.setWidget("preprocessor-diff", diffLines, { placement: "aboveEditor" });
					// Auto-clear diff after 15s
					setTimeout(() => {
						if (state.lastCleaned === cleaned) {
							ctx.ui.setWidget("preprocessor-diff", undefined);
						}
					}, 15000);
				}

				// Use transform — the cleaned text goes to the agent in the same submit cycle.
				// The UX extension's input handler runs after this and returns "continue"
				// for non-special messages, so the transform is applied and flow continues.
				return { action: "transform", text: cleaned };
			} else {
				state.skippedCount++;
				return { action: "continue" };
			}
		} catch (err: unknown) {
			clearPreprocessorWidget(ctx);
			state.errorCount++;
			if ((err as Error)?.name !== "AbortError") {
				const errorMsg = err instanceof Error ? err.message : "Unknown error";
				ctx.ui.notify(`Preprocessor error: ${errorMsg}`, "error");
			}
			return { action: "continue" };
		}
	});

	// Reset on session start
	pi.on("session_start", async (_event, _ctx) => {
		state.lastCleaned = null;
		state.lastOriginal = null;
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

// ============================================================================
// Diff Display (minimal ANSI helpers)
// ============================================================================

const colors = {
	red: (text: string) => `\x1b[31m${text}\x1b[0m`,
	green: (text: string) => `\x1b[32m${text}\x1b[0m`,
	dim: (text: string) => `\x1b[2m${text}\x1b[0m`,
};

function generateDiffLines(original: string, cleaned: string): string[] {
	const lines: string[] = [];
	lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	lines.push("  Preprocessed");
	lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

	const origLines = original.split("\n");
	const cleanLines = cleaned.split("\n");

	const deletions: string[] = [];
	const additions: string[] = [];

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

	for (const line of deletions.slice(0, 5)) {
		const truncated = line.length > 60 ? `${line.slice(0, 60)}…` : line;
		lines.push(`  ${colors.red("-")} ${truncated}`);
	}
	for (const line of additions.slice(0, 5)) {
		const truncated = line.length > 60 ? `${line.slice(0, 60)}…` : line;
		lines.push(`  ${colors.green("+")} ${truncated}`);
	}

	const totalChanges = deletions.length + additions.length;
	if (totalChanges > 10) {
		lines.push(`  ${colors.dim("…")} ${totalChanges} total changes`);
	}

	lines.push("");
	lines.push(`  ${original.length} → ${cleaned.length} chars`);

	return lines;
}