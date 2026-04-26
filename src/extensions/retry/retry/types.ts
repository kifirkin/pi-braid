/**
 * Retry extension — shared types.
 *
 * Defines the retry state, error classification, and strategy interface
 * for the /retry command and auto-retry system.
 */

import type { ImageContent } from "@mariozechner/pi-ai";

// ── Error Categories ─────────────────────────────────────────────────────────

export const ErrorCategory = {
	/** Transient network / 5xx / rate-limit that should auto-retry */
	TRANSIENT: "transient",
	/** API quota exhausted — needs manual action */
	QUOTA_EXCEEDED: "quota_exceeded",
	/** Auth / permission — needs key rotation */
	AUTH_ERROR: "auth_error",
	/** Context window overflow */
	CONTEXT_OVERFLOW: "context_overflow",
	/** Tool execution failure */
	TOOL_ERROR: "tool_error",
	/** Provider returned an error message (non-HTTP error) */
	PROVIDER_ERROR: "provider_error",
	/** Unknown / uncategorised */
	UNKNOWN: "unknown",
} as const;

export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory];

// ── Retry State ──────────────────────────────────────────────────────────────

export interface RetryState {
	/** The last user message content */
	lastUserMessage: {
		text: string;
		images?: ImageContent[];
	} | null;
	/** The session entry ID of the last user message (for tree context) */
	lastUserEntryId: string | null;
	/** Info about the last error that prevented completion */
	lastError: {
		message: string;
		category: ErrorCategory;
		httpStatus: number | null;
		providerCode: string | null;
		timestamp: number;
	} | null;
	/** Info about the last completed agent turn (successful) */
	lastTurn: {
		entryId: string;
		timestamp: number;
		hadError: boolean;
	} | null;
	/** Number of consecutive failures since last successful turn */
	failureCount: number;
	/** Whether the error happened mid-tool-chain (after assistant/tool messages) or before agent responded */
	errorPhase: "initial" | "mid_chain";
	/** Version for forward-compat */
	version: number;
}

// ── Retry Strategy Interface (extensible) ────────────────────────────────────

export interface RetryStrategy {
	/** Unique name for this strategy */
	name: string;
	/** Whether this strategy should auto-retry the given error */
	shouldAutoRetry(error: {
		message: string;
		category: ErrorCategory;
		httpStatus: number | null;
		attempt: number;
	}): boolean;
	/** Delay in ms before retry attempt */
	getDelay(attempt: number): number;
	/** Maximum number of retry attempts */
	maxAttempts: number;
}

// ── Retry Configuration ──────────────────────────────────────────────────────

export interface RetryConfig {
	/** Whether auto-retry for transient errors is enabled */
	autoRetryEnabled: boolean;
	/** Maximum auto-retry attempts for transient errors */
	maxAutoRetryAttempts: number;
	/** Base delay in ms for retry backoff */
	baseDelayMs: number;
	/** Maximum delay cap in ms */
	maxDelayMs: number;
	/** Custom retry strategies (for provider fallback etc.) */
	strategies: RetryStrategy[];
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
	autoRetryEnabled: true,
	maxAutoRetryAttempts: 3,
	baseDelayMs: 2000,
	maxDelayMs: 30000,
	strategies: [],
};

// ── Custom Entry Type for Persistence ────────────────────────────────────────

export const RETRY_STATE_ENTRY_TYPE = "__retry_state";

// ── Error Classification Helpers ─────────────────────────────────────────────

/**
 * Classify an error message into a category.
 */
export function classifyRetryError(
	message: string,
	httpStatus: number | null,
): { category: ErrorCategory; retryable: boolean } {
	const lower = message.toLowerCase();

	// Quota / rate-limit
	if (
		httpStatus === 429 ||
		lower.includes("quota") ||
		lower.includes("rate limit") ||
		lower.includes("too many requests")
	) {
		return {
			category: ErrorCategory.QUOTA_EXCEEDED,
			retryable: httpStatus !== 429, // 429 can be retried after backoff
		};
	}

	// Auth errors
	if (
		httpStatus === 401 ||
		httpStatus === 403 ||
		lower.includes("unauthorized") ||
		lower.includes("forbidden") ||
		lower.includes("api key") ||
		lower.includes("invalid authentication")
	) {
		return { category: ErrorCategory.AUTH_ERROR, retryable: false };
	}

	// Context overflow
	if (
		lower.includes("context") ||
		lower.includes("token limit") ||
		lower.includes("max tokens") ||
		lower.includes("too long")
	) {
		return { category: ErrorCategory.CONTEXT_OVERFLOW, retryable: false };
	}

	// Transient server errors
	if (
		(httpStatus !== null && httpStatus >= 500 && httpStatus < 600) ||
		httpStatus === 429 ||
		lower.includes("overloaded") ||
		lower.includes("timeout") ||
		lower.includes("connection") ||
		lower.includes("reset") ||
		lower.includes("unavailable") ||
		lower.includes("fetch failed") ||
		lower.includes("network error") ||
		lower.includes("econnreset") ||
		lower.includes("econnrefused") ||
		lower.includes("service unavailable") ||
		lower.includes("bad gateway") ||
		lower.includes("internal server error")
	) {
		return { category: ErrorCategory.TRANSIENT, retryable: true };
	}

	// Tool errors
	if (
		lower.includes("tool") &&
		(lower.includes("error") || lower.includes("fail") || lower.includes("timeout"))
	) {
		return { category: ErrorCategory.TOOL_ERROR, retryable: false };
	}

	// Provider errors (non-HTTP)
	if (lower.includes("provider") || lower.includes("model") || lower.includes("ai")) {
		return { category: ErrorCategory.PROVIDER_ERROR, retryable: false };
	}

	return { category: ErrorCategory.UNKNOWN, retryable: false };
}

/**
 * Default transient retry strategy.
 */
export const transientRetryStrategy: RetryStrategy = {
	name: "transient",
	shouldAutoRetry(error) {
		return error.category === ErrorCategory.TRANSIENT && error.attempt < 3;
	},
	getDelay(attempt: number) {
		return Math.min(2000 * Math.pow(2, attempt - 1), 30000);
	},
	maxAttempts: 3,
};
