/**
 * Enforcement Extension - Tool Usage Enforcement & Validation
 *
 * Uses the whisper pattern (before_agent_start event) to inject
 * enforcement rules and nudges as visible messages with purple background.
 *
 * Phases:
 * 1. Pre-turn injection - forces structured thinking (via whisper)
 * 2. Post-turn validation - validates planned tools were used
 * 3. Tool call interceptor - real-time validation
 * 4. Nudge generator - provides real-time feedback (via whisper)
 * 5. Verification judge - LLM-based work audit at checkpoints
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
// Detection modules
import { detectMalformedToolCalls } from "./detection/malformed.js";
import {
	detectMissingVerification,
	recordCodeChange as detectRecordCodeChange,
	queueMemoryNudge,
} from "./detection/verification.js";
// Escalation
import { sendEscalatedNudge } from "./escalation.js";
// Handlers
import { checkBlocking } from "./handlers/blocking.js";
import { registerEnforcementTools } from "./handlers/tool-registrations.js";
import { recordBashDetails, recordToolCall, recordToolInput } from "./handlers/tool-tracker.js";
// Judge
import { analyzeWithJudge } from "./judge.js";
// Nudge Manager
import { NudgeManager } from "./nudge-manager.js";
// Prompts
import { PRE_TURN_TEMPLATE, TOOL_ENFORCEMENT_RULES } from "./prompts.js";
// State
import { state } from "./state.js";
// Types
import type { TurnState } from "./types.js";
// Validation
import { validateToolForPhase, validateTurn } from "./validation.js";
// Verification Judge (LLM-based work audit)
import { formatVerificationNudge, type JudgeContext, runVerificationJudge } from "./verification-judge.js";
// Whisper
import {
	bufferEnforcementWhisper,
	clearPendingBlockAction,
	flushEnforcementBuffer,
	getPendingBlockAction,
	queueEnforcementWhisper,
	sendEnforcementWhisper,
	shouldBufferWhisper,
	startFinalizeBuffer,
} from "./whisper.js";

// Extension Factory
export default function enforcementExtension(pi: ExtensionAPI) {
	const nudgeManager = new NudgeManager();

	// Tool Registrations
	registerEnforcementTools(pi);

	// Event Handlers

	// Pre-agent: Inject enforcement prompt
	pi.on("before_agent_start", async (event) => {
		if (!state.enforcementActive) {
			return;
		}

		state.currentTurn++;

		// Add enforcement prompt to system prompt
		let enforcementPrompt = `${PRE_TURN_TEMPLATE}\n\n${TOOL_ENFORCEMENT_RULES}`;

		// Handle pending block action — include in prompt instead of using
		// sendEnforcementWhisper which triggers a new turn and overrides
		// the user's message.
		const pendingBlock = getPendingBlockAction();
		if (pendingBlock) {
			enforcementPrompt += `\n\n### BLOCKED ACTION\n${pendingBlock.reason}`;
		}
		clearPendingBlockAction();

		// Add context about previous turn if available
		const prevTurn = state.turnHistory.get(state.currentTurn - 1);
		if (prevTurn && prevTurn.actualTools.length > 0) {
			enforcementPrompt += `

### Previous Turn Context
You used these tools: ${prevTurn.actualTools.join(", ")}
${
	state.validationFailures > 0
		? `\n ${state.validationFailures} validation failure(s) in recent turns. Review your approach.`
		: ""
}
`;
		}

		// Inject scratchpad content if available
		if (state.scratchpadContent) {
			enforcementPrompt += `
### Current Scratchpad
${state.scratchpadContent}
`;
		} else {
			// Try to read from shared scratchpad file
			try {
				const fs = await import("node:fs");
				const path = await import("node:path");
				const os = await import("node:os");
				const slug = "--" + (process.cwd()?.split("/").filter(Boolean).join("-") || "default") + "--";
				const filePath = path.join(os.homedir(), ".pi", "agent", "scratchpads", slug, "latest.json");
				if (fs.existsSync(filePath)) {
					const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
					if (data.goal || data.plan?.length > 0 || data.decisions?.length > 0) {
						const lines = [`Goal: ${data.goal || "(none)"}`];
						if (data.plan?.length > 0) {
							lines.push("Plan:");
							for (let i = 0; i < data.plan.length; i++) {
								const step = data.plan[i];
								const status = data.done?.includes(step) ? "[done]" : "[ ]";
								lines.push("  " + status + " " + (i + 1) + ". " + step);
							}
						}
						if (data.decisions?.length > 0) {
							lines.push("Decisions: " + data.decisions.length);
						}
						enforcementPrompt += `
### Current Scratchpad
${lines.join("\n")}
`;
					}
				}
			} catch {
				// Silent fail
			}
		}

		// Add silent turn warning (only inject once)
		if (state.silentTurns > 0 && !state.silentTurnWarned) {
			state.silentTurnWarned = true;
			enforcementPrompt += `

### SILENT TURN WARNING
You have ${state.silentTurns} turn(s) without tool calls.
You work through tools (read, bash, edit, write, etc.) — reach for them to make progress.
`;
		}

		// Add tool chain warnings if violations detected
		if (state.toolChain.recentEditWithoutThink.length > 0) {
			enforcementPrompt += `

### EDIT WITHOUT THINK DETECTED
You edited without calling think() first in ${state.toolChain.recentEditWithoutThink.length} turn(s).
You think before you change: think() → plan() → edit().
`;
		}

		if (state.toolChain.recentEditWithoutPlan.length > 0) {
			enforcementPrompt += `

### EDIT WITHOUT HYPOTHESES DETECTED
For bug fixes, you need plan() with 2+ hypotheses from DIFFERENT files.
You explore hypotheses before fixing bugs: think() → plan() (with hypotheses) → edit().
`;
		}

		// Add memory usage warning if no memory tools called in a while (only inject once)
		if (
			state.config.enforceMemory &&
			state.turnsSinceMemory >= state.config.memoryNudgeThreshold &&
			!state.memoryNudgeWarned
		) {
			state.memoryNudgeWarned = true;
			enforcementPrompt += `

### MEMORY NOT USED
${state.turnsSinceMemory} turn(s) since you stored anything in memory.
Store important learnings with: memory_store(content="...", tags=["relevant", "tags"])
`;
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n${enforcementPrompt}`,
		};
	});

	// Tool call: Validate tool usage and enforce think→plan→edit chain
	pi.on("tool_call", async (event) => {
		if (!state.enforcementActive) {
			return undefined;
		}

		const toolName = event.toolName;
		const input = event.input as Record<string, unknown> | undefined;

		// When finalize is called, start buffering whispers for delivery after finalize
		if (toolName === "finalize") {
			startFinalizeBuffer();
		}

		// Track tool usage via extracted handler
		recordToolCall(toolName);

		// Track file paths for re-read waste detection
		recordToolInput(toolName, input);

		// Track bash-specific details
		if (toolName === "bash") {
			const cmd = (input as { command?: string } | undefined)?.command || "";
			recordBashDetails(cmd);
		}

		// Track code changes
		if (toolName === "edit" || toolName === "write") {
			detectRecordCodeChange(state.currentTurn);
			state.hasCodeChanges = true;
		}

		// Log tool usage for verification judge context
		state.toolLog.push(`${toolName}`);

		// Blocking enforcement via extracted handler
		const blockResult = checkBlocking(toolName, input, state);
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

	// Turn end: Validate and nudge
	pi.on("turn_end", async (event) => {
		if (!state.enforcementActive) {
			return;
		}

		const actualTools = (event.toolResults || []).map((r) => r.toolName);
		const erroredTools = new Set((event.toolResults || []).filter((r) => r.isError).map((r) => r.toolName));
		const hadErrors = erroredTools.size > 0;

		const hasBash = actualTools.includes("bash");
		if (hasBash) {
			// Reset pending code changes if bash ran (generic verification)
		}

		const hasCodeChange = actualTools.some((t) => ["edit", "write"].includes(t));
		if (hasCodeChange) {
			detectRecordCodeChange(state.currentTurn);
		}

		// Check for missing verification
		detectMissingVerification(pi as never, state.currentTurn);

		const scratchpadUpdated = actualTools.includes("scratchpad");
		if (scratchpadUpdated) {
			state.lastScratchpadNudgeTurn = -100;
		}

		const memoryUpdated = actualTools.some((t) => ["memory_store", "memory_recall", "memory_list"].includes(t));
		if (!memoryUpdated) {
			// Only count meaningful turns (with actual tools and no errors)
			if (actualTools.length > 0 && !hadErrors) {
				state.turnsSinceMemory++;
			}
		} else {
			state.turnsSinceMemory = 0;
		}

		// Track turns since context tool usage (for proactive nudging)
		const contextToolUpdated = actualTools.some((t) =>
			["context_tag", "context_log", "context_checkout", "context_prune", "context_audit"].includes(t),
		);
		if (contextToolUpdated) {
			state.turnsSinceContextTool = 0;
		} else if (actualTools.length > 0 && !hadErrors) {
			state.turnsSinceContextTool++;
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

		const whispersToSend: string[] = [];

		if (erroredTools.size > 0) {
			state.lastFailedToolTurn = state.currentTurn;
		}

		// Detect infrastructure errors: API timeouts, rate limits, server errors.
		// When these occur, the agent emitted tool calls but the infrastructure
		// prevented results — this is NOT a silent turn.
		const isInfrastructureError =
			actualTools.length === 0 &&
			event.message.role === "assistant" &&
			"stopReason" in event.message &&
			(event.message as { stopReason?: string }).stopReason === "error";

		const prevTurn = state.turnHistory.get(state.currentTurn - 1);
		const validation = validateTurn(prevTurn, turnState, erroredTools, isInfrastructureError);

		if (!validation.passed && validation.nudge && !hadErrors) {
			if (nudgeManager.shouldSendNudge("validation", validation.nudge).shouldSend) {
				whispersToSend.push(validation.nudge);
			}
		}

		// Memory nudge — smarter, context-aware
		const memoryThresholdReached =
			!hadErrors &&
			state.config.enforceMemory &&
			state.turnsSinceMemory >= state.config.memoryNudgeThreshold &&
			actualTools.length > 0 &&
			!state.memoryNudgeSent;

		if (memoryThresholdReached) {
			state.memoryNudgeSent = true;

			// Build context-aware memory suggestion
			const hasCodeChanges = state.hasCodeChanges;
			const hasErrors = erroredTools.size > 0;
			const hasVerification = state.verificationsDone > 0;
			const hasExploration = state.hasExplored;

			let memoryHint = "";
			if (hasCodeChanges) {
				memoryHint = "Store the key pattern or fix you discovered: `memory_store(content=\"...\", tags=[\"pattern\", \"fix\"])`";
			} else if (hasExploration) {
				memoryHint = "Store what you learned about the codebase: `memory_store(content=\"...\", tags=[\"codebase\", \"insight\"])`";
			} else if (hasVerification) {
				memoryHint = "Store verification results: `memory_store(content=\"...\", tags=[\"verification\"])`";
			} else {
				memoryHint = "Store key learnings: `memory_store(content=\"...\", tags=[\"insight\"])`";
			}

			const memoryMsg = `**Memory nudge:** ${state.turnsSinceMemory} turns since memory usage.\n\n` +
				`You've made progress — capture it!\n${memoryHint}\n\n` +
				`Example: memory_store(content="Discovered that X causes Y because Z", tags=["pattern", "root-cause"])`;

			if (nudgeManager.shouldSendNudge("memory", memoryMsg).shouldSend) {
				whispersToSend.push(memoryMsg);
			}
		}

		// Memory Analysis Ratio Nudge
		const threshold = state.config.toolAnalysisWarningThreshold ?? 0.15;
		const warningInterval = state.config.toolAnalysisWarningTurns ?? 10;

		if (
			state.totalToolCalls > 5 &&
			state.toolAnalysisRatio < threshold &&
			state.currentTurn - state.lastAnalysisTurn > warningInterval
		) {
			const turnsSinceAnalysis = state.currentTurn - state.lastAnalysisTurn;
			const analysisPercent = Math.round(state.toolAnalysisRatio * 100);
			const msg =
				`Memory analysis: Only ${analysisPercent}% of ${state.totalToolCalls} tool calls have been analyzed. ${turnsSinceAnalysis} turns since last analysis.\n` +
				`Consider: memory_analyze_tool(toolName="bash", success=true) for each tool call used.\n` +
				`This helps build cumulative intelligence and avoid repeating mistakes.`;

			const { sent } = sendEscalatedNudge(pi, "memoryAnalysis", msg);
			if (sent) {
				state.lastNudgeTime = Date.now();
			}
		}

		// Context tool usage nudge
		const contextToolInterval = state.config.contextToolNudgeInterval ?? 20;
		const contextUpdated = actualTools.some((t) =>
			["context_tag", "context_log", "context_checkout", "context_prune", "context_audit"].includes(t),
		);
		if (contextUpdated) {
			state.lastContextToolCall = state.currentTurn;
			state.turnsSinceContextTool = 0;
			state.contextToolNudged = false;
		}

		// Proactive nudge: context tools haven't been used in a while
		if (
			!hadErrors &&
			actualTools.length > 0 &&
			state.config.enforceContextTools &&
			state.turnsSinceContextTool >= contextToolInterval &&
			!state.contextToolNudged
		) {
			state.contextToolNudged = true;

			// Suggest the most appropriate context tool based on session state
			let suggestion = "";
			if (state.hasCodeChanges) {
				suggestion = `After code changes, use \`context_tag(name="checkpoint")\` to mark progress, ` +
					`or \`context_audit()\` to check hygiene.`;
			} else if (state.hasExplored) {
				suggestion = `After exploration, use \`context_tag(name="exploration-done")\` to mark what you learned.`;
			} else {
				suggestion = `Use \`context_log\` to review session history, or \`context_audit()\` for hygiene check.`;
			}

			const contextMsg = `**Context hygiene:** ${state.turnsSinceContextTool} turns since context tools.\n\n` +
				`suggestion\n\n` +
				`Context tools available: context_tag, context_log, context_checkout, context_prune, context_audit`;

			if (nudgeManager.shouldSendNudge("contextTool", contextMsg).shouldSend) {
				whispersToSend.push(contextMsg);
			}
		}

		// Context hygiene nudge
		if (contextUpdated) {
			state.lastContextCheckTurn = state.currentTurn;
			state.contextNudgeSent = false;
		}

		// Time-based context usage check (lower thresholds = more proactive)
		if (
			!hadErrors &&
			actualTools.length > 0 &&
			state.currentTurn - state.lastContextCheckTurn >= state.contextCheckInterval &&
			!state.contextNudgeSent
		) {
			state.contextNudgeSent = true;

			let usagePercent = 0;
			try {
				// @ts-ignore - ctx may be available via event
				const ctxFromEvent = (event as any)?.ctx;
				const usage = ctxFromEvent?.getContextUsage?.();
				if (usage) {
					usagePercent = usage.percent ?? 0;
				}
			} catch { /* ignore */ }

			if (usagePercent > 0) {
				const turnsSince = state.currentTurn - state.lastContextCheckTurn;
				let contextMsg = "";

				// More granular thresholds with actionable suggestions
				if (usagePercent > 85) {
					contextMsg = `🔴 **Critical: Context at ${usagePercent.toFixed(1)}%!**\n\n` +
						`${turnsSince} turns since hygiene check. Urgent actions:\n` +
						`1. \`context_audit()\` — see hygiene score + prune candidates\n` +
						`2. \`context_tag(name="checkpoint")\` — mark progress before compact\n` +
						`3. Run \`/compact\` to summarize\n` +
						`4. \`context_checkout\` to branch if exploring alternatives`;
				} else if (usagePercent > 75) {
					contextMsg = `🟠 **High: Context at ${usagePercent.toFixed(1)}%**\n\n` +
						`Consider:\n` +
						`1. \`context_prune(dryRun=true)\` to see obsolete entries\n` +
						`2. \`context_tag(name="checkpoint")\` to create a milestone\n` +
						`3. Run \`/compact\` if context grows further`;
				} else if (usagePercent > 60) {
					contextMsg = `🟡 **Moderate: Context at ${usagePercent.toFixed(1)}%**\n\n` +
						`Proactively maintain hygiene:\n` +
						`- \`context_tag(name="milestone")\` to mark progress\n` +
						`- \`context_audit()\` for hygiene recommendations\n` +
						`- \`memory_store\` for key learnings`;
				}

				if (contextMsg && nudgeManager.shouldSendNudge("context", contextMsg).shouldSend) {
					whispersToSend.push(contextMsg);
				}
			}
		}

		// High-context nudge on finalize
		const isFinalizeTurn = actualTools.includes("finalize");
		if (isFinalizeTurn && !state.highContextNudged) {
			let usagePercent = 0;
			try {
				// @ts-ignore - ctx may be available via event
				const ctxFromEvent = (event as any)?.ctx;
				const usage = ctxFromEvent?.getContextUsage?.();
				if (usage) {
					usagePercent = usage.percent ?? 0;
				}
			} catch { /* ignore */ }

			if (usagePercent > 70) {
				state.highContextNudged = true;
				whispersToSend.push(
					`⚠️ **High context usage: ${usagePercent.toFixed(1)}%**\n\n` +
					`Consider: \`context_audit()\` before finalizing to ensure context hygiene.`
				);
			}
		}

		// Record Failure Nudge
		const FAILURE_RECORD_THRESHOLD_TURNS = 3;

		if (erroredTools.size > 0 && !state.hasRecordedFailure) {
			const turnsSinceError = state.currentTurn - state.lastFailedToolTurn;
			if (turnsSinceError >= FAILURE_RECORD_THRESHOLD_TURNS) {
				const now = Date.now();
				if (now - state.lastNudgeTime > state.nudgeCooldownMs) {
					state.lastNudgeTime = now;
					state.hasRecordedFailure = true;
					const errorList = Array.from(erroredTools).join(", ");
					whispersToSend.push(
						`Error pattern: ${errorList} failed. Record the failure to avoid repeating mistakes:\n\n` +
							`memory_store(content="Error with ${errorList}: what went wrong and how to fix it", memoryType="error", tags=["error", "failure"])`,
					);
				}
			}
		}

		// Flush any buffered enforcement whispers (e.g. from finalize context)
		const flushMessage = flushEnforcementBuffer();
		if (flushMessage) {
			sendEnforcementWhisper(pi, flushMessage);
		}

		// Send all accumulated whispers
		for (const whisper of whispersToSend) {
			if (shouldBufferWhisper()) {
				bufferEnforcementWhisper(whisper);
			} else {
				sendEnforcementWhisper(pi, whisper);
			}
		}
	});

	// ── Auto-Retry End ────────────────────────────────────────────────
	// Catches non-overflow API retry failures (429 rate limits, 500s, network errors).
	// Overflow errors use compaction + retry, NOT this path.
	// See compaction_end for overflow recovery failures.
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
				msg = `API rate limit hit after ${attempt} retry(s). ` +
					`Try switching models with /model, or wait before continuing.`;
			} else if (errorType === "server_error") {
				msg = `API server error after ${attempt} retry(s) (${finalError}). ` +
					`The provider may be experiencing issues. Try again or switch models.`;
			} else if (errorType === "network") {
				msg = `Network error after ${attempt} retry(s). Check your connection and try again.`;
			} else {
				msg = `API error after ${attempt} retry(s): ${finalError ?? "unknown"}. ` +
					`Try switching models with /model.`;
			}

			const nudgeMsg = `## ⚠️ API Retry Failed\n\n${msg}\n\n` +
				`Store this error for future reference: memory_store(content="API error: ${finalError}", memoryType="error", tags=["error", "api"])`;

			if (shouldBufferWhisper()) {
				bufferEnforcementWhisper(nudgeMsg);
			} else {
				sendEnforcementWhisper(pi, nudgeMsg);
			}
		}
	});

	// Message End: LLM Judge analysis + verification checkpoints
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

		// Also extract thinking content so the judge can see the agent's reasoning
		const thinkingContent = event.message.content
			.filter((c) => c.type === "thinking")
			.map((c) => (c as { type: "thinking"; thinking: string }).thinking)
			.join("\n");

		// Combine for judge: thinking provides ground-truth of knowledge source
		const fullContent = thinkingContent
			? `## AGENT REASONING (thinking blocks)\n${thinkingContent}\n\n## AGENT RESPONSE (visible text)\n${textContent}`
			: textContent;

		if (textContent.length < 100) {
			return;
		}

		// Pattern detection: malformed tool calls
		const turnState = state.turnHistory.get(state.currentTurn);
		if (turnState) {
			detectMalformedToolCalls(textContent, pi);
		}

		// VERIFICATION JUDGE CHECKPOINTS

		// Skip verification judge if already running (prevent recursion)
		if (state.verificationJudgeRunning) {
			return;
		}

		const userHasBash = Array.from(state.uniqueToolsUsed).includes("bash");

		// Checkpoint 1: Pre-Finalize — full audit before allowing finish
		const isFinalizeTurn = turnState?.actualTools.includes("finalize");

		// Checkpoint 2: Verification gap — code changed, no verification run
		const VERIFICATION_GAP_TURNS = state.config.verifyAfterCodeChanges ? 8 : Infinity;
		const turnsSinceCodeChange = state.currentTurn - state.lastVerificationJudgeTurn;
		const hasVerificationGap = state.hasCodeChanges && !userHasBash && turnsSinceCodeChange >= VERIFICATION_GAP_TURNS;

		// Checkpoint 3: Periodic quality drift check every N turns
		const isPeriodicCheck =
			state.config.verificationJudgeInterval > 0 &&
			state.hasCodeChanges &&
			state.currentTurn - state.lastVerificationJudgeTurn >= state.config.verificationJudgeInterval;

		if (
			state.config.useVerificationJudge &&
			!state.verificationJudgeRunning &&
			(isFinalizeTurn || hasVerificationGap || isPeriodicCheck) &&
			state.uniqueToolsUsed.size > 0
		) {
			const now = Date.now();

			// Cooldown between non-finalize checks
			if (!isFinalizeTurn && now - state.lastJudgeTime < 60_000) {
				return;
			}

			state.verificationJudgeRunning = true;

			// Build tool log from recent turn history
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
					const nudgeMsg = formatVerificationNudge(result);
					if (isFinalizeTurn && result.verdict === "fail" && state.config.verifyBeforeFinalize) {
						sendEnforcementWhisper(
							pi,
							`## FINALIZE BLOCKED\n\n${nudgeMsg}\n\nPlease address the issues above before finalizing.`,
						);
					} else {
						sendEnforcementWhisper(pi, nudgeMsg);
					}

					if (result.verdict === "fail") {
						state.validationFailures++;
					}
				}
			}
		}

		// Legacy LLM Judge — fallback for text-only responses (handles hallucination/contradiction checks)
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

			const { analysis, action } = await analyzeWithJudge(ctx as never, fullContent, history, { timeoutMs: 30000 });

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

	// Command handlers
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

/** Classify a retry error message into a category for targeted guidance. */
function _classifyRetryError(errorMsg: string): "rate_limit" | "server_error" | "network" | "unknown" {
	if (/rate.?limit|too many requests|429/i.test(errorMsg)) return "rate_limit";
	if (/500|502|503|504|server.?error|internal.?error|service.?unavailable/i.test(errorMsg)) return "server_error";
	if (/network|connection|fetch failed|socket|timeout|timed out/i.test(errorMsg)) return "network";
	return "unknown";
}
