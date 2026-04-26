/**
 * Retry state management with session-entry persistence.
 *
 * The retry state is persisted as __retry_state custom entries so it survives
 * session restores (/new, /resume, /tree navigation, pi restart).
 * On session_start, we recover lastUserMessage from the most recent valid
 * entry, falling back to the last user message in the session history.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ImageContent } from "@mariozechner/pi-ai";

import {
	type RetryConfig,
	type RetryState,
	type RetryStrategy,
	DEFAULT_RETRY_CONFIG,
	RETRY_STATE_ENTRY_TYPE,
	classifyRetryError,
	transientRetryStrategy,
} from "./types.js";

// ── Module-Level State ───────────────────────────────────────────────────────

let _state: RetryState = createEmptyState();
let _config: RetryConfig = { ...DEFAULT_RETRY_CONFIG };
let _activeStrategies: Map<string, RetryStrategy> = new Map();

// Auto-retry timer management
let _autoRetryTimer: ReturnType<typeof setTimeout> | null = null;
let _autoRetryAttempt = 0;
let _autoRetryStrategy: RetryStrategy | null = null;

function createEmptyState(): RetryState {
	return {
		lastUserMessage: null,
		lastUserEntryId: null,
		lastError: null,
		lastTurn: null,
		failureCount: 0,
		errorPhase: "initial",
		version: 3,
	};
}

export function initState(config?: Partial<RetryConfig>): void {
	_state = createEmptyState();
	_config = { ...DEFAULT_RETRY_CONFIG, ...config };
	_activeStrategies.clear();
	_activeStrategies.set(transientRetryStrategy.name, transientRetryStrategy);
	for (const s of (_config.strategies ?? [])) {
		_activeStrategies.set(s.name, s);
	}
}

export function getState(): RetryState {
	return _state;
}

export function getConfig(): RetryConfig {
	return _config;
}

// ── State Recovery from Session Entries ──────────────────────────────────────

const MAX_PERSISTED_STATE_AGE_MS = 5 * 60 * 1000; // 5 min — entries older than this are stale

/**
 * Recover retry state from session entries. Called on session_start.
 * Priority 1: Youngest non-stale __retry_state custom entry (by timestamp,
 *   not array position — getEntries() uses tree-traversal order which may
 *   not be chronological in branched sessions).
 * Priority 2: Most recent user message by timestamp (fallback for old /
 *   pre-extension sessions).
 */
export function recoverState(sessionManager: { getEntries(): Array<any> }): void {
	try {
		const entries = sessionManager.getEntries();
		const now = Date.now();

		// Priority 1: custom entry with latest timestamp
		let bestEntry: RetryState | null = null;
		let bestTimestamp = 0;
		for (const e of entries) {
			if (e.type === "custom" && e.customType === RETRY_STATE_ENTRY_TYPE) {
				const saved = e.data as RetryState | undefined;
				if (saved && typeof saved === "object" && saved.version) {
					const ts = saved.lastError?.timestamp ?? saved.lastTurn?.timestamp ?? 0;
					if (ts > bestTimestamp) {
						bestTimestamp = ts;
						// Migration: v2 → v3 (added errorPhase)
						if (!saved.errorPhase) saved.errorPhase = "initial";
						bestEntry = saved;
					}
				}
			}
		}
		if (bestEntry && now - bestTimestamp < MAX_PERSISTED_STATE_AGE_MS) {
			_state = { ...createEmptyState(), ...bestEntry };
			return;
		}

		// Priority 2: last user message by timestamp (pre-extension sessions)
		let bestMsgTimestamp = 0;
		let bestMsgEntry: (typeof entries)[0] | null = null;
		for (const e of entries) {
			if (e.type === "message" && e.message?.role === "user") {
				const ts = e.timestamp ?? e.message?.timestamp ?? 0;
				if (ts > bestMsgTimestamp) {
					bestMsgTimestamp = ts;
					bestMsgEntry = e;
				}
			}
		}
		if (bestMsgEntry) {
			const msg = bestMsgEntry.message!;
			let text = "";
			let images: any[] | undefined;
			if (typeof msg.content === "string") {
				text = msg.content;
			} else if (Array.isArray(msg.content)) {
				const textParts: string[] = [];
				for (const c of msg.content) {
					if (c.type === "text" && c.text) textParts.push(c.text);
					else if (c.type === "image") { if (!images) images = []; images.push(c); }
				}
				text = textParts.join("\n");
			}
			if (text) {
				_state.lastUserMessage = { text, images: images?.length ? (images as any) : undefined };
				_state.lastUserEntryId = msg.id ?? null;
			}
		}
	} catch {
		// Fail-safe — keep current state
	}
}

