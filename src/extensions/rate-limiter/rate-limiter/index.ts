import { createLogger } from "../../../lib/logger.js";

const log = createLogger("rate-limiter");
/**
 * Rate Limiter Extension
 *
 * Implements request per minute (RPM) and tokens per minute (TPM) limiting
 * for LLM API calls. Ensures fair usage and prevents rate limit errors.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface RateLimitHistory {
	timestamp: number;
	tokens: number;
}

interface RateLimitEntry {
	provider: string;
	model: string;
	history: RateLimitHistory[];
}

const RPM_LIMIT = 30; // requests per minute
const TPM_LIMIT = 500_000; // tokens per minute

export default function (pi: ExtensionAPI) {
	// In-memory only state - transient by design (only last 60 seconds matter)
	// Not persisted to avoid session tree pollution
	const state = new Map<string, RateLimitEntry>();
	let isShuttingDown = false;

	pi.on("session_shutdown", async () => {
		isShuttingDown = true;
		// Clean up state to prevent any memory retention
		state.clear();
	});

	pi.registerCommand("rate-cancel", {
		description: "Cancel the rate limiter wait and reset its state",
		handler: async (_args: string, ctx) => {
			isShuttingDown = true;
			state.clear();
			ctx.ui.notify("Rate limiter cancelled and state cleared.", "info");
		},
	});

	// Rate limit every LLM call via context event
	pi.on("context", async (event, ctx) => {
		const model = ctx.model;
		if (!model) return;
		const key = `${model.provider}:${model.id}`;

		let entry = state.get(key);
		if (!entry) {
			entry = { provider: model.provider, model: model.id, history: [] };
			state.set(key, entry);
		}

		// Compute total tokens for this request: system prompt + all messages
		let totalTokens = 0;
		const systemPrompt = ctx.getSystemPrompt();
		if (systemPrompt) {
			totalTokens += estimateTokens(systemPrompt);
		}

		for (const msg of event.messages) {
			// Only process messages that have content (user/assistant messages)
			if (!("content" in msg) || !msg.content) continue;

			const contents = msg.content;
			for (const content of contents) {
				// Skip string content (unlikely but possible in some message types)
				if (typeof content === "string") continue;
				if (content.type === "text" && typeof content.text === "string") {
					totalTokens += estimateTokens(content.text);
				} else if (content.type === "image") {
					// Rough estimate for image tokens; adjust if needed
					totalTokens += 1000;
				}
			}
		}

		// Check if single request exceeds total capacity
		if (totalTokens > TPM_LIMIT) {
			ctx.ui.notify(`Request too large: ${totalTokens} tokens (max ${TPM_LIMIT})`, "error");
			throw new Error(`Request exceeds max token limit per minute (${totalTokens} > ${TPM_LIMIT})`);
		}

		const startTime = Date.now();
		const maxWaitMs = 120_000; // Maximum 2 minutes total wait time

		while (!isShuttingDown) {
			const now = Date.now();

			// Safety valve: prevent infinite loops
			if (now - startTime > maxWaitMs) {
				ctx.ui.notify("Rate limiter: max wait time exceeded, proceeding with request", "warning");
				break;
			}

			const oneMinuteAgo = now - 60_000;

			// Clean old entries
			entry.history = entry.history.filter((h) => h.timestamp > oneMinuteAgo);

			const currentRpm = entry.history.length;
			const currentTpm = entry.history.reduce((sum, h) => sum + h.tokens, 0);

			const willExceedRpm = currentRpm >= RPM_LIMIT;
			const willExceedTpm = currentTpm + totalTokens > TPM_LIMIT;

			if (!willExceedRpm && !willExceedTpm) {
				// Allowed - exit loop
				break;
			}

			// Rate limit exceeded - calculate wait time
			const oldest = entry.history.length > 0 ? entry.history[0].timestamp : now;
			const waitMs = Math.max(100, 60_000 - (now - oldest) + 100); // Minimum 100ms wait

			// Check if waiting would exceed max total wait time
			if (now - startTime + waitMs > maxWaitMs) {
				ctx.ui.notify("Rate limiter: cannot wait long enough to clear limits, proceeding", "warning");
				break;
			}

			ctx.ui.notify(`Rate limited. Waiting ${Math.ceil(waitMs / 1000)}s...`, "warning");

			// Interruptible sleep - checks for shutdown every 100ms
			const slept = await interruptibleSleep(waitMs, () => isShuttingDown);
			if (!slept) {
				ctx.ui.notify("Rate limiter: shutting down, proceeding with request", "warning");
				break;
			}
			// Continue loop to re-evaluate
		}

		if (isShuttingDown) {
			ctx.ui.notify("Rate limiter: shutdown in progress", "warning");
		}

		// Record the request
		entry.history.push({ timestamp: Date.now(), tokens: totalTokens });
		// Note: Not persisting to session - state is transient (60s window)
	});

	function estimateTokens(text: string): number {
		// Simple heuristic: ~4 chars per token. Replace with a proper tokenizer if needed.
		return Math.ceil(text.length / 4);
	}
}

/**
 * Sleep that can be interrupted via check function.
 * Returns true if full sleep completed, false if interrupted.
 */
async function interruptibleSleep(ms: number, shouldCancel: () => boolean): Promise<boolean> {
	const checkInterval = 100; // Check every 100ms
	const start = Date.now();

	while (Date.now() - start < ms) {
		if (shouldCancel()) {
			return false;
		}
		await new Promise((r) => setTimeout(r, Math.min(checkInterval, ms - (Date.now() - start))));
	}

	return !shouldCancel();
}
