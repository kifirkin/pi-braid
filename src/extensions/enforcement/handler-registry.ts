/**
 * Enforcement Handler Registry - thin orchestrator.
 *
 * Imports and registers each focused handler. Previously a 855-line monolith
 * with inline event handlers and dynamic imports - now a ~60-line coordinator.
 *
 * Phase 3: God object split complete. Each handler lives in its own file
 * under handlers/ for independent testing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../lib/core/logger.js";
import { guard } from "../../lib/utils/error-guard.js";
import { registerInjectionTracker } from "../../lib/utils/injection-tracker.js";
import { registerTurnEndHandler, dispatchTurnEnd } from "../../lib/events/turn-end-coordinator.js";
import { onEvent } from "../../lib/events/event-types.js";
import { sendEnforcementWhisper } from "./whisper.js";
import { processAgentResponse, formatContradictionWhisper } from "../../lib/store/claim-tracker.js";
import {
  loadSpecs,
  checkSpecCoverage,
  getVerifierState,
} from "../../lib/store/bidirectional-verifier.js";
import { ingestArchives } from "../../lib/events/consolidation-channel.js";
import { isDegraded } from "../../lib/detection/degradation-detector.js";
import { autoRollback } from "../../lib/state/state-checkpoint.js";
import { getState } from "./state.js";
import { registerInputHandler } from "./handlers/register-input-handler.js";
import { registerSessionStart } from "./handlers/register-session-start.js";
import { registerToolCallHandler } from "./handlers/register-tool-call.js";
import { registerMessageEndHandler } from "./handlers/register-message-end.js";
import { registerToolResultHandler } from "./handlers/register-tool-result.js";
import { registerToolResultFormatting } from "./handlers/register-tool-result-formatting.js";
import { registerSessionCompactHandler } from "./handlers/register-session-compact.js";
import { registerAutoRetryEndHandler } from "./handlers/register-auto-retry-end.js";
import { registerSessionShutdownHandler } from "./handlers/register-session-shutdown.js";
import { registerSessionShutdownResumption } from "./handlers/register-session-shutdown-resumption.js";
import { registerSessionStartDiscoverability } from "./handlers/register-session-start-discoverability.js";
import { registerTurnEndHygiene } from "./handlers/register-turn-end-hygiene.js";
import { driftHandler } from "./handlers/analysis/drift-handler.js";
import { bpeHandler, setLastRecommendationType } from "./handlers/analysis/bpe-handler.js";
import { marsHandler } from "./handlers/analysis/mars-handler.js";
import { dreamerHandler } from "./handlers/analysis/dreamer-handler.js";
import { feedbackHandler } from "./handlers/analysis/feedback-handler.js";
import { reflectionHandler } from "./handlers/analysis/reflection-handler.js";
import { dispatchTurnEndLoop } from "./handlers/turn-end-handler.js";
import { beginTurn } from "../../lib/enforcement/turn-dedup.js";
import { TURN_END } from "../../lib/core/event-names.js";

const log = createLogger("enforcement");

// Handler registration metadata was previously exported as
// HANDLER_REGISTRATIONS (an array of {event, method, handler} entries
// hand-coded to mirror actual registerTurnEndHandler calls). It was
// removed in 2026-06-13 (TASK-1.8 / Q6 -- user decided to remove
// the fragile thing). If a structural test is later needed, replace
// with runtime introspection of the live event bus.

/**
 * Register all enforcement event handlers on the given pi instance.
 */
export function registerHandlers(pi: ExtensionAPI): void {
  registerInjectionTracker(pi as Parameters<typeof registerInjectionTracker>[0]);

  registerInputHandler(pi);
  registerSessionStart(pi);
  registerSessionStartDiscoverability(pi);
  registerToolCallHandler(pi);

  // Clear the turn-scoped whisper dedup registry at the start of each
  // new user turn. Any pending claims from the previous turn are dropped
  // so each turn gets a fresh dedup budget.
  onEvent(pi, "input", () => {
    beginTurn();
  });
  registerMessageEndHandler(pi);
  registerToolResultFormatting(pi);
  registerToolResultHandler(pi);
  registerCompactAndSessionHandlers(pi);
}

function registerCompactAndSessionHandlers(pi: ExtensionAPI): void {
  registerSessionCompactHandler(pi);
  registerAutoRetryEndHandler(pi);
  registerSessionShutdownHandler(pi);
  registerSessionShutdownResumption(pi);

  // ── turn_end: individual analysis handlers (split from dispatch-turn-end-analysis) ──
  registerTurnEndHandler("enforcement-drift", 100, async (event, ctx) => {
    await driftHandler(pi, event, ctx);
  });

  // ── turn_end: degradation->checkpoint rollback (before analysis handlers) ──
  // heartbeatCheckpointTick runs every ~60s; this catches degradation between beats.
  registerTurnEndHandler("degradation-rollback", 99, async (_event, ctx) => {
    if (!getState(ctx).enforcementActive) return;
    if (!isDegraded(ctx)) return;
    const sessionId = ctx.cwd ?? String(process.pid);
    const result = await autoRollback(ctx, sessionId);
    if (result.restored) {
      log.warn(`Turn-end degradation rollback: ${result.note}`);
    }
  });

  registerTurnEndHandler("enforcement-bpe", 95, async (event, ctx) => {
    const newRecType = await bpeHandler(pi, event, ctx);
    if (newRecType) setLastRecommendationType(newRecType);
  });
  registerTurnEndHandler("enforcement-mars", 85, async (event, ctx) => {
    await marsHandler(pi, event, ctx);
  });
  registerTurnEndHandler("enforcement-dreamer", 80, async (event, ctx) => {
    await dreamerHandler(pi, event, ctx);
  });
  registerTurnEndHandler("enforcement-feedback", 60, async (event, ctx) => {
    await feedbackHandler(pi, event, ctx);
  });
  registerTurnEndHandler("enforcement-reflection", 50, async (event, ctx) => {
    await reflectionHandler(pi, event, ctx);
  });

  // ── turn_end: main enforcement loop ──
  registerTurnEndHandler("enforcement-loop", 90, async (event, ctx) => {
    await dispatchTurnEndLoop(pi, event, ctx);
  });

  // ── turn_end: claim tracker - cross-turn contradiction detection ──
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
        const contradictions = await processAgentResponse(msgText, ctx, getState(ctx).currentTurn);
        if (contradictions.length > 0) {
          sendEnforcementWhisper(pi, ctx, formatContradictionWhisper(contradictions));
        }
      },
      log,
    );
  });

  // ── turn_end: spec verification - checks edited files against specs ──
  registerTurnEndHandler("spec-verification", 30, async (_event, ctx) => {
    if (!getState(ctx).enforcementActive) return;
    await guard(
      "spec-verification",
      async () => {
        const specs = await loadSpecs(ctx);
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
        const ingested = await ingestArchives(ctx.cwd);
        if (ingested > 0) {
          log.info(`[archive-ingestion] Ingested ${ingested} archive(s) into consolidation queue`);
        }
      },
      log,
    );
  });

  // ── turn_end: context hygiene + discoverability (lowest priority) ──
  registerTurnEndHygiene(pi);

  // ── turn_end: coordinator dispatch ──
  onEvent(pi, TURN_END, async (event: any, ctx: any) => {
    await dispatchTurnEnd(event, ctx);
  });
}
