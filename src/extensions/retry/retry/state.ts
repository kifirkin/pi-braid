/**
 * Retry state management with session-entry persistence.
 *
 * The retry state is persisted as __retry_state custom entries so it survives
 * session restores (/new, /resume, /tree navigation, pi restart).
 * On session_start, we recover lastUserMessage from the most recent valid
 * entry, falling back to the last user message in the session history.
 *
 * State is session-scoped via getExtensionState(ctx). Functions that receive
 * ctx use session-scoped state; internal helpers use the module-level default
 * (set once per process for the first session, then overridden by ctx calls).
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

import { getExtensionState } from "../../../lib/extension-state.js";
import { createLogger } from "../../../lib/logger.js";

const log = createLogger("retry");

// ── Session-Scoped State Shape ───────────────────────────────────────────────

interface RetrySessionState {
	state: RetryState;
	config: RetryConfig;
	activeStrategies: Map<string, RetryStrategy>;
	// Auto-retry management
	autoRetryTimer: ReturnType<typeof setTimeout> | null;
	autoRetryAttempt: number;
	autoRetryStrategy: RetryStrategy | null;
	// Persistence dedup
	lastPersistedHash: string;
}

function createEmptyState(): RetryState {
	return {
		lastUserMessage: null,
		lastUserEntryId: null,
		lastError: null,
		lastTurn: null,
		failureCount: 0,
		errorPhase: "initial",
		version: 4,
		// Turn at which lastUserMessage was captured — used to detect stale captures
		agentTurnAtCapture: -1,
	};
}

function createSessionState(config?: Partial<RetryConfig>): RetrySessionState {
	const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
	const strategies = new Map<string, RetryStrategy>();
	strategies.set(transientRetryStrategy.name, transientRetryStrategy);
	for (const s of (cfg.strategies ?? [])) {
		strategies.set(s.name, s);
	}
	return {
		state: createEmptyState(),
		config: cfg,
		activeStrategies: strategies,
		autoRetryTimer: null,
		autoRetryAttempt: 0,
		autoRetryStrategy: null,
		lastPersistedHash: "",
	};
}

/**
 * Get session-scoped state. Falls back to module-level default if no ctx.
 */
function getS(ctx?: ExtensionContext): RetrySessionState {
	if (ctx) return getExtensionState(ctx, "retry", () => createSessionState());
	// Fallback: module-level default for internal calls without ctx
	return _default;
}

// Module-level default for backwards compatibility (internal calls without ctx)
const _default = createSessionState();

// ── Public API — thin wrappers preserving original signatures ────────────────

export function initState(config?: Partial<RetryConfig>, ctx?: ExtensionContext): void {
	const s = getS(ctx);
	s.state = createEmptyState();
	s.config = { ...DEFAULT_RETRY_CONFIG, ...config };
	s.activeStrategies.clear();
	s.activeStrategies.set(transientRetryStrategy.name, transientRetryStrategy);
	for (const strat of (s.config.strategies ?? [])) {
		s.activeStrategies.set(strat.name, strat);
	}
}

export function getState(ctx?: ExtensionContext): RetryState {
	return getS(ctx).state;
}

export function getConfig(ctx?: ExtensionContext): RetryConfig {
	return getS(ctx).config;
}

// ── State Recovery from Session Entries ──────────────────────────────────────

const MAX_PERSISTED_STATE_AGE_MS = 5 * 60 * 1000; // 5 min
const MAX_MIDCHAIN_RESTORE_TURNS = 3; // Only restore mid_chain if within ~3 turns (90s)

/**
 * Recover retry state from session entries. Called on session_start.
 *
 * Recovery policy:
 * - mid_chain state: only restore if error is recent (within MAX_MIDCHAIN_RESTORE_TURNS).
 *   Otherwise reset to "initial" — the agent likely completed the task or started
 *   a new one while the session was suspended.
 * - "initial" state: restore normally (user message + any error)
 */
