/**
 * register-tool-result - Calibration tracking on tool results.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addEvidence } from "../../../lib/store/evidence-pool.js";
import { emitSignal } from "../../../lib/reasoning/belief-policy-engine.js";
import { eventBus } from "../../../lib/events/event-bus.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { getState, ERROR_BURST_THRESHOLD } from "../state.js";
import { noteToolOutcomeForBurst } from "../../../lib/detection/test-burst.js";

/** Flatten a tool_result content array to one bounded text snippet. */
function contentSnippet(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
      const text = (part as { text?: string }).text;
      if (typeof text === "string" && text.length > 0) return text;
    }
  }
  return undefined;
}

export function registerToolResultHandler(pi: ExtensionAPI): void {
  pi.on("tool_result", async (event: any, ctx: ExtensionContext) => {
    const toolName = event?.toolName || "";
    // Test-burst feed: record EVERY tool outcome (success + error) in the
    // rollback-guard ring BEFORE any gate — the burst window must see the
    // full stream to distinguish a failing-test loop from real degradation.
    const isError = Boolean(event?.isError);
    noteToolOutcomeForBurst(ctx, toolName, isError, {
      command:
        typeof event?.input?.command === "string"
          ? event.input.command
          : typeof event?.input?.command === "object"
            ? JSON.stringify(event.input.command)
            : undefined,
      output: contentSnippet(event?.content),
    });

    if (!getState(ctx).enforcementActive) return;
    const isBurst = getState(ctx).consecutiveErrorTurns >= ERROR_BURST_THRESHOLD;
    if (!toolName || !toolName.trim()) return;
    if (toolName === "think") return;

    const predicted = getState(ctx).lastThinkConfidence;
    if (predicted === null) return;

    const actual = event?.isError ? 0 : 1;
    getState(ctx).calibrationPairs.push({
      predicted,
      actual,
      tool: toolName,
      turn: getState(ctx).currentTurn,
    });

    if (getState(ctx).calibrationPairs.length > 50) {
      getState(ctx).calibrationPairs = getState(ctx).calibrationPairs.slice(-50);
    }

    addEvidence(
      ctx,
      `Tool ${toolName} ${event?.isError ? "failed" : "succeeded"}`,
      "session",
      `${toolName}: ${event?.isError ? "failure" : "success"} (confidence: ${predicted.toFixed(2)})`,
      predicted,
    );

    if (event?.isError) {
      // The event carries no error message field; the failure text is the
      // result content (agent-session builds `content`, not `error`).
      eventBus.emit({
        type: "tool_error",
        toolName,
        error: (contentSnippet(event?.content) ?? `Tool ${toolName} failed`).slice(0, 500),
        turn: getState(ctx).currentTurn,
        timestamp: Date.now(),
      });
    }

    const error_abs = Math.abs(predicted - actual);
    if (!isBurst && getState(ctx).calibrationPairs.length >= 10 && error_abs > 0.4) {
      const recent = getState(ctx).calibrationPairs.slice(-10);
      const avgError =
        recent.reduce((s, p) => s + Math.abs(p.predicted - p.actual), 0) / recent.length;
      if (avgError > 0.5) {
        const enState = getState(ctx);
        const now = Date.now();
        if (now - enState.lastCalibrationWhisperTime < 120_000) return;
        enState.lastCalibrationWhisperTime = now;

        emitSignal(ctx, "calibration", "high-error", "warn", false, {
          error: avgError,
          tool: toolName,
          pairCount: getState(ctx).calibrationPairs.length,
        });

        sendEnforcementWhisper(
          pi,
          ctx,
          `[calibration] High prediction error: ${(error_abs * 100).toFixed(0)}% off on last ${toolName}. ` +
            `Avg error last 10 tools: ${(avgError * 100).toFixed(0)}%`,
        );
      }
    }
  });
}
