// ── Compaction Handler ────────────────────────────────────────────────────────
// Handles session_before_compact, session_compact, compaction_end, and retry logic.
// This is the core of context management — compaction quality directly affects
// agent performance on long sessions.
//
// Key improvements over v0.7:
// - Task-state-aware compaction instructions
// - Semantic preservation of tool call/result pairs
// - Better summarization guidance for the LLM

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { addEvidence } from "../../../lib/evidence-pool.js";
import { analyzeSession } from "../analysis.js";
import {
	log, getCmState, compactionRetryState, overflowRetryState, _compactedEntries,
	COMPACTION_RETRY_MAX_ATTEMPTS, OVERFLOW_RETRY_MAX_ATTEMPTS,
	OVERFLOW_RETRY_KEEP_REDUCTION_FACTOR, COMPACTION_RETRY_CUSTOM_TYPE,
	resetCompactionRetry, resetOverflowRetry,
	getCompactionRetryDelay, getOverflowRetryDelay,
	isTransientCompactionError,
} from "./shared.js";

// ── Compaction Instructions Builder ───────────────────────────────────────────
// Generates smarter instructions for the summarization model.
// The key insight: tell the model WHAT to preserve, not just "summarize".

function buildCompactionInstructions(audit: any): string[] {
	const instructions: string[] = [];

	// 1. Task state preservation
	if (audit.tagCount > 0) {
		instructions.push(`Session has ${audit.tagCount} checkpoint(s): preserve tag labels for navigation.`);
	}

	// 2. Prune candidates — tell model what to cut
	const highPriorityPrune = audit.candidates?.filter((c: any) => c.score >= 0.6) ?? [];
	if (highPriorityPrune.length > 3) {
		instructions.push(
			`${highPriorityPrune.length} entries are prune candidates with low semantic value — summarize briefly.`
		);
	}

	// 3. Context pressure — tell model how aggressive to be
	if (audit.usage.percent > 85) {
		instructions.push(
			`CRITICAL: Context at ${audit.usage.percent.toFixed(0)}% — aggressively summarize. ` +
			`Preserve: (1) active task/goals, (2) key file paths and edits, (3) error states. ` +
			`Discard: verbose tool outputs, repeated reads, exploration logs.`
		);
	} else if (audit.usage.percent > 70) {
		instructions.push(
			`Context at ${audit.usage.percent.toFixed(0)}% — moderate summarization. ` +
			`Keep: task context, recent decisions, pending work. Summarize: older tool outputs.`
		);
	}

	// 4. Semantic preservation rules
	instructions.push(
		"Preserve tool-call/result pairs together — never split a tool call from its result. " +
		"If a tool call produced an error, keep both the call and the error."
	);

	// 5. Memory hint
	instructions.push("After compaction: consider storing key learnings in memory for cross-session continuity.");

	return instructions;
}

// ── Session Before Compact ────────────────────────────────────────────────────
// Provides custom instructions before compaction for smarter summarization.

export function registerBeforeCompactHandler(pi: any): void {
	pi.on("session_before_compact", async (event: any, ctx: ExtensionContext) => {
		try {
			const audit = analyzeSession(ctx);
			const instructions = buildCompactionInstructions(audit);

			if (instructions.length > 0) {
				pi.sendMessage({
					customType: "context",
					display: true,
					content: [{ type: "text", text: `[COMPACTION_INSTRUCTIONS] ${instructions.join(" ")}` }],
				});
			}
		} catch (err) {
			log.error("session_before_compact error:", err);
		}
	});
}

// ── Session Compact (success only) ────────────────────────────────────────────
// session_compact fires ONLY on successful compaction.

export function registerSessionCompactHandler(pi: any): void {
	pi.on("session_compact", async (event: any, _ctx: ExtensionContext) => {
		try {
			const entry = event.compactionEntry;
			if (entry?.id) _compactedEntries.add(entry.id);

			if (entry) {
				addEvidence(_ctx, "context_compacted", "session",
					`Context compressed: ${entry.summary?.slice(0, 80) ?? "no summary"}`, 0.8);
			}
		} catch (err) {
			log.error("session_compact error:", err);
		}
	});
}

