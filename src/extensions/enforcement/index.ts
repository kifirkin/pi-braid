import { createLogger } from "../../lib/logger.js";
import { resetState } from "./state.js";

const log = createLogger("enforcement");
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
import { getReplyInstruction, setLanguage, detectLanguage } from "../../lib/language-hint.js";
import {
	detectMissingVerification,
	recordCodeChange as detectRecordCodeChange,
} from "./detection/verification.js";
import { checkBlocking } from "./handlers/blocking.js";
import {
	addEvidence,
	getUnresolvedConflicts,
	detectConflicts,
	formatConflictMessage,
 } from "../../lib/evidence-pool.js";
import {
	processConflicts as processConflictQAs,
	getPendingQAs,
	formatConflictWhisper,
} from "../../lib/conflict-qa.js";
import {
	emitSignal,
	getNextRecommendation,
} from "../../lib/belief-policy-engine.js";
import {
	shouldAdvise as marsShouldAdvise,
} from "../../lib/mars-reflector.js";
import { recordBashDetails, recordToolCall, recordToolInput } from "./handlers/tool-tracker.js";
import { analyzeMessage } from "./handlers/message-analysis.js";
import {
	TurnAnalysisContext,
	detectRedundancySignal,
	handleCriticalSignals,
} from "./handlers/turn-analysis.js";
import { detectOrphanChains } from "./handlers/orphan-chains.js";
import { classifyError as classifyErrorLib } from "../../lib/error-classifier.js";
import { checkRoutingMismatch, detectIntent, getRoutingHint, type TaskIntent } from "./handlers/routing-handler.js";
import { analyzeWithJudge } from "./judge.js";
import { NudgeManager } from "./nudge-manager.js";
import { getState } from "./state.js";

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
	pi.on("input", async (event: { text?: string; source?: string }, ctx: ExtensionContext) => {
		if (!getState(ctx).enforcementActive) return;
		const text = event.text || "";
		if (!text || text.startsWith("/") || event.source === "extension") return;

		const lang = detectLanguage(text);
		if (lang.code === "EN") return;

		setLanguage(ctx, lang.code, lang.name);
		getState(ctx).lastUserMessage = text;
		const replyLang = getReplyInstruction(ctx);
		if (!replyLang) return;

		const session = (ctx as unknown as { sessionManager?: { getCurrentSession?(): { updateSystemPrompt?(opts: { append: string }): void } } }).sessionManager?.getCurrentSession?.();
		if (session?.updateSystemPrompt) {
			session.updateSystemPrompt({ append: replyLang });
		}
	});

	// Topic drift: initialize on session_start, check on turn_end
	pi.on("session_start", async (event, ctx: ExtensionContext) => {
		if (!getState(ctx).enforcementActive) return;
		const task = (event as unknown as { task?: string; prompt?: string }).task || (event as unknown as { task?: string; prompt?: string }).prompt || getState(ctx).originalRequest || "";
		if (task) {
			getState(ctx).driftDetector?.setTaskContext(task);
		}

		getState(ctx).currentTurn++;

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
	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		if (!getState(ctx).enforcementActive) {
			return undefined;
		}

		const toolName = event.toolName;
		const input = event?.input as Record<string, unknown> | undefined;

		recordToolCall(toolName);
		recordToolInput(toolName, input);

		if (toolName === "bash") {
			const cmd = (input as { command?: string } | undefined)?.command || "";
			recordBashDetails(cmd);
		}

		if (toolName === "edit" || toolName === "write") {
			detectRecordCodeChange(getState(ctx).currentTurn);
			getState(ctx).hasCodeChanges = true;
		}

		if (toolName === "edit" || toolName === "write") {
			const filePath = (input as { path?: string } | undefined)?.path;
			if (filePath) {
				knownFiles.set(filePath, { content: "", turn: getState(ctx).currentTurn });
			}
		}

		getState(ctx).toolLog.push(`${toolName}`);

		// Task 4a: Reflection gap + Task 4b: Thought chain tracking
		if (toolName === "think") {
			const thinkType = (input as { type?: string })?.type || "unknown";
			const parentId = (input as { parent_id?: string })?.parent_id || null;
			const confidence = (input as { confidence?: number })?.confidence;
			if (typeof confidence === "number") getState(ctx).lastThinkConfidence = confidence;
			const thoughtId = `t${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			getState(ctx).thoughtChains.push({ id: thoughtId, parentId, type: thinkType, timestamp: Date.now() });

			if (thinkType === "reflection" || thinkType === "conclusion") {
				getState(ctx).toolsSinceReflection = 0;
			} else {
				getState(ctx).toolsSinceReflection++;
			}
		} else {
			getState(ctx).toolsSinceReflection++;
		}

		// Sequence repetition detection: 9+ same tool in a row
		const REPETITION_THRESHOLD = 9;
		if (getState(ctx).toolLog.length >= REPETITION_THRESHOLD) {
			const lastN = getState(ctx).toolLog.slice(-REPETITION_THRESHOLD);
			if (lastN.every((t) => t === lastN[0])) {
				const now = Date.now();
				if (now - getState(ctx).lastNudgeTime > getState(ctx).nudgeCooldownMs) {
					getState(ctx).lastNudgeTime = now;
					sendEnforcementWhisper(pi, `Repeating ${toolName} ${REPETITION_THRESHOLD}+ times - consider a different approach`);
				}
			}
		}

		// Blocking enforcement
		const blockResult = checkBlocking(pi, toolName, input, getState(ctx));
		if (blockResult.blocked) {
			return { block: true, reason: blockResult.reason };
		}

		// Phase validation nudge
		const { message } = validateToolForPhase(toolName, getState(ctx).currentTurn);
		if (message) {
			const now = Date.now();
			if (now - getState(ctx).lastNudgeTime > getState(ctx).nudgeCooldownMs) {
				getState(ctx).lastNudgeTime = now;
				queueEnforcementWhisper(message);
			}
		}

		return undefined;
	});

	// ── message_end: conflict detection (Task 3) ────────────────────────────
	pi.on("message_end", async (event: any, ctx: any) => {
		if (!getState(ctx).enforcementActive) return;

		// Run conflict detection and surface unresolved conflicts
		const newConflicts = detectConflicts(ctx);
		if (newConflicts.length > 0) {
			const msg = formatConflictMessage(newConflicts[0]);
			queueEnforcementWhisper(msg);
			// Emit to Belief Policy Engine
			emitSignal(ctx, "conflict", "detected", newConflicts[0]?.for[0]?.confidence > 0.7 ? "warn" : "info", false, { conflictId: newConflicts[0]?.id });
		}

		const unresolved = getUnresolvedConflicts(ctx);
		if (unresolved.length > 0) {
			emitSignal(ctx, "conflict", "unresolved", "info", false, { count: unresolved.length });
		}
		if (unresolved.length > 0 && unresolved.length % 5 === 0) {
			// Every 5 unresolved conflicts, remind
			queueEnforcementWhisper(
				`[conflict] ${unresolved.length} unresolved source conflicts. ` +
				`Consider resolving: memory_store content with conflict_verified tag.`,
			);
		}

		// Conflict QA: classify conflicts and generate resolution questions
		const newQAs = processConflictQAs(ctx);
		if (newQAs.length > 0) {
			const whisper = formatConflictWhisper(newQAs);
			queueEnforcementWhisper(whisper);
		}
	});

	// ── tool_end: calibration tracking (Task 4c) ───────────────────────────
	// @ts-expect-error custom event not in ExtensionAPI types
	pi.on("tool_end", async (event: { tool?: string; error?: unknown }, ctx: ExtensionContext) => {
		if (!getState(ctx).enforcementActive) return;
		const toolName = event?.tool || "";
		if (toolName === "think") return;

		const predicted = getState(ctx).lastThinkConfidence;
		const actual = event?.error ? 0 : 1;
		getState(ctx).calibrationPairs.push({ predicted, actual, tool: toolName, turn: getState(ctx).currentTurn });

		if (getState(ctx).calibrationPairs.length > 50) {
			getState(ctx).calibrationPairs = getState(ctx).calibrationPairs.slice(-50);
		}

		// Evidence tracking: record tool outcomes as evidence
		addEvidence(
			ctx,
			`Tool ${toolName} ${event?.error ? "failed" : "succeeded"}`,
			"session",
			`${toolName}: ${event?.error ? "failure" : "success"} (confidence: ${predicted.toFixed(2)})`,
			predicted,
		);

		const error = Math.abs(predicted - actual);
		if (getState(ctx).calibrationPairs.length >= 10 && error > 0.4) {
			const recent = getState(ctx).calibrationPairs.slice(-10);
			const avgError = recent.reduce((s, p) => s + Math.abs(p.predicted - p.actual), 0) / recent.length;
			if (avgError > 0.3) {
				sendEnforcementWhisper(
					pi,
					`[calibration] High prediction error: ${(error * 100).toFixed(0)}% off on last ${toolName}. ` +
					`Avg error last 10 tools: ${(avgError * 100).toFixed(0)}%`,
				);
			}
		}
	});

	// ── turn_end ─────────────────────────────────────────────────────────────
	// Bundle all non-critical signals into ONE structured nudge.
	// L3 critical signals sent individually.
	pi.on("turn_end", async (event, ctx: ExtensionContext) => {
		if (!getState(ctx).enforcementActive) {
			return;
		}

		const actualTools = (event.toolResults || []).map((r) => r.toolName);
		const erroredTools = new Set(
			(event.toolResults || []).filter((r) => r.isError).map((r) => r.toolName),
		);
		const hadErrors = erroredTools.size > 0;

		// Detect context overflow - suppress L2 signals during recovery so the agent
		// gets breathing room to stabilize after compaction/retry.
		const msgContent = (event.message as unknown as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
		const isOverflowTurn =
			event.message.role === "assistant" &&
			"stopReason" in event.message &&
			(event.message as unknown as { stopReason?: string }).stopReason === "error" &&
			msgContent
				.filter((c) => c?.type === "text")
				.map((c) => c?.text || "")
				.join(" ")
				.toLowerCase()
				.includes("context") &&
			msgContent
				.filter((c) => c?.type === "text")
				.map((c) => c?.text || "")
				.join(" ")
				.toLowerCase()
				.includes("overflow");

		if (isOverflowTurn) {
			getState(ctx).overflowRecently = getState(ctx).currentTurn;
		}

		// Track code changes
		if (actualTools.some((t) => ["edit", "write"].includes(t))) {
			detectRecordCodeChange(getState(ctx).currentTurn);
		}

		// Track memory/context tools
		detectMissingVerification(pi as never, getState(ctx).currentTurn);

		const scratchpadUpdated = actualTools.includes("scratchpad");
		if (scratchpadUpdated) {
			getState(ctx).lastScratchpadNudgeTurn = -100;
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
				getState(ctx).turnsSinceMemory++;
			}
		} else {
			getState(ctx).turnsSinceMemory = 0;
		}

		const turnState: TurnState = {
			turnIndex: getState(ctx).currentTurn,
			plannedTools: [],
			actualTools,
			scratchpadUpdated,
			memoryUpdated,
			sequenceRepetitionCount: 0,
			thinkCalledBeforeEdit: getState(ctx).toolChain.lastThinkCall >= getState(ctx).currentTurn - 2,
			planCalledForBugFix: getState(ctx).toolChain.lastPlanCall >= getState(ctx).currentTurn - 3,
		};

		getState(ctx).turnHistory.set(getState(ctx).currentTurn, turnState);

		if (getState(ctx).turnHistory.size > 50) {
			const oldest = Math.min(...getState(ctx).turnHistory.keys());
			getState(ctx).turnHistory.delete(oldest);
		}

		// ── Redundancy Detection ─────────────────────────────────────────────────
		if (actualTools.some((t) => ["edit", "write"].includes(t))) {
			const tac: TurnAnalysisContext = {
				pi,
				ctx,
				state: getState(ctx),
				event: { role: event.message.role, stopReason: (event.message as unknown as { stopReason?: string }).stopReason },
				actualTools,
				erroredTools,
				hadErrors,
				knownFiles,
				enforcementSignals,
				sendWhisper: (msg) => sendEnforcementWhisper(pi, msg),
				loadFileContent,
			};
			await detectRedundancySignal(tac);
		}

		// ── L3: Critical signals ───────────────────────────────────────────────
		const prevTurn = getState(ctx).turnHistory.get(getState(ctx).currentTurn - 1);
		const tac: TurnAnalysisContext = {
			pi,
			ctx,
			state: getState(ctx),
			event: { role: event.message.role, stopReason: (event.message as unknown as { stopReason?: string }).stopReason },
			actualTools,
			erroredTools,
			hadErrors,
			knownFiles,
			enforcementSignals,
			sendWhisper: (msg) => sendEnforcementWhisper(pi, msg),
			loadFileContent,
		};
		handleCriticalSignals(tac, prevTurn, turnState, nudgeManager, validateTurn);

		// ── Task 4b: Orphan thought chain detection ────────────────────────────
		const orphanResult = detectOrphanChains(getState(ctx));
		if (orphanResult) {
			sendEnforcementWhisper(pi, orphanResult.suggestion);
		}

		// ── L2: Non-critical signals → bundled Session Signals nudge ─────────

		// Collect signals for the bundled nudge
		const sessionSignals: string[] = [];

		// Memory signal: fires on EVENT basis, not schedule.
		// Trigger: code changed after last memory usage (not just turns elapsed).
		// The session_compact handler fires the primary compaction memory signal.
		// Skip during overflow recovery - agent needs breathing room to stabilize.
		const RECOVERY_GRACE_TURNS = 5;
		const inOverflowRecovery = getState(ctx).currentTurn - getState(ctx).overflowRecently < RECOVERY_GRACE_TURNS;

		if (
			!hadErrors &&
			!inOverflowRecovery &&
			getState(ctx).config.enforceMemory &&
			getState(ctx).hasCodeChanges &&
			getState(ctx).turnsSinceMemory >= 20 && // only after substantial work without memory
			!getState(ctx).memoryNudgeSent
		) {
			getState(ctx).memoryNudgeSent = true;
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
			getState(ctx).config.enforceScratchpad &&
			actualTools.some((t) => ["edit", "write"].includes(t)) &&
			!scratchpadUpdated
		) {
			// Only signal if we haven't done so recently
			if (getState(ctx).currentTurn - getState(ctx).lastScratchpadNudgeTurn >= 8) {
				getState(ctx).lastScratchpadNudgeTurn = getState(ctx).currentTurn;
				sessionSignals.push(
					`Code changed without updating scratchpad - consider scratchpad(action="add_note", text="...") or scratchpad(action="add_decision", text="...")`,
				);
			}
		}

		// Think tool enforcement: nudge if many turns without think()
		if (
			!hadErrors &&
			!inOverflowRecovery &&
			getState(ctx).toolChain.lastThinkCall === 0 &&
			getState(ctx).currentTurn >= 5 &&
			getState(ctx).currentTurn % 5 === 0
		) {
			sessionSignals.push(
				`${getState(ctx).currentTurn} turns without think() - use think(observation, decision, reason) to track reasoning`,
			);
		}

		// Context usage signal (only at high usage - semantic, not metric)
		if (actualTools.some((t) =>
			["context_tag", "context_log", "context_checkout", "context_prune", "context_audit"].includes(t),
		)) {
			getState(ctx).lastContextCheckTurn = getState(ctx).currentTurn;
			getState(ctx).contextNudgeSent = false;
		}

		let usagePercent = 0;
		try {
				const ctxFromEvent = (event as unknown as { ctx?: { getContextUsage?(): { percent?: number } } })?.ctx;
			const usage = ctxFromEvent?.getContextUsage?.();
			if (usage) usagePercent = usage.percent ?? 0;
		} catch { /* ignore */ }

		if (
			!hadErrors &&
			actualTools.length > 0 &&
			getState(ctx).currentTurn - getState(ctx).lastContextCheckTurn >= getState(ctx).contextCheckInterval &&
			!getState(ctx).contextNudgeSent &&
			usagePercent > 0
		) {
			getState(ctx).contextNudgeSent = true;

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
				if (enforcementSignals[key].turn < getState(ctx).currentTurn - 1) {
					delete enforcementSignals[key];
				}
			}

			// Populate L1 signal store - keyed by semantic type for easy lookup
			// Also emit via event bus for cross-extension coordination (prompt-builder)
			for (const signal of sessionSignals) {
				const entry = { turn: getState(ctx).currentTurn, text: signal, acted: false };
				if (signal.includes("nothing stored") || signal.includes("memory_store")) {
					enforcementSignals["memory"] = { ...entry, acted: getState(ctx).memoryNudgeSent };
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
				turn: getState(ctx).currentTurn,
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
		if (!getState(ctx).enforcementActive) return;

		const compactTurn = getState(ctx).currentTurn;

		try {
			const scratchpadResult = await (ctx as unknown as { tools?: { scratchpad?(params: { action: string }): Promise<unknown> } }).tools?.scratchpad?.({ action: "read" });
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
					turn: getState(ctx).currentTurn,
					text: `${unpersisted.length} key learning(s) not yet persisted - persist them now`,
					acted: false,
				};
				pi.events.emit("enforcement_signals", {
					turn: getState(ctx).currentTurn,
					signals: { ...enforcementSignals },
				});
			}

			// Reset hygiene counters - compaction resets context, agent needs fresh start.
			// Rebase turn-based cooldown anchors to currentTurn so agent isn't nudged
			// before it starts working post-compaction.

			getState(ctx).contextNudgeSent = false;
			getState(ctx).lastContextCheckTurn = getState(ctx).currentTurn;
			getState(ctx).lastCompactionTurn = compactTurn;
			getState(ctx).lastScratchpadNudgeTurn = getState(ctx).currentTurn;
			getState(ctx).overflowRecently = getState(ctx).currentTurn; // Extend grace period through recovery

			// Reset memory tracking - fire on NEW code changes post-compaction only
			getState(ctx).hasCodeChanges = false;
			getState(ctx).lastCodeChangeTurn = 0;
			getState(ctx).memoryNudgeSent = false;
			getState(ctx).turnsSinceMemory = 0;
		} catch {
			// Silent fail - don't block on scratchpad read
  /* Non-fatal: enforcement state access failed */
		}
	});

	// ── auto_retry_end ────────────────────────────────────────────────────────
	// L3: Infrastructure errors from retry failures → individual, semantic
	// @ts-expect-error custom event not in ExtensionAPI types
	pi.on("auto_retry_end", async (event: { success: boolean; attempt: number; finalError?: string }, ctx: ExtensionContext) => {
		if (!getState(ctx).enforcementActive) return;

		const { success, attempt, finalError } = event;

		if (!success) {
			getState(ctx).validationFailures++;

			const now = Date.now();
			if (now - getState(ctx).lastNudgeTime < getState(ctx).nudgeCooldownMs) return;
			getState(ctx).lastNudgeTime = now;

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
		if (!getState(ctx).enforcementActive) {
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

		// ── Message Analysis (complexity, routing, stability) ─────────────────
		const analysisSignals = analyzeMessage(textContent, thinkingContent, getState(ctx));
		getState(ctx).lastUserMessage = "";
		const signalEntries = analysisSignals as Record<string, { turn: number; text: string; acted: boolean }>;
		for (const [key, signal] of Object.entries(signalEntries)) {
			if (signal?.text) {
				enforcementSignals[key] = signal;
			}
		}

		const turnState = getState(ctx).turnHistory.get(getState(ctx).currentTurn);
		if (turnState) {
			detectMalformedToolCalls(textContent, pi);
		}

		// Skip verification judge if already running
		if (getState(ctx).verificationJudgeRunning) {
			return;
		}

		const userHasBash = Array.from(getState(ctx).uniqueToolsUsed).includes("bash");

		const VERIFICATION_GAP_TURNS = getState(ctx).config.verifyAfterCodeChanges ? 8 : Infinity;
		const turnsSinceCodeChange = getState(ctx).currentTurn - getState(ctx).lastVerificationJudgeTurn;
		const hasVerificationGap =
			getState(ctx).hasCodeChanges && !userHasBash && turnsSinceCodeChange >= VERIFICATION_GAP_TURNS;

		const isPeriodicCheck =
			getState(ctx).config.verificationJudgeInterval > 0 &&
			getState(ctx).hasCodeChanges &&
			getState(ctx).currentTurn - getState(ctx).lastVerificationJudgeTurn >= getState(ctx).config.verificationJudgeInterval;

		if (
			getState(ctx).config.useVerificationJudge &&
			!getState(ctx).verificationJudgeRunning &&
			(hasVerificationGap || isPeriodicCheck) &&
			getState(ctx).uniqueToolsUsed.size > 0
		) {
			const now = Date.now();

			if (now - getState(ctx).lastJudgeTime < 60_000) {
				return;
			}

			getState(ctx).verificationJudgeRunning = true;

			const toolLog: string[] = [];
			for (const [, turn] of getState(ctx).turnHistory) {
				if (turn.actualTools.length > 0) {
					toolLog.push(`Turn ${turn.turnIndex}: [${turn.actualTools.join(", ")}]`);
				}
			}

			const judgeCtx: JudgeContext = {
				userRequest: getState(ctx).originalRequest,
				toolsUsed: Array.from(getState(ctx).uniqueToolsUsed),
				toolLog,
				hasCodeChanges: getState(ctx).hasCodeChanges,
				hasVerification: userHasBash,
				lastResponse: fullContent,
				thinking: thinkingContent,
			};

			const result = await runVerificationJudge(ctx as never, judgeCtx, { timeoutMs: 30000 });

			getState(ctx).lastVerificationJudgeTurn = getState(ctx).currentTurn;
			getState(ctx).verificationJudgeRunning = false;

			if (result) {
				if (result.verdict === "fail" || result.verdict === "warn") {
					// L3: Verification judge is critical enough to warrant individual message
					sendEnforcementWhisper(pi, formatVerificationNudge(result));
					if (result.verdict === "fail") {
						getState(ctx).validationFailures++;
					}
				}
			}
		}

		// Legacy LLM Judge - only for text-only responses
		if (getState(ctx).config.useJudge && turnState && turnState.actualTools.length === 0) {
			const now = Date.now();

			if (now - getState(ctx).lastJudgeTime < getState(ctx).config.judgeCooldownMs) {
				return;
			}

			getState(ctx).judgeSkipCounter++;
			if (getState(ctx).judgeSkipCounter < getState(ctx).config.judgeSkipTurns) {
				return;
			}
			getState(ctx).judgeSkipCounter = 0;

			const history: string[] = [];
			for (const [turnIdx, turn] of getState(ctx).turnHistory) {
				if (turnIdx >= getState(ctx).currentTurn) continue;
				const tools = turn.actualTools.length > 0 ? ` [Tools: ${turn.actualTools.join(", ")}]` : "";
				history.push(`[Turn ${turnIdx}]${tools}`);
			}

			const { analysis, action } = await analyzeWithJudge(ctx as never, fullContent, history, {
				timeoutMs: 30000,
			});

			getState(ctx).lastJudgeTime = now;
			getState(ctx).lastJudgeAnalysis = analysis;

			if (action.type === "nudge" && action.nudgeMessage) {
				const rateLimitOk = now - getState(ctx).lastNudgeTime > getState(ctx).nudgeCooldownMs;
				if (rateLimitOk) {
					getState(ctx).lastNudgeTime = now;
					sendEnforcementWhisper(pi, action.nudgeMessage);

					if (action.priority === "critical" || action.priority === "high") {
						getState(ctx).validationFailures++;
					}
				}
			}
		}
	});

	// ── Commands ───────────────────────────────────────────────────────────────
	pi.registerCommand("enforcement-on", {
		description: "Enable enforcement",
		handler: async (_args, ctx) => {
			getState(ctx).enforcementActive = true;
			ctx.ui.notify("Enforcement enabled", "info");
		},
	});

	pi.registerCommand("enforcement-off", {
		description: "Disable enforcement",
		handler: async (_args, ctx) => {
			getState(ctx).enforcementActive = false;
			ctx.ui.notify("Enforcement disabled", "info");
		},
	});

	pi.registerCommand("enforcement-stats", {
		description: "Show enforcement stats",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`Turn ${getState(ctx).currentTurn} | Failures: ${getState(ctx).validationFailures} | Silent: ${getState(ctx).silentTurns}`,
				"info",
			);
		},
	});
	// Helpers
	function _classifyRetryError(
		errorMsg: string,
	): "rate_limit" | "server_error" | "network" | "unknown" {
		const classification = classifyErrorLib(errorMsg);
		if (classification.category === "TRANSIENT") {
			if (/429|rate.?limit/i.test(errorMsg)) return "rate_limit";
			return "server_error";
		}
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
		if (!getState(ctx).enforcementActive || !getState(ctx).driftDetector) return;
			const session = (ctx as unknown as { sessionManager?: { getCurrentSession?(): { messages?: Array<{ role?: string; content?: unknown }> } } }).sessionManager?.getCurrentSession?.() || null;
		const recentMsgs = session?.messages?.slice(-4) ?? [];
		for (let i = recentMsgs.length - 1; i >= 0; i--) {
			const msg = recentMsgs[i];
			const text = extractTextContent(msg);
			if (msg?.role === "user" && text.length > 10) {
				getState(ctx).driftDetector.addTurn(text);
				break;
			}
		}
		const driftCheck = getState(ctx).driftDetector.check();
		if (driftCheck.drifted) {
			const whisper = getState(ctx).driftDetector.generateWhisper(driftCheck);
			if (whisper) {
				pi.sendMessage({
					customType: "context",
					display: true,
					content: [{ type: "text", text: whisper }],
				});
			}
			// Emit to Belief Policy Engine
			emitSignal(ctx, "topic-drift", "detected", driftCheck.severity === "strong" ? "warn" : "info", false, { severity: driftCheck.severity });
		}

		// Belief Policy Engine — get actionable recommendations and surface them
		const bpeRec = getNextRecommendation(ctx);
		if (bpeRec) {
			pi.sendMessage({
				customType: "context",
				display: true,
				content: [{ type: "text", text: `[policy] ${bpeRec.message}` }],
			});
		}

		// MARS — get self-reflection advice
		const marsAdvice = marsShouldAdvise(ctx);
		if (marsAdvice) {
			pi.sendMessage({
				customType: "context",
				display: true,
				content: [{ type: "text", text: marsAdvice.message }],
			});
		}
	});

	// ── Session shutdown: reset state for session isolation (D1) ─────────────
	pi.on("session_shutdown", async (_event: any, ctx: ExtensionContext) => {
		const state = getState(ctx);
		const sessionId = ctx.cwd ?? "default";

		// Log session summary before cleanup
		log.info(
			`[session_shutdown] Session ${sessionId}: ` +
				`${state.totalToolCalls} tool calls, ${state.uniqueToolsUsed.size} unique tools, ` +
				`${state.verificationsDone} verifications, ${state.validationFailures} failures`,
		);

		// Reset state for this session (clears turnHistory, toolSequences, etc.)
		resetState(state);

		log.info(`[session_shutdown] Enforcement state reset for session ${sessionId}`);
	});
}
