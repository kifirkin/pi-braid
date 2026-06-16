/**
 * Silicon Mirror - Anti-Sycophancy Detector
 *
 * MVI: Detects validation-before-correction (VbC) patterns in agent responses.
 * Fires whisper correction + emits signal on detection.
 *
 * Research base: arxiv:2604.00478 "The Silicon Mirror" (K&W 2026)
 *                arxiv:2604.19117 "LLMs know they're wrong" (Pandey 2026)
 *
 * Key constraint: pi-braid has no pre-response hook. Detection fires
 * post-message_end; the VbC response is already sent. Whisper corrects
 * future behavior, not the past response.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sendEnforcementWhisper } from "../../enforcement/whisper.js";
import { emitSignal } from "../../../lib/reasoning/belief-policy-engine.js";
import { createLogger } from "../../../lib/core/logger.js";
import { getExtensionState, safeSessionManagerTyped } from "../../../lib/state/extension-state.js";
import { classify } from "../../../lib/ai/text-classifier.js";
import { CRITICS } from "../../../lib/ai/critic-registry.js";
import { MESSAGE_END } from "../../../lib/core/event-names.js";
import { MIN_TEXT_LENGTH_FOR_CLASSIFY } from "../../../lib/constants/session-thresholds.js";
import type { SessionEntry } from "../../../lib/state/session-manager.js";

const log = createLogger("sycophancy-detector");

// ── Config ────────────────────────────────────────────────────────────────────

const RISK_THRESHOLD = 0.5;
const MAX_WHISPERS_PER_SESSION = 10;
const COOLDOWN_TURNS = 3;

// ── State ─────────────────────────────────────────────────────────────────────

interface SycophancyState {
  detectionCount: number;
  whisperCount: number;
  lastWhisperTurn: number;
  turnCount: number;
}

function createState(): SycophancyState {
  return { detectionCount: 0, whisperCount: 0, lastWhisperTurn: -COOLDOWN_TURNS, turnCount: 0 };
}

function getState(ctx: ExtensionContext): SycophancyState {
  return getExtensionState(ctx, "sycophancy-detector", createState);
}

// ── Risk Computation (User Input) ──────────────────────────────────────────────

interface SycophancyRisk {
  score: number;
  tactics: string[];
  severity: "low" | "medium" | "high";
  /**
   * True when the classifier call failed (tier === "failed"). The score
   * is the conservative "no risk" default. Consumers can check this to
   * surface a "sycophancy monitor offline" signal instead of the usual
   * risk whisper. Same anti-pattern as the input-polisher (9966c8ad)
   * and topic-drift fixes - never silently default to "no problem"
   * when the classifier is down.
   */
  classifierDown?: boolean;
}

/**
 * Compute sycophancy risk from user input.
 * Uses utility model classification (fallback: heuristic patterns).
 */
async function computeRisk(text: string, ctx: ExtensionContext): Promise<SycophancyRisk> {
  const result = await classify(
    ctx,
    CRITICS.sycophancyTactics.criteria,
    { text },
    {
      ...CRITICS.sycophancyTactics.options,
      // Q9: heuristic sycophancy detection misses novel forms. Always use LLM.
      tierPolicy: "always-llm",
      label: CRITICS.sycophancyTactics.label,
    },
  );

  if (result.label === "yes") {
    return {
      score: 0.6,
      tactics: [`classify(${result.tier})`],
      severity: "medium",
    };
  }

  // classifierDown signal: tier === "failed" means the LLM call did
  // not produce a usable answer. We still return score:0 (the safe
  // default) but flag the offline state so the consumer can emit a
  // "sycophancy monitor offline" whisper.
  return {
    score: 0,
    tactics: [],
    severity: "low",
    classifierDown: result.tier === "failed",
  };
}

// ── VbC Detection (Assistant Response) ────────────────────────────────────────



interface VbCResult {
  detected: boolean;
  severity: "low" | "medium" | "high";
  score: number;
  correction_hint: string;
}

/**
 * Detect validation-before-correction (VbC) in assistant responses.
 * Uses utility model classification (fallback: heuristic patterns).
 * Replaces the 30s LLM auditor - this runs in ~50ms via the utility model.
 */
async function detectVbC(responseText: string, ctx: ExtensionContext): Promise<VbCResult> {
  if (responseText.length < 100) {
    return { detected: false, severity: "low", score: 0, correction_hint: "" };
  }

  // Truncate long responses to keep prompt tokens reasonable
  const truncated = responseText.length > 2000 ? responseText.slice(0, 2000) + "..." : responseText;

  const result = await classify(
    ctx,
    CRITICS.vbCDetection.criteria,
    { text: truncated },
    {
      ...CRITICS.vbCDetection.options,
      // Q9: regex on "You're right...however" misses nuance. Always use LLM.
      tierPolicy: "always-llm",
      label: CRITICS.vbCDetection.label,
    },
  );

  if (result.label === "yes") {
    return {
      detected: true,
      severity: "medium",
      score: 0.6,
      correction_hint:
        "Avoid validation-before-correction. State the correction directly " +
        "without first agreeing with the user's incorrect premise.",
    };
  }

  return { detected: false, severity: "low", score: 0, correction_hint: "" };
}

