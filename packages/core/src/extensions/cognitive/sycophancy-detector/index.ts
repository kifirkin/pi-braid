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
import {
  getExtensionState,
  getSessionIdSafe,
  safeSessionManagerTyped,
} from "../../../lib/state/extension-state.js";
import { setAcceptanceSignal } from "../../../lib/state/global-state.js";
import { classifyWithOffline } from "../../../lib/reasoning/classifier-offline.js";
import { CRITICS } from "../../../lib/ai/critic-registry.js";
import { MESSAGE_END } from "../../../lib/core/event-names.js";
import { MIN_TEXT_LENGTH_FOR_CLASSIFY } from "../../../lib/constants/session-thresholds.js";
import type { SessionEntry } from "../../../lib/state/session-manager.js";

const log = createLogger("sycophancy-detector");

const RISK_THRESHOLD = 0.5;
const MAX_WHISPERS_PER_SESSION = 10;
const COOLDOWN_TURNS = 3;

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

// Risk Computation (User Input)

interface SycophancyRisk {
  score: number;
  tactics: string[];
  severity: "low" | "medium" | "high";
  /**
   * True when the classifier call failed (tier === "failed"). The score
   * is the conservative "no risk" default. Consumers can check this to
   * surface a "sycophancy monitor offline" signal instead of the usual
   * risk whisper. Same anti-pattern as the topic-drift fix - never
   * silently default to "no problem" when the classifier is down.
   */
  classifierDown?: boolean;
}

/**
 * Compute sycophancy risk from user input.
 * Uses utility model classification (fallback: heuristic patterns).
 */
async function computeRisk(text: string, ctx: ExtensionContext): Promise<SycophancyRisk> {
  // Heuristic sycophancy detection misses novel forms, so this always uses
  // the LLM. classifyWithOffline() captures the offline state so the
  // consumer can emit a "sycophancy monitor offline" whisper.
  const result = await classifyWithOffline(
    ctx,
    CRITICS.sycophancyTactics.criteria,
    { text },
    {
      ...CRITICS.sycophancyTactics.options,
      tierPolicy: "always-llm",
      label: CRITICS.sycophancyTactics.label,
      fallback: () => "no",
    },
  );

  if (result.value === "yes") {
    return {
      score: 0.6,
      tactics: [`classify(${result.tier})`],
      severity: "medium",
    };
  }

  return {
    score: 0,
    tactics: [],
    severity: "low",
    classifierDown: result.classifierDown,
  };
}

// VbC Detection (Assistant Response)

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

  const result = await classifyWithOffline(
    ctx,
    CRITICS.vbCDetection.criteria,
    { text: truncated },
    {
      ...CRITICS.vbCDetection.options,
      // Q9: regex on "You're right...however" misses nuance. Always use LLM.
      tierPolicy: "always-llm",
      label: CRITICS.vbCDetection.label,
      fallback: () => "no",
    },
  );

  if (result.value === "yes") {
    return {
      detected: true,
      severity: "medium",
      score: 0.6,
      correction_hint:
        "Avoid validation-before-correction. State the correction directly " +
        "without first agreeing with the user's incorrect premise.",
    };
  }

  // classifierDown is intentionally not surfaced on VbC: VbC is a
  // pattern-match detector and the heuristic fallback is sufficient.
  // computeRisk() surfaces classifierDown; detectVbC() does not.
  return { detected: false, severity: "low", score: 0, correction_hint: "" };
}

// VbC detection is the heuristic detectVbC(), not an LLM auditor call: a
// per-response LLM audit costs ~30s latency and ~$0.002/call on paid models,
// and the heuristic achieves comparable detection for VbC patterns.

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

  const risk = await computeRisk(userText, ctx);
  // Note: We don't gate on risk.score here - VbC can occur even with neutral user input.
  // User risk is used as an additional signal for severity reporting below.

  log.info(`User sycophancy risk: ${risk.score.toFixed(2)} (${risk.tactics.join(", ") || "none"})`);

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

  // Replaces expensive 30s LLM auditor call with fast pattern matching
  const vbcResult = await detectVbC(responseText, ctx);
  if (!vbcResult.detected) return; // No VbC found - no correction needed

  log.info(`VbC detected: severity=${vbcResult.severity}, score=${vbcResult.score}`);

  state.detectionCount++;

  // Publish the already-computed acceptance verdict for the over-correction
  // gate (handlers/over-correction-gate.ts): the gate reads this seam at
  // tool-call time and treats a signal older than its recency window (or
  // from another session) as cold. Additive only — detection is unchanged.
  setAcceptanceSignal({
    atMs: Date.now(),
    score: vbcResult.score,
    sessionId: getSessionIdSafe(ctx),
  });

  const turnSinceLastWhisper = state.turnCount - state.lastWhisperTurn;
  if (turnSinceLastWhisper >= COOLDOWN_TURNS && state.whisperCount < MAX_WHISPERS_PER_SESSION) {
    sendEnforcementWhisper(pi, ctx, `VbC correction: ${vbcResult.correction_hint}`);
    state.whisperCount++;
    state.lastWhisperTurn = state.turnCount;
  }

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
    // anti-pattern fix as topic-drift.
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
