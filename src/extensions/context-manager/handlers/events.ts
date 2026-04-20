// ── Context-Manager Event Handlers ───────────────────────────────────────────
// agent_end (retry handling), auto_retry_end (API errors), context (pruning workflow).

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { addEvidence } from "../../../lib/evidence-pool.js";
import { applyPruningWorkflow } from "../pruning.js";
import {
	log, getCmState,
	compactionRetryState, overflowRetryState,
	COMPACTION_RETRY_MAX_ATTEMPTS, OVERFLOW_RETRY_MAX_ATTEMPTS,
	COMPACTION_RETRY_CUSTOM_TYPE,
	resetCompactionRetry, resetOverflowRetry,
	getCompactionRetryDelay, getOverflowRetryDelay,
} from "./shared.js";

// ── Agent End Retry Handling ──────────────────────────────────────────────────
export function registerAgentEndRetryHandler(pi: any): void {
	pi.on("agent_end", async (event: any, ctx: any) => {
		try {
			const messages = event.messages;
			let hasRetryTrigger = false;
			let hasOverflowRetryTrigger = false;

			for (const msg of messages) {
				if (msg.role === "custom" && msg.customType === COMPACTION_RETRY_CUSTOM_TYPE) {
					hasRetryTrigger = true;
					break;
				}
				if (msg.role === "custom" && msg.customType === "__overflow_retry_trigger") {
					hasOverflowRetryTrigger = true;
				}
			}

			// Handle overflow retry
			if (hasOverflowRetryTrigger) {
				let lastAssistant: any = null;
				for (let i = messages.length - 1; i >= 0; i--) {
					if (messages[i].role === "assistant") { lastAssistant = messages[i]; break; }
				}

				if (lastAssistant && lastAssistant.stopReason !== "error" && lastAssistant.stopReason !== "aborted") {
					if (overflowRetryState.attempt > 0) {
						ctx.ui.notify(`Overflow recovery succeeded on attempt ${overflowRetryState.attempt}!`, "info");
					}
					resetOverflowRetry();
					return;
				}

				const errorMessage = lastAssistant?.errorMessage || overflowRetryState.lastError;
				if (overflowRetryState.attempt >= OVERFLOW_RETRY_MAX_ATTEMPTS) {
					resetOverflowRetry();
					return;
				}

				overflowRetryState.attempt++;
				overflowRetryState.lastError = errorMessage;
				const delayMs = getOverflowRetryDelay(overflowRetryState.attempt);
				ctx.ui.setStatus("context-manager", `Overflow recovery "${errorMessage}", retrying (${overflowRetryState.attempt}/${OVERFLOW_RETRY_MAX_ATTEMPTS}) in ${(delayMs / 1000).toFixed(0)}s...`);
				triggerOverflowRetryFromAgentEnd(pi, overflowRetryState.attempt, errorMessage, ctx);
				return;
			}

			if (!hasRetryTrigger) return;

			let lastAssistant: any = null;
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].role === "assistant") { lastAssistant = messages[i]; break; }
			}

			if (lastAssistant && lastAssistant.stopReason !== "error" && lastAssistant.stopReason !== "aborted") {
				if (compactionRetryState.attempt > 0) {
					ctx.ui.notify(`Compaction retry succeeded on attempt ${compactionRetryState.attempt}.`, "info");
				}
				resetCompactionRetry();
				return;
			}

			const errorMessage = lastAssistant?.errorMessage || compactionRetryState.lastError;
			if (compactionRetryState.attempt >= COMPACTION_RETRY_MAX_ATTEMPTS) {
				log.error(`Compaction retry exhausted after ${COMPACTION_RETRY_MAX_ATTEMPTS} attempts: ${errorMessage}`);
				ctx.ui.notify(`Compaction failed permanently after ${COMPACTION_RETRY_MAX_ATTEMPTS} retries: ${errorMessage}`, "error");
				ctx.ui.setStatus("context-manager", undefined);
				resetCompactionRetry();
				return;
			}

			compactionRetryState.attempt++;
			compactionRetryState.lastError = errorMessage;
			const delayMs = getCompactionRetryDelay(compactionRetryState.attempt);
			ctx.ui.setStatus("context-manager", `Compaction failed "${errorMessage}", retrying (${compactionRetryState.attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS}) in ${(delayMs / 1000).toFixed(0)}s...`);
			triggerCompactionRetryFromAgentEnd(pi, compactionRetryState.attempt, errorMessage);
		} catch (err) {
			log.error("agent_end retry error:", err);
		}
	});
}