// ── Compaction End (all outcomes) ─────────────────────────────────────────────
// Handles ALL compaction outcomes including failures.

export function registerCompactionEndHandler(pi: any): void {
	pi.on("compaction_end" as any, async (event: any, _ctx: ExtensionContext) => {
		try {
			const { reason, willRetry, aborted, errorMessage, result } = event;

			// Overflow recovery failure
			if (reason === "overflow" && !willRetry && !aborted) {
				handleOverflowFailure(pi, event, errorMessage);
				return;
			}

			// Aborted
			if (aborted) {
				pi.sendMessage({
					customType: "context",
					content: [{ type: "text" as const, text: "Context compaction was aborted (no changes made)." }],
					display: true,
				}, { deliverAs: "steer" });
				return;
			}

			// Transient server error
			if (isTransientCompactionError(errorMessage)) {
				handleTransientError(pi, event, errorMessage);
				return;
			}

			// Threshold/manual compaction failure
			if ((reason === "threshold" || reason === "manual") && !result) {
				handleThresholdFailure(pi, event, errorMessage);
				return;
			}

			// Success — enforcement handles memory nudge via session_compact
		} catch (err) {
			log.error("compaction_end error:", err);
		}
	});
}

// ── Overflow Failure Handler ──────────────────────────────────────────────────
function handleOverflowFailure(pi: any, event: any, errorMessage?: string): void {
	const entryId = event.result?.firstKeptEntryId ?? event.compactionEntry?.id;
	const errMsg = errorMessage ?? "Compaction succeeded but the retry overflowed.";

	if (overflowRetryState.attempt < OVERFLOW_RETRY_MAX_ATTEMPTS) {
		_compactedEntries.add(entryId ?? "overflow-" + Date.now());

		const reducedKeep = Math.floor(20000 * Math.pow(OVERFLOW_RETRY_KEEP_REDUCTION_FACTOR, overflowRetryState.attempt));

		pi.sendMessage({
			customType: "context",
			content: [{
				type: "text" as const,
				text: [
					`## ⚠️ Context overflow recovery failed (attempt ${overflowRetryState.attempt + 1}/${OVERFLOW_RETRY_MAX_ATTEMPTS})`,
					errMsg, "",
					overflowRetryState.attempt === 0
						? "Retrying with more aggressive compaction..."
						: `Retrying with keep ≤${reducedKeep} tokens...`, "",
					"If this persists:",
					"1. Switch to a larger-context model",
					"2. Run `/model` to verify settings",
					"3. Store learnings in memory and start a new session",
				].join("\n"),
			}],
			display: true,
		}, { deliverAs: "steer" });

		triggerOverflowRetry(pi, overflowRetryState.attempt + 1, errMsg);
		return;
	}

	// Exhausted
	_compactedEntries.add(entryId ?? "overflow-" + Date.now());
	pi.sendMessage({
		customType: "context",
		content: [{
			type: "text" as const,
			text: [
				"## ⚠️ Context overflow recovery exhausted",
				errMsg, "",
				`After ${OVERFLOW_RETRY_MAX_ATTEMPTS} attempts, compaction cannot reduce context enough.`,
				"Consider switching models, starting a new session, or storing learnings in memory.",
			].join("\n"),
		}],
		display: true,
	}, { deliverAs: "steer" });
	resetOverflowRetry();
}

// ── Transient Error Handler ───────────────────────────────────────────────────
function handleTransientError(pi: any, event: any, errorMessage?: string): void {
	const errMsg = errorMessage ?? "Compaction threw an error.";

	if (compactionRetryState.attempt < COMPACTION_RETRY_MAX_ATTEMPTS) {
		compactionRetryState.attempt++;
		compactionRetryState.lastError = errMsg;
		compactionRetryState.lastReason = event.reason ?? "";

		pi.sendMessage({
			customType: "context",
			content: [{
				type: "text" as const,
				text: `⚠️ Server overload (${errMsg}). Auto-retrying... (${compactionRetryState.attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS})`,
			}],
			display: true,
		}, { deliverAs: "steer" });

		triggerCompactionRetry(pi, compactionRetryState.attempt, errMsg);
		return;
	}

	pi.sendMessage({
		customType: "context",
		content: [{
			type: "text" as const,
			text: `⚠️ Auto-compaction failed after retries (server overload): ${errMsg}`,
		}],
		display: true,
	}, { deliverAs: "steer" });
}