export function recoverState(sessionManager: { getEntries(): Array<any> }, ctx?: ExtensionContext): void {
	const s = getS(ctx);
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
						if (!saved.errorPhase) saved.errorPhase = "initial";
						bestEntry = saved;
					}
				}
			}
		}
		if (bestEntry && now - bestTimestamp < MAX_PERSISTED_STATE_AGE_MS) {
			// Bug fix: don't restore stale mid_chain state — the session may have
			// continued and completed the task while we were away. Only restore
			// mid_chain if the failure was recent.
			if (bestEntry.errorPhase === "mid_chain") {
				const ageMs = now - bestTimestamp;
				const maxAge = MAX_MIDCHAIN_RESTORE_TURNS * 30_000; // ~30s per turn estimate
				if (ageMs > maxAge) {
					// Stale mid_chain — reset to initial, preserve lastUserMessage only
					log.info(`recoverState: skipping stale mid_chain state (${Math.round(ageMs / 1000)}s old), resetting to initial`);
					s.state = { ...createEmptyState(), lastUserMessage: bestEntry.lastUserMessage };
					return;
				}
			}
			s.state = { ...createEmptyState(), ...bestEntry };
			return;
		}

		// Priority 2: last user message by timestamp
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
				s.state.lastUserMessage = { text, images: images?.length ? (images as any) : undefined };
				s.state.lastUserEntryId = msg.id ?? null;
			}
		}
	} catch {
		// Fail-safe — keep current state
	}
}

// ── State Persistence ────────────────────────────────────────────────────────

function stateHash(s: RetrySessionState): string {
	return JSON.stringify({
		m: s.state.lastUserMessage?.text ?? "",
		mi: s.state.lastUserMessage?.images?.length ?? 0,
		e: s.state.lastError?.message ?? "",
		ec: s.state.lastError?.category ?? "",
		et: s.state.lastError?.timestamp ?? 0,
		f: s.state.failureCount,
		p: s.state.errorPhase,
	});
}

export function persistState(pi: ExtensionAPI, ctx?: ExtensionContext): void {
	const s = getS(ctx);
	const h = stateHash(s);
	if (h === s.lastPersistedHash) return;
	s.lastPersistedHash = h;
	pi.appendEntry(RETRY_STATE_ENTRY_TYPE, {
		lastUserMessage: s.state.lastUserMessage,
		lastUserEntryId: s.state.lastUserEntryId,
		lastError: s.state.lastError,
		lastTurn: s.state.lastTurn,
		failureCount: s.state.failureCount,
		errorPhase: s.state.errorPhase,
		version: s.state.version,
		agentTurnAtCapture: s.state.agentTurnAtCapture,
	} satisfies RetryState);
}

// ── State Mutators ───────────────────────────────────────────────────────────

export function captureUserInput(pi: ExtensionAPI, text: string, images?: ImageContent[], entryId?: string, ctx?: ExtensionContext): void {
	const s = getS(ctx);
	// Never overwrite a mid-chain state — the agent was mid-task when it failed.
	// New user input should only replace lastUserMessage if the previous state
	// was a successful turn (errorPhase == "initial" or no error recorded).
	const safeToOverwrite = s.state.errorPhase === "initial" || !s.state.lastError;
	if (!safeToOverwrite) {
		// Log but don't overwrite — mid_chain state must be preserved
		log.debug("captureUserInput: blocked — mid-chain state active, not overwriting lastUserMessage");
		return;
	}
	s.state.lastUserMessage = { text, images: images?.length ? images : undefined };
	if (entryId) s.state.lastUserEntryId = entryId;
	// Record turn at capture so auto-retry can detect stale captures
	if (ctx) {
		s.state.agentTurnAtCapture = (ctx as any).currentTurn ?? -1;
	}
	persistState(pi, ctx);
}

export function recordAgentEnd(pi: ExtensionAPI, entryId: string | null, hadError: boolean, errorMessage?: string | null, httpStatus?: number | null, hasPostUserAssistantMsgs?: boolean, ctx?: ExtensionContext): void {
	const s = getS(ctx);
	if (hadError && errorMessage) {
		const classification = classifyRetryError(errorMessage, httpStatus ?? null);
		s.state.lastError = {
			message: errorMessage,
			category: classification.category,
			httpStatus: httpStatus ?? null,
			providerCode: null,
			timestamp: Date.now(),
		};
		s.state.failureCount++;
		s.state.errorPhase = hasPostUserAssistantMsgs ? "mid_chain" : "initial";
	} else {
		s.state.lastError = null;
		s.state.failureCount = 0;
		s.state.errorPhase = "initial";
	}
	if (entryId) {
		s.state.lastTurn = { entryId, timestamp: Date.now(), hadError };
	}
	persistState(pi, ctx);
}

