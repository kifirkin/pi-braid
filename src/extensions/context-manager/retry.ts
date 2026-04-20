/**
 * Compaction and overflow retry orchestration.
 * Manages retry state, exponential backoff, and aggressive compaction triggers.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("context-manager:retry");

// ── Configuration ────────────────────────────────────────────────────────────

export const COMPACTION_RETRY_MAX_ATTEMPTS = 3;
export const COMPACTION_RETRY_BASE_DELAY_MS = 2000;
export const COMPACTION_RETRY_CUSTOM_TYPE = "__compact_retry_trigger";

export const OVERFLOW_RETRY_MAX_ATTEMPTS = 3;
export const OVERFLOW_RETRY_BASE_DELAY_MS = 3000;
export const OVERFLOW_RETRY_KEEP_REDUCTION_FACTOR = 0.7;

// ── State ────────────────────────────────────────────────────────────────────

export interface CompactionRetryState {
	attempt: number;
	lastError: string;
	lastReason: string;
	retryTimeout: ReturnType<typeof setTimeout> | null;
}

export interface OverflowRetryState {
	attempt: number;
	lastError: string;
	retryTimeout: ReturnType<typeof setTimeout> | null;
	aggressiveMode: boolean;
}

// Module-level state (to be migrated to getExtensionState in next phase)
export const compactionRetryState: CompactionRetryState = {
	attempt: 0,
	lastError: "",
	lastReason: "",
	retryTimeout: null,
};

export const overflowRetryState: OverflowRetryState = {
	attempt: 0,
	lastError: "",
	retryTimeout: null,
	aggressiveMode: false,
};

// Track compacted entries for deduplication
export const compactedEntries: Set<string> = new Set();

// ── Compaction Retry ─────────────────────────────────────────────────────────

export function getCompactionRetryDelay(attempt: number): number {
	return COMPACTION_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
}

export function clearCompactionRetry(): void {
	if (compactionRetryState.retryTimeout) {
		clearTimeout(compactionRetryState.retryTimeout);
		compactionRetryState.retryTimeout = null;
	}
}

export function resetCompactionRetry(): void {
	clearCompactionRetry();
	compactionRetryState.attempt = 0;
	compactionRetryState.lastError = "";
	compactionRetryState.lastReason = "";
}

export function isTransientCompactionError(errorMessage: string | null | undefined): boolean {
	if (!errorMessage) return false;

	// Common transient error patterns
	if (/\b529\b/.test(errorMessage)) return true; // Anthropic overloaded
	if (/overloaded_error/i.test(errorMessage)) return true;
	if (/server.*(overload|cluster.*load|high.*load|under.*high.*load)/i.test(errorMessage)) return true;
	if (/rate.?limit|too.?many.?requests|429\b/i.test(errorMessage)) return true;
	if (/\b5\d{2}\b.*server/i.test(errorMessage)) return true; // 5xx server errors
	if (/\b503\b/.test(errorMessage)) return true; // Service unavailable

	return false;
}

export function triggerCompactionRetry(pi: ExtensionAPI, attempt: number, errorMessage: string): void {
	clearCompactionRetry();

	// Schedule delayed retry with exponential backoff
	const delayMs = getCompactionRetryDelay(attempt);

	compactionRetryState.retryTimeout = setTimeout(() => {
		compactionRetryState.retryTimeout = null;

		// Send hidden trigger message that prompts retry
		pi.sendMessage(
			{
				customType: COMPACTION_RETRY_CUSTOM_TYPE,
				content: [
					{
						type: "text" as const,
						text: attempt === 1
							? `[Auto-retry] Compaction failed (${errorMessage}). Retrying... (${attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS})`
							: `[Auto-retry] Compaction retry ${attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS}: ${errorMessage}`,
					},
				],
				display: false, // Hidden from user
			},
			{ triggerTurn: true },
		);
	}, delayMs);
}

// ── Overflow Retry ───────────────────────────────────────────────────────────

export function getOverflowRetryDelay(attempt: number): number {
	return OVERFLOW_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
}

export function clearOverflowRetry(): void {
	if (overflowRetryState.retryTimeout) {
		clearTimeout(overflowRetryState.retryTimeout);
		overflowRetryState.retryTimeout = null;
	}
}

export function resetOverflowRetry(): void {
	clearOverflowRetry();
	overflowRetryState.attempt = 0;
	overflowRetryState.lastError = "";
	overflowRetryState.aggressiveMode = false;
}

export function triggerOverflowRetry(
	pi: ExtensionAPI,
	attempt: number,
	errorMessage: string,
	ctx?: any,
): void {
	clearOverflowRetry();

	overflowRetryState.attempt = attempt;
	overflowRetryState.lastError = errorMessage;
	overflowRetryState.aggressiveMode = attempt > 1;

	const delayMs = getOverflowRetryDelay(attempt);
	const baseKeep = 20000;
	const reducedKeep = Math.floor(baseKeep * Math.pow(OVERFLOW_RETRY_KEEP_REDUCTION_FACTOR, attempt - 1));

	overflowRetryState.retryTimeout = setTimeout(() => {
		overflowRetryState.retryTimeout = null;

		pi.sendMessage(
			{
				customType: "__overflow_retry_trigger",
				content: [
					{
						type: "text" as const,
						text: attempt === 1
							? `[Overflow Recovery] Initial compaction failed (${errorMessage}). Retrying with reduced context... (${attempt}/${OVERFLOW_RETRY_MAX_ATTEMPTS})`
							: `[Overflow Recovery] Retry ${attempt}/${OVERFLOW_RETRY_MAX_ATTEMPTS}: ${errorMessage}. Attempting more aggressive compaction (keep ≤${reducedKeep} tokens)...`,
					},
				],
				display: true,
			},
			{ triggerTurn: true },
		);
	}, delayMs);
}
