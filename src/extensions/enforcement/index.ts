/**
 * Enforcement Extension - Smart Nudge Delivery with Semantic Interrupts
 *
 * Signal Architecture (Cognitive Context Architecture):
 * - L1 (Internal): Tool usage, context hygiene, turn validation tracked in state only
 * - L2 (Structured hints): Bundled per-turn into a SINGLE Session Signals nudge
 * - L3 (Critical): Overflow failures, infrastructure errors, dangerous commands
 *   that passed review — individual visible messages with semantic framing
 *
 * Key design: Agent gets ONE [auto] message per turn max for non-critical signals.
 * Critical signals (L3) get their own messages because they require immediate action.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { detectMalformedToolCalls } from "./detection/malformed.js";
import {
	detectMissingVerification,
	recordCodeChange as detectRecordCodeChange,
} from "./detection/verification.js";
import { checkBlocking } from "./handlers/blocking.js";
import { recordBashDetails, recordToolCall, recordToolInput } from "./handlers/tool-tracker.js";
import { analyzeWithJudge } from "./judge.js";
import { NudgeManager } from "./nudge-manager.js";
import { state } from "./state.js";
import type { TurnState } from "./types.js";
import { validateToolForPhase, validateTurn } from "./validation.js";
import { formatVerificationNudge, type JudgeContext, runVerificationJudge } from "./verification-judge.js";
import {
	clearPendingBlockAction,
	getPendingBlockAction,
	queueEnforcementWhisper,
	sendEnforcementWhisper,
} from "./whisper.js";

// Extension Factory
export default function enforcementExtension(pi: ExtensionAPI) {
	const nudgeManager = new NudgeManager();

	// ── before_agent_start ─────────────────────────────────────────────────────
	// Minimal: only handle block actions. All verbose enforcement prose is gone.
	// Non-critical signals → bundled Session Signals nudge (turn_end).
	// Critical signals (L3) → individual sendEnforcementWhisper (turn_end).
	pi.on("before_agent_start", async (event) => {
		if (!state.enforcementActive) {
			return;
		}

		state.currentTurn++;

		// Block action must surface via system prompt — whisper would trigger a new turn
		const pendingBlock = getPendingBlockAction();
		clearPendingBlockAction();

		if (pendingBlock) {
			return {
				systemPrompt: `${event.systemPrompt}\n\n### BLOCKED ACTION\n${pendingBlock.reason}`,
			};
		}
	});

	// ── tool_call ────────────────────────────────────────────────────────────
	pi.on("tool_call", async (event) => {
		if (!state.enforcementActive) {
			return undefined;
		}

		const toolName = event.toolName;
		const input = event.input as Record<string, unknown> | undefined;

		recordToolCall(toolName);
		recordToolInput(toolName, input);

		if (toolName === "bash") {
			const cmd = (input as { command?: string } | undefined)?.command || "";
			recordBashDetails(cmd);
		}

		if (toolName === "edit" || toolName === "write") {
			detectRecordCodeChange(state.currentTurn);
			state.hasCodeChanges = true;
		}

		state.toolLog.push(`${toolName}`);

		// Blocking enforcement
		const blockResult = checkBlocking(pi, toolName, input, state);
		if (blockResult.blocked) {
			return { block: true, reason: blockResult.reason };
		}

		// Phase validation nudge
		const { message } = validateToolForPhase(toolName, state.currentTurn);
		if (message) {
			const now = Date.now();
			if (now - state.lastNudgeTime > state.nudgeCooldownMs) {
				state.lastNudgeTime = now;
				queueEnforcementWhisper(message);
			}
		}

		return undefined;
	});

	// ── turn_end ─────────────────────────────────────────────────────────────
	// Bundle all non-critical signals into ONE structured nudge.
	// L3 critical signals sent individually.
	pi.on("turn_end", async (event) => {
		if (!state.enforcementActive) {
			return;
		}

		const actualTools = (event.toolResults || []).map((r) => r.toolName);
		const erroredTools = new Set(
			(event.toolResults || []).filter((r) => r.isError).map((r) => r.toolName),
		);
		const hadErrors = erroredTools.size > 0;

		// Detect context overflow — suppress L2 signals during recovery so the agent
		// gets breathing room to stabilize after compaction/retry.
		const isOverflowTurn =
			event.message.role === "assistant" &&
			"stopReason" in event.message &&
			(event.message as { stopReason?: string }).stopReason === "error" &&
			((event.message as any).content || [])
				.flat()
				.filter((c: any) => c?.type === "text")
				.map((c: any) => c?.text || "")
				.join(" ")
				.toLowerCase()
				.includes("context") &&
			((event.message as any).content || [])
				.flat()
				.filter((c: any) => c?.type === "text")
				.map((c: any) => c?.text || "")
				.join(" ")
				.toLowerCase()
				.includes("overflow");

		if (isOverflowTurn) {
			state.overflowRecently = state.currentTurn;
		}

		// Track code changes
		if (actualTools.some((t) => ["edit", "write"].includes(t))) {
			detectRecordCodeChange(state.currentTurn);
		}

		// Track memory/context tools
		detectMissingVerification(pi as never, state.currentTurn);

		const scratchpadUpdated = actualTools.includes("scratchpad");
		if (scratchpadUpdated) {
			state.lastScratchpadNudgeTurn = -100;
		}

		const memoryUpdated = actualTools.some((t) =>
			["memory_store", "memory_recall", "memory_list"].includes(t),
		);
		if (!memoryUpdated) {
			if (actualTools.length > 0 && !hadErrors) {
				state.turnsSinceMemory++;
			}
		} else {
			state.turnsSinceMemory = 0;
		}

		const turnState: TurnState = {
			turnIndex: state.currentTurn,
			plannedTools: [],
			actualTools,
			scratchpadUpdated,
			memoryUpdated,
			sequenceRepetitionCount: 0,
			thinkCalledBeforeEdit: state.toolChain.lastThinkCall >= state.currentTurn - 2,
			planCalledForBugFix: state.toolChain.lastPlanCall >= state.currentTurn - 3,
		};

		state.turnHistory.set(state.currentTurn, turnState);

		if (state.turnHistory.size > 50) {
			const oldest = Math.min(...state.turnHistory.keys());
			state.turnHistory.delete(oldest);
		}

		// ── L3: Critical signals — individual, semantic ────────────────────────

		if (erroredTools.size > 0) {
			state.lastFailedToolTurn = state.currentTurn;
		}

		// Infrastructure error (no tools ran but assistant responded — not silent)
		const isInfrastructureError =
			actualTools.length === 0 &&
			event.message.role === "assistant" &&
			"stopReason" in event.message &&
			(event.message as { stopReason?: string }).stopReason === "error";

		// Validation failures → L3 if critical
		const prevTurn = state.turnHistory.get(state.currentTurn - 1);
		const validation = validateTurn(prevTurn, turnState, erroredTools, isInfrastructureError);

		if (!validation.passed && validation.nudge && !hadErrors) {
			const { shouldSend, escalated } = nudgeManager.shouldSendNudge("validation", validation.nudge);
			if (shouldSend) {
				sendEnforcementWhisper(
					pi,
					escalated
						? `**Escalated:** ${validation.nudge}`
						: validation.nudge,
				);
			}
		}

		// Failure recording nudge → L3
		const FAILURE_RECORD_THRESHOLD_TURNS = 3;
		if (erroredTools.size > 0 && !state.hasRecordedFailure) {
			const turnsSinceError = state.currentTurn - state.lastFailedToolTurn;
			if (turnsSinceError >= FAILURE_RECORD_THRESHOLD_TURNS) {
				const now = Date.now();
				if (now - state.lastNudgeTime > state.nudgeCooldownMs) {
					state.lastNudgeTime = now;
					state.hasRecordedFailure = true;
					const errorList = Array.from(erroredTools).join(", ");
					sendEnforcementWhisper(
						pi,
						`${errorList} failed. Record this to avoid repeating: ` +
							`memory_store(content="Error with ${errorList}: [what went wrong and fix]", tags=["error"])`,
					);
				}
			}
		}

		// ── L2: Non-critical signals → bundled Session Signals nudge ─────────

		// Collect signals for the bundled nudge
		const sessionSignals: string[] = [];

		// Memory signal: fires on EVENT basis, not schedule.
		// Trigger: code changed after last memory usage (not just turns elapsed).
		// The session_compact handler fires the primary compaction memory signal.
		// Skip during overflow recovery — agent needs breathing room to stabilize.
		const RECOVERY_GRACE_TURNS = 5;
		const inOverflowRecovery = state.currentTurn - state.overflowRecently < RECOVERY_GRACE_TURNS;

		if (
			!hadErrors &&
			!inOverflowRecovery &&
			state.config.enforceMemory &&
			state.hasCodeChanges &&
			state.turnsSinceMemory >= 20 && // only after substantial work without memory
			!state.memoryNudgeSent
		) {
			state.memoryNudgeSent = true;
			sessionSignals.push(
				"Code changed but nothing stored. Capture the key pattern or fix: " +
				"memory_store(content=\"...\", tags=[\"pattern\", \"fix\"])",
			);
		}

		// Context tool signal: REMOVED.
		// Interval-based "use context tools" nudges are wrong signal — they fire on
		// enforcement turn count, not user-perceived progress. Context hygiene is already
		// covered by the context usage nudge (75%/85%) below.

		// Scratchpad signal: code changed but scratchpad not updated
		// Skip during overflow recovery — agent needs breathing room to stabilize.
		if (
			!hadErrors &&
			!inOverflowRecovery &&
			state.config.enforceScratchpad &&
			actualTools.some((t) => ["edit", "write"].includes(t)) &&
			!scratchpadUpdated
		) {
			// Only signal if we haven't done so recently
			if (state.currentTurn - state.lastScratchpadNudgeTurn >= 8) {
				state.lastScratchpadNudgeTurn = state.currentTurn;
				sessionSignals.push(
					`Code changed without updating scratchpad — consider scratchpad(action="add_note", text="...") or scratchpad(action="add_decision", text="...")`,
				);
			}
		}

		// Context usage signal (only at high usage — semantic, not metric)
		if (actualTools.some((t) =>
			["context_tag", "context_log", "context_checkout", "context_prune", "context_audit"].includes(t),
		)) {
			state.lastContextCheckTurn = state.currentTurn;
			state.contextNudgeSent = false;
		}

		let usagePercent = 0;
		try {
			const ctxFromEvent = (event as any)?.ctx;
			const usage = ctxFromEvent?.getContextUsage?.();
			if (usage) usagePercent = usage.percent ?? 0;
		} catch { /* ignore */ }

		if (
			!hadErrors &&
			actualTools.length > 0 &&
			state.currentTurn - state.lastContextCheckTurn >= state.contextCheckInterval &&
			!state.contextNudgeSent &&
			usagePercent > 0
		) {
			state.contextNudgeSent = true;

			if (usagePercent > 85) {
				sessionSignals.push(
					"Context at critical levels — run /compact or use context_checkout to branch before continuing",
				);
			} else if (usagePercent > 75) {
				sessionSignals.push(
					"Context getting high — consider /compact or context_tag to mark progress",
				);
			}
			// Below 75%: no signal — not actionable enough to bother
		}

		// Send bundled nudge if we have signals AND no L3 critical message just went out
		if (sessionSignals.length > 0) {
			const bundled = `[Session Signals]\n${sessionSignals.map((s) => `- ${s}`).join("\n")}`;
			const { shouldSend } = nudgeManager.shouldSendNudge("scratchpad", bundled);
			if (shouldSend) {
				sendEnforcementWhisper(pi, bundled);
			}
		}
	});

	// ── session_compact ────────────────────────────────────────────────────────
	// L3: Compaction happened — harness-level minimum-fidelity trigger.
	// Key learnings from scratchpad must be persisted before they get lost.
	pi.on("session_compact" as any, async (event: any, ctx: any) => {
		if (!state.enforcementActive) return;

		const compactTurn = state.currentTurn;

		try {
			const scratchpadResult = await ctx.tools.scratchpad?.({ action: "read" });
			const details = (scratchpadResult as any)?.details;
			const learnings = details?.key_learnings ?? [];
			const unpersisted = (learnings as any[]).filter((l: any) => !l.persisted);

			if (unpersisted.length > 0) {
				// L3: Individual message — compaction means context is about to lose these
				sendEnforcementWhisper(
					pi,
					`Context compacted at turn ${compactTurn}. ` +
					`${unpersisted.length} key learning(s) not yet persisted — these will be harder to recover:

` +
					unpersisted
						.map((l: any) => `- memory_store(content="${l.content}", memoryType="insight", tags=["${l.category}", "session"])`)
						.join("\n") +
					`

Persist them now — this is the minimum-fidelity moment.`,
				);
			}

			// Reset hygiene counters — compaction resets context, agent needs fresh start.
			// Rebase turn-based cooldown anchors to currentTurn so agent isn't nudged
			// before it starts working post-compaction.

			state.contextNudgeSent = false;
			state.lastContextCheckTurn = state.currentTurn;
			state.lastCompactionTurn = compactTurn;
			state.lastScratchpadNudgeTurn = state.currentTurn;
			state.overflowRecently = state.currentTurn; // Extend grace period through recovery

			// Reset memory tracking — fire on NEW code changes post-compaction only
			state.hasCodeChanges = false;
			state.lastCodeChangeTurn = 0;
			state.memoryNudgeSent = false;
			state.turnsSinceMemory = 0;
		} catch {
			// Silent fail — don't block on scratchpad read
		}
	});

	// ── auto_retry_end ────────────────────────────────────────────────────────
	// L3: Infrastructure errors from retry failures → individual, semantic
	pi.on("auto_retry_end" as any, async (event: any, _ctx: any) => {
		if (!state.enforcementActive) return;

		const { success, attempt, finalError } = event;

		if (!success) {
			state.validationFailures++;

			const now = Date.now();
			if (now - state.lastNudgeTime < state.nudgeCooldownMs) return;
			state.lastNudgeTime = now;

			const errorType = _classifyRetryError(finalError ?? "");

			let msg = "";
			if (errorType === "rate_limit") {
				msg = `Rate limit after ${attempt} retry(s). Switch model with /model or wait.`;
			} else if (errorType === "server_error") {
				msg = `Server error after ${attempt} retry(s) (${finalError}). Provider may be overloaded.`;
			} else if (errorType === "network") {
				msg = `Network error after ${attempt} retry(s). Check your connection.`;
			} else {
				msg = `API error after ${attempt} retry(s): ${finalError ?? "unknown"}.`;
			}

			sendEnforcementWhisper(
				pi,
				`## ⚠️ ${msg}\n\nStore for reference: memory_store(content="API error: ${finalError}", tags=["error", "api"])`,
			);
		}
	});

	// ── message_end ────────────────────────────────────────────────────────────
	pi.on("message_end", async (event, ctx) => {
		if (!state.enforcementActive) {
			return;
		}

		if (event.message.role !== "assistant") {
			return;
		}

		const textContent = event.message.content
			.filter((c) => c.type === "text")
			.map((c) => (c as { type: "text"; text: string }).text)
			.join("\n");

		const thinkingContent = event.message.content
			.filter((c) => c.type === "thinking")
			.map((c) => (c as { type: "thinking"; thinking: string }).thinking)
			.join("\n");

		const fullContent = thinkingContent
			? `## REASONING\n${thinkingContent}\n\n## RESPONSE\n${textContent}`
			: textContent;

		if (textContent.length < 100) {
			return;
		}

		const turnState = state.turnHistory.get(state.currentTurn);
		if (turnState) {
			detectMalformedToolCalls(textContent, pi);
		}

		// Skip verification judge if already running
		if (state.verificationJudgeRunning) {
			return;
		}

		const userHasBash = Array.from(state.uniqueToolsUsed).includes("bash");

		const VERIFICATION_GAP_TURNS = state.config.verifyAfterCodeChanges ? 8 : Infinity;
		const turnsSinceCodeChange = state.currentTurn - state.lastVerificationJudgeTurn;
		const hasVerificationGap =
			state.hasCodeChanges && !userHasBash && turnsSinceCodeChange >= VERIFICATION_GAP_TURNS;

		const isPeriodicCheck =
			state.config.verificationJudgeInterval > 0 &&
			state.hasCodeChanges &&
			state.currentTurn - state.lastVerificationJudgeTurn >= state.config.verificationJudgeInterval;

		if (
			state.config.useVerificationJudge &&
			!state.verificationJudgeRunning &&
			(hasVerificationGap || isPeriodicCheck) &&
			state.uniqueToolsUsed.size > 0
		) {
			const now = Date.now();

			if (now - state.lastJudgeTime < 60_000) {
				return;
			}

			state.verificationJudgeRunning = true;

			const toolLog: string[] = [];
			for (const [, turn] of state.turnHistory) {
				if (turn.actualTools.length > 0) {
					toolLog.push(`Turn ${turn.turnIndex}: [${turn.actualTools.join(", ")}]`);
				}
			}

			const judgeCtx: JudgeContext = {
				userRequest: state.originalRequest,
				toolsUsed: Array.from(state.uniqueToolsUsed),
				toolLog,
				hasCodeChanges: state.hasCodeChanges,
				hasVerification: userHasBash,
				lastResponse: fullContent,
				thinking: thinkingContent,
			};

			const result = await runVerificationJudge(ctx as never, judgeCtx, { timeoutMs: 30000 });

			state.lastVerificationJudgeTurn = state.currentTurn;
			state.verificationJudgeRunning = false;

			if (result) {
				if (result.verdict === "fail" || result.verdict === "warn") {
					// L3: Verification judge is critical enough to warrant individual message
					sendEnforcementWhisper(pi, formatVerificationNudge(result));
					if (result.verdict === "fail") {
						state.validationFailures++;
					}
				}
			}
		}

		// Legacy LLM Judge — only for text-only responses
		if (state.config.useJudge && turnState && turnState.actualTools.length === 0) {
			const now = Date.now();

			if (now - state.lastJudgeTime < state.config.judgeCooldownMs) {
				return;
			}

			state.judgeSkipCounter++;
			if (state.judgeSkipCounter < state.config.judgeSkipTurns) {
				return;
			}
			state.judgeSkipCounter = 0;

			const history: string[] = [];
			for (const [turnIdx, turn] of state.turnHistory) {
				if (turnIdx >= state.currentTurn) continue;
				const tools = turn.actualTools.length > 0 ? ` [Tools: ${turn.actualTools.join(", ")}]` : "";
				history.push(`[Turn ${turnIdx}]${tools}`);
			}

			const { analysis, action } = await analyzeWithJudge(ctx as never, fullContent, history, {
				timeoutMs: 30000,
			});

			state.lastJudgeTime = now;
			state.lastJudgeAnalysis = analysis;

			if (action.type === "nudge" && action.nudgeMessage) {
				const rateLimitOk = now - state.lastNudgeTime > state.nudgeCooldownMs;
				if (rateLimitOk) {
					state.lastNudgeTime = now;
					sendEnforcementWhisper(pi, action.nudgeMessage);

					if (action.priority === "critical" || action.priority === "high") {
						state.validationFailures++;
					}
				}
			}
		}
	});

	// ── Commands ───────────────────────────────────────────────────────────────
	pi.registerCommand("enforcement-on", {
		description: "Enable enforcement",
		handler: async (_args, ctx) => {
			state.enforcementActive = true;
			ctx.ui.notify("Enforcement enabled", "info");
		},
	});

	pi.registerCommand("enforcement-off", {
		description: "Disable enforcement",
		handler: async (_args, ctx) => {
			state.enforcementActive = false;
			ctx.ui.notify("Enforcement disabled", "info");
		},
	});

	pi.registerCommand("enforcement-stats", {
		description: "Show enforcement stats",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`Turn ${state.currentTurn} | Failures: ${state.validationFailures} | Silent: ${state.silentTurns}`,
				"info",
			);
		},
	});
}

// Helpers

function _classifyRetryError(
	errorMsg: string,
): "rate_limit" | "server_error" | "network" | "unknown" {
	if (/rate.?limit|too many requests|429/i.test(errorMsg)) return "rate_limit";
	if (/500|502|503|504|server.?error|internal.?error|service.?unavailable/i.test(errorMsg))
		return "server_error";
	if (/network|connection|fetch failed|socket|timeout|timed out/i.test(errorMsg)) return "network";
	return "unknown";
}
