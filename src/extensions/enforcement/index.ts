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
import { recordBashDetails, recordToolCall } from "./handlers/tool-tracker.js";
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

// ============================================================================
// Extension Factory
// ============================================================================

export default function enforcementExtension(pi: ExtensionAPI) {
	// Initialize the smart nudge manager
	const nudgeManager = new NudgeManager();
	// =======================================================================
	// Tool Registrations
	// =======================================================================

	// Register enforcement tools, config, reset
	registerEnforcementTools(pi);

	// =======================================================================
	// Event Handlers
	// =======================================================================

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

		// When finalize is called, start buffering whispers for delivery after finalize
		if (toolName === "finalize") {
			startFinalizeBuffer();
		}

		// Track tool usage via extracted handler
		recordToolCall(toolName);

		// Track bash-specific details
		if (toolName === "bash") {
			const bashEvent = event as { input?: { command?: string } };
			const cmd = bashEvent.input?.command || "";
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
		const input = event.input as Record<string, unknown> | undefined;
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
			state.turnsSinceMemory++;
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

		// Memory nudge
		const memoryThresholdReached =
			!hadErrors &&
			state.config.enforceMemory &&
			state.turnsSinceMemory >= state.config.memoryNudgeThreshold &&
			actualTools.length > 0 &&
			!state.memoryNudgeSent;

		if (memoryThresholdReached) {
			state.memoryNudgeSent = true;

			const memoryMsg = state.config.enforceMemoryNudge
				? `Memory reminder: ${state.turnsSinceMemory} turns since you stored anything in memory.\n\nConsider executing:\nmemory_store(content="...", tags=["relevant"]) with what you learned.`
				: `Memory reminder: ${state.turnsSinceMemory} turns since you stored anything in memory.\n\nStore important learnings:\n- Patterns you discovered\n- Errors you encountered and how you fixed them\n- Solutions that worked\n\nExample: memory_store(content="Found that X causes Y because Z", tags=["pattern", "error", "fix"])`;

			if (state.config.enforceMemoryNudge) {
				// Removed auto-captured memory nudge — agents should store meaningful memories;
			}

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

		// =====================================================
		// VERIFICATION JUDGE CHECKPOINTS
		// =====================================================

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
