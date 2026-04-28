/**
 * Retry Extension — /retry command + auto-retry for transient errors.
 *
 * Persists last user message via session custom entries (survives restart/resume),
 * provides manual /retry with error context display, and auto-retries transient
 * errors (network, 5xx) with configurable backoff.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InputEvent,
	AgentEndEvent,
	SessionStartEvent,
} from "@mariozechner/pi-coding-agent";

import { createLogger } from "../../../lib/logger.js";

import {
	type RetryConfig,
	classifyRetryError,
} from "./types.js";
import {
	initState,
	getState,
	recoverState,
	captureUserInput,
	recordAgentEnd,
	clearAutoRetry,
	isAutoRetryPending,
	getAutoRetryAttempt,
	scheduleAutoRetry,
	continueRetry,
} from "./state.js";

const log = createLogger("retry");

// ── Extension Factory ────────────────────────────────────────────────────────

export default async function retryExtension(pi: ExtensionAPI): Promise<void> {
	// ── Events ───────────────────────────────────────────────────────────

	// Recover persisted retry state on session start
	pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
		recoverState(ctx.sessionManager, ctx);
		const state = getState(ctx);
		if (state.lastUserMessage) log.info(`Recovered retry state: "${truncate(state.lastUserMessage.text, 60)}"`);
	});

	// Capture user input for potential retry (skip commands and shell invocations)
	pi.on("input", (event: InputEvent, ctx: ExtensionContext) => {
		if (event.text.startsWith("/") || event.text.startsWith("!")) return;
		captureUserInput(pi, event.text, event.images as any, undefined, ctx);
	});

	// tool_end no longer needs to capture failed tool name — /retry sends
	// a minimal steer regardless of which tool failed.

	// Detect errors on agent_end, record turn result, trigger auto-retry
	pi.on("agent_end", (event: AgentEndEvent, ctx: ExtensionContext) => {
		const messages = (event as any).messages as any[];
		if (!messages || messages.length === 0) return;

		// Fallback capture of last user message (only if `input` event was missed)
		let lastUserMsg: any = null;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") { lastUserMsg = messages[i]; break; }
		}
		if (lastUserMsg && !getState(ctx).lastUserMessage) {
			const text = typeof lastUserMsg.content === "string"
				? lastUserMsg.content
				: lastUserMsg.content?.find((c: any) => c.type === "text" && c.text)?.text ?? "";
			const imgs = Array.isArray(lastUserMsg.content)
				? lastUserMsg.content.filter((c: any) => c.type === "image")
				: undefined;
			if (text) captureUserInput(pi, text, imgs, lastUserMsg.id ?? null, ctx);
		}

		// Detect error from tool results (Priority 1) or assistant text (Priority 2)
		let errorMsg: string | null = null;
		for (const msg of messages) {
			if (msg.role === "tool" && msg.isError) {
				const text = typeof msg.content === "string"
					? msg.content
					: msg.content?.find((c: any) => c.type === "text" && c.text)?.text ?? "";
				if (text) { errorMsg = text; break; }
			}
		}
		if (!errorMsg) {
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].role === "assistant") {
					const text = typeof messages[i].content === "string"
						? messages[i].content
						: messages[i].content?.find((c: any) => c.type === "text" && c.text)?.text ?? "";
					if (text && classifyRetryError(text, null).category !== "unknown") {
						errorMsg = text; break;
					}
				}
			}
		}

		// Detect mid-chain: assistant/tool messages after the last user message?
		let hasPostUserAssistantMsgs = false;
		if (lastUserMsg) {
			const lastUserIdx = messages.lastIndexOf(lastUserMsg);
			for (let i = lastUserIdx + 1; i < messages.length; i++) {
				if (messages[i].role === "assistant" || messages[i].role === "tool") {
					hasPostUserAssistantMsgs = true;
					break;
				}
			}
		}

		recordAgentEnd(pi, lastUserMsg?.id ?? null, errorMsg !== null, errorMsg, null, hasPostUserAssistantMsgs, ctx);
		if (errorMsg) {
			const delay = scheduleAutoRetry(pi, ctx);
			if (delay > 0) log.info(`Auto-retry scheduled in ${delay}ms: ${truncate(errorMsg, 80)}`);
		}
	});

	// Capture HTTP status codes from provider responses
	pi.on("after_provider_response", (event: any, ctx: ExtensionContext) => {
		if (event.status >= 400) {
			const state = getState(ctx);
			if (state.lastError) state.lastError.httpStatus = event.status;
		}
	});

	// Forward visibility into built-in AgentSession auto-retry
	pi.on("auto_retry_start" as never, async (event: any, ctx: ExtensionContext) => {
		const attempt = event.attempt ?? 1;
		const delay = event.delay ?? 5000;
		ctx.ui.notify?.(`Auto-retrying (attempt ${attempt}) in ${(delay / 1000).toFixed(0)}s: ${truncate(event.message ?? "", 60)}`, "info");
	});
	pi.on("auto_retry_end" as never, async (event: any, ctx: ExtensionContext) => {
		if (event.success) ctx.ui.notify?.("Auto-retry successful.", "info");
		else ctx.ui.notify?.(`Auto-retry failed after ${event.attempt ?? "?"} attempts: ${truncate(event.finalError ?? "unknown error", 80)}`, "warning");
	});

	// ── Command: /retry ─────────────────────────────────────────────────

	pi.registerCommand("retry", {
		description: "Retry the last turn as a steer continuation.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const state = getState(ctx);

			if (isAutoRetryPending(ctx)) {
				ctx.ui.notify?.(`Auto-retry in progress (attempt ${getAutoRetryAttempt(ctx)}), waiting for it to finish.`, "warning");
				return;
			}
			if (!state.lastUserMessage) {
				ctx.ui.notify?.("Nothing to retry — no previous user message found.", "warning");
				return;
			}

			ctx.ui.notify?.(`Retrying: "${truncate(state.lastUserMessage.text, 100)}"`, "info");

			if (state.lastError) {
				const age = Math.round((Date.now() - state.lastError.timestamp) / 1000);
				const hints: Record<string, string> = {
					quota_exceeded: "add API keys or switch providers",
					auth_error: "check API keys",
					transient: "should work on retry",
					context_overflow: "conversation too long — compaction may help",
				};
				const hint = hints[state.lastError.category] ? ` (${hints[state.lastError.category]})` : "";
				ctx.ui.notify?.(
					`Error (${age}s ago): [${state.lastError.category}] ${truncate(state.lastError.message, 100)}${hint}`,
					state.lastError.category === "transient" ? "info" : "warning",
				);
			}
			if (state.failureCount > 0) {
				ctx.ui.notify?.(`Retry attempt #${state.failureCount + 1} for this turn.`, "info");
			}

			// Staleness check — don't retry messages older than 10 minutes
			if (state.lastUserMessage) {
				const lastTurnTs = state.lastTurn?.timestamp ?? 0;
				const lastErrorTs = state.lastError?.timestamp ?? 0;
				const lastActivity = Math.max(lastTurnTs, lastErrorTs);
				if (lastActivity > 0 && Date.now() - lastActivity > 10 * 60 * 1000) {
					ctx.ui.notify?.("Last message is too old (>10 min) to retry safely.", "warning");
					return;
				}
			}

			// Ensure agent is idle before sending (with timeout guard)
			try {
				if (!ctx.isIdle()) {
					await ctx.abort();
					await new Promise((r) => setTimeout(r, 100));
					await Promise.race([
						ctx.waitForIdle(),
						new Promise((_, reject) => setTimeout(() => reject(new Error("waitForIdle timeout")), 10000)),
					]);
				}
			} catch { /* best-effort */ }

			clearAutoRetry(ctx);
			try {
				if (!(await continueRetry(pi, ctx))) { ctx.ui.notify?.("Retry failed — no message to send.", "error"); return; }
				ctx.ui.notify?.("Retrying last turn.", "info");
			} catch (sendErr) {
				log.error(`Retry send failed: ${(sendErr as Error).message}`);
				ctx.ui.notify?.(`Retry failed: ${(sendErr as Error).message}`, "error");
			}
		},
	});

	// ── Command: /retry-status (debugging) ─────────────────────────────

	pi.registerCommand("retry-status", {
		description: "Show current retry state.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const state = getState(ctx);
			const parts: string[] = [];
			if (state.lastUserMessage) {
				parts.push(`Last message: "${truncate(state.lastUserMessage.text, 80)}"`);
				if (state.lastUserMessage.images?.length) parts.push(`  Images: ${state.lastUserMessage.images.length}`);
			} else { parts.push("No last message captured."); }
			if (state.lastError) {
				const age = Math.round((Date.now() - state.lastError.timestamp) / 1000);
				parts.push(`Last error (${age}s ago): [${state.lastError.category}] ${truncate(state.lastError.message, 120)}`);
			} else { parts.push("No last error."); }
			if (state.lastTurn) parts.push(`Last turn: ${state.lastTurn.hadError ? "FAILED" : "OK"} — entry: ${state.lastTurn.entryId}`);
			parts.push(`Failures: ${state.failureCount}`);
			parts.push(`Auto-retry pending: ${isAutoRetryPending(ctx)}`);
			parts.push(`Version: ${state.version}`);
			ctx.ui.notify?.(parts.join("\n"), "info");
		},
	});
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncate(s: string, maxLen: number): string {
	if (!s) return "";
	return s.length <= maxLen ? s : s.slice(0, maxLen - 3) + "...";
}