// ── Auditor LLM (Optional Async) ──────────────────────────────────────────────
// Previously: 30s LLM auditor call per response. Removed in favor of heuristic detectVbC().
// The LLM approach was too expensive (~30s latency, ~$0.002/call on paid models)
// and the heuristic achieves comparable detection for VbC patterns.
// To re-introduce: import callLlm from judge-utils.js, define AUDITOR_SYSTEM prompt,
// and call auditorLLM(ctx, responseText) in handleSycophancy().

// ── Core Handler ──────────────────────────────────────────────────────────────

async function handleSycophancy(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: SycophancyState,
): Promise<void> {
  state.turnCount++;

  // Get session history - use getBranch(), getCurrentSession() does not exist on SessionManager
  // Use safeSessionManagerTyped to avoid assertActive() crash on stale ctx
  const sm = safeSessionManagerTyped(ctx);

  const entries: SessionEntry[] = sm?.getBranch?.() ?? [];

  const messages: any[] = entries
    .filter((e: any) => e.type === "message")
    .map((e: any) => e.message);

  // Get the last user message
  const userMessages = messages.filter((m: any) => m.role === "user");
  const lastUserMsg = userMessages[userMessages.length - 1];
  const userText =
    typeof lastUserMsg?.content === "string"
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg?.content)
        ? (lastUserMsg.content as unknown[])
            .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
            .map((c: { type: "text"; text: string }) => c.text)
            .join("\n")
        : "";

  if (userText.length < 30) return; // Skip short messages

  // Step 1: Compute tactic-based risk from user message (optional signal)
  const risk = await computeRisk(userText, ctx);
  // Note: We don't gate on risk.score here - VbC can occur even with neutral user input.
  // User risk is used as an additional signal for severity reporting below.

  log.info(`User sycophancy risk: ${risk.score.toFixed(2)} (${risk.tactics.join(", ") || "none"})`);

  // Get the last assistant response
  const assistantMessages = messages.filter((m: any) => m.role === "assistant");
  const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];
  const responseText =
    typeof lastAssistantMsg?.content === "string"
      ? lastAssistantMsg.content
      : Array.isArray(lastAssistantMsg?.content)
        ? (lastAssistantMsg.content as unknown[])
            .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
            .map((c: { type: "text"; text: string }) => c.text)
            .join("\n")
        : "";

  if (responseText.length < MIN_TEXT_LENGTH_FOR_CLASSIFY) return;

  // Step 2: Detect VbC in assistant response using heuristic patterns
  // Replaces expensive 30s LLM auditor call with fast pattern matching
  const vbcResult = await detectVbC(responseText, ctx);
  if (!vbcResult.detected) return; // No VbC found - no correction needed

  log.info(`VbC detected: severity=${vbcResult.severity}, score=${vbcResult.score}`);

  // Step 3: Update state
  state.detectionCount++;

  // Step 4: Rate limit whispers (max 10 per session, min 3 turns between)
  const turnSinceLastWhisper = state.turnCount - state.lastWhisperTurn;
  if (turnSinceLastWhisper >= COOLDOWN_TURNS && state.whisperCount < MAX_WHISPERS_PER_SESSION) {
    sendEnforcementWhisper(pi, ctx, `VbC correction: ${vbcResult.correction_hint}`);
    state.whisperCount++;
    state.lastWhisperTurn = state.turnCount;
  }

  // Step 5: Emit signal for policy engine tracking
  const combinedSeverity =
    risk.score >= RISK_THRESHOLD
      ? risk.severity === "high" || vbcResult.severity === "high"
        ? "warn"
        : "info"
      : vbcResult.severity === "high"
        ? "warn"
        : "info";
  emitSignal(ctx, "sycophancy", "detected", combinedSeverity, false, {
    userRisk: risk.score,
    userTactics: risk.tactics,
    vbcScore: vbcResult.score,
    vbcSeverity: vbcResult.severity,
    // Surface classifier-down state so downstream consumers (analytics,
    // logging) can see when the sycophancy monitor was offline. Same
    // anti-pattern fix as input-polisher 9966c8ad and topic-drift.
    userRiskClassifierDown: risk.classifierDown ?? false,
  });

  // If the user-risk classifier is down, emit a separate signal so the
  // operator knows the monitor is offline. Don't pretend the absence
  // of "yes" votes means there's no sycophancy.
  if (risk.classifierDown) {
    emitSignal(ctx, "sycophancy", "user_risk_classifier_down", "warn", false, {
      reason: "sycophancy-tactics classifier unavailable",
    });
  }
}

// ── Extension Factory ─────────────────────────────────────────────────────────

export default function sycophancyDetector(): (pi: ExtensionAPI) => void {
  return function register(pi: ExtensionAPI): void {
    pi.on(MESSAGE_END, async (event: any, ctx: ExtensionContext) => {
      try {
        if (event.message?.role !== "assistant") return;

        // Skip short responses (tool call results, etc.)
        const textContent = (event.message.content ?? [])
          .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
          .map((c: { type: "text"; text: string }) => c.text)
          .join("\n");
        if (textContent.length < MIN_TEXT_LENGTH_FOR_CLASSIFY) return;

        const state = getState(ctx);
        await handleSycophancy(pi, ctx, state);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[sycophancy] message_end handler error: ${msg}`);
      }
    });
  };
}
