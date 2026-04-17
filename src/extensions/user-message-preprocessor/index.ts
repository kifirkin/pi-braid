/**
 * User Message Preprocessor Extension
 *
 * Cleans up user messages before sending to main LLM:
 * - Translates non-English messages to English
 * - Corrects spelling/grammar in English messages
 * - Uses utility model via resolveUtilityModel() (respects /utility-model setting)
 *
 * Smart content detection (skips processing when content is already clean):
 * - Very long text (>maxChars, default 5000) - too expensive to preprocess
 * - Code-heavy text (>30% code characters) - likely technical content
 * - Well-written English with proper structure - no changes needed
 * - Markdown content with good formatting - already structured
 * - Short prose after stripping code blocks - likely just brief context
 *
 * Uses `transform` action so preprocessed text flows to the agent in the same
 * input cycle. The user sees the diff widget with cleaned text, but pressing
 * Enter sends the cleaned text directly - no second submit needed.
 *
 * Settings:
 * - Enabled state persists to ~/.pi/agent/settings.json
 * - Other config (minLength, maxChars, skipCommands, etc.) stored in memory
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Context, ImageContent, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, InputEventResult } from "@mariozechner/pi-coding-agent";
import { resolveUtilityModel } from "../../lib/model-resolver.js";

const SYSTEM_PROMPT = `You are a message preprocessor. Your job is to translate or correct the message sent by User.

Think silently before producing output.

Guidelines:
- Translate message to English if it is not already
- Correct spelling, grammar mistakes, or meaning collisions
- Preserve technical terms, code, file paths, and markdown formatting
- Keep code blocks, lists, and other structural elements intact
- Respond with ONLY the corrected message - no commentary, no explanation
`;

interface PreprocessorConfig {
	enabled: boolean;
	/** Skip text shorter than this (characters) */
	minLength: number;
	/** Skip text longer than this (characters) - protects against huge pastes */
	maxChars: number;
	/** Skip messages starting with / or ! (commands) */
	skipCommands: boolean;
	showDiff: boolean;
	timeoutSeconds: number;
}

const DEFAULT_CONFIG: PreprocessorConfig = {
	enabled: true,
	minLength: 10,
	maxChars: 5000,
	skipCommands: true,
	showDiff: true,
	timeoutSeconds: 180,
};

// Settings Persistence

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

// Content Analysis Helpers

/** Characters that indicate code content */
const CODE_CHARS = new Set("{}[]();=>+-*/|&<>@#$%^~`\\");

/**
 * Strip triple-backtick (```) and tilde (~~~) code blocks from text.
 * Returns { prose, hadCodeBlocks, codeBlockCharCount }.
 *
 * The prose length tells us how much actual text content there is,
 * independent of pasted code/examples.
 */
function stripCodeBlocks(text: string): { prose: string; hadCodeBlocks: boolean; codeBlockChars: number } {
	const startLen = text.length;

	// Remove fenced code blocks (```, ~~~, with optional language tags)
	// Use non-greedy matching to handle multiple blocks
	let prose = text.replace(/```[\s\S]*?```~~~?/gm, "");
	prose = prose.replace(/~~~[\s\S]*?~~~/gm, "");

	const hadCodeBlocks = prose.length < startLen;
	const codeBlockChars = startLen - prose.length;

	return { prose, hadCodeBlocks, codeBlockChars };
}

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
 * Markdown/formatting patterns that indicate content is already well-structured.
 * If text has several of these, it's likely already clean/properly formatted.
 */
const FORMATTING_PATTERNS = [
	/```/, // Has inline code
	/^#+\s/m, // Headings
	/^\s*[-*+]\s/m, // Unordered list items
	/^\s*\d+\.\s/m, // Ordered list items
	/^\s*>\s/m, // Blockquotes
	/\|.*\|/, // Tables
	/\*\*.+?\*\*/, // Bold
	/\*.+?\*/, // Italic
];

/**
 * Common English words (stopwords) for language detection.
 * If a high ratio of words are English stopwords, text is likely in English.
 */
const ENGLISH_STOPWORDS = new Set([
	"the","be","to","of","and","a","in","that","have","i","it","for","not","on","with","he","as","you","do","at",
	"this","but","his","by","from","they","we","say","her","she","or","an","will","my","one","all","would","there",
	"their","what","so","up","out","if","about","who","get","which","go","me","when","make","can","like",
	"time","no","just","him","know","take","people","into","year","your","good","some","could","them","see","other",
	"than","then","now","look","only","come","its","over","think","also","back","after","use","two","how","our",
	"work","first","well","way","even","new","want","because","any","these","give","day","most","us",
	"is","are","was","were","been","has","had","does","did","been","being","here","there","where","when","what",
	"how","why","can","could","should","would","may","might","must","shall","will","would","could","should",
]);

/**
 * Detect if text is primarily English.
 * Uses stopword ratio: count words matching English stopwords / total words.
 * Returns true if ratio > 0.1 (10% English stopwords = likely English text).
 *
 * Note: Lowered from 0.2 to 0.1 because well-written English with technical terms
 * (e.g., "Create a function that handles errors") has lower stopword ratios.
 */
function isLikelyEnglish(text: string): boolean {
	const words = text.toLowerCase().split(/[\s,.!?;:"'()\[\]{}]+/).filter((w) => w.length > 1);
	let englishCount = 0;
	for (const w of words) {
		if (ENGLISH_STOPWORDS.has(w)) englishCount++;
	}
	if (words.length < 3 && englishCount === 0) return false;
	return englishCount / words.length > 0.1;
}

/**
 * Count how many formatting patterns match the text.
 */
function countFormattingPatterns(text: string): number {
	let count = 0;
	for (const pattern of FORMATTING_PATTERNS) {
		if (pattern.test(text)) count++;
	}
	return count;
}

/**
 * Check if message looks already well-written / properly formatted.
 * Skip if text appears to be already clean English.
 *
 * Uses multiple heuristics:
 * - Multiple well-capitalized sentences
 * - Few/no repeated character patterns (typos)
 * - Substantial formatting (markdown structure)
 * - Balanced brackets
 */
function looksWellWritten(text: string): boolean {
	// Strip code blocks first - they inflate content without being "writing"
	const { prose: stripped } = stripCodeBlocks(text);

	// Must have sentences
	const sentenceCount = (stripped.match(/[.!?]+\s/g) || []).length;
	if (sentenceCount < 2) return false;

	// Check capitalization
	const sentences = stripped.split(/[.!?]+\s/);
	let capitalizedCount = 0;
	for (const s of sentences) {
		const trimmed = s.trim();
		if (trimmed.length > 0 && /^[A-Z]/.test(trimmed)) capitalizedCount++;
	}
	if (capitalizedCount < sentenceCount * 0.5) return false;

	// No excessive repeated characters (common typo pattern)
	if (/(.)\1{4,}/.test(text)) return false;

	// If substantial formatting present, likely already structured
	if (countFormattingPatterns(text) >= 3) return true;

	// Balanced brackets - if well-balanced and has formatting, likely clean
	const brackets = { "(": 0, ")": 0, "[": 0, "]": 0, "{": 0, "}": 0 };
	for (const char of text) {
		if (char in brackets) brackets[char as keyof typeof brackets]++;
	}
	const balanced =
		brackets["("] === brackets[")"] && brackets["["] === brackets["]"] && brackets["{"] === brackets["}"];

	return balanced && countFormattingPatterns(text) >= 1;
}

/**
 * Check if prose (text without code blocks) is too brief to warrant preprocessing.
 * If the actual user text is just a few words after stripping code, skip it.
 */
function isProseTooBrief(text: string): boolean {
	const { prose } = stripCodeBlocks(text);
	// Count non-whitespace, non-code chars in prose
	const proseChars = prose.replace(/\s/g, "").replace(/[`#*_~\[\](){}]/g, "").length;
	return proseChars < 20;
}

