/**
 * Enforcement Extension - Smart Nudge Delivery with Semantic Interrupts
 *
 * Signal Architecture (Cognitive Context Architecture):
 * - L1 (Internal): Tool usage, context hygiene, turn validation tracked in state only
 * - L2 (Structured hints): Bundled per-turn into a SINGLE Session Signals nudge
 * - L3 (Critical): Overflow failures, infrastructure errors, dangerous commands
 *   that passed review - individual visible messages with semantic framing
 *
 * Key design: Agent gets ONE [auto] message per turn max for non-critical signals.
 * Critical signals (L3) get their own messages because they require immediate action.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "path";
import type { ExtensionAPI, SessionCompactEvent, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { detectMalformedToolCalls } from "./detection/malformed.js";
import { TopicDriftDetector } from "../../lib/topic-drift-detector.js";
import { getReplyInstruction, setLanguage, detectLanguage } from "../../lib/language-hint.js";
import { measureStability } from "../../lib/reasoning-metrics.js";
import {
	detectMissingVerification,
	recordCodeChange as detectRecordCodeChange,
} from "./detection/verification.js";
import { checkBlocking } from "./handlers/blocking.js";
import { checkComplexityMismatch, estimateComplexity, type ComplexityProbe } from "./handlers/probe-handler.js";
import { recordBashDetails, recordToolCall, recordToolInput } from "./handlers/tool-tracker.js";
import { checkRoutingMismatch, detectIntent, getRoutingHint, type TaskIntent } from "./handlers/routing-handler.js";
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

// ── Simple Text Similarity ────────────────────────────────────────────────────
// Tokenize text into lines and compute Jaccard similarity
function tokenize(text: string): Set<string> {
	return new Set(text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let intersection = 0;
	for (const item of a) {
		if (b.has(item)) intersection++;
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

function computeSimilarity(text1: string, text2: string): number {
	const set1 = tokenize(text1);
	const set2 = tokenize(text2);
	return jaccardSimilarity(set1, set2);
}

// Map of file path -> { content, turn }
const knownFiles = new Map<string, { content: string; turn: number }>();

async function loadFileContent(filePath: string): Promise<string | null> {
	try {
		const resolvedPath = path.isAbsolute(filePath)
			? filePath
			: path.resolve(process.cwd(), filePath);

		try {
			const stat = await fs.stat(resolvedPath);
			if (stat.isDirectory()) return null;
		} catch {
			return null; // File doesn't exist or not accessible
		}
		return await fs.readFile(resolvedPath, "utf-8");
	} catch {
		return null;
	}
}

async function detectRedundancy(newContent: string, newPath: string): Promise<string | null> {
	const SIMILARITY_THRESHOLD = 0.7;

	for (const [existingPath, { content: existingContent }] of knownFiles) {
		if (existingPath === newPath) continue;
		const similarity = computeSimilarity(newContent, existingContent);
		if (similarity >= SIMILARITY_THRESHOLD) {
			return existingPath;
		}
	}
	return null;
}

// ── L1 Surfacing ─────────────────────────────────────────────────────────────
// Shared signal state for prompt-builder. Writable object - prompt-builder reads
// this directly (same process, no IPC needed). Turn-keyed so stale signals are
// dropped when the turn advances without new signals.
export const enforcementSignals: Record<
	string, // signal type
	{ turn: number; text: string; acted: boolean }
> = {};

// Extension Factory
export default function enforcementExtension(pi: ExtensionAPI) {
	const nudgeManager = new NudgeManager();

	// ── before_agent_start ─────────────────────────────────────────────────────
	// Minimal: only handle block actions. All verbose enforcement prose is gone.
	// Non-critical signals → bundled Session Signals nudge (turn_end).
	// Critical signals (L3) → individual sendEnforcementWhisper (turn_end).
	// Language detection: detect from user text → set reply instruction in system prompt
	pi.on("input", async (event: any, ctx: any) => {
		if (!state.enforcementActive) return;
		const text = event.text || "";
		if (!text || text.startsWith("/") || (event as any).source === "extension") return;

		const lang = detectLanguage(text);
		if (lang.code === "EN") return;

		setLanguage(lang.code, lang.name);
		state.lastUserMessage = text;
		const replyLang = getReplyInstruction();
		if (!replyLang) return;

		const session = (ctx.sessionManager as any)?.getCurrentSession?.();
		if (session?.updateSystemPrompt) {
			session.updateSystemPrompt({ append: replyLang });
		}
	});

	// Topic drift: initialize on session_start, check on turn_end
	pi.on("session_start", async (event) => {
		if (!state.enforcementActive) return;
		const task = (event as any).task || (event as any).prompt || state.originalRequest || "";
		if (task) {
			state.driftDetector?.setTaskContext(task);
		}

		state.currentTurn++;

		// Block action must surface via system prompt
		const pendingBlock = getPendingBlockAction();
		clearPendingBlockAction();

		if (pendingBlock) {
			pi.sendMessage({
				customType: "context",
				display: true,
				content: [{ type: "text", text: `[BLOCKED] ${pendingBlock.reason}` }],
			});
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

		if (toolName === "edit" || toolName === "write") {
			const filePath = (input as { path?: string } | undefined)?.path;
			if (filePath) {
				knownFiles.set(filePath, { content: "", turn: state.currentTurn });
			}
		}

		state.toolLog.push(`${toolName}`);

		// Sequence repetition detection: 9+ same tool in a row
		const REPETITION_THRESHOLD = 9;
		if (state.toolLog.length >= REPETITION_THRESHOLD) {
			const lastN = state.toolLog.slice(-REPETITION_THRESHOLD);
			if (lastN.every((t) => t === lastN[0])) {
				const now = Date.now();
				if (now - state.lastNudgeTime > state.nudgeCooldownMs) {
					state.lastNudgeTime = now;
					sendEnforcementWhisper(pi, `Repeating ${toolName} ${REPETITION_THRESHOLD}+ times - consider a different approach`);
				}
			}
		}

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

		// Detect context overflow - suppress L2 signals during recovery so the agent
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

		// Clear session_compact memory nudge once agent acts (uses any memory tool)
		if (memoryUpdated && enforcementSignals["unpersisted_learnings"]) {
			delete enforcementSignals["unpersisted_learnings"];
		}

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

		// ── Redundancy Detection ─────────────────────────────────────────────────
		// Detect code >70% similar to existing files when edit/write tools run
		if (actualTools.some((t) => ["edit", "write"].includes(t))) {
			for (const [filePath, entry] of knownFiles) {
				if (!entry.content) {
					// Content not yet loaded - try to load now
					const loaded = await loadFileContent(filePath);
					if (loaded !== null) {
						entry.content = loaded;
					}
				}
			}

			// Check new/updated files for similarity
			for (const [filePath, entry] of knownFiles) {
				if (entry.turn === state.currentTurn && entry.content === "") {
					const loaded = await loadFileContent(filePath);
					if (loaded !== null) {
						entry.content = loaded;
						const similarTo = await detectRedundancy(loaded, filePath);
						if (similarTo) {
							const now = Date.now();
							if (now - state.lastNudgeTime > state.nudgeCooldownMs) {
								state.lastNudgeTime = now;
								sendEnforcementWhisper(
									pi,
									`[Quality] Similar code exists at \`${similarTo}\`. Reuse or deduplicate.`,
								);
							}
						}
					}
				}
			}
		}

		// ── L3: Critical signals - individual, semantic ────────────────────────

		if (erroredTools.size > 0) {
			state.lastFailedToolTurn = state.currentTurn;
		}

		// Infrastructure error (no tools ran but assistant responded - not silent)
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
		// Skip during overflow recovery - agent needs breathing room to stabilize.
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
		// Interval-based "use context tools" nudges are wrong signal - they fire on
		// enforcement turn count, not user-perceived progress. Context hygiene is already
		// covered by the context usage nudge (75%/85%) below.

		// Scratchpad signal: code changed but scratchpad not updated
		// Skip during overflow recovery - agent needs breathing room to stabilize.
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
					`Code changed without updating scratchpad - consider scratchpad(action="add_note", text="...") or scratchpad(action="add_decision", text="...")`,
				);
			}
		}

		// Think tool enforcement: nudge if many turns without think()
		if (
			!hadErrors &&
			!inOverflowRecovery &&
			state.toolChain.lastThinkCall === 0 &&
			state.currentTurn >= 5 &&
			state.currentTurn % 5 === 0
		) {
			sessionSignals.push(
				`${state.currentTurn} turns without think() - use think(observation, decision, reason) to track reasoning`,
			);
		}

		// Context usage signal (only at high usage - semantic, not metric)
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
					"Context at critical levels - run /compact or use context_checkout to branch before continuing",
				);
			} else if (usagePercent > 75) {
				sessionSignals.push(
					"Context getting high - consider /compact or context_tag to mark progress",
				);
			}
			// Below 75%: no signal - not actionable enough to bother
		}

		// Send bundled nudge if we have signals AND no L3 critical message just went out.
		// Also populate enforcementSignals for L1 surfacing in prompt-builder.
		if (sessionSignals.length > 0) {
			// Clear stale signals from previous turns before populating new ones
			for (const key of Object.keys(enforcementSignals)) {
				if (enforcementSignals[key].turn < state.currentTurn - 1) {
					delete enforcementSignals[key];
				}
			}

			// Populate L1 signal store - keyed by semantic type for easy lookup
			// Also emit via event bus for cross-extension coordination (prompt-builder)
			for (const signal of sessionSignals) {
				const entry = { turn: state.currentTurn, text: signal, acted: false };
				if (signal.includes("nothing stored") || signal.includes("memory_store")) {
					enforcementSignals["memory"] = { ...entry, acted: state.memoryNudgeSent };
				} else if (signal.includes("scratchpad")) {
					enforcementSignals["scratchpad"] = entry;
				} else if (signal.includes("critical")) {
					enforcementSignals["context_critical"] = entry;
				} else if (signal.includes("high") || signal.includes("getting high") || signal.includes("/compact") || signal.includes("context")) {
					enforcementSignals["context_high"] = entry;
				} else {
					enforcementSignals["generic"] = entry;
				}
			}

			// Emit for prompt-builder (and any other extension listening)
			pi.events.emit("enforcement_signals", {
				turn: state.currentTurn,
				signals: { ...enforcementSignals },
			});

			const bundled = `[Session Signals]\n${sessionSignals.map((s) => `- ${s}`).join("\n")}`;
			const { shouldSend } = nudgeManager.shouldSendNudge("scratchpad", bundled);
			if (shouldSend) {
				sendEnforcementWhisper(pi, bundled);
			}
		}
	});

	// ── session_compact ────────────────────────────────────────────────────────
	// L3: Compaction happened - harness-level minimum-fidelity trigger.
	// Key learnings from scratchpad must be persisted before they get lost.
	pi.on("session_compact", async (event: SessionCompactEvent, ctx: ExtensionContext) => {
		if (!state.enforcementActive) return;

		const compactTurn = state.currentTurn;

		try {
			const scratchpadResult = await (ctx as any).tools.scratchpad?.({ action: "read" });
			const details = (scratchpadResult as { details?: { key_learnings?: Array<{ persisted?: boolean }> } } | undefined)?.details;
			const learnings = details?.key_learnings ?? [];
			const unpersisted = learnings.filter((l) => !l.persisted);

			if (unpersisted.length > 0) {
				// L3: Individual message - compaction means context is about to lose these
				sendEnforcementWhisper(
					pi,
					`Context compacted at turn ${compactTurn}. ` +
					`${unpersisted.length} key learning(s) not yet persisted - these will be harder to recover:

` +
					unpersisted
						.map((l: any) => `- memory_store(content="${l.content}", memoryType="insight", tags=["${l.category}", "session"])`)
						.join("\n") +
					`

Persist them now - this is the minimum-fidelity moment.`,
				);
				// Also emit for L1 surfacing in prompt-builder
				enforcementSignals["unpersisted_learnings"] = {
					turn: state.currentTurn,
					text: `${unpersisted.length} key learning(s) not yet persisted - persist them now`,
					acted: false,
				};
				pi.events.emit("enforcement_signals", {
					turn: state.currentTurn,
					signals: { ...enforcementSignals },
				});
			}

			// Reset hygiene counters - compaction resets context, agent needs fresh start.
			// Rebase turn-based cooldown anchors to currentTurn so agent isn't nudged
			// before it starts working post-compaction.

			state.contextNudgeSent = false;
			state.lastContextCheckTurn = state.currentTurn;
			state.lastCompactionTurn = compactTurn;
			state.lastScratchpadNudgeTurn = state.currentTurn;
			state.overflowRecently = state.currentTurn; // Extend grace period through recovery

			// Reset memory tracking - fire on NEW code changes post-compaction only
			state.hasCodeChanges = false;
			state.lastCodeChangeTurn = 0;
			state.memoryNudgeSent = false;
			state.turnsSinceMemory = 0;
		} catch {
			// Silent fail - don't block on scratchpad read
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

		// ── PROBE-BASED: Complexity signals ───────────────────────────────────
		// Analyze task complexity and warn if mismatched
		const recentTools: string[] = [];
		for (const [, turn] of state.turnHistory) {
			recentTools.push(...turn.actualTools);
		}

		const lastTool = recentTools[recentTools.length - 1];
		let probeSuggestion = "";
		if (lastTool) {
			const probe = estimateComplexity(lastTool, undefined);
			const complexityCheck = checkComplexityMismatch(probe, {
				totalToolCalls: state.totalToolCalls,
				contextUsage: 0,
			});

			if (complexityCheck.mismatch) {
				probeSuggestion = complexityCheck.suggestion;
			}
		}

		// ── ROUTING-BASED: Intent signals ─────────────────────────────────────
		// Detect task intent and check if tools match
		const intent = detectIntent(recentTools.slice(-10), fullContent);
		const routingHint = getRoutingHint(intent.intent, recentTools);
		let routingSuggestion = "";

		if (routingHint) {
			routingSuggestion = routingHint;
		}

		if (lastTool && intent.confidence > 0.5) {
			const routingCheck = checkRoutingMismatch(lastTool, intent.intent);
			if (routingCheck.mismatch) {
				routingSuggestion = routingSuggestion
					? routingSuggestion + ". " + routingCheck.suggestion
				: routingCheck.suggestion;
			}
		}

		// Send probe/routing signals as low-priority nudges (bundled in turn_end)
		// These go through the existing nudge system to avoid creating new L2 signals here
		if (probeSuggestion || routingSuggestion) {
			// Store in enforcementSignals for prompt-builder to include in system prompt
			if (probeSuggestion) {
				enforcementSignals["probe"] = {
					turn: state.currentTurn,
					text: probeSuggestion,
					acted: false,
				};
			}
			if (routingSuggestion) {
				enforcementSignals["routing"] = {
					turn: state.currentTurn,
					text: routingSuggestion,
					acted: false,
				};
			}
		}

		// ── Reasoning stability check (MEASUREMENT_GAP_SOLUTION) ───────────
		const lastUserMsg = state.lastUserMessage || "";
		state.lastUserMessage = "";
		if (lastUserMsg.length > 10 && textContent.length > 100) {
			const stability = measureStability(lastUserMsg, textContent);
			if (!stability.stable) {
				enforcementSignals["stability"] = {
					turn: state.currentTurn,
					text: `[stability] Response ${stability.reason} (overlap=${stability.metrics.overlap.toFixed(2)}, entropy=${stability.metrics.entropy.toFixed(2)}, contradictions=${stability.metrics.contradictions})`,
					acted: false,
				};
			}
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

		// Legacy LLM Judge - only for text-only responses
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

	function extractTextContent(msg: any): string {
		if (typeof msg.content === "string") return msg.content;
		if (Array.isArray(msg.content)) {
			return msg.content
				.map((c: any) => (c.type === "text" ? c.text : c.type === "toolCall" ? `tool:${c.name}` : ""))
				.join(" ");
		}
		return "";
	}

	// ── Topic Drift Detection (PROPOSAL_TOPIC_DRIFT_DETECTOR)
	pi.on("turn_end", async (_event: any, ctx: ExtensionContext) => {
		if (!state.enforcementActive || !state.driftDetector) return;
		const session = (ctx.sessionManager as any)?.getCurrentSession?.() || null;
		const recentMsgs = session?.messages?.slice(-4) ?? [];
		for (let i = recentMsgs.length - 1; i >= 0; i--) {
			const msg = recentMsgs[i];
			const text = extractTextContent(msg);
			if (msg?.role === "user" && text.length > 10) {
				state.driftDetector.addTurn(text);
				break;
			}
		}
		const driftCheck = state.driftDetector.check();
		if (driftCheck.drifted) {
			const whisper = state.driftDetector.generateWhisper(driftCheck);
			if (whisper) {
				pi.sendMessage({ customType: "context", display: true, content: [{ type: "text", text: whisper }] });
			}
		}
	});
}
