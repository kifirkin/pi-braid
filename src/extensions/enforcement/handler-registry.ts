/**
 * Enforcement Handler Registry — thin orchestrator.
 *
 * Imports and registers each focused handler. Previously a 855-line monolith
 * with inline event handlers and dynamic imports — now a ~60-line coordinator.
 *
 * Phase 3: God object split complete. Each handler lives in its own file
 * under handlers/ for independent testing.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../lib/logger.js";
import { guard } from "../../lib/error-guard.js";
import { registerInjectionTracker } from "../../lib/injection-tracker.js";
import { registerTurnEndHandler, dispatchTurnEnd } from "../../lib/turn-end-coordinator.js";
import { onEvent } from "../../lib/event-types.js";
import { type NudgeManager } from "./nudge-manager.js";
import { sendEnforcementWhisper } from "./whisper.js";
import { processAgentResponse, formatContradictionWhisper } from "../../lib/claim-tracker.js";
import {
  loadSpecs,
  checkSpecCoverage,
  getVerifierState,
} from "../../lib/bidirectional-verifier.js";
import { scanArchives } from "../../lib/consolidation-channel.js";
import { getState } from "./state.js";
import { registerInputHandler } from "./handlers/register-input-handler.js";
import { registerSessionStart } from "./handlers/register-session-start.js";
import { registerToolCallHandler } from "./handlers/register-tool-call.js";
import { registerMessageEndHandler } from "./handlers/register-message-end.js";
import { registerToolResultHandler } from "./handlers/register-tool-result.js";
import { registerSessionCompactHandler } from "./handlers/register-session-compact.js";
import { registerAutoRetryEndHandler } from "./handlers/register-auto-retry-end.js";
import { registerSessionShutdownHandler } from "./handlers/register-session-shutdown.js";
import { dispatchTurnEndAnalysis } from "./handlers/dispatch-turn-end-analysis.js";
import { dispatchTurnEndLoop } from "./handlers/turn-end-handler.js";

const log = createLogger("enforcement");

let _lastRecommendationType: string | null = null;

/**
 * Handler registration metadata — used by tests instead of fragile source parsing.
 */
export const HANDLER_REGISTRATIONS: Array<{ event: string; method: string; handler: string }> = [
  { event: "input", method: "pi.on", handler: "language detection" },
  {
    event: "session_start",
    method: "registerSessionStartHandler",
    handler: "phase:CoreInit:block check",
  },
  { event: "tool_call", method: "onEvent", handler: "tool tracking + blocking" },
  { event: "message_end", method: "onEvent", handler: "conflict + analysis + judge (merged)" },
  { event: "tool_result", method: "pi.on", handler: "calibration" },
  { event: "session_compact", method: "onEvent", handler: "hygiene reset" },
  { event: "auto_retry_end", method: "onEvent", handler: "error classification" },
  { event: "session_shutdown", method: "onEvent", handler: "state reset" },
  { event: "turn_end", method: "registerTurnEndHandler", handler: "enforcement-analysis" },
  { event: "turn_end", method: "registerTurnEndHandler", handler: "enforcement-loop" },
  { event: "turn_end", method: "registerTurnEndHandler", handler: "claim-tracker" },
  { event: "turn_end", method: "registerTurnEndHandler", handler: "spec-verification" },
  { event: "turn_end", method: "registerTurnEndHandler", handler: "archive-ingestion" },
];

/**
 * Register all enforcement event handlers on the given pi instance.
 */
export function registerHandlers(pi: ExtensionAPI, nudgeManager: NudgeManager): void {
  registerInjectionTracker(
    pi as unknown as { on: (event: string, handler: (...args: any[]) => any) => void },
  );

  registerInputHandler(pi);
  registerSessionStart(pi);
  registerToolCallHandler(pi);
  registerMessageEndHandler(pi);
  registerToolResultHandler(pi);
  registerCompactAndSessionHandlers(pi, nudgeManager);
}

function registerCompactAndSessionHandlers(pi: ExtensionAPI, _nudgeManager: NudgeManager): void {
  registerSessionCompactHandler(pi);
  registerAutoRetryEndHandler(pi);
  registerSessionShutdownHandler(pi);

  // ── turn_end: enforcement analysis (drift + BPE + MARS + dreamer + reflection) ──
  registerTurnEndHandler("enforcement-analysis", 100, async (event, ctx) => {
    const newRecType = await dispatchTurnEndAnalysis(pi, event, ctx, _lastRecommendationType);
    if (newRecType) _lastRecommendationType = newRecType;
  });

  // ── turn_end: main enforcement loop ──
  registerTurnEndHandler("enforcement-loop", 90, async (event, ctx) => {
    await dispatchTurnEndLoop(pi, event, ctx, _nudgeManager);
  });

  // ── turn_end: claim tracker — cross-turn contradiction detection ──
  registerTurnEndHandler("claim-tracker", 70, async (event, ctx) => {
    if (!getState(ctx).enforcementActive) return;
    const isBurst = getState(ctx).consecutiveErrorTurns >= 3;
    if (isBurst || event.message?.role !== "assistant" || !event.message?.content) return;

    const msgText = Array.isArray(event.message.content)
      ? event.message.content
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c?.text || "")
          .join(" ")
      : typeof event.message.content === "string"
        ? event.message.content
        : "";

    if (msgText.length <= 50) return;
    await guard(
      "claim-tracker",
      async () => {
        const contradictions = processAgentResponse(msgText, ctx, getState(ctx).currentTurn);
        if (contradictions.length > 0) {
          sendEnforcementWhisper(pi, ctx, formatContradictionWhisper(contradictions));
        }
      },
      log,
    );
  });

  // ── turn_end: spec verification — checks edited files against specs ──
  registerTurnEndHandler("spec-verification", 30, async (_event, ctx) => {
    if (!getState(ctx).enforcementActive) return;
    await guard(
      "spec-verification",
      async () => {
        const specs = loadSpecs(ctx);
        if (specs.length === 0) return;
        const state = getVerifierState(ctx);
        const editedFiles = [...state.editedFiles];
        if (editedFiles.length === 0) return;
        const results = checkSpecCoverage(editedFiles, specs);
        const violations = results.filter((r) => !r.covered);
        if (violations.length > 0) {
          const msg = `[spec] ${violations.length} spec requirement(s) affected by recent edits:\n${violations.map((v) => `  - ${v.strength}: ${v.requirement}`).join("\n")}`;
          sendEnforcementWhisper(pi, ctx, msg);
        }
      },
      log,
    );
  });

  // ── turn_end: archive ingestion ──
  registerTurnEndHandler("archive-ingestion", 10, async (_event, ctx) => {
    await guard(
      "archive-ingestion",
      async () => {
        const archives = scanArchives(ctx.cwd);
        if (archives.length > 0) {
          log.info(`[archive-ingestion] Found ${archives.length} archive(s) to process`);
        }
      },
      log,
    );
  });

  // ── turn_end: coordinator dispatch ──
  onEvent(pi, "turn_end", async (event: any, ctx: any) => {
    await dispatchTurnEnd(event, ctx);
  });
}