// ── State Persistence ────────────────────────────────────────────────────────

let _lastPersistedHash = "";

/** Compute content hash of the fields that matter for recovery — used to
 *  skip persisting when nothing changed, avoiding entry accumulation. */
function stateHash(): string {
	return JSON.stringify({
		m: _state.lastUserMessage?.text ?? "",
		mi: _state.lastUserMessage?.images?.length ?? 0,
		e: _state.lastError?.message ?? "",
		ec: _state.lastError?.category ?? "",
		et: _state.lastError?.timestamp ?? 0,
		f: _state.failureCount,
		p: _state.errorPhase,
	});
}

export function persistState(pi: ExtensionAPI): void {
	const h = stateHash();
	if (h === _lastPersistedHash) return;
	_lastPersistedHash = h;
	pi.appendEntry(RETRY_STATE_ENTRY_TYPE, {
		lastUserMessage: _state.lastUserMessage,
		lastUserEntryId: _state.lastUserEntryId,
		lastError: _state.lastError,
		lastTurn: _state.lastTurn,
		failureCount: _state.failureCount,
		errorPhase: _state.errorPhase,
		version: _state.version,
	} satisfies RetryState);
}

// ── State Mutators ───────────────────────────────────────────────────────────

/** Record a user message for potential retry. Called from the `input` event. */
export function captureUserInput(pi: ExtensionAPI, text: string, images?: ImageContent[], entryId?: string): void {
	_state.lastUserMessage = { text, images: images?.length ? images : undefined };
	if (entryId) _state.lastUserEntryId = entryId;
	persistState(pi);
}

/** Record an agent turn result — success clears error state, failure increments
 *  failureCount and stores the classified error. Called from `agent_end`.
 *  `hasPostUserAssistantMsgs` indicates assistant/tool messages exist after the
 *  last user message — used to detect mid-chain vs initial failures. */
export function recordAgentEnd(pi: ExtensionAPI, entryId: string | null, hadError: boolean, errorMessage?: string | null, httpStatus?: number | null, hasPostUserAssistantMsgs?: boolean): void {
	if (hadError && errorMessage) {
		const classification = classifyRetryError(errorMessage, httpStatus ?? null);
		_state.lastError = {
			message: errorMessage,
			category: classification.category,
			httpStatus: httpStatus ?? null,
			providerCode: null,
			timestamp: Date.now(),
		};
		_state.failureCount++;
		_state.errorPhase = hasPostUserAssistantMsgs ? "mid_chain" : "initial";
	} else {
		_state.lastError = null;
		_state.failureCount = 0;
		_state.errorPhase = "initial";
	}
	if (entryId) {
		_state.lastTurn = { entryId, timestamp: Date.now(), hadError };
	}
	persistState(pi);
}

/** Reset retry state (user started a new conversation). */
export function resetState(pi: ExtensionAPI): void {
	_state = createEmptyState();
	clearAutoRetry();
	persistState(pi);
}

// ── Auto-Retry ───────────────────────────────────────────────────────────────