// ── Auto-Retry End Event ──────────────────────────────────────────────────────
export function registerAutoRetryEndHandler(pi: any): void {
	pi.on("auto_retry_end" as any, async (event: any, _ctx: ExtensionContext) => {
		try {
			const { success, attempt, finalError } = event as { success?: boolean; attempt?: number; finalError?: string };
			if (!success) {
				pi.sendMessage(
					{
						customType: "context",
						content: [{
							type: "text" as const,
							text: [
								"## ⚠️ API retry failed after " + attempt + " attempt(s)",
								finalError ?? "Unknown error",
								"",
								"The API kept returning errors despite retries. Possible causes:",
								"- Rate limit (429) - wait a moment or switch models",
								"- Server error (500/502/503) - provider is having issues",
								"- Network error - check your connection",
								"",
								"Actions: Run `/model` to switch models, or wait and retry.",
							].join("\n"),
						}],
						display: true,
					},
					{ deliverAs: "steer" },
				);
			}
		} catch (err) {
			log.error("auto_retry_end error:", err);
		}
	});
}

// ── Context Event Handler (real pruning) ──────────────────────────────────────
export function registerContextPruningHandler(pi: any): void {
	pi.on("context", async (event: any, ctx: any) => {
		try {
			const messages = event.messages;
			if (!messages || messages.length === 0) return;
			const filtered = applyPruningWorkflow(getCmState(ctx).pruningState, messages);
			const pruned = messages.length - filtered.length;
			if (pruned > 0) {
				addEvidence(ctx, "context_pruned", "session", `Pruned ${pruned} messages from context`, 0.7);
			}
			return { messages: filtered };
		} catch (err) {
			log.error("context event error:", err);
		}
	});
}

// ── Retry trigger helpers (for agent_end) ─────────────────────────────────────
function triggerCompactionRetryFromAgentEnd(pi: any, attempt: number, errorMessage: string): void {
	if (compactionRetryState.retryTimeout) clearTimeout(compactionRetryState.retryTimeout);
	const delayMs = getCompactionRetryDelay(attempt);
	compactionRetryState.retryTimeout = setTimeout(() => {
		compactionRetryState.retryTimeout = null;
		pi.sendMessage(
			{
				customType: COMPACTION_RETRY_CUSTOM_TYPE,
				content: [{ type: "text" as const, text: `[Auto-retry] Compaction failed (${errorMessage}). Retrying... (${attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS})` }],
				display: false,
			},
			{ triggerTurn: true },
		);
	}, delayMs);
}

function triggerOverflowRetryFromAgentEnd(pi: any, attempt: number, errorMessage: string, _ctx: any): void {
	if (overflowRetryState.retryTimeout) clearTimeout(overflowRetryState.retryTimeout);
	const delayMs = getOverflowRetryDelay(attempt);
	overflowRetryState.retryTimeout = setTimeout(() => {
		overflowRetryState.retryTimeout = null;
		pi.sendMessage(
			{
				customType: "__overflow_retry_trigger",
				content: [{ type: "text" as const, text: `[Auto-retry] Overflow recovery (${errorMessage}). Retrying... (${attempt}/${OVERFLOW_RETRY_MAX_ATTEMPTS})` }],
				display: false,
			},
			{ triggerTurn: true },
		);
	}, delayMs);
}
