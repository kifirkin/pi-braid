/**
 * Silicon Mirror — Anti-Sycophancy Detector
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

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { sendEnforcementWhisper } from "../../enforcement/whisper.js";
import { emitSignal } from "../../../lib/belief-policy-engine.js";
import { createLogger } from "../../../lib/logger.js";
import { getExtensionState } from "../../../lib/extension-state.js";

const log = createLogger("sycophancy-detector");

// ── Config ────────────────────────────────────────────────────────────────────

const RISK_THRESHOLD = 0.5;
const MAX_WHISPERS_PER_SESSION = 10;
const COOLDOWN_TURNS = 3;

// ── Tactic Patterns ───────────────────────────────────────────────────────────

interface Tactic {
  name: string;
  pattern: RegExp;
  severity: number;
}

const TACTICS: Tactic[] = [
  {
    name: "AGREEABLENESS",
    pattern: /\b(I think|I believe|you must (agree|be right)|Surely)\b/i,
    severity: 0.3,
  },
  {
    name: "CONFIDENCE_ERROR",
    pattern: /\b(This is definitely|The code (always|never)|Obviously)\b/i,
    severity: 0.7,
  },
  {
    name: "SKEPTICISM",
    pattern: /\b(That (approach|solution) is (wrong|bad)|Why would you)\b/i,
    severity: 0.5,
  },
  { name: "LOADED_QUESTION", pattern: /\bWhy did you (do|choose|use)/i, severity: 0.6 },
  {
    name: "AUTHORITY_CLAIM",
    pattern: /\b(Trust me|As a (senior|expert)|Everyone knows)\b/i,
    severity: 0.5,
  },
];

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
}

/**
 * Compute sycophancy risk from user input.
 * Uses matchAll() to count ALL alternation matches per tactic pattern,
 * not just the first match (fix: old code used test() which returns on first match).
 */
function computeRisk(text: string): SycophancyRisk {
  let totalScore = 0;
  const matched: string[] = [];

  for (const tactic of TACTICS) {
    // Use matchAll to count ALL alternation matches, not just the first
    const matches = [...text.matchAll(new RegExp(tactic.pattern.source, tactic.pattern.flags))];
    // Each match contributes the tactic's severity (capped at 1.0 total per tactic type)
    const tacticScore = Math.min(tactic.severity, matches.length * tactic.severity * 0.5);
    if (matches.length > 0) {
      totalScore += tacticScore;
      matched.push(`${tactic.name}(${matches.length})`);
    }
  }

  const score = Math.min(1, totalScore);
  return {
    score,
    tactics: matched,
    severity: score >= 0.7 ? "high" : score >= 0.5 ? "medium" : "low",
  };
}

// ── VbC Detection (Assistant Response) ────────────────────────────────────────

/**
 * Detect validation-before-correction (VbC) patterns in assistant responses.
 * Uses heuristic patterns instead of 30s LLM auditor call.
 *
 * VbC patterns: "You're right that X... however Y"
 *                "That's a fair point... but actually"
 *                "I understand your concern... but the issue is"
 */
const VBC_PATTERNS: RegExp[] = [
  // Classic VbC: validate then correct
  /\b(You('re| are) right\b|That('s| is) a (fair|good) point\b|I understand your (concern|point|perspective)\b)(?=.*\b(however|but actually|the (real|actual) (issue|problem)|having said that)\b).{50,}/is,
  // Agreement then correction
  /\b(I agree\b|That makes sense\b|You make a good point\b)(?=.*\b(however|but|yet|nevertheless|on the other hand)\b).{50,}/is,
  // "I think you're right but..."
  /\bI think you('re| are) right\b(?=.*\b(but|however)\b).{50,}/is,
  // Correction prefaced with disagreement deferral
  /\b(While|Although|Even though) (you('re| are) (right|correct)|that('s| is) valid)\b.{30,}actually\b.{20,}/is,
];

/**
 * Score suggested correction instruction based on the VbC text.
 * Higher score = more severe VbC.
 */
interface VbCResult {
  detected: boolean;
  severity: "low" | "medium" | "high";
  score: number;
  correction_hint: string;
}

function detectVbC(responseText: string): VbCResult {
  if (responseText.length < 100) {
    return { detected: false, severity: "low", score: 0, correction_hint: "" };
  }

  let totalScore = 0;
  const matchedPatterns: string[] = [];

  for (const pattern of VBC_PATTERNS) {
    const matches = responseText.match(pattern);
    if (matches) {
      totalScore += 0.6; // Each matched VbC pattern adds 0.6
      matchedPatterns.push(pattern.source.substring(0, 40));
    }
  }

  const score = Math.min(1, totalScore);
  return {
    detected: score >= 0.4,
    severity: score >= 0.8 ? "high" : score >= 0.5 ? "medium" : "low",
    score,
    correction_hint:
      score >= 0.4
        ? "Avoid validation-before-correction. State the correction directly without first agreeing with the user's incorrect premise."
        : "",
  };
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

  // Get session history
  const session = (ctx as any).sessionManager?.getCurrentSession?.();
  const messages = session?.messages ?? [];

  // Get the last user message
  const userMessages = messages.filter((m: any) => m.role === "user");
  const lastUserMsg = userMessages[userMessages.length - 1];
  const userText =
    typeof lastUserMsg?.content === "string"
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg?.content)
        ? (lastUserMsg.content as any[])
            .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
            .map((c: { type: "text"; text: string }) => c.text)
            .join("\n")
        : "";

  if (userText.length < 30) return; // Skip short messages

  // Step 1: Compute tactic-based risk from user message (optional signal)
  const risk = computeRisk(userText);
  // Note: We don't gate on risk.score here — VbC can occur even with neutral user input.
  // User risk is used as an additional signal for severity reporting below.

  log.info(`User sycophancy risk: ${risk.score.toFixed(2)} (${risk.tactics.join(", ") || "none"})`);

  // Get the last assistant response
  const assistantMessages = messages.filter((m: any) => m.role === "assistant");
  const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];
  const responseText =
    typeof lastAssistantMsg?.content === "string"
      ? lastAssistantMsg.content
      : Array.isArray(lastAssistantMsg?.content)
        ? (lastAssistantMsg.content as any[])
            .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
            .map((c: { type: "text"; text: string }) => c.text)
            .join("\n")
        : "";

  if (responseText.length < 50) return;

  // Step 2: Detect VbC in assistant response using heuristic patterns
  // Replaces expensive 30s LLM auditor call with fast pattern matching
  const vbcResult = detectVbC(responseText);
  if (!vbcResult.detected) return; // No VbC found — no correction needed

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
  });
}

// ── Extension Factory ─────────────────────────────────────────────────────────

export default function sycophancyDetector(): (pi: ExtensionAPI) => void {
  return function register(pi: ExtensionAPI): void {
    pi.on("message_end", async (event: any, ctx: ExtensionContext) => {
      try {
        if (event.message?.role !== "assistant") return;

        // Skip short responses (tool call results, etc.)
        const textContent = (event.message.content ?? [])
          .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
          .map((c: { type: "text"; text: string }) => c.text)
          .join("\n");
        if (textContent.length < 50) return;

        const state = getState(ctx);
        await handleSycophancy(pi, ctx, state);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[sycophancy] message_end handler error: ${msg}`);
      }
    });
  };
}
