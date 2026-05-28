/**
 * register-tool-result — Calibration tracking on tool results.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { addEvidence } from "../../../lib/evidence-pool.js";
import { emitSignal } from "../../../lib/reasoning/belief-policy-engine.js";
import { eventBus } from "../../../lib/event-bus.js";
import { sendEnforcementWhisper } from "../whisper.js";
import { getState } from "../state.js";

const ERROR_BURST_THRESHOLD = 3;

export function registerToolResultHandler(pi: ExtensionAPI): void {
  pi.on("tool_result", async (event: any, ctx: ExtensionContext) => {
    if (!getState(ctx).enforcementActive) return;
    const isBurst = getState(ctx).consecutiveErrorTurns >= ERROR_BURST_THRESHOLD;
    const toolName = event?.toolName || "";
    if (!toolName || !toolName.trim()) return;
    if (toolName === "think") return;

    const predicted = getState(ctx).lastThinkConfidence;
    if (predicted === null) return;

    const actual = event?.error ? 0 : 1;
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
      `Tool ${toolName} ${event?.error ? "failed" : "succeeded"}`,
      "session",
      `${toolName}: ${event?.error ? "failure" : "success"} (confidence: ${predicted.toFixed(2)})`,
      predicted,
    );

    if (event?.error) {
      eventBus.emit({
        type: "tool_error",
        toolName,
        error: String(event.error).slice(0, 500),
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
