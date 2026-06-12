import { createLogger } from "../../../lib/core/logger.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const log = createLogger("enforcement");
/**
 * Message Analysis Handler - extracted from enforcement/index.ts
 *
 * Handles complexity, intent, routing, and stability analysis
 * of assistant messages at message_end boundaries.
 */

import { measureStability } from "../../../lib/reasoning/reasoning-metrics.js";
import { estimateComplexity, checkComplexityMismatch } from "./probe-handler.js";
import { detectIntent, getRoutingHint, checkRoutingMismatch } from "./routing-handler.js";
import type { EnforcementState } from "../state.js";

export interface AnalysisSignals {
  probe?: { turn: number; text: string; acted: boolean };
  routing?: { turn: number; text: string; acted: boolean };
  stability?: { turn: number; text: string; acted: boolean };
}

/**
 * Analyze assistant message for complexity, intent, and stability signals.
 * Returns enforcement signals to be stored in enforcementSignals map.
 */
export async function analyzeMessage(
  textContent: string,
  thinkingContent: string,
  state: EnforcementState,
  ctx: ExtensionContext,
): Promise<AnalysisSignals> {
  const signals: AnalysisSignals = {};

  if (textContent.length < 100) return signals;

  const fullContent = thinkingContent
    ? `## REASONING\n${thinkingContent}\n\n## RESPONSE\n${textContent}`
    : textContent;

  // ── PROBE-BASED: Complexity signals ───────────────────────────────────
  const recentTools: string[] = [];
  for (const [, turn] of state.turnHistory) {
    recentTools.push(...turn.actualTools);
  }

  const lastTool = recentTools[recentTools.length - 1];

  if (lastTool) {
    const probe = estimateComplexity(lastTool, undefined);
    const complexityCheck = checkComplexityMismatch(probe, {
      totalToolCalls: state.totalToolCalls,
      contextUsage: 0,
    });

    if (complexityCheck.mismatch) {
      signals.probe = {
        turn: state.currentTurn,
        text: complexityCheck.suggestion,
        acted: false,
      };
    }
  }

  // ── ROUTING-BASED: Intent signals ─────────────────────────────────────
  const intent = await detectIntent(recentTools.slice(-10), fullContent, ctx);
  let routingSuggestion = getRoutingHint(intent.intent, recentTools) ?? "";

  if (lastTool && intent.confidence > 0.5) {
    const routingCheck = checkRoutingMismatch(lastTool, intent.intent);
    if (routingCheck.mismatch) {
      routingSuggestion = routingSuggestion
        ? routingSuggestion + ". " + routingCheck.suggestion
        : routingCheck.suggestion;
    }
  }

  if (routingSuggestion) {
    signals.routing = {
      turn: state.currentTurn,
      text: routingSuggestion,
      acted: false,
    };
  }

  // ── Reasoning stability check ────────────────────────────────────────
  const lastUserMsg = state.lastUserMessage || "";
  if (lastUserMsg.length > 10 && textContent.length > 100) {
    const stability = measureStability(lastUserMsg, textContent);
    if (!stability.stable) {
      signals.stability = {
        turn: state.currentTurn,
        text: `[stability] Response ${stability.reason} (overlap=${stability.metrics.overlap.toFixed(2)}, entropy=${stability.metrics.entropy.toFixed(2)}, contradictions=${stability.metrics.contradictions})`,
        acted: false,
      };
    }
  }

  return signals;
}
