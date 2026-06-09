import { createLogger } from "../../../lib/core/logger.js";

const log = createLogger("reasoning");
/**
 * Reasoning Extension — Minimal Thinking Helper
 *
 * Lightweight reasoning quality analyzer. On every assistant MESSAGE_END
 * it runs `measureStability()` from lib/reasoning/reasoning-metrics.ts and:
 *
 *   1. Emits a `reasoning` signal on the belief bus when stability degrades
 *      (repetitive / topic_drift / self_contradiction), with a `unstableStreak`
 *      counter that escalates severity as the streak grows.
 *   2. Sends a whisper nudge suggesting `verify()` when a stable response
 *      contains a completion claim and the cooldown has elapsed — closes the
 *      loop with the verify tool in core/metacognition.
 *
 * Why this lives in cognitive/ and not enforcement/:
 *   Enforcement has its own stability check (see enforcement/handlers/
 *   message-analysis.ts) that fires whisper nudges. This extension is the
 *   agent-facing reasoning quality surface — it emits structured signals
 *   for downstream consumers (analytics, dreamer) and tracks unstable
 *   streaks, which is work enforcement doesn't do.
 *
 * Tool-call shape validation (e.g., XML tags emitted as text instead of
 * function calls) lives in enforcement/detection/malformed.ts, not here.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { sendEnforcementWhisper } from "../../enforcement/whisper.js";
import { emitSignal } from "../../../lib/reasoning/belief-policy-engine.js";
import {
	measureStability,
	type StabilityMetrics,
	type StabilityReason,
} from "../../../lib/reasoning/reasoning-metrics.js";
import { MESSAGE_END } from "../../../lib/core/event-names.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Minimum assistant response length (chars) before stability is analyzed. */
const MIN_RESPONSE_LENGTH = 100;

/** Consecutive unstable turns before the signal severity escalates to "warn". */
const UNSTABLE_STREAK_ESCALATION = 3;

/** Minimum turns between verify-reminder whispers. */
const VERIFY_REMINDER_COOLDOWN = 5;

/** Patterns that suggest the agent is about to declare the task done. */
const COMPLETION_CLAIM_PATTERNS: readonly RegExp[] = [
	/\b(that should|this should|should (now )?work)\b/i,
	/\b(we('re| are) done|we('ve| have) finished|all (set|done))\b/i,
	/\b(task (is )?complete|fix(ed|es)? the (issue|bug|problem))\b/i,
	/\b(this (fix|solution) (should|works?))\b/i,
];

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReasoningState {
	/** Total turns elapsed in this session. */
	turnCount: number;
	/** Consecutive unstable turns; resets to 0 on a stable check. */
	unstableStreak: number;
	/** Most recent stability verdict. */
	lastReason: StabilityReason;
	/** Most recent stability metrics (null until the first check). */
	lastStability: StabilityMetrics | null;
	/** Most recent user message (used as the stability anchor). */
	lastUserMessage: string;
	/** Turn index of the most recent verify-reminder whisper (-cooldown means "ready"). */
	lastVerifyReminderTurn: number;
	/** Total verify-reminder whispers sent this session. */
	verifyRemindersSent: number;
}

function createReasoningState(): ReasoningState {
	return {
		turnCount: 0,
		unstableStreak: 0,
		lastReason: "ok",
		lastStability: null,
		lastUserMessage: "",
		lastVerifyReminderTurn: -VERIFY_REMINDER_COOLDOWN,
		verifyRemindersSent: 0,
	};
}

function getReasoningState(ctx: ExtensionContext): ReasoningState {
	return getExtensionState(ctx, "reasoning", createReasoningState);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractTextContent(message: { content: unknown }): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter(
			(c): c is { type: "text"; text: string } =>
				typeof c === "object" &&
				c !== null &&
				(c as { type?: string }).type === "text" &&
				typeof (c as { text?: unknown }).text === "string",
		)
		.map((c) => c.text)
		.join("\n");
}

function hasCompletionClaim(text: string): boolean {
	return COMPLETION_CLAIM_PATTERNS.some((p) => p.test(text));
}

// ── Extension Factory ────────────────────────────────────────────────────────

export default function reasoningExtension(pi: ExtensionAPI) {
	// Pre-Turn: bump turn counter (used to throttle the verify reminder).
	pi.on("before_agent_start", async (_event, ctx) => {
		const state = getReasoningState(ctx);
		state.turnCount++;
	});

	// Message End: stability check + verify-before-done nudge.
	pi.on(MESSAGE_END, async (event, ctx) => {
		const state = getReasoningState(ctx);
		const message = event.message as { role: string; content: unknown };
		const textContent = extractTextContent(message);

		// Track user messages so measureStability() can anchor to the request.
		if (message.role === "user") {
			state.lastUserMessage = textContent;
			return;
		}

		if (message.role !== "assistant") return;
		if (textContent.length < MIN_RESPONSE_LENGTH) return;

		// ── Stability check ──────────────────────────────────────────────
		const result = measureStability(state.lastUserMessage, textContent);
		state.lastStability = result.metrics;
		state.lastReason = result.reason;

		if (!result.stable) {
			state.unstableStreak++;
			const severity =
				state.unstableStreak >= UNSTABLE_STREAK_ESCALATION ? "warn" : "info";
			emitSignal(ctx, "reasoning", "unstable", severity, false, {
				reason: result.reason,
				metrics: result.metrics,
				streak: state.unstableStreak,
				turn: state.turnCount,
			});
			log.debug(
				`reasoning: unstable (${result.reason}) streak=${state.unstableStreak} turn=${state.turnCount}`,
			);
		} else {
			state.unstableStreak = 0;
		}

		// ── Verify-before-done nudge ──────────────────────────────────────
		// Only nudge on stable responses that look like a completion claim
		// — an unstable response is not the right moment to suggest a tool.
		if (
			result.stable &&
			hasCompletionClaim(textContent) &&
			state.turnCount - state.lastVerifyReminderTurn >= VERIFY_REMINDER_COOLDOWN
		) {
			sendEnforcementWhisper(
				pi,
				ctx,
				"[reasoning] Response looks complete. Consider calling verify() to catch any " +
					"issues before finalizing.",
			);
			state.lastVerifyReminderTurn = state.turnCount;
			state.verifyRemindersSent++;
		}
	});
}

// ── Public view (for analytics + downstream consumers) ───────────────────────

/**
 * Read-only view of the reasoning state for a given session.
 * Used by analytics and any future extension that wants to surface
 * reasoning quality to the user.
 */
export function getReasoningStateView(ctx: ExtensionContext): Readonly<ReasoningState> {
	return getReasoningState(ctx);
}
