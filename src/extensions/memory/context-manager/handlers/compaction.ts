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
import { addEvidence } from "../../../../lib/evidence-pool.js";
import { sendTrackedMessage } from "../../../../lib/injection-tracker.js";
import { analyzeSession } from "../analysis.js";
import {
	log, getCmState, compactionRetryState, overflowRetryState, _compactedEntries,
	COMPACTION_RETRY_MAX_ATTEMPTS, OVERFLOW_RETRY_MAX_ATTEMPTS,
	OVERFLOW_RETRY_KEEP_REDUCTION_FACTOR, COMPACTION_RETRY_CUSTOM_TYPE,
	resetCompactionRetry, resetOverflowRetry,
	getCompactionRetryDelay, getOverflowRetryDelay,
	isTransientCompactionError,
	isContextWindowError,
} from "./shared.js";
import { getRotationState } from "../../../../lib/global-state.js";
import { loadScratchpadFromDisk, projectSlugFromCwd, formatScratchpad } from "../../../../extensions/core/scratchpad/index.js";
import { filterSafeToRemove, type AgentMessage } from "../../../../lib/filter-safe-to-remove.js";
// ── Hard Truncation Summary Builder ───────────────────────────────────────────
// When the context is too large for the LLM to even receive the summarization
// prompt, we build a minimal summary locally from preparation data (previous
// summary + file ops) and return it as a custom compaction. This bypasses the
// LLM call entirely and prevents the death-spiral where retries add messages.
//
// CRITICAL FIX (v0.21): Previous versions dropped the agent's final response and
// user's follow-up from the summary. The session tail (last ~5 entries including
// the agent's last output + user's follow-up message) is read BEFORE pi compacts
// the context and passed in as recentEntries. This preserves conversation continuity
// so the agent knows what it just said and what was asked next.

interface RecentEntry {
	type: string;
	role?: string;
	content?: string;
	summary?: string;
}

async function buildHardTruncationSummary(
	previousSummary: string | undefined,
	fileOps: { readFiles?: string[]; modifiedFiles?: string[] },
	cwd?: string,
	recentEntries?: RecentEntry[],
): Promise<string> {
	const lines: string[] = [];

	// PRIORITY 1: Task state (must survive compaction at all costs)
	if (cwd) {
		try {
			const slug = projectSlugFromCwd(cwd);
			const pad = await loadScratchpadFromDisk(slug);
			if (pad && (pad.goal || pad.plan.length > 0)) {
				lines.push("## Active Task");
				lines.push(formatScratchpad(pad));
				lines.push("");
			}
		} catch {
			// Non-fatal — scratchpad may not exist
		}
	}

	if (previousSummary && previousSummary.trim().length > 0) {
		lines.push("## Previous Context");
		const trimmed = previousSummary.slice(0, 3000);
		lines.push(trimmed);
		if (previousSummary.length > 3000) {
			lines.push("... (truncated)");
		}
		lines.push("");
	}

	lines.push("## Note");
	lines.push("Session context exceeded model limits. Earlier work was compacted without LLM summarization to preserve recent context.");
	lines.push("");

	const readFiles = fileOps?.readFiles ?? [];
	const modifiedFiles = fileOps?.modifiedFiles ?? [];

	if (readFiles.length > 0 || modifiedFiles.length > 0) {
		lines.push("## File Activity");
		if (readFiles.length > 0) {
			lines.push("### Read");
			for (const f of readFiles.slice(-30)) {
				lines.push(`- ${f}`);
			}
		}
		if (modifiedFiles.length > 0) {
			lines.push("### Modified");
			for (const f of modifiedFiles.slice(-30)) {
				lines.push(`- ${f}`);
			}
		}
		lines.push("");
	}

	lines.push("## Next Steps");
	lines.push("Continue from the most recent context. Use `memory_recall` if specific details from earlier work are needed.");

	// FIX: Include conversation tail — agent's last response + user's follow-up
	// This was dropped in previous versions, causing agent to "forget" its last output.
	if (recentEntries && recentEntries.length > 0) {
		lines.push("");
		lines.push("## Recent Conversation (before compaction)");
		for (const entry of recentEntries.slice(-6)) {
			if (entry.type === "branch_summary" || entry.type === "compaction") {
				// Summaries from previous compaction cycles
				const text = entry.summary ?? "";
				if (text) {
					lines.push(`[PREVIOUS COMPACTION: ${text.slice(0, 200)}]`);
				}
			} else {
				const role = entry.role ?? "?";
				let text = entry.content ?? "";
				if (typeof text !== "string") text = JSON.stringify(text).slice(0, 200);
				if (text.length > 300) text = text.slice(0, 300) + "...";
				if (text.trim()) {
					const label = role === "assistant" ? "Agent" : role === "user" ? "You" : role;
					lines.push(`**${label}**: ${text}`);
				}
			}
		}
	}

	return lines.join("\n");
}

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
//
// FIX: Inject customInstructions into the event object so pi core passes them
// to compact(). Previously we called pi.sendMessage(display:true) which added
// the instructions as a conversation message — counted in token usage and
// staying in context after compaction (causing 266k→350k growth). Now we inject
// into the event so they go into the summarization prompt instead.