// ── Threshold Failure Handler ─────────────────────────────────────────────────
function handleThresholdFailure(pi: any, event: any, errorMessage?: string): void {
	const errMsg = errorMessage ?? "Compaction failed.";

	if (compactionRetryState.attempt < COMPACTION_RETRY_MAX_ATTEMPTS) {
		compactionRetryState.attempt++;
		compactionRetryState.lastError = errMsg;
		compactionRetryState.lastReason = event.reason ?? "";

		pi.sendMessage({
			customType: "context",
			content: [{
				type: "text" as const,
				text: `⚠️ Compaction failed (${errMsg}). Auto-retrying... (${compactionRetryState.attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS})`,
			}],
			display: true,
		}, { deliverAs: "steer" });

		triggerCompactionRetry(pi, compactionRetryState.attempt, errMsg);
		return;
	}

	pi.sendMessage({
		customType: "context",
		content: [{
			type: "text" as const,
			text: [
				"## ⚠️ Auto-compaction failed permanently",
				errMsg, "",
				"Consider: `/compact` manually, `context_checkout` with backup, or storing learnings in memory.",
			].join("\n"),
		}],
		display: true,
	}, { deliverAs: "steer" });
}

// ── Retry Trigger Functions ───────────────────────────────────────────────────
function triggerCompactionRetry(pi: any, attempt: number, errorMessage: string): void {
	clearCompactionRetry();
	const delayMs = getCompactionRetryDelay(attempt);

	compactionRetryState.retryTimeout = setTimeout(() => {
		compactionRetryState.retryTimeout = null;
		pi.sendMessage(
			{
				customType: COMPACTION_RETRY_CUSTOM_TYPE,
				content: [{
					type: "text" as const,
					text: `[Auto-retry] Compaction failed (${errorMessage}). Retrying... (${attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS})`,
				}],
				display: false,
			},
			{ triggerTurn: true },
		);
	}, delayMs);
}

function triggerOverflowRetry(pi: any, attempt: number, errorMessage: string, _reducedKeep?: number): void {
	clearOverflowRetryInternal();
	const delayMs = getOverflowRetryDelay(attempt);

	overflowRetryState.retryTimeout = setTimeout(() => {
		overflowRetryState.retryTimeout = null;
		pi.sendMessage(
			{
				customType: "__overflow_retry_trigger",
				content: [{
					type: "text" as const,
					text: `[Auto-retry] Overflow recovery (${errorMessage}). Retrying... (${attempt}/${OVERFLOW_RETRY_MAX_ATTEMPTS})`,
				}],
				display: false,
			},
			{ triggerTurn: true },
		);
	}, delayMs);
}

function clearCompactionRetry(): void {
	if (compactionRetryState.retryTimeout) clearTimeout(compactionRetryState.retryTimeout);
	compactionRetryState.retryTimeout = null;
}

function clearOverflowRetryInternal(): void {
	if (overflowRetryState.retryTimeout) clearTimeout(overflowRetryState.retryTimeout);
	overflowRetryState.retryTimeout = null;
}

// ── Context Event Handler (retry trigger cleanup) ─────────────────────────────
// Intercepts hidden retry triggers to clean them from context.

export function registerContextCleanupHandler(pi: any): void {
	pi.on("context", async (event: any) => {
		const messages = event.messages;
		let cleaned = false;
		const result = messages.map((msg: any) => {
			if (msg.role === "custom" && (
				msg.customType === COMPACTION_RETRY_CUSTOM_TYPE ||
				msg.customType === "__overflow_retry_trigger"
			)) {
				cleaned = true;
				return null;
			}
			return msg;
		}).filter(Boolean);

		if (cleaned) return { messages: result };
	});
}

// ── Turn End Retry Reset ──────────────────────────────────────────────────────
export function registerTurnEndRetryReset(pi: any): void {
	pi.on("turn_end", async () => {
		if (compactionRetryState.attempt > 0 && !compactionRetryState.retryTimeout) {
			resetCompactionRetry();
		}
	});
}