// State

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

// Preprocessing

async function preprocess(
	original: string,
	_images: ImageContent[] | undefined,
	ctx: ExtensionContext,
): Promise<string | null> {
	// Use model-resolver (reads utilityModel from ~/.pi/agent/settings.json)
	let model = resolveUtilityModel(ctx);
	if (!model) {
		state.skippedCount++;
		return null;
	}

	// If reasoning model, prefer non-reasoning model for fast preprocessing
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
		// Abort - don't show error, just return original
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

	// Strip <user_message> XML tags the LLM might echo back
	if (cleaned) {
		cleaned = cleaned
			.replace(/^<user_message>/i, "")
			.replace(/<\/user_message>$/i, "")
			.trim();
	}

	return cleaned && cleaned !== original && cleaned.length > 0 ? cleaned : null;
}

// Extension Registration

export default function userMessagePreprocessorExtension(pi: ExtensionAPI) {
	// Tools removed (2026-04-15): preprocessor_config, preprocessor_stats - use /preprocessor command instead

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

		if (original.length > state.config.maxChars) {
			state.skippedCount++;
			return { action: "continue" };
		}

		if (state.config.skipCommands && (original.startsWith("/") || original.startsWith("!"))) {
			state.skippedCount++;
			return { action: "continue" };
		}

		// Strip code blocks to analyze the actual prose
		const { prose, hadCodeBlocks } = stripCodeBlocks(original);

		// If code blocks were the bulk of content, treat as code-heavy
		if (hadCodeBlocks && prose.trim().length < 30) {
			state.skippedCount++;
			return { action: "continue" };
		}

		// Prose too brief after stripping code
		if (isProseTooBrief(original)) {
			state.skippedCount++;
			return { action: "continue" };
		}

		// Check code-heavy ratio on the stripped prose
		if (isCodeHeavy(prose)) {
			state.skippedCount++;
			return { action: "continue" };
		}

		// Skip well-written text
		if (looksWellWritten(original)) {
			state.skippedCount++;
			return { action: "continue" };
		}

		// ── NEW: Handle badly-written English messages ───────────────────────────────
		// The preprocessor should clean BAD English, not skip it.
		// If text is likely English but not well-written, PROCEED to preprocessing.
		if (isLikelyEnglish(prose)) {
			// Check if it needs cleaning (badly-written) vs already clean enough
			const wordCount = prose.split(/\s+/).filter((w) => w.length > 0).length;
			const shortWords = prose.split(/\s+/).filter((w) => w.length > 0 && w.length <= 4).length;
			const missingPunctuation = (prose.match(/[.!?;:,]/g) || []).length / Math.max(1, prose.length);
			const repeatedCharPatterns = (prose.match(/(.)\1{2,}/g) || []).length;
			const missingCapitals = (prose.match(/\. [a-z]/g) || []).length; // lowercase after period = bad

			// Indicators of badly-written English that needs cleaning:
			const needsCleaning =
				(shortWords > wordCount * 0.6 && wordCount > 5) || // Sentence fragments
				missingPunctuation < 0.03 || // Very low punctuation (run-on sentences)
				repeatedCharPatterns > 0 || // Has obvious typos
				missingCapitals > 2; // Multiple missing capitalizations

			if (!needsCleaning) {
				// Well-written enough - skip preprocessing
				state.skippedCount++;
				return { action: "continue" };
			}
			// needsCleaning === true → proceed to preprocessing
		}

		// Run preprocessing - await result and return transform
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

// Diff Display

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
