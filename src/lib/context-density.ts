/**
 * Context Information Density Evaluator
 *
 * Measures signal-to-noise ratio in context to predict when context management
 * is needed. Based on:
 *   - SimpleMem (2601.02553): 30x token reduction via semantic structured compression
 *   - GenericAgent (2604.17091): Information density, not length, determines performance
 *
 * Key insight: Count-based thresholds miss the real problem. A 50-message context with
 * high signal is better than a 10-message context with mostly boilerplate.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DensityResult {
	/** Signal / (signal + noise), 0-1. Higher = more informative context. */
	density: number;
	/** Messages with meaningful, non-boilerplate content. */
	signalMessages: number;
	/** Messages that are pure boilerplate, duplication, or noise. */
	noisyMessages: number;
	/** Messages that appear nearly identical to previous messages. */
	duplicates: number;
	/** Estimated token count of context. */
	totalTokens: number;
	/** tokens / tokenLimit, 0-1. */
	tokenRatio: number;
}

export type CompressionStrategy = "aggressive" | "semantic" | "conservative" | "none";

// ── Noise Patterns ───────────────────────────────────────────────────────────────

/** Regex patterns that indicate boilerplate/noise in message content. */
const NOISE_PATTERNS = [
	// Python tracebacks
	/\bFile "[^"]*", line \d+/,
	// Import statements in tool results
	/^(import |from "|\.\.\.)/m,
	// npm/yarn package manager output
	/(?:added|removed|changed) \d+ packages?/,
	// HTTP headers
	/^(GET|POST|PUT|DELETE|HEAD|OPTIONS) [^\n]+\n(?:[^\n]*\n)*(?:content-type|content-length|server|date)[^\n]*\n*/i,
	// Very repetitive single characters (progress indicators)
	/(.)\1{4,}/,
];

const MIN_SIGNAL_LENGTH = 30;
const CHARS_PER_TOKEN = 4;

function countTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function isNoiseMessage(content: string): boolean {
	if (!content || content.trim().length < MIN_SIGNAL_LENGTH) return true;
	for (const pattern of NOISE_PATTERNS) {
		if (pattern.test(content)) return true;
	}
	// Very repetitive content
	const nonRepeat = content.replace(/(.)\1{4,}/g, "");
	if (nonRepeat.length < MIN_SIGNAL_LENGTH) return true;
	return false;
}

/** Simple string hash for duplicate detection. */
function simpleHash(s: string): number {
	let h = 0;
	for (let i = 0; i < Math.min(s.length, 200); i++) {
		h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
	}
	return h;
}

// ── Main Evaluator ─────────────────────────────────────────────────────────────

/**
 * Evaluate the information density of a session's context.
 *
 * @param ctx - ExtensionContext to access session entries
 * @returns DensityResult with aggregate metrics
 *
 * @example
 * const d = evaluateContextDensity(ctx);
 * if (d.density < 0.4) {
 *   ctx.whisper("Context density low — consider context_archive()");
 * }
 */
export function evaluateContextDensity(ctx: ExtensionContext): DensityResult {
	let entries: any[] = [];
	try {
		entries = ctx.sessionManager?.getEntries?.() ?? [];
	} catch {
		/* fallback: empty */
	}

	let totalTokens = 0;
	let signalMessages = 0;
	let noisyMessages = 0;
	let duplicates = 0;

	// Deduplication: track recent message hashes
	const recentHashes = new Set<string>();
	const MAX_RECENT = 20;

	for (const entry of entries) {
		let content = "";

		if (entry.type === "message" && entry.message) {
			const msg = entry.message;
			content = typeof msg.content === "string"
				? msg.content
				: Array.isArray(msg.content)
					? msg.content.map((c: any) => c.text ?? "").join(" ")
					: "";
		} else if (entry.type === "tool_result" && entry.result) {
			content = typeof entry.result === "string"
				? entry.result
				: JSON.stringify(entry.result);
		} else if (entry.type === "custom") {
			// Skip custom entries (memory, retry state, etc.)
			continue;
		}

		if (!content) continue;

		const tokens = countTokens(content);
		const clean = content.trim();
		const isNoise = isNoiseMessage(clean);

		// Duplicate detection: hash of first 200 chars + length
		const hashKey = `${simpleHash(clean)}:${clean.length}`;
		const isDuplicate = recentHashes.has(hashKey);
		if (isDuplicate) duplicates++;
		recentHashes.add(hashKey);
		if (recentHashes.size > MAX_RECENT) {
			// Evict oldest
			const first = recentHashes.values().next().value;
			if (first !== undefined) recentHashes.delete(first);
		}

		totalTokens += tokens;
		if (isNoise || isDuplicate) noisyMessages++;
		else signalMessages++;
	}

	const tokenLimit = 100_000; // Default 100k tokens (adjust per model)
	const tokenRatio = tokenLimit > 0 ? Math.min(totalTokens / tokenLimit, 1) : 0;
	const totalMessages = signalMessages + noisyMessages;
	const density = totalMessages > 0 ? signalMessages / totalMessages : 1;

	return { density, signalMessages, noisyMessages, duplicates, totalTokens, tokenRatio };
}

// ── Compression Strategy Recommendation ───────────────────────────────────────────

/**
 * Recommend a compression strategy based on context density.
 *
 * Low density (< 0.4):     Aggressive pruning — remove noise, keep signal
 * Medium density (0.4-0.7): Semantic compression — summarize without losing meaning
 * High density (> 0.7):     Conservative — only compress if context is large
 */
export function recommendCompressionStrategy(density: DensityResult): CompressionStrategy {
	if (density.tokenRatio > 0.85) {
		return density.density < 0.4 ? "aggressive" : "semantic";
	}
	if (density.tokenRatio > 0.6) {
		if (density.density < 0.4) return "semantic";
		if (density.density < 0.6) return "conservative";
		return "none";
	}
	return "none";
}