export function resetState(pi: ExtensionAPI, ctx?: ExtensionContext): void {
	const s = getS(ctx);
	s.state = createEmptyState();
	clearAutoRetry(ctx);
	persistState(pi, ctx);
}

// ── Auto-Retry ───────────────────────────────────────────────────────────────

export function shouldAutoRetry(errorMessage: string, httpStatus: number | null, ctx?: ExtensionContext): RetryStrategy | null {
	const s = getS(ctx);
	const classification = classifyRetryError(errorMessage, httpStatus);
	for (const strategy of s.activeStrategies.values()) {
		if (strategy.shouldAutoRetry({
			message: errorMessage,
			category: classification.category,
			httpStatus,
			attempt: s.autoRetryAttempt + 1,
		})) return strategy;
	}
	return null;
}

export function scheduleAutoRetry(pi: ExtensionAPI, ctx: ExtensionContext): number {
	const s = getS(ctx);
	if (!s.config.autoRetryEnabled || !s.state.lastUserMessage) return -1;
	const classification = s.state.lastError
		? classifyRetryError(s.state.lastError.message, s.state.lastError.httpStatus)
		: null;
	if (!classification?.retryable) return -1;
	const strategy = shouldAutoRetry(s.state.lastError?.message ?? "", s.state.lastError?.httpStatus ?? null, ctx);
	if (!strategy) return -1;

	// Bug fix: Cancel pending auto-retry if a NEWER user input has arrived
	// since we captured lastUserMessage. The agent has moved on — don't retry
	// the stale turn. We detect this by comparing agentTurnAtCapture against
	// the current turn.
	if (s.state.agentTurnAtCapture >= 0) {
		const currentTurn = (ctx as any).currentTurn ?? s.state.agentTurnAtCapture;
		// If currentTurn is more than 1 ahead of captureTurn, new input has arrived
		if (currentTurn > s.state.agentTurnAtCapture + 1) {
			log.info(
				`Auto-retry suppressed: agent has moved on (captureTurn=${s.state.agentTurnAtCapture}, ` +
				`currentTurn=${currentTurn}). New user input has arrived since the failed turn.`,
			);
			clearAutoRetry(ctx);
			return -1;
		}
	}

	s.autoRetryAttempt++;
	if (s.autoRetryAttempt > strategy.maxAttempts) { clearAutoRetry(ctx); return -1; }
	s.autoRetryStrategy = strategy;
	const delay = strategy.getDelay(s.autoRetryAttempt);
	ctx.ui.notify?.(`Auto-retry in ${(delay / 1000).toFixed(1)}s (attempt ${s.autoRetryAttempt}/${strategy.maxAttempts})`, "info");
	s.autoRetryTimer = setTimeout(async () => {
		s.autoRetryTimer = null;
		try {
			await continueRetry(pi, ctx);
		} catch (e) {
			log.error("Auto-retry send failed:", e);
			ctx.ui.notify?.("Auto-retry failed: " + String(e), "error");
		}
	}, delay);
	return delay;
}

export async function continueRetry(pi: ExtensionAPI, ctx?: ExtensionContext): Promise<boolean> {
	const s = getS(ctx);
	if (!s.state.lastUserMessage) return false;

	// Minimal steer: just ask the agent to retry. The agent already has the
	// user message and error context in its conversation history. Re-sending
	// the raw message or verbose error context creates confusion.
	await pi.sendUserMessage([{ type: "text", text: "Try again." }], { deliverAs: "steer" });
	return true;
}

export function clearAutoRetry(ctx?: ExtensionContext): void {
	const s = getS(ctx);
	if (s.autoRetryTimer) { clearTimeout(s.autoRetryTimer); s.autoRetryTimer = null; }
	s.autoRetryAttempt = 0;
	s.autoRetryStrategy = null;
}

export function isAutoRetryPending(ctx?: ExtensionContext): boolean { return getS(ctx).autoRetryTimer !== null; }
export function getAutoRetryAttempt(ctx?: ExtensionContext): number { return getS(ctx).autoRetryAttempt; }