/** Determine if an error triggers auto-retry. Returns the matching strategy or null. */
export function shouldAutoRetry(errorMessage: string, httpStatus: number | null): RetryStrategy | null {
	const classification = classifyRetryError(errorMessage, httpStatus);
	for (const strategy of _activeStrategies.values()) {
		if (strategy.shouldAutoRetry({
			message: errorMessage,
			category: classification.category,
			httpStatus,
			attempt: _autoRetryAttempt + 1,
		})) return strategy;
	}
	return null;
}

/** Schedule an auto-retry of the last user message. Returns delay in ms, or -1. */
export function scheduleAutoRetry(pi: ExtensionAPI, ctx: ExtensionContext): number {
	if (!_config.autoRetryEnabled || !_state.lastUserMessage) return -1;
	const classification = _state.lastError
		? classifyRetryError(_state.lastError.message, _state.lastError.httpStatus)
		: null;
	if (!classification?.retryable) return -1;
	const strategy = shouldAutoRetry(_state.lastError?.message ?? "", _state.lastError?.httpStatus ?? null);
	if (!strategy) return -1;
	_autoRetryAttempt++;
	if (_autoRetryAttempt > strategy.maxAttempts) { clearAutoRetry(); return -1; }
	_autoRetryStrategy = strategy;
	const delay = strategy.getDelay(_autoRetryAttempt);
	ctx.ui.notify?.(`Auto-retry in ${(delay / 1000).toFixed(1)}s (attempt ${_autoRetryAttempt}/${strategy.maxAttempts})`, "info");
	_autoRetryTimer = setTimeout(() => {
		_autoRetryTimer = null;
		continueRetry(pi);
	}, delay);
	return delay;
}

/** Restart agent from scratch with the last user message (fresh turn). */
export function executeRetry(pi: ExtensionAPI): boolean {
	if (!_state.lastUserMessage) return false;
	const content: (import("@mariozechner/pi-ai").TextContent | import("@mariozechner/pi-ai").ImageContent)[] = [
		{ type: "text", text: _state.lastUserMessage.text },
	];
	if (_state.lastUserMessage.images?.length) content.push(..._state.lastUserMessage.images);
	pi.sendUserMessage(content);
	return true;
}

/** Send a retry message. For mid-chain failures, sends a contextual continuation
 *  nudge instead of the original user message (which is already in session history
 *  and meaningless at that point). For initial failures (agent never responded),
 *  re-sends the original user message. */
export function continueRetry(pi: ExtensionAPI): boolean {
	if (!_state.lastUserMessage) return false;

	if (_state.errorPhase === "mid_chain") {
		// Mid-chain: the original user message is already in session history.
		// Send a continuation nudge so the agent picks up where it left off.
		const errMsg = _state.lastError?.message ?? "unknown error";
		const snippet = errMsg.length > 200 ? errMsg.slice(0, 200) + "…" : errMsg;
		const attempt = _state.failureCount > 1 ? ` (attempt ${_state.failureCount})` : "";
		const text = `Continue from where you left off${attempt}. The last operation failed: ${snippet}\n\nResume the task.`;

		const content: import("@mariozechner/pi-ai").TextContent[] = [
			{ type: "text", text },
		];

		pi.sendUserMessage(content, { deliverAs: "steer" });
	} else {
		// Initial failure (agent never responded): re-send original message
		const content: (import("@mariozechner/pi-ai").TextContent | import("@mariozechner/pi-ai").ImageContent)[] = [
			{ type: "text", text: _state.lastUserMessage.text },
		];
		if (_state.lastUserMessage.images?.length) content.push(..._state.lastUserMessage.images);
		pi.sendUserMessage(content, { deliverAs: "steer" });
	}

	return true;
}

/** Clear any pending auto-retry timer and reset attempt count. */
export function clearAutoRetry(): void {
	if (_autoRetryTimer) { clearTimeout(_autoRetryTimer); _autoRetryTimer = null; }
	_autoRetryAttempt = 0;
	_autoRetryStrategy = null;
}

export function isAutoRetryPending(): boolean { return _autoRetryTimer !== null; }
export function getAutoRetryAttempt(): number { return _autoRetryAttempt; }