export function registerBeforeCompactHandler(pi: any): void {
	pi.on("session_before_compact", async (event: any, ctx: ExtensionContext) => {
		try {
			const usage = ctx.getContextUsage();
			const model = (ctx as any).model;
			const contextWindow = model?.contextWindow ?? usage?.contextWindow ?? 262_144;
			const usageTokens = usage?.tokens ?? 0;

			// STEP 1: Selective hard truncation — pre-filter 100%-certain-redundant items
			// This runs FIRST to reduce context size before LLM summarization.
			// If filtering helps enough, context drops below 70% → pi does normal LLM summarization.
			const prep = event.preparation;
			if (prep?.messagesToSummarize?.length) {
				const { filtered, stats } = filterSafeToRemove(prep.messagesToSummarize as AgentMessage[]);
				if (stats.totalRemoved > 0) {
					log.info(
						`[context-manager] Selective filtering: removed ${stats.totalRemoved} messages ` +
						`(from ${stats.beforeTokens} to ${stats.afterTokens} tokens, ` +
						`saved ~${Math.round((1 - stats.afterTokens / stats.beforeTokens) * 100)}%)`
					);
					// Update the mutable copy — pi will summarize the reduced list
					(prep as any).messagesToSummarize = filtered;
				}
			}

			// STEP 2: Check hard truncation threshold (70% of context window).
			// Previous 50% was too aggressive — sessions at 50-70% can usually use LLM summarization.
			// Only bypass LLM when context is truly unsafe (>=70%) or pi already has a summary
			// (meaning LLM summarization already ran; we shouldn't re-summarize).
			const threshold = Math.floor(contextWindow * 0.70);

			if (usage && usageTokens >= threshold && !event.preparation?.summary) {
				log.warn(
					`[context-manager] Hard truncation at ${(usageTokens / contextWindow * 100).toFixed(1)}% ` +
					`(${usageTokens}/${contextWindow} tokens) — firstKeptEntryId=null (summary only)`
				);

				// FIX: Read conversation tail BEFORE pi compacts the context.
				// We need the last ~6 entries so the summary includes the agent's final response
				// + user's follow-up (which would otherwise be lost with firstKeptEntryId=null).
				const sm = (ctx as any).sessionManager as { getBranch?(): Array<{ id?: string; entry?: { type?: string; id?: string; summary?: string; message?: { role?: string; content?: string | Array<{ text?: string }> } } }> } | undefined;
				const branch = sm?.getBranch?.() ?? [];
				const totalEntries = branch.length;
				const entriesToSummarize = event.preparation?.entryCount ?? Math.floor(totalEntries * 0.6);
				const survivors = branch.slice(-Math.min(6, Math.max(1, totalEntries - entriesToSummarize)));
				const recentEntries = survivors.map((e) => {
					const entry = e.entry ?? e as any;
					if (entry.type === "branch_summary" || entry.type === "compaction") {
						return { type: entry.type, summary: entry.summary ?? "" };
					}
					const msg = entry.message ?? {};
					const content = Array.isArray(msg.content)
						? (msg.content[0] as any)?.text ?? ""
						: (typeof msg.content === "string" ? msg.content : "");
					return { type: entry.type ?? "message", role: msg.role, content };
				});

				const previousSummary = event.preparation?.previousSummary ?? "";
				const fileOps = event.preparation?.fileOps ?? { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
				const readFiles = [...(fileOps.read ?? new Set())];
				const modifiedFiles = [...(fileOps.written ?? new Set()), ...(fileOps.edited ?? new Set())];
				const summary = await buildHardTruncationSummary(previousSummary, { readFiles, modifiedFiles }, ctx.cwd, recentEntries);

				return {
					compaction: {
						summary,
						firstKeptEntryId: null,
						tokensBefore: event.preparation?.tokensBefore ?? usageTokens,
						details: { readFiles, modifiedFiles },
					},
				};
			}

			const audit = analyzeSession(ctx);
			const instructions = buildCompactionInstructions(audit);

			if (instructions.length > 0) {
				// Inject into event so pi core picks it up in compact():
				//   const finalCustomInstructions = event.customInstructions ?? customInstructions;
				event.customInstructions = instructions.join(" ");
			}
		} catch (err) {
			log.error("session_before_compact error:", err);
		}
	});
}

// ── Session Compact (success only) ────────────────────────────────────────────
// session_compact fires ONLY on successful compaction.

export function registerSessionCompactHandler(pi: any): void {
	pi.on("session_compact", async (event: any, ctx: ExtensionContext) => {
		try {
			const entry = event.compactionEntry;
			if (entry?.id) _compactedEntries.add(entry.id);

			if (entry) {
				addEvidence(ctx, "context_compacted", "session",
					`Context compressed: ${entry.summary?.slice(0, 80) ?? "no summary"}`, 0.8);
			}

			// Clear overflow notification flag and retry guards on successful compaction
			const cmState = getCmState(ctx);
			cmState.overflowNotified = false;
			cmState.compactionRetryActive = false;
			cmState.overflowRetryActive = false;
		} catch (err) {
			log.error("session_compact error:", err);
		}
	});
}

// ── Compaction End (all outcomes) ─────────────────────────────────────────────
// Handles ALL compaction outcomes including failures.
// Key insight: pi core handles retry internally (willRetry flag). We only step in
// for cases where pi does NOT retry (permanent failure, user needs guidance).

export function registerCompactionEndHandler(pi: any): void {
	pi.on("compaction_end" as never, async (event: { reason?: string; willRetry?: boolean; aborted?: boolean; errorMessage?: string; result?: unknown; compactionEntry?: { id?: string; summary?: string }; firstKeptEntryId?: string }, _ctx: ExtensionContext) => {
		try {
			const { reason, willRetry, aborted, errorMessage, result } = event;

			// pi core is retrying — nothing to do, let pi handle it
			if (willRetry) {
				return;
			}

			// Aborted — user cancelled, no action needed
			if (aborted) {
				return;
			}

			// Context window error — context too large even for LLM summarization
			// Triggers emergency rotation immediately (handled inside)
			if (isContextWindowError(errorMessage)) {
				handleContextWindowError(pi, event, _ctx, errorMessage);
				return;
			}

			// Threshold/manual compaction failure (no result means it didn't succeed)
			if ((reason === "threshold" || reason === "manual") && !result) {
				handleThresholdFailure(pi, event, _ctx, errorMessage);
				return;
			}

			// Overflow recovery failure — pi couldn't reduce context enough
			if (reason === "overflow") {
				handleOverflowFailure(pi, event, _ctx, errorMessage);
				return;
			}

			// Transient server error (529, 500, network) — pi didn't retry
			if (isTransientCompactionError(errorMessage)) {
				handleTransientError(pi, event, _ctx, errorMessage);
				return;
			}

			// Success — enforcement handles memory nudge via session_compact event
		} catch (err) {
			log.error("compaction_end error:", err);
		}
	});
}

// ── Overflow Failure Handler ──────────────────────────────────────────────────
async function handleOverflowFailure(pi: any, event: any, ctx: ExtensionContext, errorMessage?: string): Promise<void> {
	const entryId = event.result?.firstKeptEntryId ?? event.compactionEntry?.id;
	const errMsg = errorMessage ?? "Compaction succeeded but the retry overflowed.";

	// Emergency rotation guard: if context is critically full, trigger rotation instead of retry
	try {
		const analysis = await analyzeSession(ctx);
		if (analysis.usage.percent >= 75) {
			log.warn(`[Critical] Context at ${analysis.usage.percent.toFixed(1)}% - triggering emergency rotation (overflow)`);

			const rotationModule = await import("./rotation.js");
			const triggerEmergencyRotation = rotationModule?.triggerEmergencyRotation;
			if (triggerEmergencyRotation) {
				triggerEmergencyRotation(pi, ctx);
			}

			log.warn("[Critical] Emergency rotation triggered, skipping overflow retry");
			return;
		}
	} catch (e) {
		// Analysis failed — but check error message directly for context window error
		if (isContextWindowError(errMsg)) {
			log.warn(`[Critical] Context window error detected directly — triggering emergency rotation`);
			const rotationModule = await import("./rotation.js");
			const triggerEmergencyRotation = rotationModule?.triggerEmergencyRotation;
			if (triggerEmergencyRotation) {
				triggerEmergencyRotation(pi, ctx);
				log.warn("[Critical] Emergency rotation triggered from overflow handler");
				return;
			}
		}
		log.debug("[Overflow] Analysis skipped (state not available yet)");
	}

	if (overflowRetryState.attempt < OVERFLOW_RETRY_MAX_ATTEMPTS) {
		_compactedEntries.add(entryId ?? "overflow-" + Date.now());

		const reducedKeep = Math.floor(20000 * Math.pow(OVERFLOW_RETRY_KEEP_REDUCTION_FACTOR, overflowRetryState.attempt));

		sendTrackedMessage(
			pi,
			{
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
			},
			{ deliverAs: "hint" },
			{ type: "context", source: "context-manager/compaction/overflow" },
		);

		triggerOverflowRetry(pi, ctx, overflowRetryState.attempt + 1, errMsg);
		return;
	}

	// Exhausted
	_compactedEntries.add(entryId ?? "overflow-" + Date.now());
	sendTrackedMessage(
		pi,
		{
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
		},
		{ deliverAs: "hint" },
		{ type: "context", source: "context-manager/compaction/overflow-exhausted" },
	);
	resetOverflowRetry();
}

// ── Transient Error Handler ───────────────────────────────────────────────────
async function handleTransientError(pi: any, event: any, ctx: ExtensionContext, errorMessage?: string): Promise<void> {
	const errMsg = errorMessage ?? "Compaction threw an error.";

	// Emergency rotation guard: if context is critically full, trigger rotation and skip retry
	try {
		const analysis = await analyzeSession(ctx);
		if (analysis.usage.percent >= 75) {
			log.warn(`[Critical] Context at ${analysis.usage.percent.toFixed(1)}% - triggering emergency rotation (transient error)`);

			const rotationModule = await import("./rotation.js");
			const triggerEmergencyRotation = rotationModule?.triggerEmergencyRotation;
			if (triggerEmergencyRotation) {
				triggerEmergencyRotation(pi, ctx);
			}

			log.warn("[Critical] Emergency rotation triggered, skipping compaction retry");
			return;
		}
	} catch (e) {
		log.debug("[Transient] Analysis skipped (state not available yet)");
	}

	if (compactionRetryState.attempt < COMPACTION_RETRY_MAX_ATTEMPTS) {
		compactionRetryState.attempt++;
		compactionRetryState.lastError = errMsg;
		compactionRetryState.lastReason = event.reason ?? "";

		sendTrackedMessage(
			pi,
			{
				customType: "context",
				content: [{
					type: "text" as const,
					text: `⚠️ Server overload (${errMsg}). Auto-retrying... (${compactionRetryState.attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS})`,
				}],
				display: true,
			},
			{ deliverAs: "hint" },
			{ type: "context", source: "context-manager/compaction/transient" },
		);

		triggerCompactionRetry(pi, ctx, compactionRetryState.attempt, errMsg);
		return;
	}

	sendTrackedMessage(
		pi,
		{
			customType: "context",
			content: [{
				type: "text" as const,
				text: `⚠️ Auto-compaction failed after retries (server overload): ${errMsg}`,
			}],
			display: true,
		},
		{ deliverAs: "hint" },
		{ type: "context", source: "context-manager/compaction/transient-exhausted" },
	);
}

// ── Context Window Error Handler ──────────────────────────────────────────────
// When the LLM cannot even receive the compaction prompt because the session is too long,
// we skip LLM summarization and fall back to hard truncation + emergency rotation.
async function handleContextWindowError(pi: any, _event: any, ctx: ExtensionContext, errorMessage?: string): Promise<void> {
	const errMsg = errorMessage ?? "Context window limit exceeded during compaction.";
	log.warn(`[Critical] ${errMsg}`);

	// Attempt emergency rotation immediately — this branches the session with a summary
	// and truncates the conversation, freeing up context.
	try {
		const rotationModule = await import("./rotation.js");
		const triggerEmergencyRotation = rotationModule?.triggerEmergencyRotation;
		if (triggerEmergencyRotation) {
			triggerEmergencyRotation(pi, ctx);
			log.info("[ContextWindow] Emergency rotation triggered successfully");
			return;
		}
	} catch (e) {
		log.error("[ContextWindow] Failed to trigger emergency rotation:", e);
	}

	// If emergency rotation fails, inform the user
	sendTrackedMessage(
		pi,
		{
			customType: "context",
			content: [{
				type: "text" as const,
				text: [
					"## ⚠️ Session too large",
					errMsg, "",
					"The session cannot be compacted because it exceeds the model's context limit.",
					"Please use `finalize()` to rotate the session, or `context_compress(start, end, summary)` to archive older work.",
				].join("\n"),
			}],
			display: true,
		},
		{ deliverAs: "hint" },
		{ type: "context", source: "context-manager/compaction/context-window" },
	);
}

// ── Threshold Failure Handler ─────────────────────────────────────────────────
async function handleThresholdFailure(pi: any, event: any, ctx: ExtensionContext, errorMessage?: string): Promise<void> {
	const errMsg = errorMessage ?? "Compaction failed.";

	// Emergency rotation guard: if context is critically full (>75%), trigger rotation instead of retry
	try {
		const analysis = await analyzeSession(ctx);
		if (analysis.usage.percent >= 75) {
			log.warn(`[Critical] Context at ${analysis.usage.percent.toFixed(1)}% - triggering emergency rotation (threshold)`);

			const rotationModule = await import("./rotation.js");
			const triggerEmergencyRotation = rotationModule?.triggerEmergencyRotation;
			if (triggerEmergencyRotation) {
				triggerEmergencyRotation(pi, ctx);
			}

			log.warn("[Critical] Emergency rotation triggered, skipping threshold retry");
			return;
		}
	} catch (e) {
		log.debug("[Threshold] Analysis skipped (state not available yet)");
	}

	if (compactionRetryState.attempt < COMPACTION_RETRY_MAX_ATTEMPTS) {
		compactionRetryState.attempt++;
		compactionRetryState.lastError = errMsg;
		compactionRetryState.lastReason = event.reason ?? "";

		sendTrackedMessage(
			pi,
			{
				customType: "context",
				content: [{
					type: "text" as const,
					text: `⚠️ Compaction failed (${errMsg}). Auto-retrying... (${compactionRetryState.attempt}/${COMPACTION_RETRY_MAX_ATTEMPTS})`,
				}],
				display: true,
			},
			{ deliverAs: "hint" },
			{ type: "context", source: "context-manager/compaction/threshold" },
		);

		triggerCompactionRetry(pi, ctx, compactionRetryState.attempt, errMsg);
		return;
	}

	sendTrackedMessage(
		pi,
		{
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
		},
		{ deliverAs: "hint" },
		{ type: "context", source: "context-manager/compaction/threshold-exhausted" },
	);
}

// ── Retry Trigger Functions ───────────────────────────────────────────────────
function triggerCompactionRetry(pi: any, ctx: ExtensionContext, attempt: number, errorMessage: string): void {
	clearCompactionRetry();
	const delayMs = getCompactionRetryDelay(attempt);

	compactionRetryState.retryTimeout = setTimeout(() => {
		compactionRetryState.retryTimeout = null;

		// Guard: if another retry is already active, skip this one
		const cmState = getCmState(ctx);
		if (cmState.compactionRetryActive) {
			log.info("[Compaction] Retry skipped - already active");
			resetCompactionRetry();
			return;
		}
		cmState.compactionRetryActive = true;

		pi.compact();
	}, delayMs);
}

function triggerOverflowRetry(pi: any, ctx: ExtensionContext, attempt: number, errorMessage: string, reducedKeep?: number): void {
	clearOverflowRetryInternal();
	const delayMs = getOverflowRetryDelay(attempt);

	overflowRetryState.retryTimeout = setTimeout(() => {
		overflowRetryState.retryTimeout = null;

		// Guard: if another retry is already active, skip this one
		const cmState = getCmState(ctx);
		if (cmState.overflowRetryActive) {
			log.info("[Overflow] Retry skipped - already active");
			resetOverflowRetry();
			return;
		}
		cmState.overflowRetryActive = true;

		pi.compact({ keep: reducedKeep });
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

// ── Context Cleanup Retry Reset ────────────────────────────────────────────
export function registerContextCleanupHandler(pi: any): void {
	pi.on("context_cleanup", async (_event: any, ctx: ExtensionContext) => {
		// Reset retry guards when context is cleaned up to prevent stale state
		const cmState = getCmState(ctx);
		cmState.compactionRetryActive = false;
		cmState.overflowRetryActive = false;
		log.debug("[Cleanup] Retry guards reset on context cleanup");
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
